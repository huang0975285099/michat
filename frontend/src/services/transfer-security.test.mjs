import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertTransferActive, pendingCiphertext, stopSensitiveTransfers } from './transfer-security.mjs'

test('locking aborts and wakes tasks, clears attachment secrets and persists only ciphertext', async () => {
  const metadata = { fileKey: 'secret', noncePrefix: 'nonce', filename: 'private.png', filetype: 'image/png' }
  const controller = new AbortController()
  let resumed = false
  const operation = { metadata, controller, paused: true, resume: () => { resumed = true } }
  const payload = { msg_id: 'message', from: 'sender', ciphertext: 'encrypted', metadata: { fileKey: 'do-not-persist' } }
  const entry = { metadata, payload }
  const transfer = { id: 'file', msgId: 'message', direction: 'receive', transport: 'offline', payload, metadata, objectUrl: 'blob:preview', chunks: ['data'] }
  const saved = []
  const revoked = []
  await stopSensitiveTransfers({ uploads: new Map(), downloads: new Map([['file', operation]]), queued: new Map([['message', entry]]), transfers: { file: transfer }, persistPending: record => saved.push(record), markUploadPending: () => {}, revokeUrl: url => revoked.push(url) })
  assert.equal(controller.signal.aborted, true)
  assert.equal(resumed, true)
  assert.equal(operation.securityLocked, true)
  assert.equal(metadata.fileKey, null)
  assert.equal(metadata.filename, null)
  assert.equal(entry.metadata, null)
  assert.equal(transfer.metadata, null)
  assert.deepEqual(revoked, ['blob:preview'])
  assert.ok(saved.every(record => record.ciphertext === 'encrypted' && !record.metadata))
})

test('old operations cannot continue even after the application unlocks again', () => {
  assert.throws(() => assertTransferActive({ securityLocked: true }, 1, 1, false), { code: 'security_locked' })
  assert.throws(() => assertTransferActive({}, 1, 2, false), { code: 'security_locked' })
  assert.throws(() => assertTransferActive({}, 1, 1, true), { code: 'security_locked' })
  assert.doesNotThrow(() => assertTransferActive({}, 2, 2, false))
})

test('upload lock recovery marks a durable message retryable without canceling its server attachment', async () => {
  const updated = []
  const metadata = { fileKey: 'secret' }
  await stopSensitiveTransfers({ uploads: new Map(), downloads: new Map(), queued: new Map(), transfers: { file: { transport: 'offline', direction: 'send', msgId: 'outgoing', metadata } }, persistPending: () => {}, markUploadPending: id => updated.push(id), revokeUrl: () => {} })
  assert.deepEqual(updated, ['outgoing'])
  assert.equal(metadata.fileKey, null)
})

test('pending records do not retain arbitrary private fields from a transfer payload', () => {
  assert.deepEqual(pendingCiphertext({ msg_id: 'id', ciphertext: 'cipher', fileKey: 'secret', plaintext: 'text' }), { msg_id: 'id', ciphertext: 'cipher' })
})
