import assert from 'node:assert/strict'
import test from 'node:test'

import { burnModeStorageKey, loadBurnMode, saveBurnMode } from './chat-preferences.mjs'

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
