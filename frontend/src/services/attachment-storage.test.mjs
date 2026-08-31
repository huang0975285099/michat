import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ATTACHMENT_STORAGE_RESERVE_BYTES,
  assertLocalAttachmentSpace,
  attachmentStorageRequiredBytes,
  binarySize,
  formatStorageBytes,
} from './attachment-storage.mjs'

test('attachment storage calculation includes file bytes and working overhead', () => {
  assert.ok(attachmentStorageRequiredBytes(10 * 1024 * 1024) > 10 * 1024 * 1024)
})

test('storage preflight rejects before writing when capacity is insufficient', async () => {
  await assert.rejects(
    assertLocalAttachmentSpace(10 * 1024 * 1024, {
      storage: { estimate: async () => ({ usage: 90 * 1024 * 1024, quota: 100 * 1024 * 1024 }) },
      reserveBytes: ATTACHMENT_STORAGE_RESERVE_BYTES,
    }),
    error => error.code === 'local_attachment_storage_full' && error.availableBytes === 10 * 1024 * 1024,
  )
})

test('unsupported storage estimate does not block attachments', async () => {
  const result = await assertLocalAttachmentSpace(500, { storage: null })
  assert.equal(result.supported, false)
})

test('binary size and byte formatter handle common values', () => {
  assert.equal(binarySize(new Uint8Array(5)), 5)
  assert.match(formatStorageBytes(5 * 1024 * 1024, 'en-US'), /^5 MB$/)
})
