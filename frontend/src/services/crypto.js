/**
 * 加密服务
 * - X25519 密钥对生成（用 ECDH P-256 代替，因为 Web Crypto API 原生不支持 X25519，
 *   而是支持 ECDH with P-256 / P-384。为兼容性使用 P-256，安全等级足够 MVP）
 * - AES-256-GCM 加解密
 * - IndexedDB 私钥持久化
 * - 安全改进：私钥默认加密存储，使用设备密钥保护
 */

const DB_NAME = 'e2eechat'
const DB_VERSION = 2  // 升级版本以支持设备密钥存储
const STORE_NAME = 'identity'
const DEVICE_KEY_STORE = 'device_key'  // 设备密钥存储
const KEY_RECORD_ID = 'keypair'

// ── IndexedDB 辅助 ──────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
      // 添加设备密钥存储
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

// ── 设备密钥（用于加密私钥）──────────────────────────────────────

/**
 * 生成或加载设备密钥
 * CryptoKey 对象直接存入 IndexedDB（Structured Clone），raw bytes 永不落盘。
 * 旧格式（raw bytes）在首次读取时自动迁移。
 */
async function getOrCreateDeviceKey() {
  const record = await dbGet('device_encrypt_key', DEVICE_KEY_STORE)
  if (record) {
    // 新格式：CryptoKey 对象直接存储
    if (record.cryptoKey) return record.cryptoKey
    // 旧格式：raw bytes → 迁移
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

  // 生成新的 non-extractable 密钥，直接存 CryptoKey 对象
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  await dbPut({ id: 'device_encrypt_key', cryptoKey: key }, DEVICE_KEY_STORE)
  return key
}

// ── Base64 工具 ──────────────────────────────────────────────────

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

// ── 密钥对管理 ──────────────────────────────────────────────────

/**
 * 生成 ECDH P-256 密钥对，私钥加密后存入 IndexedDB，返回公钥的 Base64
 * 安全改进：私钥使用设备密钥加密存储，防止明文泄露
 */
export async function generateAndStoreKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, // extractable（用于导出备份）
    ['deriveKey', 'deriveBits']
  )

  // 导出公钥（SPKI 格式）和私钥（PKCS8 格式）
  const [pubKeyBuf, privKeyBuf] = await Promise.all([
    crypto.subtle.exportKey('spki', keyPair.publicKey),
    crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  ])

  const pubKeyB64 = bufToB64(pubKeyBuf)

  // 安全改进：使用设备密钥加密私钥
  const deviceKey = await getOrCreateDeviceKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encryptedPrivKey = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    deviceKey,
    privKeyBuf
  )

  // 存储 CryptoKey 对象（用于日常操作）和加密的私钥备份
  await dbPut({
    id: KEY_RECORD_ID,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,  // CryptoKey 对象，IndexedDB 可存储
    pubKeyB64,
    encryptedPrivateKey: bufToB64(encryptedPrivKey),  // 加密后的私钥
    deviceKeyIv: bufToB64(iv),  // 加密 IV
    hasDeviceEncryption: true  // 标记使用设备密钥加密
  })

  return pubKeyB64
}

/**
 * 从 IndexedDB 加载密钥对
 * 安全改进：支持设备密钥加密的私钥解密
 */
export async function loadKeyPair() {
  const record = await dbGet(KEY_RECORD_ID)
  if (!record) return null

  const keys = { id: KEY_RECORD_ID, pubKeyB64: record.pubKeyB64 }

  // 总是导入公钥（无论是否加密模式）
  if (record.pubKeyB64) {
    const pubKeyBuf = b64ToBuf(record.pubKeyB64)
    keys.publicKey = await crypto.subtle.importKey(
      'spki', pubKeyBuf,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    )
  }

  // 如果是安全码加密模式且已解锁，使用缓存的私钥
  if (record.hasSecurityCode && decryptedPrivateKeyCache) {
    keys.privateKey = decryptedPrivateKeyCache
    keys.privKeyB64 = null
    return keys
  }

  // 如果 IndexedDB 中有 CryptoKey 对象，直接使用（日常操作最快）
  if (record.privateKey) {
    keys.privateKey = record.privateKey
    return keys
  }

  // 需要从加密存储解密私钥
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

      // 缓存 CryptoKey 对象以便后续快速访问
      await dbPut({
        ...record,
        privateKey: keys.privateKey
      })

      return keys
    } catch (e) {
      console.error('[crypto] decrypt private key failed:', e)
      // 解密失败，可能是设备密钥丢失
      throw new Error('Failed to decrypt private key. Device key may be corrupted.')
    }
  }

  // 兼容旧数据：从 Base64 重新导入私钥（旧版本明文存储）
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
 * 删除本地密钥（注销身份）
 * 同时删除设备密钥
 */
export async function clearKeyPair() {
  await dbDelete(KEY_RECORD_ID)
  await dbDelete('device_encrypt_key', DEVICE_KEY_STORE)
}

/**
 * 导出私钥为 Base64 文本（供用户备份）
 * 在安全码模式下需要已解锁状态
 */
export async function exportPrivateKey() {
  // 已解锁的加密模式
  if (decryptedPrivateKeyCache) {
    const buf = await crypto.subtle.exportKey('pkcs8', decryptedPrivateKeyCache)
    return bufToB64(buf)
  }

  const record = await dbGet(KEY_RECORD_ID)
  if (!record) throw new Error('no key pair found')

  if (record.hasSecurityCode) {
    throw new Error('locked, please unlock first')
  }

  // 从 CryptoKey 导出
  if (record.privateKey) {
    const buf = await crypto.subtle.exportKey('pkcs8', record.privateKey)
    return bufToB64(buf)
  }

  // 从加密存储解密后导出
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

  // 兼容旧数据
  return record.privKeyB64
}

/**
 * 从 Base64 私钥恢复身份（导入到 IndexedDB）
 * 安全改进：私钥使用设备密钥加密存储
 * 公钥可从私钥自动推导，无需用户提供
 */
export async function importPrivateKey(privKeyB64) {
  const privKeyBuf = b64ToBuf(privKeyB64)

  const privateKey = await crypto.subtle.importKey(
    'pkcs8', privKeyBuf,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )

  // 导出公钥（从私钥推导 SPKI 格式）
  const privKeyJwk = await crypto.subtle.exportKey('jwk', privateKey)
  // ECDH P-256 私钥 JWK 包含 crv, d, key_ops, ext, kty, x, y
  // 用 x, y 构建公钥
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

  // 安全改进：使用设备密钥加密私钥存储
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
    privateKey,  // CryptoKey 对象
    pubKeyB64,
    encryptedPrivateKey: bufToB64(encryptedPrivKey),
    deviceKeyIv: bufToB64(iv),
    hasDeviceEncryption: true
  })
  return pubKeyB64
}

// ── 挑战签名 ──────────────────────────────────────────────────────

/**
 * 用 ECDH P-256 私钥对挑战码签名（以 ECDSA 方式重新导入同一私钥材料）
 * @param {string} nonce - 服务端返回的挑战码字符串
 * @returns {string} Base64 签名（IEEE P1363 格式，64字节）
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

// ── 消息加密 ──────────────────────────────────────────────────────

/**
 * 加密消息
 * @param {string} plaintext - 明文
 * @param {string} recipientPubKeyB64 - 接收方公钥（Base64 SPKI）
 * @returns {{ ephemeralPubKey: string, iv: string, ciphertext: string }}
 */
export async function encryptMessage(plaintext, recipientPubKeyB64) {
  // 1. 生成临时密钥对
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )

  // 2. 导入接收方公钥
  const recipientPubKey = await crypto.subtle.importKey(
    'spki',
    b64ToBuf(recipientPubKeyB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  // 3. ECDH 派生共享密钥 → AES-256-GCM
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: recipientPubKey },
    ephemeralKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )

  // 4. AES-256-GCM 加密
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    encoded
  )

  // 5. 导出临时公钥
  const ephPubBuf = await crypto.subtle.exportKey('spki', ephemeralKeyPair.publicKey)

  return {
    ephemeralPubKey: bufToB64(ephPubBuf),
    iv: bufToB64(iv),
    ciphertext: bufToB64(ciphertextBuf)
  }
}

/**
 * 解密消息
 * @param {{ ephemeralPubKey: string, iv: string, ciphertext: string }} payload
 * @returns {string} 明文
 */
export async function decryptMessage(payload) {
  const record = await loadKeyPair()
  if (!record) throw new Error('no private key')

  // 1. 导入发送方临时公钥
  const ephPubKey = await crypto.subtle.importKey(
    'spki',
    b64ToBuf(payload.ephemeralPubKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )

  // 2. ECDH 派生共享密钥
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: ephPubKey },
    record.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )

  // 3. AES-256-GCM 解密
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(payload.iv) },
    sharedKey,
    b64ToBuf(payload.ciphertext)
  )

  return new TextDecoder().decode(plainBuf)
}

// ── 安全码锁定（Phase 3）─────────────────────────────────────────

const STORE_LOCK = 'lock_config'

// 内存变量（不持久化）
let decryptedPrivateKeyCache = null  // 解锁后的私钥

// ── 派生加密密钥 ─────────────────────────────────────────────────

/**
 * 用 PBKDF2 从安全码派生 AES-256-GCM 加密密钥
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

// ── 设置安全码（加密私钥）────────────────────────────────────────

/**
 * 设置安全码，将 IndexedDB 中的私钥加密存储
 * @param {string} code - 6 位数字安全码
 */
export async function setupSecurityCode(code) {
  // 校验格式
  if (!/^\d{6}$/.test(code)) {
    throw new Error('安全码必须为 6 位纯数字')
  }

  // 加载现有私钥
  const record = await loadKeyPair()
  if (!record) {
    throw new Error('no key pair found')
  }

  // 1. 生成盐值
  const salt = crypto.getRandomValues(new Uint8Array(16))

  // 2. 派生加密密钥
  const encryptionKey = await deriveKeyFromCode(code, salt)

  // 3. 加密私钥（PKCS8 格式）
  const privKeyBuf = record.privKeyB64 ? b64ToBuf(record.privKeyB64)
    : await crypto.subtle.exportKey('pkcs8', record.privateKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encryptedPrivateKey = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    privKeyBuf
  )

  // 4. 存储加密后的私钥 + 盐值 + IV
  await dbPut({
    id: KEY_RECORD_ID,
    encryptedPrivateKey: bufToB64(encryptedPrivateKey),
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    pubKeyB64: record.pubKeyB64,
    hasSecurityCode: true,
    updatedAt: Date.now()
  })

  // 5. 清除内存缓存
  decryptedPrivateKeyCache = null

  return true
}

// ── 验证安全码（通过尝试解密）────────────────────────────────────

/**
 * 验证安全码是否正确（通过尝试解密私钥）
 * @param {string} code - 6 位数字安全码
 * @returns {boolean} 是否成功
 */
export async function verifySecurityCode(code) {
  const record = await dbGet(KEY_RECORD_ID)
  if (!record || !record.hasSecurityCode) {
    return false
  }

  const salt = b64ToBuf(record.salt)
  const encryptionKey = await deriveKeyFromCode(code, salt)

  try {
    // 尝试解密私钥
    const privateKeyBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(record.iv) },
      encryptionKey,
      b64ToBuf(record.encryptedPrivateKey)
    )

    // 解密成功，导入私钥
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBuf,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,  // extractable: true，允许导出用于备份
      ['deriveKey', 'deriveBits']
    )

    // 缓存解密后的私钥
    decryptedPrivateKeyCache = privateKey

    return true
  } catch (e) {
    return false
  }
}

// ── 获取解密后的私钥 ─────────────────────────────────────────────

/**
 * 获取当前缓存的私钥（需先解锁）
 * @returns {CryptoKey|null}
 */
export function getCachedPrivateKey() {
  return decryptedPrivateKeyCache
}

/**
 * 检查是否已解锁
 */
export function isUnlocked() {
  return decryptedPrivateKeyCache !== null
}

/**
 * 检查是否设置了安全码
 */
export async function hasSecurityCode() {
  const record = await dbGet(KEY_RECORD_ID)
  return !!(record && record.hasSecurityCode)
}

// ── 锁定 / 解锁 ──────────────────────────────────────────────────

/**
 * 立即锁定（清除内存中的私钥缓存）
 */
export function lock() {
  decryptedPrivateKeyCache = null
}

/**
 * 解锁（用安全码解密私钥）
 */
export async function unlock(code) {
  const success = await verifySecurityCode(code)
  if (success) {
    // 重置活动计时器
    resetActivityTimer()
  }
  return success
}

// ── 关闭安全码（恢复明文存储）────────────────────────────────────

/**
 * 关闭安全码功能（需用正确安全码先解锁，然后恢复明文存储）
 */
export async function disableSecurityCode(code) {
  // 先验证安全码
  const verified = await verifySecurityCode(code)
  if (!verified) {
    throw new Error('安全码错误')
  }

  // 从缓存获取私钥
  if (!decryptedPrivateKeyCache) {
    throw new Error('private key not in memory')
  }

  const record = await dbGet(KEY_RECORD_ID)

  // 恢复无安全码模式：仅存 CryptoKey 对象，不存 raw bytes（防止明文落盘）
  await dbPut({
    id: KEY_RECORD_ID,
    privateKey: decryptedPrivateKeyCache,
    pubKeyB64: record.pubKeyB64,
    hasSecurityCode: false,
    updatedAt: Date.now()
  })

  // 清除缓存
  decryptedPrivateKeyCache = null

  return true
}

// ── 超时自动锁定 ─────────────────────────────────────────────────

const DEFAULT_TIMEOUT_HOURS = 4  // 默认 4 小时
let autoLockTimer = null
let lastActivity = Date.now()

/**
 * 加载超时配置
 */
export async function loadLockConfig() {
  const config = await dbGet(STORE_LOCK)
  return config ? config.timeoutHours : DEFAULT_TIMEOUT_HOURS
}

/**
 * 保存超时配置
 */
export async function saveLockConfig(timeoutHours) {
  await dbPut({ id: STORE_LOCK, timeoutHours })
}

/**
 * 重置活动计时器
 */
function resetActivityTimer() {
  lastActivity = Date.now()
}

/**
 * 启动自动锁定检测
 */
export function startAutoLock(onLock) {
  // 清除旧的
  if (autoLockTimer) clearInterval(autoLockTimer)

  // 监听用户活动
  const events = ['click', 'keydown', 'touchstart', 'mousemove', 'scroll']
  const handler = () => { lastActivity = Date.now() }
  events.forEach(e => document.addEventListener(e, handler, { passive: true }))

  // 每分钟检测一次
  autoLockTimer = setInterval(async () => {
    // 检查是否已设置安全码
    const hasCode = await hasSecurityCode()
    if (!hasCode) return

    // 检查是否已锁定
    if (!decryptedPrivateKeyCache) return

    const elapsed = Date.now() - lastActivity
    const timeoutHours = await loadLockConfig()
    const timeoutMs = timeoutHours * 60 * 60 * 1000

    if (elapsed > timeoutMs) {
      lock()
      onLock?.()
    }
  }, 60000)

  // 返回清理函数
  return () => {
    events.forEach(e => document.removeEventListener(e, handler))
    if (autoLockTimer) clearInterval(autoLockTimer)
  }
}

// ── 文件加解密（P2P 文件传输）────────────────────────────────────

/**
 * 加密文件（整体加密，供 P2P 传输使用）
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
 * 解密文件
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

// ── 导出私钥（兼容安全码模式）────────────────────────────────────

/**
 * 导出私钥（需在解锁状态下）
 */
export async function exportPrivateKeyWithCode() {
  if (decryptedPrivateKeyCache) {
    const buf = await crypto.subtle.exportKey('pkcs8', decryptedPrivateKeyCache)
    return bufToB64(buf)
  }
  // 回退到明文模式
  const record = await loadKeyPair()
  if (!record) throw new Error('no key pair found')
  return record.privKeyB64 || bufToB64(await crypto.subtle.exportKey('pkcs8', record.privateKey))
}
