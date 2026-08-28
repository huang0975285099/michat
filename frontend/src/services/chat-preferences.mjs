const BURN_MODE_PREFIX = 'yunmi.chat.burn-mode'

export function burnModeStorageKey(ownerChatId, friendChatId) {
  return `${BURN_MODE_PREFIX}.${ownerChatId}.${friendChatId}`
}

export function loadBurnMode(ownerChatId, friendChatId, storage = globalThis.localStorage) {
  if (!ownerChatId || !friendChatId || !storage) return false
  try {
    return storage.getItem(burnModeStorageKey(ownerChatId, friendChatId)) === '1'
  } catch {
    return false
  }
}

export function saveBurnMode(ownerChatId, friendChatId, enabled, storage = globalThis.localStorage) {
  if (!ownerChatId || !friendChatId || !storage) return
  const key = burnModeStorageKey(ownerChatId, friendChatId)
  try {
    if (enabled) storage.setItem(key, '1')
    else storage.removeItem(key)
  } catch {
    // Keeping the in-memory setting is sufficient when storage is unavailable.
  }
}
