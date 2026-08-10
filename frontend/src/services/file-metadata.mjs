import { decryptMessage, encryptMessage } from './crypto.js'

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILENAME_BYTES = 255
const MAX_FILETYPE_BYTES = 255
const ALLOWED_FILE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg',
  'mp4', 'webm', 'mov',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf',
  'zip', 'rar', '7z', 'tar', 'gz', 'apk',
])

function validateNameAndType(filename, filetype) {
  if (typeof filename !== 'string' || !filename ||
      new TextEncoder().encode(filename).length > MAX_FILENAME_BYTES) {
    throw new Error('File metadata is invalid')
  }
  if (typeof filetype !== 'string' ||
      new TextEncoder().encode(filetype).length > MAX_FILETYPE_BYTES) {
    throw new Error('File metadata is invalid')
  }
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
    throw new Error('File metadata is invalid')
  }
}

export function validateFileMetadata(filename, filetype, filesize) {
  validateNameAndType(filename, filetype)
  if (!Number.isInteger(filesize) || filesize <= 0 || filesize > MAX_FILE_SIZE) {
    throw new Error('File metadata is invalid')
  }
}

export async function sealFileMetadata({ filename, filetype }, recipientPublicKey, encrypt = encryptMessage) {
  validateNameAndType(filename, filetype)
  const encrypted = await encrypt(JSON.stringify({ filename, filetype }), recipientPublicKey)
  return {
    metadata_ephemeral_pub_key: encrypted.ephemeralPubKey,
    metadata_iv: encrypted.iv,
    metadata_ciphertext: encrypted.ciphertext,
  }
}

export function buildEncryptedFileOfferPayload({
  to,
  transferId,
  msgId,
  filesize,
  totalChunks,
  ephemeralPubKey,
  iv,
  burnAfterRead,
  sealedMetadata,
}) {
  return {
    to,
    transfer_id: transferId,
    msg_id: msgId,
    filesize,
    total_chunks: totalChunks,
    ephemeral_pub_key: ephemeralPubKey,
    iv,
    burn_after_read: burnAfterRead,
    ...sealedMetadata,
  }
}

export async function openFileOfferMetadata(payload, decrypt = decryptMessage) {
  const encryptedFields = [
    payload?.metadata_ephemeral_pub_key,
    payload?.metadata_iv,
    payload?.metadata_ciphertext,
  ]
  const present = encryptedFields.filter(value => typeof value === 'string' && value.length > 0).length
  if (present !== 0 && present !== encryptedFields.length) {
    throw new Error('File metadata is invalid')
  }

  let metadata
  if (present === encryptedFields.length) {
    const plaintext = await decrypt({
      ephemeralPubKey: payload.metadata_ephemeral_pub_key,
      iv: payload.metadata_iv,
      ciphertext: payload.metadata_ciphertext,
    })
    try {
      metadata = JSON.parse(plaintext)
    } catch {
      throw new Error('File metadata is invalid')
    }
  } else {
    metadata = {
      filename: payload?.filename,
      filetype: payload?.filetype,
    }
  }

  validateFileMetadata(metadata?.filename, metadata?.filetype, payload?.filesize)
  return {
    filename: metadata.filename,
    filetype: metadata.filetype,
  }
}
