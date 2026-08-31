import { b64ToBuf, bufToB64 } from './crypto.js'
import { validateFileMetadata } from './file-metadata.mjs'

export const OFFLINE_ATTACHMENT_MARKER = 'yunmi.chat.attachment'
export const OFFLINE_ATTACHMENT_VERSION = 1
export const OFFLINE_ATTACHMENT_CHUNK_SIZE = 1024 * 1024

const AES_GCM_TAG_BYTES = 16
const FILE_KEY_BYTES = 32
const NONCE_PREFIX_BYTES = 8
const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CHAT_CONTENT_MARKER = 'yunmi.chat.text'
const LEGACY_ATTACHMENT_FALLBACK = '[Encrypted attachment / 加密附件，请升级客户端查看]'

function responseData(response) {
  return response?.data ?? response
}

function requiredAPI(options) {
  if (!options?.api) throw new Error('Attachment API is required')
  return options.api
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError('Attachment chunk must be binary')
}

function decodeFixedBase64(value, expectedBytes, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is invalid`)
  let decoded
  try {
    decoded = new Uint8Array(b64ToBuf(value))
  } catch {
    throw new Error(`${label} is invalid`)
  }
  if (decoded.byteLength !== expectedBytes) throw new Error(`${label} is invalid`)
  return decoded
}

function attachmentNonce(prefix, index) {
  if (!(prefix instanceof Uint8Array) || prefix.byteLength !== NONCE_PREFIX_BYTES ||
      !Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error('Attachment nonce parameters are invalid')
  }
  const nonce = new Uint8Array(12)
  nonce.set(prefix, 0)
  new DataView(nonce.buffer).setUint32(8, index, false)
  return nonce
}

function expectedPlainChunkSize(fileSize, chunkSize, chunkCount, index) {
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount) {
    throw new Error('Attachment chunk index is invalid')
  }
  return index === chunkCount - 1
    ? fileSize - index * chunkSize
    : chunkSize
}

function attachmentAAD(metadata, index, plainSize) {
  return new TextEncoder().encode([
    OFFLINE_ATTACHMENT_MARKER,
    OFFLINE_ATTACHMENT_VERSION,
    metadata.attachmentId,
    index,
    metadata.chunkCount,
    metadata.fileSize,
    metadata.chunkSize,
    plainSize,
  ].join('|'))
}

async function sha256Hex(value) {
  const bytes = toUint8Array(value)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function importAttachmentKey(rawKey, usage) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, [usage])
}

export function validateOfflineAttachmentMetadata(metadata) {
  if (!metadata || metadata.marker !== OFFLINE_ATTACHMENT_MARKER ||
      metadata.version !== OFFLINE_ATTACHMENT_VERSION ||
      !ATTACHMENT_ID_PATTERN.test(metadata.attachmentId || '')) {
    throw new Error('Offline attachment metadata is invalid')
  }
  validateFileMetadata(metadata.filename, metadata.filetype, metadata.fileSize)
  if (!Number.isInteger(metadata.chunkSize) || metadata.chunkSize <= 0 ||
      !Number.isInteger(metadata.chunkCount) || metadata.chunkCount <= 0 ||
      metadata.chunkCount !== Math.ceil(metadata.fileSize / metadata.chunkSize) ||
      metadata.ciphertextSize !== metadata.fileSize + AES_GCM_TAG_BYTES * metadata.chunkCount) {
    throw new Error('Offline attachment metadata is invalid')
  }
  decodeFixedBase64(metadata.fileKey, FILE_KEY_BYTES, 'Attachment file key')
  decodeFixedBase64(metadata.noncePrefix, NONCE_PREFIX_BYTES, 'Attachment nonce prefix')
  if (metadata.kind !== undefined && metadata.kind !== 'voice') {
    throw new Error('Offline attachment metadata is invalid')
  }
  if (metadata.kind === 'voice' && (!Number.isInteger(metadata.durationMs) || metadata.durationMs <= 0)) {
    throw new Error('Offline attachment metadata is invalid')
  }
  return metadata
}

export function parseOfflineAttachmentContent(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length < 2 || plaintext[0] !== '{') return null
  let parsed
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (parsed?.marker === OFFLINE_ATTACHMENT_MARKER) return validateOfflineAttachmentMetadata(parsed)
  if (parsed?.marker === CHAT_CONTENT_MARKER && parsed?.version === 1 && parsed?.attachment) {
    return validateOfflineAttachmentMetadata(parsed.attachment)
  }
  return null
}

export function serializeOfflineAttachmentContent(metadata) {
  validateOfflineAttachmentMetadata(metadata)
  return JSON.stringify({
    marker: CHAT_CONTENT_MARKER,
    version: 1,
    text: LEGACY_ATTACHMENT_FALLBACK,
    reply: null,
    attachment: metadata,
  })
}

export async function createOfflineAttachmentUpload(file, recipientChatId, options = {}) {
  const api = requiredAPI(options)
  const chunkSize = options.chunkSize || OFFLINE_ATTACHMENT_CHUNK_SIZE
  validateFileMetadata(file?.name, file?.type || '', file?.size)
  if (typeof recipientChatId !== 'string' || !recipientChatId) throw new Error('Recipient is invalid')
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error('Attachment chunk size is invalid')

  const chunkCount = Math.ceil(file.size / chunkSize)
  const ciphertextSize = file.size + AES_GCM_TAG_BYTES * chunkCount
  const rawKey = crypto.getRandomValues(new Uint8Array(FILE_KEY_BYTES))
  const noncePrefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES))
  const created = responseData(await api.init({
    recipient_chat_id: recipientChatId,
    file_size: file.size,
    ciphertext_size: ciphertextSize,
    chunk_size: chunkSize,
    chunk_count: chunkCount,
  }, options.signal))
  if (!ATTACHMENT_ID_PATTERN.test(created?.id || '')) throw new Error('Attachment server returned an invalid ID')

  return {
    marker: OFFLINE_ATTACHMENT_MARKER,
    version: OFFLINE_ATTACHMENT_VERSION,
    attachmentId: created.id,
    fileKey: bufToB64(rawKey),
    noncePrefix: bufToB64(noncePrefix),
    filename: file.name,
    filetype: file.type || '',
    fileSize: file.size,
    ciphertextSize,
    chunkSize,
    chunkCount,
    ...(options.kind === 'voice' ? { kind: 'voice', durationMs: Math.round(options.durationMs) } : {}),
  }
}

export async function uploadOfflineAttachment(file, metadata, options = {}) {
  const api = requiredAPI(options)
  validateOfflineAttachmentMetadata(metadata)
  if (file?.size !== metadata.fileSize || file?.name !== metadata.filename || (file?.type || '') !== metadata.filetype) {
    throw new Error('Selected file no longer matches the attachment upload')
  }

  const state = responseData(await api.get(metadata.attachmentId, options.signal))
  if (state?.status === 'available') return state
  if (state?.status !== 'uploading' || !Array.isArray(state.missing_chunks)) {
    throw new Error('Attachment upload is no longer available')
  }
  const missing = new Set(state.missing_chunks)
  const rawKey = decodeFixedBase64(metadata.fileKey, FILE_KEY_BYTES, 'Attachment file key')
  const noncePrefix = decodeFixedBase64(metadata.noncePrefix, NONCE_PREFIX_BYTES, 'Attachment nonce prefix')
  const key = await importAttachmentKey(rawKey, 'encrypt')
  let completedBytes = Math.max(0, Number(state.received_bytes || 0))

  for (let index = 0; index < metadata.chunkCount; index++) {
    if (!missing.has(index)) continue
    if (options.signal?.aborted) throw new DOMException('Attachment upload aborted', 'AbortError')
    const start = index * metadata.chunkSize
    const end = Math.min(metadata.fileSize, start + metadata.chunkSize)
    const plaintext = await file.slice(start, end).arrayBuffer()
    const plainSize = expectedPlainChunkSize(metadata.fileSize, metadata.chunkSize, metadata.chunkCount, index)
    if (plaintext.byteLength !== plainSize) throw new Error('Attachment source chunk changed')
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: attachmentNonce(noncePrefix, index),
      additionalData: attachmentAAD(metadata, index, plainSize),
      tagLength: 128,
    }, key, plaintext)
    await api.putChunk(metadata.attachmentId, index, ciphertext, await sha256Hex(ciphertext), options.signal)
    completedBytes += ciphertext.byteLength
    options.onProgress?.(Math.min(95, Math.round(completedBytes / metadata.ciphertextSize * 95)))
  }
  return responseData(await api.complete(metadata.attachmentId, options.signal))
}

export async function downloadOfflineAttachment(metadata, options = {}) {
  const api = requiredAPI(options)
  validateOfflineAttachmentMetadata(metadata)
  const state = responseData(await api.get(metadata.attachmentId, options.signal))
  if (state?.status !== 'available' || state.chunk_count !== metadata.chunkCount ||
      state.file_size !== metadata.fileSize || state.ciphertext_size !== metadata.ciphertextSize ||
      state.chunk_size !== metadata.chunkSize) {
    throw new Error('Attachment server metadata does not match the E2EE message')
  }

  const rawKey = decodeFixedBase64(metadata.fileKey, FILE_KEY_BYTES, 'Attachment file key')
  const noncePrefix = decodeFixedBase64(metadata.noncePrefix, NONCE_PREFIX_BYTES, 'Attachment nonce prefix')
  const key = await importAttachmentKey(rawKey, 'decrypt')
  const collectPlaintext = options.collectPlaintext !== false
  const plaintextChunks = collectPlaintext ? [] : null
  let received = 0
  for (let index = 0; index < metadata.chunkCount; index++) {
    if (options.signal?.aborted) throw new DOMException('Attachment download aborted', 'AbortError')
    const plainSize = expectedPlainChunkSize(metadata.fileSize, metadata.chunkSize, metadata.chunkCount, index)
    const storedPlaintext = await options.getStoredPlaintextChunk?.(index)
    if (storedPlaintext) {
      const plaintext = toUint8Array(storedPlaintext)
      if (plaintext.byteLength !== plainSize) throw new Error('Stored attachment plaintext length mismatch')
      if (collectPlaintext) {
        plaintextChunks.push(plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength))
      }
      received += plaintext.byteLength
      options.onProgress?.(Math.min(95, Math.round(received / metadata.fileSize * 95)))
      continue
    }
    const storedChunk = await options.getStoredCiphertextChunk?.(index)
    const response = storedChunk ? null : await api.downloadChunk(metadata.attachmentId, index, options.signal)
    const ciphertext = toUint8Array(storedChunk || responseData(response))
    const expectedHash = response?.headers?.['x-chunk-sha256']
    if (typeof expectedHash === 'string' && expectedHash && await sha256Hex(ciphertext) !== expectedHash.toLowerCase()) {
      throw new Error('Attachment ciphertext checksum mismatch')
    }
    if (ciphertext.byteLength !== plainSize + AES_GCM_TAG_BYTES) throw new Error('Attachment ciphertext length mismatch')
    if (!storedChunk) await options.onCiphertextChunk?.(index, ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength))
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: attachmentNonce(noncePrefix, index),
      additionalData: attachmentAAD(metadata, index, plainSize),
      tagLength: 128,
    }, key, ciphertext)
    await options.onPlaintextChunk?.(index, plaintext)
    if (collectPlaintext) plaintextChunks.push(plaintext)
    received += plaintext.byteLength
    options.onProgress?.(Math.min(95, Math.round(received / metadata.fileSize * 95)))
  }
  if (received !== metadata.fileSize) throw new Error('Attachment plaintext length mismatch')
  return collectPlaintext ? new Blob(plaintextChunks, { type: metadata.filetype }) : null
}

export async function acknowledgeOfflineAttachment(metadata, options = {}) {
  validateOfflineAttachmentMetadata(metadata)
  return responseData(await requiredAPI(options).acknowledge(metadata.attachmentId, options.signal))
}
