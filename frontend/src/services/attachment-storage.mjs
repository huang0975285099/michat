export const ATTACHMENT_STORAGE_RESERVE_BYTES = 32 * 1024 * 1024
export const ATTACHMENT_STORAGE_OVERHEAD_BYTES = 2 * 1024 * 1024

export function attachmentStorageRequiredBytes(fileSize) {
  const size = Math.max(0, Number(fileSize) || 0)
  // Local AES-GCM adds a small amount per 1 MiB chunk. Keep a fixed working
  // allowance as browsers may briefly hold both the downloaded and encrypted chunk.
  const chunks = Math.max(1, Math.ceil(size / (1024 * 1024)))
  return size + chunks * 32 + ATTACHMENT_STORAGE_OVERHEAD_BYTES
}

export async function estimateLocalStorage(storage = globalThis.navigator?.storage) {
  if (!storage?.estimate) {
    return { supported: false, usage: null, quota: null, available: null }
  }
  const estimate = await storage.estimate()
  const usage = Number.isFinite(estimate?.usage) ? Math.max(0, estimate.usage) : null
  const quota = Number.isFinite(estimate?.quota) ? Math.max(0, estimate.quota) : null
  return {
    supported: usage !== null && quota !== null,
    usage,
    quota,
    available: usage !== null && quota !== null ? Math.max(0, quota - usage) : null,
  }
}

export async function assertLocalAttachmentSpace(fileSize, options = {}) {
  const estimate = await estimateLocalStorage(options.storage)
  if (!estimate.supported) return estimate

  const required = attachmentStorageRequiredBytes(fileSize)
  const reserve = Number.isFinite(options.reserveBytes)
    ? Math.max(0, options.reserveBytes)
    : ATTACHMENT_STORAGE_RESERVE_BYTES
  if (estimate.available < required + reserve) {
    const error = new Error('Insufficient local attachment storage')
    error.code = 'local_attachment_storage_full'
    error.requiredBytes = required
    error.availableBytes = estimate.available
    error.reserveBytes = reserve
    throw error
  }
  return { ...estimate, requiredBytes: required, reserveBytes: reserve }
}

export function binarySize(value) {
  if (!value) return 0
  if (typeof value === 'string') return value.length * 2
  if (typeof value.byteLength === 'number') return value.byteLength
  if (typeof value.size === 'number') return value.size
  return 0
}

export function formatStorageBytes(bytes, locale = 'zh-CN') {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = value / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024
    unit = units[index]
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: amount >= 10 ? 1 : 2 }).format(amount)} ${unit}`
}
