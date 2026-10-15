export const PENDING_LIMITS = Object.freeze({
  count: 2000,
  bytes: 64 * 1024 * 1024,
  entryBytes: 512 * 1024,
  ttl: 30 * 24 * 60 * 60 * 1000,
})

export function invalidPendingContent(error) {
  return ['OperationError', 'DataError', 'InvalidCharacterError', 'SyntaxError'].includes(error?.name) ||
    /^(Message is unsigned or has an invalid context|Message sender signature is invalid|Message has an invalid group authentication context)$/.test(error?.message || '')
}

export function pendingEvictions(entries, now, limits = PENDING_LIMITS) {
  const removed = []
  const retained = []
  for (const entry of entries) {
    if (entry.bytes > limits.entryBytes || now - entry.storedAt >= limits.ttl) removed.push(entry.id)
    else retained.push(entry)
  }
  retained.sort((first, second) => first.updatedAt - second.updatedAt)
  let bytes = retained.reduce((total, entry) => total + entry.bytes, 0)
  let remaining = retained.length
  for (const entry of retained) {
    if (remaining <= limits.count && bytes <= limits.bytes) break
    removed.push(entry.id)
    bytes -= entry.bytes
    remaining--
  }
  return removed
}

export function accessPendingStore(db, storeName, payload = null, now = Date.now()) {
  if (payload && new TextEncoder().encode(JSON.stringify(payload)).byteLength > PENDING_LIMITS.entryBytes - 256) {
    return Promise.reject(new Error('Pending message exceeds local storage limit'))
  }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    let result
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = event => reject(event.target.error)
    transaction.onabort = () => reject(transaction.error || new Error('Pending storage transaction aborted'))
    function prune() {
      const entries = []
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          const record = cursor.value
          const storedAt = Number.isFinite(record.pendingStoredAt) ? record.pendingStoredAt : now
          const updatedAt = Number.isFinite(record.pendingUpdatedAt) ? record.pendingUpdatedAt : storedAt
          const normalized = { ...record, pendingStoredAt: storedAt, pendingUpdatedAt: updatedAt }
          const bytes = Number.isSafeInteger(record.pendingBytes) && record.pendingBytes > 0
            ? record.pendingBytes
            : new TextEncoder().encode(JSON.stringify(normalized)).byteLength + 64
          entries.push({ id: cursor.primaryKey, storedAt, updatedAt, bytes })
          if (!Number.isFinite(record.pendingStoredAt) || record.pendingBytes !== bytes) {
            cursor.update({ ...normalized, pendingBytes: bytes })
          }
          cursor.continue()
          return
        }
        for (const id of pendingEvictions(entries, now)) store.delete(id)
        if (!payload) {
          const read = store.getAll()
          read.onsuccess = () => { result = read.result || [] }
        }
      }
    }
    if (payload) {
      const request = store.get(payload.msg_id)
      request.onsuccess = () => {
        const record = {
          ...payload,
          pendingStoredAt: request.result?.pendingStoredAt ?? now,
          pendingUpdatedAt: now,
          pendingBytes: 0,
        }
        record.pendingBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength + 64
        store.put(record)
        prune()
      }
    } else prune()
  })
}
