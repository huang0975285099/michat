import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_SECURITY_CODE_ATTEMPTS,
  SECURITY_CODE_COOLDOWN_MS,
  applySecurityLockEffects,
  registerSecurityCodeFailure,
  securityCodeCooldownSeconds,
} from './security-lock.mjs'

test('starts a 30-minute cooldown on the fifth failed security-code attempt', () => {
  const now = 1_000_000
  const result = registerSecurityCodeFailure(MAX_SECURITY_CODE_ATTEMPTS - 1, now)

  assert.equal(result.errorCount, MAX_SECURITY_CODE_ATTEMPTS)
  assert.equal(result.cooldownEnd, now + SECURITY_CODE_COOLDOWN_MS)
})

test('does not start cooldown before the fifth failure', () => {
  assert.deepEqual(registerSecurityCodeFailure(2, 1000), {
    errorCount: 3,
    cooldownEnd: 0,
  })
})

test('reports zero seconds once a security-code cooldown has expired', () => {
  assert.equal(securityCodeCooldownSeconds(10_000, 9_001), 1)
  assert.equal(securityCodeCooldownSeconds(10_000, 10_000), 0)
  assert.equal(securityCodeCooldownSeconds(10_000, 11_000), 0)
})

test('locking hangs up an active call and pauses attachment transfers', () => {
  const calls = []
  const callStore = { state: 'active', hangup: () => calls.push('hangup') }
  const chatStore = {
    pauseAllOfflineUploads: () => calls.push('pause-uploads'),
    pauseAllOfflineDownloads: () => calls.push('pause-downloads'),
  }

  applySecurityLockEffects(callStore, chatStore)

  assert.deepEqual(calls, ['hangup', 'pause-uploads', 'pause-downloads'])
})

test('locking does not send a hangup when no call exists', () => {
  let hangups = 0
  const callStore = { state: 'idle', hangup: () => { hangups++ } }
  const chatStore = {
    pauseAllOfflineUploads: () => {},
    pauseAllOfflineDownloads: () => {},
  }

  applySecurityLockEffects(callStore, chatStore)

  assert.equal(hangups, 0)
})
