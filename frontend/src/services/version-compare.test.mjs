import test from 'node:test'
import assert from 'node:assert/strict'

import { cmpVersion, getUpdateStatus } from './version-compare.mjs'

test('compares numeric versions without lexicographic errors', () => {
  assert.equal(cmpVersion('1.0.10', '1.0.9'), 1)
  assert.equal(cmpVersion('1.2', '1.2.0'), 0)
  assert.equal(cmpVersion('v1.2.3', '1.2.3'), 0)
})

test('follows SemVer prerelease precedence', () => {
  assert.equal(cmpVersion('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(cmpVersion('1.0.0-beta.2', '1.0.0-beta.10'), -1)
  assert.equal(cmpVersion('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(cmpVersion('1.0.0+build.1', '1.0.0+build.2'), 0)
})

test('rejects malformed or unsupported versions', () => {
  for (const version of ['', '1.2.x', '1.2.3.4', 'release-1.2.3']) {
    assert.throws(() => cmpVersion(version, '1.0.0'), TypeError)
  }
})

test('prioritizes required updates and detects optional releases', () => {
  assert.equal(getUpdateStatus('0.9.9', '1.1.0', '1.0.0'), 'required')
  assert.equal(getUpdateStatus('1.0.7', '1.1.0', '1.0.0'), 'available')
  assert.equal(getUpdateStatus('1.1.0', '1.1.0', '1.0.0'), 'current')
})
