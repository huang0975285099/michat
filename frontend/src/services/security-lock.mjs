export const MAX_SECURITY_CODE_ATTEMPTS = 5
export const SECURITY_CODE_COOLDOWN_MS = 30 * 60 * 1000

export function registerSecurityCodeFailure(currentCount, now = Date.now()) {
  const normalizedCount = Number.isFinite(currentCount)
    ? Math.max(0, Math.floor(currentCount))
    : 0
  const errorCount = normalizedCount + 1

  return {
    errorCount,
    cooldownEnd: errorCount >= MAX_SECURITY_CODE_ATTEMPTS
      ? now + SECURITY_CODE_COOLDOWN_MS
      : 0,
  }
}

export function securityCodeCooldownSeconds(endTime, now = Date.now()) {
  const remaining = Number(endTime) - now
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

export function applySecurityLockEffects(callStore, chatStore) {
  if (callStore.state !== 'idle') callStore.hangup()
  chatStore.pauseAllOfflineUploads()
  chatStore.pauseAllOfflineDownloads()
}
