import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyAttachmentError } from './attachment-errors.mjs'

test('distinguishes server attachment quota from local and destination storage', () => {
  assert.equal(classifyAttachmentError({ response: { data: { code: 'attachment_quota_exceeded' } } }), 'server_quota')
  assert.equal(classifyAttachmentError({ name: 'QuotaExceededError' }, 'local'), 'local_storage')
  assert.equal(classifyAttachmentError({ code: 'destination_storage_full' }, 'save'), 'destination_storage')
  assert.equal(classifyAttachmentError(new Error('ENOSPC: no space left on device'), 'save'), 'destination_storage')
})

test('classifies plain network failure messages', () => {
  assert.equal(classifyAttachmentError(new Error('network unavailable'), 'transfer'), 'network')
})

test('distinguishes network, expiry and corrupted attachment failures', () => {
  assert.equal(classifyAttachmentError({ code: 'ERR_NETWORK', message: 'Network Error' }), 'network')
  assert.equal(classifyAttachmentError({ response: { status: 410 } }), 'expired')
  assert.equal(classifyAttachmentError({ code: 'attachment_corrupted' }), 'corrupted')
})
