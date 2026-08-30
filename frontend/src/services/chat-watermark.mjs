function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Use a fixed UTC display so changing the device timezone cannot alter the
 * timestamp embedded in a screenshot. `timestamp` must come from the server
 * calibrated monotonic clock; null means calibration is still in progress.
 */
export function formatWatermarkTime(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-- UTC'

  const date = new Date(timestamp)
  return [
    date.getUTCFullYear(),
    '-',
    pad2(date.getUTCMonth() + 1),
    '-',
    pad2(date.getUTCDate()),
    ' ',
    pad2(date.getUTCHours()),
    ':',
    pad2(date.getUTCMinutes()),
    ' UTC',
  ].join('')
}

export function createChatWatermark(chatId, timestamp) {
  const viewerId = typeof chatId === 'string' && chatId.trim() ? chatId.trim() : 'UNKNOWN'
  return `Yunmi · ${viewerId} · ${formatWatermarkTime(timestamp)}`
}
