import assert from 'node:assert/strict'
import test from 'node:test'

import { selectUpdateUrl, validateUpdateUrl } from './native-update.mjs'

const versionInfo = {
  url: 'https://m.yzs88.com:8088',
  windows: 'https://m.yzs88.com:8088/download/yunChat.exe',
  apk: 'https://m.yzs88.com:8088/download/yunChat.apk'
}

test('selects a platform-specific installer while preserving the legacy fallback', () => {
  assert.equal(selectUpdateUrl(versionInfo, 'windows'), versionInfo.windows)
  assert.equal(selectUpdateUrl(versionInfo, 'apk'), versionInfo.apk)
  assert.equal(selectUpdateUrl(versionInfo, 'web'), versionInfo.url)
  assert.equal(selectUpdateUrl({ url: versionInfo.url }, 'windows'), versionInfo.url)
})

test('accepts only HTTPS update addresses', () => {
  assert.equal(validateUpdateUrl(versionInfo.windows), versionInfo.windows)
  assert.throws(() => validateUpdateUrl('http://example.com/yunChat.exe'), /HTTPS/)
  assert.throws(() => validateUpdateUrl('javascript:alert(1)'), /HTTPS/)
  assert.throws(() => validateUpdateUrl(''), TypeError)
})
