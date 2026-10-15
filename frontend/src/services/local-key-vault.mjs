const KEY_VERSION = 2

export async function identityLocalDatabaseName(baseName, publicKey) {
  if (!publicKey) throw new Error('Local database identity is missing')
  const bytes = Uint8Array.from(atob(publicKey), character => character.charCodeAt(0))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `${baseName}_${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

export async function openLocalKeyVault(record, wrappingKey) {
  if (record?.version === KEY_VERSION && record.wrappedKey) {
    const rawKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, wrappingKey, record.wrappedKey)
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
    return { record, key }
  }
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrappedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawKey)
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
  let legacyKey = record?.cryptoKey
  if (!legacyKey && record?.key) {
    legacyKey = await crypto.subtle.importKey('raw', new Uint8Array(record.key), 'AES-GCM', false, ['decrypt'])
  }
  return {
    key,
    record: { id: 'encrypt_key', version: KEY_VERSION, iv, wrappedKey, migrating: true, ...(legacyKey ? { cryptoKey: legacyKey } : {}) },
  }
}

export async function migrateLocalRecord(storeName, record, oldKey, newKey) {
  const encrypted = storeName === 'messages' ? record.text : record
  if (!encrypted || encrypted.keyVersion === KEY_VERSION) return record
  if (storeName !== 'messages' && !encrypted.ciphertext) return record
  const isText = storeName === 'messages'
  let plaintext
  if (isText && !encrypted.encrypted) {
    plaintext = new TextEncoder().encode(encrypted)
  } else {
    if (!oldKey) throw new Error('Legacy local encryption key is missing')
    const iv = isText ? Uint8Array.from(atob(encrypted.iv), character => character.charCodeAt(0)) : encrypted.iv
    const ciphertext = isText ? Uint8Array.from(atob(encrypted.ciphertext), character => character.charCodeAt(0)) : encrypted.ciphertext
    const additionalData = storeName === 'message_file_chunks'
      ? new TextEncoder().encode(`yunmi.local-file-chunk|1|${record.msgId}|${record.index}`)
      : undefined
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, ...(additionalData ? { additionalData } : {}) }, oldKey, ciphertext)
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const additionalData = storeName === 'message_file_chunks'
    ? new TextEncoder().encode(`yunmi.local-file-chunk|1|${record.msgId}|${record.index}`)
    : undefined
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, ...(additionalData ? { additionalData } : {}) }, newKey, plaintext)
  if (isText) {
    const toBase64 = bytes => btoa(Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join(''))
    return { ...record, text: { encrypted: true, keyVersion: KEY_VERSION, iv: toBase64(iv), ciphertext: toBase64(ciphertext) } }
  }
  return { ...record, iv, ciphertext, keyVersion: KEY_VERSION }
}
