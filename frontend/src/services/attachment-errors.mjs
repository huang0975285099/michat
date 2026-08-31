const NO_SPACE_PATTERN = /(?:no space left|disk(?: is)? full|not enough space|insufficient (?:disk|storage)|enospc|磁盘空间不足|存储空间不足)/i

export function isStorageQuotaError(error) {
  return error?.name === 'QuotaExceededError' || error?.code === 22 || NO_SPACE_PATTERN.test(String(error?.message || ''))
}

export function classifyAttachmentError(error, phase = 'transfer') {
  const serverCode = error?.response?.data?.code
  const status = error?.response?.status
  const code = String(error?.code || serverCode || '').toLowerCase()
  const message = String(error?.message || '').toLowerCase()
  if (serverCode === 'attachment_quota_exceeded' || error?.code === 'attachment_quota_exceeded' ||
      error?.response?.data?.error === 'attachment quota exceeded') {
    return 'server_quota'
  }
  if (error?.code === 'local_attachment_storage_full') return 'local_storage'
  if (phase === 'save' && (error?.code === 'destination_storage_full' || isStorageQuotaError(error))) {
    return 'destination_storage'
  }
  if (phase === 'local' && isStorageQuotaError(error)) return 'local_storage'
  if (status === 404 || status === 410 || code === 'attachment_expired') return 'expired'
  if (code === 'attachment_corrupted' || code === 'operationerror' ||
      /(?:integrity|checksum|authentication|decrypt|corrupt|damaged)/i.test(message)) return 'corrupted'
  if (!error?.response && (code === 'err_network' || code === 'network_error' || code === 'econnreset' ||
      code === 'etimedout' || /(?:network|failed to fetch|connection|timeout)/i.test(message))) return 'network'
  return null
}
