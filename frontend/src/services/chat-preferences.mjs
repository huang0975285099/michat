const BURN_MODE_PREFIX = 'yunmi.chat.burn-mode'
const ATTACHMENT_AUTO_CLEAN_PREFIX = 'yunmi.attachment.auto-clean-received'
const BURN_WARNING_PREFIX = 'yunmi.chat.burn-warning-v1'

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

export function attachmentAutoCleanStorageKey(ownerChatId) {
  return `${ATTACHMENT_AUTO_CLEAN_PREFIX}.${ownerChatId}`
}

export function loadAttachmentAutoClean(ownerChatId, storage = globalThis.localStorage) {
  if (!ownerChatId || !storage) return false
  try {
    return storage.getItem(attachmentAutoCleanStorageKey(ownerChatId)) === '1'
  } catch {
    return false
  }
}

export function saveAttachmentAutoClean(ownerChatId, enabled, storage = globalThis.localStorage) {
  if (!ownerChatId || !storage) return
  const key = attachmentAutoCleanStorageKey(ownerChatId)
  try {
    if (enabled) storage.setItem(key, '1')
    else storage.removeItem(key)
  } catch {
    // Keep the in-memory setting when browser storage is unavailable.
  }
}

export function burnWarningStorageKey(ownerChatId) {
  return `${BURN_WARNING_PREFIX}.${ownerChatId}`
}

export function hasAcceptedBurnWarning(ownerChatId, storage = globalThis.localStorage) {
  if (!ownerChatId || !storage) return false
  try {
    return storage.getItem(burnWarningStorageKey(ownerChatId)) === '1'
  } catch {
    return false
  }
}

export function acceptBurnWarning(ownerChatId, storage = globalThis.localStorage) {
  if (!ownerChatId || !storage) return
  try {
    storage.setItem(burnWarningStorageKey(ownerChatId), '1')
  } catch {
    // The warning will be shown again if acknowledgement cannot be persisted.
  }
}
