import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachmentAutoCleanStorageKey,
  acceptBurnWarning,
  burnModeStorageKey,
  burnWarningStorageKey,
  hasAcceptedBurnWarning,
  loadAttachmentAutoClean,
  loadBurnMode,
  saveAttachmentAutoClean,
  saveBurnMode,
} from './chat-preferences.mjs'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  }
}

test('remembers burn mode separately for each account and friend', () => {
  const storage = memoryStorage()
  saveBurnMode('1000-AAAA', '2000-BBBB', true, storage)

  assert.equal(loadBurnMode('1000-AAAA', '2000-BBBB', storage), true)
  assert.equal(loadBurnMode('1000-AAAA', '3000-CCCC', storage), false)
  assert.equal(loadBurnMode('9999-ZZZZ', '2000-BBBB', storage), false)
})

test('removes the saved preference when burn mode is disabled', () => {
  const storage = memoryStorage()
  saveBurnMode('1000-AAAA', '2000-BBBB', true, storage)
  saveBurnMode('1000-AAAA', '2000-BBBB', false, storage)

  assert.equal(loadBurnMode('1000-AAAA', '2000-BBBB', storage), false)
  assert.match(burnModeStorageKey('1000-AAAA', '2000-BBBB'), /1000-AAAA\.2000-BBBB$/)
})

test('remembers automatic sender attachment cleanup per account and defaults off', () => {
  const storage = memoryStorage()
  assert.equal(loadAttachmentAutoClean('1000-AAAA', storage), false)
  saveAttachmentAutoClean('1000-AAAA', true, storage)
  assert.equal(loadAttachmentAutoClean('1000-AAAA', storage), true)
  assert.equal(loadAttachmentAutoClean('2000-BBBB', storage), false)
  saveAttachmentAutoClean('1000-AAAA', false, storage)
  assert.equal(loadAttachmentAutoClean('1000-AAAA', storage), false)
  assert.match(attachmentAutoCleanStorageKey('1000-AAAA'), /1000-AAAA$/)
})

test('records the burn-after-reading warning acknowledgement per account', () => {
  const storage = memoryStorage()
  assert.equal(hasAcceptedBurnWarning('1000-AAAA', storage), false)
  acceptBurnWarning('1000-AAAA', storage)
  assert.equal(hasAcceptedBurnWarning('1000-AAAA', storage), true)
  assert.equal(hasAcceptedBurnWarning('2000-BBBB', storage), false)
  assert.match(burnWarningStorageKey('1000-AAAA'), /1000-AAAA$/)
})
