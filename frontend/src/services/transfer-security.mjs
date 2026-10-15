export function transferLockedError() {
  const error = new Error('Attachment operation was stopped by the security lock')
  error.code = 'security_locked'
  return error
}

export function assertTransferActive(operation, generation, currentGeneration, locked) {
  if (operation?.securityLocked || generation !== currentGeneration || locked) throw transferLockedError()
}

export function eraseAttachmentSecrets(metadata) {
  if (!metadata || typeof metadata !== 'object') return
  for (const field of ['fileKey', 'noncePrefix', 'filename', 'filetype', 'contentKey', 'privateKey']) {
    if (field in metadata) metadata[field] = null
  }
}

export function pendingCiphertext(payload) {
  const record = {}
  for (const field of ['msg_id', 'from', 'ephemeral_pub_key', 'iv', 'ciphertext', 'reply_ephemeral_pub_key', 'reply_iv', 'reply_ciphertext', 'ts', 'burn_after_read', 'group_id', 'key_envelope', 'group', 'attachment_paused', 'attachment_failed', 'attachment_failure_code']) {
    if (payload?.[field] !== undefined) record[field] = payload[field]
  }
  return record
}

export function stopSensitiveTransfers({ uploads, downloads, queued, transfers, persistPending, markUploadPending, revokeUrl = URL.revokeObjectURL }) {
  const pending = []
  for (const operation of [...uploads.values(), ...downloads.values()]) {
    operation.securityLocked = true
    operation.paused = false
    operation.pauseRequested = false
    operation.controller?.abort()
    const resume = operation.resume
    operation.resume = null
    resume?.()
    eraseAttachmentSecrets(operation.metadata)
    if (operation.promise) pending.push(operation.promise)
  }
  for (const entry of queued.values()) {
    eraseAttachmentSecrets(entry.metadata)
    entry.metadata = null
    pending.push(Promise.resolve().then(() => persistPending(pendingCiphertext(entry.payload))))
    if (entry.task) pending.push(entry.task)
  }
  for (const transfer of Object.values(transfers)) {
    if (transfer.timer) clearTimeout(transfer.timer)
    if (transfer.objectUrl) revokeUrl(transfer.objectUrl)
    transfer.objectUrl = null
    eraseAttachmentSecrets(transfer)
    eraseAttachmentSecrets(transfer.metadata)
    transfer.metadata = null
    transfer.chunks = []
    if (transfer.transport === 'offline' && transfer.direction === 'send') {
      const manuallyPaused = uploads.get(transfer.id)?.pauseReason === 'user' || transfer.status === 'paused'
      pending.push(Promise.resolve().then(() => markUploadPending(transfer.msgId, manuallyPaused ? 'paused' : 'pending')))
    } else if (transfer.payload) {
      const record = pendingCiphertext(transfer.payload)
      if (downloads.get(transfer.id)?.pauseReason === 'user' || transfer.status === 'paused') record.attachment_paused = true
      if (transfer.status === 'error') {
        record.attachment_failed = true
        record.attachment_failure_code = transfer.errorCode
      }
      pending.push(Promise.resolve().then(() => persistPending(record)))
    }
  }
  return Promise.allSettled(pending)
}
