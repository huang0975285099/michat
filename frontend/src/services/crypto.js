/**
 * Encryption service
 * - X25519 key pair generation (replaced with ECDH P-256 as the Web Crypto API does not support X25519 natively,
 * Instead, ECDH with P-256/P-384 is supported. Uses P-256 for compatibility, safety level sufficient MVP)
 * - AES-256-GCM encryption and decryption
 * - IndexedDB private key persistence
 * - Security improvements: Private keys are stored encrypted by default and protected with device keys
 */

const DB_NAME = 'e2eechat'
const DB_VERSION = 2  //Upgrade version to support device key storage
const STORE_NAME = 'identity'
const DEVICE_KEY_STORE = 'device_key'  //Device key storage
const KEY_RECORD_ID = 'keypair'

// ── IndexedDB Auxiliary ───────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
      // Add device key storage
      if (!db.objectStoreNames.contains(DEVICE_KEY_STORE)) {
        db.createObjectStore(DEVICE_KEY_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbGet(key, storeName = STORE_NAME) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const req = tx.objectStore(storeName).get(key)
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbPut(record, storeName = STORE_NAME) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const req = tx.objectStore(storeName).put(record)
    req.onsuccess = () => resolve()
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbDelete(key, storeName = STORE_NAME) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const req = tx.objectStore(storeName).delete(key)
    req.onsuccess = () => resolve()
    req.onerror = (e) => reject(e.target.error)
  })
}

// ──Device key (used to encrypt the private key)────────────────────────────────────

/**
 * Generate or load device keys
 * The CryptoKey object is directly stored in IndexedDB (Structured Clone), and the raw bytes are never dropped.
 * The old format (raw bytes) is automatically migrated the first time it is read.
 */
async function getOrCreateDeviceKey() {
  const record = await dbGet('device_encrypt_key', DEVICE_KEY_STORE)
  if (record) {
    // New format: CryptoKey objects stored directly
    if (record.cryptoKey) return record.cryptoKey
    // Old format: raw bytes → migrate
    if (record.key) {
      const key = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(record.key),
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      )
      await dbPut({ id: 'device_encrypt_key', cryptoKey: key }, DEVICE_KEY_STORE)
      return key
    }
  }

  // Generate new non-extractable keys and store them directly in CryptoKey objects
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  await dbPut({ id: 'device_encrypt_key', cryptoKey: key }, DEVICE_KEY_STORE)
  return key
}

// ──Base64 Tools───────────────────────────────────────────────

export function bufToB64(buf) {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function b64ToBuf(b64) {
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

// ──Key pair management───────────────────────────────────────────────

/**
 * Generate an ECDH P-256 key pair, encrypt the private key and store it in IndexedDB, and return the Base64 of the public key.
 * Security improvements: Private keys are encrypted and stored using device keys to prevent plaintext leakage
 */
export async function generateAndStoreKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, //extractable (for exporting backups)
    ['deriveKey', 'deriveBits']
  )

  // Export public key (SPKI format) and private key (PKCS8 format)
  const [pubKeyBuf, privKeyBuf] = await Promise.all([
    crypto.subtle.exportKey('spki', keyPair.publicKey),
    crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  ])

  const pubKeyB64 = bufToB64(pubKeyBuf)

  // Security improvement: Use device key to encrypt private keys
  const deviceKey = await getOrCreateDeviceKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encryptedPrivKey = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    deviceKey,
    privKeyBuf
  )

  // Stores CryptoKey objects (used for daily operations) and encrypted private key backups
  await dbPut({
    id: KEY_RECORD_ID,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,  //CryptoKey object, IndexedDB can store
    pubKeyB64,
    encryptedPrivateKey: bufToB64(encryptedPrivKey),  //Encrypted private key
    deviceKeyIv: bufToB64(iv),  //Encryption IV
    hasDeviceEncryption: true  //Tags are encrypted using device keys
  })

  return pubKeyB64
}

/**
 * Load key pair from IndexedDB
 * Security improvement: support for private key decryption of device key encryption
 */
export async function loadKeyPair() {
  const record = await dbGet(KEY_RECORD_ID)
  if (!record) return null

  const keys = { id: KEY_RECORD_ID, pubKeyB64: record.pubKeyB64 }

  // Always import public keys (regardless of encryption mode or not)
  if (record.pubKeyB64) {
    const pubKeyBuf = b64ToBuf(record.pubKeyB64)
    keys.publicKey = await crypto.subtle.importKey(
      'spki', pubKeyBuf,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    )
  }

  // If it is security code encryption mode and unlocked, use the cached private key
  if (record.hasSecurityCode && decryptedPrivateKeyCache) {
    keys.privateKey = decryptedPrivateKeyCache
    keys.privKeyB64 = null
    return keys
  }

  // If there is a CryptoKey object in IndexedDB, use it directly (the fastest for daily operations)
  if (record.privateKey) {
    keys.privateKey = record.privateKey
    return keys
  }

  // Need to decrypt private key from encrypted storage
  if (record.hasDeviceEncryption && record.encryptedPrivateKey && record.deviceKeyIv) {
    try {
      const deviceKey = await getOrCreateDeviceKey()
      const encryptedBuf = b64ToBuf(record.encryptedPrivateKey)
      const iv = b64ToBuf(record.deviceKeyIv)

      const privKeyBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        deviceKey,
        encryptedBuf
      )

      keys.privateKey = await crypto.subtle.importKey(
        'pkcs8', privKeyBuf,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
      )

      // Cache CryptoKey objects for quick subsequent access
      await dbPut({
        ...record,
        privateKey: keys.privateKey
      })

      return keys
    } catch (e) {
      console.error('[crypto] decrypt private key failed:', e)
      // Decryption failed, possibly because the device key is lost
      throw new Error('Failed to decrypt private key. Device key may be corrupted.')
    }
  }

  // Compatible with old data: Re-import private keys from Base64 (old version is stored in clear text)
  if (record.privKeyB64) {
    const privKeyBuf = b64ToBuf(record.privKeyB64)
    keys.privateKey = await crypto.subtle.importKey(
      'pkcs8', privKeyBuf,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    )
  }

  return keys
}

/**
 * Delete local key (log out)
 * Also delete the device key
 */
export async function clearKeyPair() {
  await dbDelete(KEY_RECORD_ID)
  await dbDelete('device_encrypt_key', DEVICE_KEY_STORE)
}

/**
 * Export the private key as Base64 text (for user backup)
 * Requires unlocked status in security code mode
 */
export async function exportPrivateKey() {
  // Unlocked encryption mode
  if (decryptedPrivateKeyCache) {
    const buf = await crypto.subtle.exportKey('pkcs8', decryptedPrivateKeyCache)
    return bufToB64(buf)
  }

  const record = await dbGet(KEY_RECORD_ID)
  if (!record) throw new Error('no key pair found')

  if (record.hasSecurityCode) {
    throw new Error('locked, please unlock first')
  }

  // Export from CryptoKey
  if (record.privateKey) {
    const buf = await crypto.subtle.exportKey('pkcs8', record.privateKey)
    return bufToB64(buf)
  }

  // Export after decryption from encrypted storage
  if (record.hasDeviceEncryption && record.encryptedPrivateKey && record.deviceKeyIv) {
    const deviceKey = await getOrCreateDeviceKey()
    const encryptedBuf = b64ToBuf(record.encryptedPrivateKey)
    const iv = b64ToBuf(record.deviceKeyIv)

    const privKeyBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      deviceKey,
      encryptedBuf
    )
    return bufToB64(privKeyBuf)
  }

  // Compatible with old data
  return record.privKeyB64
}

/**
 * Identity recovery from Base64 private key (import into IndexedDB)
 * Security improvement: Private keys are stored encrypted using the device key
 * The public key can be automatically derived from the private key without the need for user provision
 */
export async function importPrivateKey(privKeyB64) {
  const privKeyBuf = b64ToBuf(privKeyB64)

  const privateKey = await crypto.subtle.importKey(
    'pkcs8', privKeyBuf,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )

  // Export public key (derive SPKI format from private key)
  const privKeyJwk = await crypto.subtle.exportKey('jwk', privateKey)
  // ECDH P-256 private key JWK contains crv, d, key_ops, ext, kty, x, y
  // Construct the public key using x, y
  const pubKeyJwk = {
    kty: privKeyJwk.kty,
    crv: privKeyJwk.crv,
    x: privKeyJwk.x,
    y: privKeyJwk.y,
    ext: true,
    key_ops: []
  }

  const publicKey = await crypto.subtle.importKey(
    'jwk', pubKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  )

  const pubKeyB64 = bufToB64(await crypto.subtle.exportKey('spki', publicKey))

  // Security improvement: Use device key to encrypt private key storage
  const deviceKey = await getOrCreateDeviceKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encryptedPrivKey = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    deviceKey,
    privKeyBuf
  )

  await dbPut({
    id: KEY_RECORD_ID,
    publicKey,
    privateKey,  //CryptoKey object
    pubKeyB64,
    encryptedPrivateKey: bufToB64(encryptedPrivKey),
    deviceKeyIv: bufToB64(iv),
    hasDeviceEncryption: true
  })
  return pubKeyB64
}

// ── Challenge signature ──────────────────────────────────────────────────

/**
 * Sign the challenge code with the ECDH P-256 private key (re-import the same private key material in ECDSA mode)
 * @param {string} nonce - the challenge code string returned by the server
 * @returns {string} Base64 signature (IEEE P1363 format, 64 bytes)
 */
export async function signChallenge(nonce) {
  const record = await loadKeyPair()
  if (!record) throw new Error('no private key')
  const privKeyBuf = await crypto.subtle.exportKey('pkcs8', record.privateKey)
  const signingKey = await crypto.subtle.importKey(
    'pkcs8', privKeyBuf,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    new TextEncoder().encode(nonce)
  )
  return bufToB64(sigBuf)
}

// ── Message encryption ─────────────────────────────────────────────────

/**
 * Encrypted message
 * @param {string} plaintext - plain text
 * @param {string} recipientPubKeyB64 - recipient public key (Base64 SPKI)
 * @returns {{ ephemeralPubKey: string, iv: string, ciphertext: string }}
 */
export async function encryptMessage(plaintext, recipientPubKeyB64) {
  // 1. Generate a temporary key pair
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )

  // 2. Import the recipient’s public key
  const recipientPubKey = await crypto.subtle.importKey(
    'spki',
    b64ToBuf(recipientPubKeyB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  // 3. ECDH derived shared key → AES-256-GCM
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: recipientPubKey },
    ephemeralKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )

  // 4. AES-256-GCM encryption
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    encoded
  )

  // 5. Export temporary public key
  const ephPubBuf = await crypto.subtle.exportKey('spki', ephemeralKeyPair.publicKey)

  return {
    ephemeralPubKey: bufToB64(ephPubBuf),
    iv: bufToB64(iv),
    ciphertext: bufToB64(ciphertextBuf)
  }
}

/**
 * Decrypt message
 * @param {{ ephemeralPubKey: string, iv: string, ciphertext: string }} payload
 * @returns {string} plain text
 */
export async function decryptMessage(payload) {
  const record = await loadKeyPair()
  if (!record) throw new Error('no private key')

  // 1. Import the sender’s temporary public key
  const ephPubKey = await crypto.subtle.importKey(
    'spki',
    b64ToBuf(payload.ephemeralPubKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  // 2. ECDH derives shared key
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: ephPubKey },
    record.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )

  // 3. AES-256-GCM decryption
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(payload.iv) },
    sharedKey,
    b64ToBuf(payload.ciphertext)
  )

  return new TextDecoder().decode(plainBuf)
}

// ── Security Code Lock (Phase 3)───────────────────────────────────────

const STORE_LOCK = 'lock_config'

// Memory variables (not persisted)
let decryptedPrivateKeyCache = null  //Unlocked private key

// ── Derive the encryption key ─────────────────────────────────────────────

/**
 * Deriving AES-256-GCM encryption keys from security codes using PBKDF2
 */
async function deriveKeyFromCode(code, salt) {
  const codeKeyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(code),
    'PBKDF2',
    false,
    ['deriveKey']
  )

  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    codeKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// ──Set security code (encrypted private key)──────────────────────────────────────

/**
 * Set a security code to encrypt and store the private key in IndexedDB
 * @param {string} code - 6-digit security code
 */
export async function setupSecurityCode(code) {
  // Check format
  if (!/^\d{6}$/.test(code)) {
    throw new Error('The security code must be 6 pure digits')
  }

  // Load existing private key
  const record = await loadKeyPair()
  if (!record) {
    throw new Error('no key pair found')
  }

  // 1. Generate salt value
  const salt = crypto.getRandomValues(new Uint8Array(16))

  // 2. Derive encryption keys
  const encryptionKey = await deriveKeyFromCode(code, salt)

  // 3. Encrypted private key (PKCS8 format)
  const privKeyBuf = record.privKeyB64 ? b64ToBuf(record.privKeyB64)
    : await crypto.subtle.exportKey('pkcs8', record.privateKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encryptedPrivateKey = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    privKeyBuf
  )

  // 4. Store the encrypted private key + salt value + IV
  await dbPut({
    id: KEY_RECORD_ID,
    encryptedPrivateKey: bufToB64(encryptedPrivateKey),
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    pubKeyB64: record.pubKeyB64,
    hasSecurityCode: true,
    updatedAt: Date.now()
  })

  // 5. Clear memory cache
  decryptedPrivateKeyCache = null

  return true
}

// ──Verify security code (by trying to decrypt)───────────────────────────────────

/**
 * Verify that the security code is correct (by trying to decrypt the private key)
 * @param {string} code - 6-digit security code
 * @returns {boolean} whether successful
 */
export async function verifySecurityCode(code) {
  const record = await dbGet(KEY_RECORD_ID)
  if (!record || !record.hasSecurityCode) {
    return false
  }

  const salt = b64ToBuf(record.salt)
  const encryptionKey = await deriveKeyFromCode(code, salt)

  try {
    // Try to decrypt the private key
    const privateKeyBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(record.iv) },
      encryptionKey,
      b64ToBuf(record.encryptedPrivateKey)
    )

    // Decryption successful, import private key
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBuf,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,  //extractable: true, allows exporting for backup
      ['deriveKey', 'deriveBits']
    )

    // Cache decrypted private key
    decryptedPrivateKeyCache = privateKey

    return true
  } catch (e) {
    return false
  }
}

// ── Obtain the decrypted private key ──────────────────────────────────────────

/**
 * Get the currently cached private key (needs to be unlocked first)
 * @returns {CryptoKey|null}
 */
export function getCachedPrivateKey() {
  return decryptedPrivateKeyCache
}

/**
 * Check if it is unlocked
 */
export function isUnlocked() {
  return decryptedPrivateKeyCache !== null
}

/**
 * Check if security code is set
 */
export async function hasSecurityCode() {
  const record = await dbGet(KEY_RECORD_ID)
  return !!(record && record.hasSecurityCode)
}

// ──Lock/Unlock ──────────────────────────────────────────────

/**
 * Lock now (clear private key cache in memory)
 */
export function lock() {
  decryptedPrivateKeyCache = null
}

/**
 * Unlock (decrypt private key with security code)
 */
export async function unlock(code) {
  const success = await verifySecurityCode(code)
  if (success) {
    // Reset activity timer
    resetActivityTimer()
  }
  return success
}

// ── Turn off security code (restore plain text storage)──────────────────────────────────

/**
 * Turn off the security code function (you need to use the correct security code to unlock first, and then restore plain text storage)
 */
export async function disableSecurityCode(code) {
  // Verify security code first
  const verified = await verifySecurityCode(code)
  if (!verified) {
    throw new Error('Security code error')
  }

  // Get private key from cache
  if (!decryptedPrivateKeyCache) {
    throw new Error('private key not in memory')
  }

  const record = await dbGet(KEY_RECORD_ID)

  // Restore no security code mode: only CryptoKey objects are saved, no raw bytes are saved (to prevent clear text from being written to disk)
  await dbPut({
    id: KEY_RECORD_ID,
    privateKey: decryptedPrivateKeyCache,
    pubKeyB64: record.pubKeyB64,
    hasSecurityCode: false,
    updatedAt: Date.now()
  })

  // clear cache
  decryptedPrivateKeyCache = null

  return true
}

// ── Automatically lock after timeout ──────────────────────────────────────────────

const DEFAULT_TIMEOUT_HOURS = 4  //Default 4 hours
let autoLockTimer = null
let lastActivity = Date.now()

/**
 * Load timeout configuration
 */
export async function loadLockConfig() {
  const config = await dbGet(STORE_LOCK)
  return config ? config.timeoutHours : DEFAULT_TIMEOUT_HOURS
}

/**
 * Save timeout configuration
 */
export async function saveLockConfig(timeoutHours) {
  await dbPut({ id: STORE_LOCK, timeoutHours })
}

/**
 * Reset activity timer
 */
function resetActivityTimer() {
  lastActivity = Date.now()
}

/**
 * Enable automatic lock detection
 */
export function startAutoLock(onLock) {
  // clear old
  if (autoLockTimer) clearInterval(autoLockTimer)

  // Monitor user activity
  const events = ['click', 'keydown', 'touchstart', 'mousemove', 'scroll']
  const handler = () => { lastActivity = Date.now() }
  events.forEach(e => document.addEventListener(e, handler, { passive: true }))

  // Check every minute
  autoLockTimer = setInterval(async () => {
    // Check if the security code has been set
    const hasCode = await hasSecurityCode()
    if (!hasCode) return

    // Check if it is locked
    if (!decryptedPrivateKeyCache) return

    const elapsed = Date.now() - lastActivity
    const timeoutHours = await loadLockConfig()
    const timeoutMs = timeoutHours * 60 * 60 * 1000

    if (elapsed > timeoutMs) {
      lock()
      onLock?.()
    }
  }, 60000)

  // Return cleaning function
  return () => {
    events.forEach(e => document.removeEventListener(e, handler))
    if (autoLockTimer) clearInterval(autoLockTimer)
  }
}

// ──File encryption and decryption (P2P file transfer)───────────────────────────────────

/**
 * Encrypted files (entirely encrypted for P2P transfers)
 * @param {ArrayBuffer} fileBuffer
 * @param {string} recipientPubKeyB64
 * @returns {{ ephemeralPubKey: string, iv: string, ciphertext: ArrayBuffer }}
 */
export async function encryptFile(fileBuffer, recipientPubKeyB64) {
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )

  const recipientPubKey = await crypto.subtle.importKey(
    'spki',
    b64ToBuf(recipientPubKeyB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: recipientPubKey },
    ephemeralKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    fileBuffer
  )

  const ephPubBuf = await crypto.subtle.exportKey('spki', ephemeralKeyPair.publicKey)
  return {
    ephemeralPubKey: bufToB64(ephPubBuf),
    iv: bufToB64(iv),
    ciphertext // ArrayBuffer
  }
}

/**
 * Decrypt files
 * @param {{ ephemeralPubKey: string, iv: string, ciphertext: ArrayBuffer }} payload
 * @returns {ArrayBuffer}
 */
export async function decryptFile(payload) {
  const record = await loadKeyPair()
  if (!record) throw new Error('no private key')

  const ephPubKey = await crypto.subtle.importKey(
    'spki',
    b64ToBuf(payload.ephemeralPubKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: ephPubKey },
    record.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )

  return await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(payload.iv) },
    sharedKey,
    payload.ciphertext
  )
}

// ──Export private key (compatible with security code mode)───────────────────────────────────

/**
 * Export private key (need to be in unlocked state)
 */
export async function exportPrivateKeyWithCode() {
  if (decryptedPrivateKeyCache) {
    const buf = await crypto.subtle.exportKey('pkcs8', decryptedPrivateKeyCache)
    return bufToB64(buf)
  }
  // Fallback to clear text mode
  const record = await loadKeyPair()
  if (!record) throw new Error('no key pair found')
  return record.privKeyB64 || bufToB64(await crypto.subtle.exportKey('pkcs8', record.privateKey))
}
