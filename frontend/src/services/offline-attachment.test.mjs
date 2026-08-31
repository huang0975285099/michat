import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOfflineAttachmentUpload,
  downloadOfflineAttachment,
  parseOfflineAttachmentContent,
  serializeOfflineAttachmentContent,
  uploadOfflineAttachment,
} from './offline-attachment.mjs'

const attachmentId = '12345678-1234-4234-9234-123456789abc'

function makeFile(parts, name, type) {
  const blob = new Blob(parts, { type })
  blob.name = name
  return blob
}

function mockAttachmentAPI() {
  const chunks = new Map()
  let initBody
  let available = false
  return {
    chunks,
    failAt: null,
    failedOnce: false,
    get initBody() { return initBody },
    async init(body) {
      initBody = structuredClone(body)
      return { data: { id: attachmentId, status: 'uploading', missing_chunks: [0, 1] } }
    },
    async get() {
      return { data: {
        status: available ? 'available' : 'uploading',
        file_size: initBody.file_size,
        ciphertext_size: initBody.ciphertext_size,
        chunk_size: initBody.chunk_size,
        chunk_count: initBody.chunk_count,
        received_bytes: [...chunks.values()].reduce((total, item) => total + item.body.byteLength, 0),
        missing_chunks: [...Array(initBody.chunk_count).keys()].filter(index => !chunks.has(index)),
      } }
    },
    async putChunk(_id, index, body, sha256) {
      if (this.failAt === index && !this.failedOnce) {
        this.failedOnce = true
        throw new Error('simulated disconnect')
      }
      chunks.set(index, { body: body.slice(0), sha256 })
      return { data: { index } }
    },
    async complete() {
      available = true
      return { data: { status: 'available' } }
    },
    async downloadChunk(_id, index) {
      const chunk = chunks.get(index)
      return { data: chunk.body.slice(0), headers: { 'x-chunk-sha256': chunk.sha256 } }
    },
  }
}

test('uploads independent AES-GCM chunks without exposing file secrets to init API', async () => {
  const api = mockAttachmentAPI()
  const file = makeFile([new Uint8Array(20).map((_, index) => index)], 'proof.png', 'image/png')
  const metadata = await createOfflineAttachmentUpload(file, '1234-ABCD', { api, chunkSize: 12 })
  assert.deepEqual(api.initBody, {
    recipient_chat_id: '1234-ABCD',
    file_size: 20,
    ciphertext_size: 52,
    chunk_size: 12,
    chunk_count: 2,
  })
  assert.equal('fileKey' in api.initBody, false)
  assert.equal('filename' in api.initBody, false)

  const progress = []
  await uploadOfflineAttachment(file, metadata, { api, onProgress: value => progress.push(value) })
  assert.equal(api.chunks.size, 2)
  assert.equal(api.chunks.get(0).body.byteLength, 28)
  assert.equal(api.chunks.get(1).body.byteLength, 24)
  assert.equal(progress.at(-1), 95)

  const downloaded = await downloadOfflineAttachment(metadata, { api })
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), new Uint8Array(await file.arrayBuffer()))
})

test('uses resume state and uploads only missing chunks', async () => {
  const api = mockAttachmentAPI()
  const file = makeFile([new Uint8Array(20).fill(7)], 'resume.pdf', 'application/pdf')
  const metadata = await createOfflineAttachmentUpload(file, '1234-ABCD', { api, chunkSize: 12 })
  api.failAt = 1
  await assert.rejects(uploadOfflineAttachment(file, metadata, { api }), /simulated disconnect/)
  const originalChunk = api.chunks.get(0)
  await uploadOfflineAttachment(file, metadata, { api })
  assert.equal(api.chunks.get(0), originalChunk)
  assert.equal(api.chunks.size, 2)
})

test('continues from server missing chunks after an explicit pause', async () => {
  const api = mockAttachmentAPI()
  const file = makeFile([new Uint8Array(20).fill(5)], 'pause.zip', 'application/zip')
  const metadata = await createOfflineAttachmentUpload(file, '1234-ABCD', { api, chunkSize: 12 })
  const controller = new AbortController()
  await assert.rejects(uploadOfflineAttachment(file, metadata, {
    api,
    signal: controller.signal,
    onProgress: () => controller.abort(),
  }), error => error?.name === 'AbortError')
  assert.equal(api.chunks.size, 1)
  const first = api.chunks.get(0)
  await uploadOfflineAttachment(file, metadata, { api })
  assert.equal(api.chunks.get(0), first)
  assert.equal(api.chunks.size, 2)
})

test('rejects tampered ciphertext and swapped chunk authentication context', async () => {
  const api = mockAttachmentAPI()
  const file = makeFile([new Uint8Array(20).fill(9)], 'tamper.jpg', 'image/jpeg')
  const metadata = await createOfflineAttachmentUpload(file, '1234-ABCD', { api, chunkSize: 12 })
  await uploadOfflineAttachment(file, metadata, { api })

  const first = api.chunks.get(0)
  const second = api.chunks.get(1)
  api.chunks.set(0, second)
  api.chunks.set(1, first)
  await assert.rejects(downloadOfflineAttachment(metadata, { api }))
})

test('resumes downloads from locally persisted ciphertext chunks', async () => {
  const api = mockAttachmentAPI()
  const file = makeFile([new Uint8Array(20).fill(3)], 'download.pdf', 'application/pdf')
  const metadata = await createOfflineAttachmentUpload(file, '1234-ABCD', { api, chunkSize: 12 })
  await uploadOfflineAttachment(file, metadata, { api })
  const persisted = new Map([[0, api.chunks.get(0).body]])
  let networkDownloads = 0
  const originalDownload = api.downloadChunk
  api.downloadChunk = async (...args) => {
    networkDownloads++
    return originalDownload(...args)
  }
  const downloaded = await downloadOfflineAttachment(metadata, {
    api,
    getStoredCiphertextChunk: index => persisted.get(index) || null,
    onCiphertextChunk: (index, ciphertext) => persisted.set(index, ciphertext),
  })
  assert.equal(networkDownloads, 1)
  assert.equal(persisted.size, 2)
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), new Uint8Array(await file.arrayBuffer()))
})

test('streams decrypted chunks to durable storage without assembling a whole-file blob', async () => {
  const api = mockAttachmentAPI()
  const original = new Uint8Array(20).map((_, index) => index + 10)
  const file = makeFile([original], 'large.zip', 'application/zip')
  const metadata = await createOfflineAttachmentUpload(file, '1234-ABCD', { api, chunkSize: 12 })
  await uploadOfflineAttachment(file, metadata, { api })

  const plaintextChunks = []
  const downloaded = await downloadOfflineAttachment(metadata, {
    api,
    collectPlaintext: false,
    onPlaintextChunk: (index, plaintext) => { plaintextChunks[index] = new Uint8Array(plaintext) },
  })

  assert.equal(downloaded, null)
  assert.equal(plaintextChunks.length, 2)
  assert.deepEqual(new Uint8Array([...plaintextChunks[0], ...plaintextChunks[1]]), original)
})

test('continues a download from authenticated plaintext already stored locally', async () => {
  const api = mockAttachmentAPI()
  const original = new Uint8Array(20).map((_, index) => index + 30)
  const file = makeFile([original], 'restart.zip', 'application/zip')
  const metadata = await createOfflineAttachmentUpload(file, '1234-ABCD', { api, chunkSize: 12 })
  await uploadOfflineAttachment(file, metadata, { api })
  let networkDownloads = 0
  const originalDownload = api.downloadChunk
  api.downloadChunk = async (...args) => {
    networkDownloads++
    return originalDownload(...args)
  }
  const newlyStored = []

  await downloadOfflineAttachment(metadata, {
    api,
    collectPlaintext: false,
    getStoredPlaintextChunk: index => index === 0 ? original.slice(0, 12) : null,
    onPlaintextChunk: (index, plaintext) => { newlyStored[index] = new Uint8Array(plaintext) },
  })

  assert.equal(networkDownloads, 1)
  assert.deepEqual(newlyStored[1], original.slice(12))
})

test('parses only versioned and validated offline attachment content', async () => {
  const api = mockAttachmentAPI()
  const file = makeFile([new Uint8Array(4)], 'voice.ogg', 'audio/ogg')
  const metadata = await createOfflineAttachmentUpload(file, '1234-ABCD', {
    api,
    chunkSize: 4,
    kind: 'voice',
    durationMs: 1200,
  })
  assert.deepEqual(parseOfflineAttachmentContent(JSON.stringify(metadata)), metadata)
  const wrapped = serializeOfflineAttachmentContent(metadata)
  assert.deepEqual(parseOfflineAttachmentContent(wrapped), metadata)
  assert.equal(JSON.parse(wrapped).text, '[Encrypted attachment / 加密附件，请升级客户端查看]')
  assert.equal(parseOfflineAttachmentContent('ordinary message'), null)
  assert.throws(() => parseOfflineAttachmentContent(JSON.stringify({ ...metadata, fileKey: 'bad' })))
})
