import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { encryptMessage, decryptMessage, encryptFile, decryptFile, bufToB64, b64ToBuf } from 'src/services/crypto'
import { send, on, off, confirmPendingReads, getServerNow } from 'src/services/websocket'
import { notifyNewMessage } from 'src/services/notify'
import { useIdentityStore } from 'src/stores/identity'

// ── 安全常量 ──────────────────────────────────────────────

const DB_NAME = 'e2eechat_messages'
const DB_VERSION = 5  // v5: 新增 message_files 持久化加密文件体（刷新后仍可下载/预览）
const STORE_NAME = 'messages'
const KEY_STORE_NAME = 'message_key'  // 存储消息加密密钥
const PENDING_STORE_NAME = 'pending_messages'  // 锁定期间收到、待解锁后解密的原始密文
const FILE_STORE_NAME = 'message_files'  // 加密后的文件二进制（与消息记录分离，懒加载）
const BURN_AFTER_READ_DELAY = 2 * 60 * 60 * 1000  // 2小时

// ── 文件传输常量 ──────────────────────────────────────────

const CHUNK_SIZE = 128 * 1024  // 128KB 二进制分块
const MAX_FILE_SIZE = 10 * 1024 * 1024  // 10MB
const MAX_FILENAME_BYTES = 255
const AES_GCM_TAG_SIZE = 16
// 文件扩展名必须在白名单中；浏览器提供明确 MIME 时，还必须与扩展名匹配。
// 空 MIME 和 application/octet-stream 仅作为浏览器无法识别类型时的兼容值，
// 不能再单独作为放行任意文件扩展名的依据。
const ALLOWED_FILE_TYPES = new Map([
  ['jpg', new Set(['image/jpeg', 'image/jpg'])],
  ['jpeg', new Set(['image/jpeg', 'image/jpg'])],
  ['png', new Set(['image/png'])],
  ['gif', new Set(['image/gif'])],
  ['webp', new Set(['image/webp'])],
  ['bmp', new Set(['image/bmp'])],
  ['svg', new Set(['image/svg+xml'])],
  ['mp4', new Set(['video/mp4'])],
  ['webm', new Set(['video/webm'])],
  ['mov', new Set(['video/quicktime'])],
  ['doc', new Set(['application/msword'])],
  ['docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'])],
  ['xls', new Set(['application/vnd.ms-excel'])],
  ['xlsx', new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'])],
  ['ppt', new Set(['application/vnd.ms-powerpoint'])],
  ['pptx', new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'])],
  ['pdf', new Set(['application/pdf'])],
  ['zip', new Set(['application/zip', 'application/x-zip-compressed', 'application/x-zip'])],
  ['rar', new Set([
    'application/x-rar-compressed',
    'application/vnd.rar',
    'application/x-rar',
    'application/x-compressed'
  ])],
  ['7z', new Set(['application/x-7z-compressed'])],
  ['tar', new Set(['application/x-tar'])],
  ['gz', new Set(['application/gzip', 'application/x-gzip'])],
  ['apk', new Set(['application/vnd.android.package-archive', 'application/zip'])]
])

const GENERIC_BINARY_MIME_TYPES = new Set(['', 'application/octet-stream'])

function expectedFileChunks(filesize) {
  return Math.ceil((filesize + AES_GCM_TAG_SIZE) / CHUNK_SIZE)
}

function expectedFileChunkSize(filesize, chunkIndex) {
  return Math.min(CHUNK_SIZE, filesize + AES_GCM_TAG_SIZE - chunkIndex * CHUNK_SIZE)
}

function validateFileMetadata(filename, filetype, filesize) {
  if (typeof filename !== 'string' || !filename || new TextEncoder().encode(filename).length > MAX_FILENAME_BYTES) {
    throw new Error('文件名无效或过长')
  }
  if (!Number.isInteger(filesize) || filesize <= 0) throw new Error('不能发送空文件')
  if (filesize > MAX_FILE_SIZE) throw new Error('文件超过 10MB 限制')

  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const allowedMimeTypes = ALLOWED_FILE_TYPES.get(ext)
  if (!allowedMimeTypes) throw new Error('不支持的文件格式')

  const mimeType = (filetype || '').split(';', 1)[0].trim().toLowerCase()
  if (!GENERIC_BINARY_MIME_TYPES.has(mimeType) && !allowedMimeTypes.has(mimeType)) {
    throw new Error('文件扩展名与文件类型不匹配')
  }
}

// ── 消息加密密钥管理 ──────────────────────────────────────────────

/**
 * 生成或加载消息加密密钥
 * CryptoKey 对象直接存入 IndexedDB（Structured Clone），raw bytes 永不落盘。
 * 旧格式（raw bytes）在首次读取时自动迁移。
 */
async function getOrCreateMessageEncryptKey() {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE_NAME, 'readonly')
    const store = tx.objectStore(KEY_STORE_NAME)
    const req = store.get('encrypt_key')
    req.onsuccess = async (e) => {
      const record = e.target.result
      if (record) {
        // 新格式：CryptoKey 对象直接存储
        if (record.cryptoKey) {
          resolve(record.cryptoKey)
          return
        }
        // 旧格式：raw bytes → 迁移为 CryptoKey 存储
        if (record.key) {
          try {
            const key = await crypto.subtle.importKey(
              'raw', new Uint8Array(record.key),
              { name: 'AES-GCM', length: 256 },
              false, ['encrypt', 'decrypt']
            )
            const tx2 = db.transaction(KEY_STORE_NAME, 'readwrite')
            tx2.objectStore(KEY_STORE_NAME).put({ id: 'encrypt_key', cryptoKey: key })
            tx2.oncomplete = () => resolve(key)
            tx2.onerror = () => resolve(key)  // 迁移失败仍可用
            return
          } catch (err) {
            reject(err)
            return
          }
        }
      }
      // 生成新的 non-extractable 密钥，直接存 CryptoKey 对象
      try {
        const key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        )
        const tx2 = db.transaction(KEY_STORE_NAME, 'readwrite')
        tx2.objectStore(KEY_STORE_NAME).put({ id: 'encrypt_key', cryptoKey: key })
        tx2.oncomplete = () => resolve(key)
        tx2.onerror = (e) => reject(e.target.error)
      } catch (err) {
        reject(err)
      }
    }
    req.onerror = (e) => reject(e.target.error)
  })
}

/**
 * 加密消息文本（用于 IndexedDB 存储）
 */
async function encryptMessageText(plaintext, key) {
  if (!key) return plaintext  // 无密钥时不加密（降级处理）
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  )
  return {
    encrypted: true,
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
  }
}

/**
 * 解密消息文本（从 IndexedDB 加载时）
 */
async function decryptMessageText(encryptedData, key) {
  if (!encryptedData.encrypted) return encryptedData  // 未加密的数据
  if (!key) throw new Error('No decryption key available')
  const iv = Uint8Array.from(atob(encryptedData.iv), c => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(encryptedData.ciphertext), c => c.charCodeAt(0))
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  )
  return new TextDecoder().decode(decrypted)
}

/**
 * 加密文件二进制（用于 IndexedDB 持久化）。
 * iv 与 ciphertext 都以 ArrayBuffer/TypedArray 形式存储（结构化克隆，避免 base64 膨胀）。
 */
async function encryptFileBytes(arrayBuffer, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer)
  return { iv, ciphertext }
}

/**
 * 解密文件二进制（从 IndexedDB 加载时），返回明文 ArrayBuffer。
 */
async function decryptFileBytes(record, key) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.ciphertext)
}

// ── IndexedDB 辅助 ──────────────────────────────────────────────

function openMessagesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      // 检查 object store 是否已存在
      let store
      if (db.objectStoreNames.contains(STORE_NAME)) {
        // 已存在，获取现有的 store
        store = e.target.transaction.objectStore(STORE_NAME)
      } else {
        // 不存在，创建新 store
        store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
      // 添加索引（如果不存在）
      if (!store.indexNames.contains('burnAt')) {
        store.createIndex('burnAt', 'burnAt', { unique: false })
      }
      // 添加消息加密密钥存储
      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
        db.createObjectStore(KEY_STORE_NAME, { keyPath: 'id' })
      }
      // 暂存锁定期间无法解密的原始密文（解锁后补解密）
      if (!db.objectStoreNames.contains(PENDING_STORE_NAME)) {
        db.createObjectStore(PENDING_STORE_NAME, { keyPath: 'msg_id' })
      }
      // 加密文件体：key = 消息 ID，附带 chatId 便于按会话清理
      if (!db.objectStoreNames.contains(FILE_STORE_NAME)) {
        const fileStore = db.createObjectStore(FILE_STORE_NAME, { keyPath: 'id' })
        fileStore.createIndex('chatId', 'chatId', { unique: false })
      }
    }
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbGetAllMessages() {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.getAll()
    req.onsuccess = (e) => resolve(e.target.result || [])
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbGetExpiredBurnMessages(now) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const index = tx.objectStore(STORE_NAME).index('burnAt')
    const req = index.getAll(IDBKeyRange.upperBound(now))
    req.onsuccess = (e) => resolve((e.target.result || []).filter(m => Number.isFinite(m.burnAt) && m.burnAt <= now))
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbAddMessage(msg) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const req = tx.objectStore(STORE_NAME).add(msg)
    req.onsuccess = () => resolve()
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbPutMessage(msg) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const req = tx.objectStore(STORE_NAME).put(msg)
    req.onsuccess = () => resolve()
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbDeleteMessage(msgId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(msgId)
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

// ── 文件体持久化 ──────────────────────────────────────────────

async function dbPutFile(record) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE_NAME, 'readwrite')
    tx.objectStore(FILE_STORE_NAME).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

async function dbGetFile(msgId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE_NAME, 'readonly')
    const req = tx.objectStore(FILE_STORE_NAME).get(msgId)
    req.onsuccess = (e) => resolve(e.target.result || null)
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbDeleteFile(msgId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE_NAME, 'readwrite')
    tx.objectStore(FILE_STORE_NAME).delete(msgId)
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

// 按会话清除文件体（配合 clearChatMessages）
async function dbClearChatFiles(chatId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE_NAME, 'readwrite')
    const index = tx.objectStore(FILE_STORE_NAME).index('chatId')
    const req = index.openCursor(IDBKeyRange.only(chatId))
    req.onsuccess = (e) => {
      const cursor = e.target.result
      if (cursor) { cursor.delete(); cursor.continue() }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

async function dbMarkMessageRead(msgId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(msgId)
    req.onsuccess = (e) => {
      const record = e.target.result
      if (record) { record.read = true; store.put(record) }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

// 标记某条消息的已读回执「已确认发出」，持久化以便刷新后不丢失
async function dbMarkReceiptSent(msgId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(msgId)
    req.onsuccess = (e) => {
      const record = e.target.result
      if (record) { record.receiptSent = true; store.put(record) }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

// 接收端首次读到阅后即焚消息时，启动销毁倒计时并持久化（保留记录的其他字段）
// 对非阅后即焚消息仅置 read=true；对已启动倒计时的消息为幂等操作，
// 因此可安全地对任意 msg_id 调用，无需调用方预先判断 burnAfterRead。
async function dbStartBurnCountdown(msgId, readReceivedAt, burnAt) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(msgId)
    let found = false
    req.onsuccess = (e) => {
      const record = e.target.result
      if (record) {
        found = true
        record.read = true
        // 仅对阅后即焚消息且尚未启动倒计时时设置销毁时间，
        // 避免重放回执（syncReadStatus 每次返回同一批 ID）导致倒计时反复重置
        if (record.burnAfterRead && !record.readReceivedAt) {
          record.readReceivedAt = readReceivedAt
          record.burnAt = burnAt
        }
        store.put(record)
      }
    }
    tx.oncomplete = () => resolve(found)
    tx.onerror = (e) => reject(e.target.error)
  })
}

// 阅读方收到服务器 read_ack 后，用数据库中的首次阅读时间校正本地预启动的倒计时。
async function dbCorrectBurnCountdown(msgId, readReceivedAt, burnAt) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(msgId)
    req.onsuccess = (e) => {
      const record = e.target.result
      if (record?.burnAfterRead) {
        record.read = true
        record.readReceivedAt = readReceivedAt
        record.burnAt = burnAt
        store.put(record)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

async function dbUpdateMessageDelivery(msgId, status, ts) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(msgId)
    req.onsuccess = (e) => {
      const record = e.target.result
      if (record) {
        record.status = status
        if (typeof ts === 'number') record.ts = ts
        store.put(record)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

export function clearAllMessagesDB() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

// ── 待解密密文暂存（锁定期间） ──────────────────────────────────

async function dbAddPending(payload) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE_NAME, 'readwrite')
    // put 而非 add：同一 msg_id 重复到达时覆盖，避免 ConstraintError
    tx.objectStore(PENDING_STORE_NAME).put(payload)
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

async function dbGetAllPending() {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE_NAME, 'readonly')
    const req = tx.objectStore(PENDING_STORE_NAME).getAll()
    req.onsuccess = (e) => resolve(e.target.result || [])
    req.onerror = (e) => reject(e.target.error)
  })
}

async function dbDeletePending(msgId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE_NAME, 'readwrite')
    tx.objectStore(PENDING_STORE_NAME).delete(msgId)
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

async function dbClearMessages(chatId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.openCursor()
    req.onsuccess = (e) => {
      const cursor = e.target.result
      if (cursor) {
        if (cursor.value.chatId === chatId || cursor.value.from === chatId) {
          cursor.delete()
        }
        cursor.continue()
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

// ── Store 定义 ──────────────────────────────────────────────────

let msgCounter = 0

/**
 * 生成全局唯一消息 ID
 * 格式: timestamp-base36 + counter + random
 */
function genMsgId() {
  msgCounter++
  return Date.now().toString(36) + '-' + msgCounter.toString(36) + '-' + crypto.randomUUID().slice(0, 6)
}

export const useChatStore = defineStore('chat', () => {
  // messages: { [chatId]: [ { id, chatId, from, text, ts, mine, read } ] }
  const messages = ref({})

  // fileTransfers: { [transferId]: { direction, status, progress, filename, ... } }
  const fileTransfers = ref({})

  // 等待服务器 ACK 的文字消息。ACK 超时只改变本地展示状态，不自动重发，避免重复消息。
  const ackTimers = new Map()
  const MESSAGE_ACK_TIMEOUT_MS = 15000
  // 消息入库是异步的；对方可能在极短窗口内已经打开会话并发回已读通知。
  // 暂存这类早到回执，待本地消息入库时立即应用。
  const earlyReadReceipts = new Map()
  const EARLY_READ_RECEIPT_MAX = 500

  // 消息加密密钥（用于加密 IndexedDB 存储）
  let messageEncryptKey = null
  // 单例化首次密钥初始化：并发调用共享同一个 Promise，避免各自生成不同的密钥。
  // 否则冷启动时多条离线消息并发进入 addMessage，会各自走「无密钥→生成新密钥」分支
  // 产生分叉，最后一把落盘，先前用其它密钥加密的消息重载时解密失败（[解密失败]）。
  let messageKeyPromise = null

  async function ensureMessageKey() {
    if (messageEncryptKey) return messageEncryptKey
    if (!messageKeyPromise) {
      messageKeyPromise = getOrCreateMessageEncryptKey()
        .then((k) => { messageEncryptKey = k; return k })
        .catch((e) => { messageKeyPromise = null; throw e })  // 失败可重试
    }
    return messageKeyPromise
  }

  function ensureThread(chatId) {
    if (!messages.value[chatId]) messages.value[chatId] = []
  }

  /**
   * 检查消息 ID 是否已存在（防止重放攻击）
   */
  function isMsgIdExists(msgId) {
    for (const chatId in messages.value) {
      if (messages.value[chatId].some(m => m.id === msgId)) {
        return true
      }
    }
    return false
  }

  function applyEarlyReadReceipt(msg) {
    if (!msg.mine) return null
    const receipt = earlyReadReceipts.get(msg.id)
    if (!receipt) return null
    msg.read = true
    msg.status = 'sent'
    if (msg.burnAfterRead && !msg.readReceivedAt) {
      msg.readReceivedAt = receipt.read_at
      msg.burnAt = receipt.read_at + BURN_AFTER_READ_DELAY
    }
    earlyReadReceipts.delete(msg.id)
    return receipt
  }

  function rememberEarlyReadReceipt(receipt) {
    if (earlyReadReceipts.size >= EARLY_READ_RECEIPT_MAX && !earlyReadReceipts.has(receipt.msg_id)) {
      earlyReadReceipts.delete(earlyReadReceipts.keys().next().value)
    }
    earlyReadReceipts.set(receipt.msg_id, receipt)
  }

  function confirmReadReceiptsApplied(readerChatId, msgIds) {
    if (!validateChatId(readerChatId) || !Array.isArray(msgIds)) return
    const uniqueIds = [...new Set(msgIds.filter(validateMsgId))]
    for (let i = 0; i < uniqueIds.length; i += 100) {
      send('read_receipt_applied', { to: readerChatId, msg_id: uniqueIds.slice(i, i + 100) })
    }
  }

  /**
   * 添加消息到内存并加密持久化到 IndexedDB
   */
  async function addMessage(chatId, msg) {
    // 安全检查：防止重放攻击
    if (isMsgIdExists(msg.id)) {
      console.warn('[chat] duplicate message id, ignoring:', msg.id)
      return false
    }

    const earlyReceipt = applyEarlyReadReceipt(msg)
    ensureThread(chatId)
    messages.value[chatId].push(msg)

    // 加密存储到 IndexedDB
    try {
      await ensureMessageKey()
      const encryptedText = await encryptMessageText(msg.text, messageEncryptKey)
      await dbAddMessage({
        id: msg.id,
        chatId: chatId,
        from: msg.from,
        type: msg.type || 'text',
        text: encryptedText,
        ts: msg.ts,
        mine: msg.mine,
        read: msg.read || false,
        receiptSent: msg.receiptSent || false,
        burnAfterRead: msg.burnAfterRead || false,
        readReceivedAt: msg.readReceivedAt || null,
        burnAt: msg.burnAt || null,
        status: msg.status || (msg.mine ? 'sent' : undefined)
      })
      if (earlyReceipt) confirmReadReceiptsApplied(chatId, [earlyReceipt.msg_id])
    } catch (e) {
      // DB 写入失败：保留内存中的消息（用户仍可见），仅刷新后丢失。
      // 回滚内存会导致「消息已发出但发送方看不到」的不一致——
      // 对方已收到消息，而发送方本地既无内存记录也无 DB 记录。
      console.error('[chat] persist message failed, kept in memory:', e)
      return false
    }
    return true
  }

  /**
   * 从 IndexedDB 加载指定 chatId 的消息并解密
   */
  async function loadMessages(chatId) {
    try {
      // 初始化加密密钥
      await ensureMessageKey()

      // 保留内存中已有的 blob URL（切换聊天时 store 单例仍持有有效 URL）
      const existingUrls = {}
      for (const m of messages.value[chatId] || []) {
        if (m.type === 'file' && m.objectUrl) existingUrls[m.id] = m.objectUrl
      }

      const allMsgs = await dbGetAllMessages()
      const chatMsgs = allMsgs.filter(m => m.chatId === chatId || m.from === chatId)

      // 解密消息文本
      const decryptedMsgs = await Promise.all(chatMsgs.map(async (m) => {
        try {
          const decryptedText = await decryptMessageText(m.text, messageEncryptKey)
          if (m.type === 'file') {
            const meta = JSON.parse(decryptedText)
            return { ...m, text: null, objectUrl: existingUrls[m.id] || null, ...meta }
          }
          return { ...m, text: decryptedText, status: m.mine ? (m.status === 'pending' ? 'failed' : (m.status || 'sent')) : undefined }
        } catch (e) {
          console.warn('[chat] decrypt message failed:', m.id, e)
          return { ...m, text: '[解密失败]' }
        }
      }))

      // 懒加载文件体：仅为「内存中没有有效 blob URL」的文件消息从 IndexedDB 重建。
      // 仅作用于当前打开的会话，避免一次性把所有文件读进内存。
      await Promise.all(decryptedMsgs.map(async (m) => {
        if (m.type !== 'file' || m.objectUrl) return
        try {
          const rec = await dbGetFile(m.id)
          if (!rec) return  // 无持久化副本（旧数据/未存成功）→ 保持 null，显示「已过期」
          const buf = await decryptFileBytes(rec, messageEncryptKey)
          m.objectUrl = URL.createObjectURL(new Blob([buf], { type: m.filetype || rec.filetype }))
        } catch (e) {
          console.warn('[chat] rehydrate file blob failed:', m.id, e)
        }
      }))

      // 合并内存里已有、但 DB 快照没有的消息（按 id 去重），避免加载期间到达的消息被
      // 整体覆盖清掉。详见 loadAllMessages 里的同类修复说明。
      const ids = new Set(decryptedMsgs.map((m) => m.id))
      for (const m of messages.value[chatId] || []) {
        if (!ids.has(m.id)) decryptedMsgs.push(m)
      }

      decryptedMsgs.sort((a, b) => a.ts - b.ts)
      messages.value[chatId] = decryptedMsgs
    } catch (e) {
      console.error('[chat] load messages failed:', e)
      // 丢弃前先释放已有 blob URL，避免加载失败路径泄漏内存
      for (const m of messages.value[chatId] || []) releaseFileObjectUrl(m)
      messages.value[chatId] = []
    }
  }

  /**
   * 从 IndexedDB 加载所有消息并解密（应用启动时调用）
   */
  async function loadAllMessages() {
    try {
      // 初始化加密密钥
      await ensureMessageKey()

      // 保留内存中已有的 blob URL
      const existingUrls = {}
      for (const cid in messages.value) {
        for (const m of messages.value[cid]) {
          if (m.type === 'file' && m.objectUrl) existingUrls[m.id] = m.objectUrl
        }
      }

      const allMsgs = await dbGetAllMessages()
      const grouped = {}

      // 解密并分组
      for (const m of allMsgs) {
        const cid = m.chatId || m.from
        if (!grouped[cid]) grouped[cid] = []

        try {
          const decryptedText = await decryptMessageText(m.text, messageEncryptKey)
          if (m.type === 'file') {
            const meta = JSON.parse(decryptedText)
            grouped[cid].push({ ...m, text: null, objectUrl: existingUrls[m.id] || null, ...meta })
          } else {
            grouped[cid].push({ ...m, text: decryptedText, status: m.mine ? (m.status === 'pending' ? 'failed' : (m.status || 'sent')) : undefined })
          }
        } catch (e) {
          console.warn('[chat] decrypt message failed:', m.id, e)
          grouped[cid].push({ ...m, text: '[解密失败]' })
        }
      }

      // 合并内存中已有、但 DB 快照里还没有的消息（按 id 去重）。
      // 关键修复：冷启动时 dbGetAllMessages 读到的是「读那一刻」的 DB 快照，若离线消息
      // 在「读 DB」之后、「赋值 messages.value」之前才由 addMessage 到达并入库，直接
      // 整体覆盖会把这些刚到达的消息从内存清掉（DB 里其实有，故切 tab 重载才出现）。
      // 改为合并保留：内存里有而快照没有的消息补进 grouped。撤回/焚毁会同时清内存与
      // DB，故不会复活已删除的消息。
      for (const cid in messages.value) {
        const ids = new Set((grouped[cid] || []).map((m) => m.id))
        for (const m of messages.value[cid]) {
          if (!ids.has(m.id)) {
            if (!grouped[cid]) grouped[cid] = []
            grouped[cid].push(m)
          }
        }
      }

      // 排序
      for (const cid in grouped) {
        grouped[cid].sort((a, b) => a.ts - b.ts)
      }
      messages.value = grouped
    } catch (e) {
      console.error('[chat] load all messages failed:', e)
    }
  }

  /**
   * 清除指定 chatId 的消息（清空 IndexedDB 和内存）
   */
  async function clearChatMessages(chatId) {
    // 先释放内存中该会话所有文件 blob URL，避免泄漏
    for (const m of messages.value[chatId] || []) releaseFileObjectUrl(m)
    try {
      await dbClearMessages(chatId)
      await dbClearChatFiles(chatId)
    } catch (e) {
      console.error('[chat] clear messages failed:', e)
    }
    delete messages.value[chatId]
  }

  /**
   * 发送加密消息
   * @param {string} toChatId - 接收方 chat_id
   * @param {string} recipientPubKey - 接收方公钥（Base64）
   * @param {string} text - 明文
   * @param {boolean} burnAfterRead - 阅后即焚（对方阅读后2小时自动删除）
   */
  async function sendMessage(toChatId, recipientPubKey, text, burnAfterRead = false) {
    const msgId = genMsgId()
    const encrypted = await encryptMessage(text, recipientPubKey)

    // 先建立本地 pending 记录，确保极速 ACK 到达时一定能找到对应消息。
    await addMessage(toChatId, {
      id: msgId,
      from: 'me',
      text,
      ts: Date.now(),
      mine: true,
      read: false,
      status: 'pending',
      burnAfterRead,
      burnAt: null
    })

    const ok = send('message', {
      to: toChatId,
      msg_id: msgId,
      ephemeral_pub_key: encrypted.ephemeralPubKey,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      burn_after_read: burnAfterRead
    })
    if (!ok) {
      const msg = messages.value[toChatId]?.find(m => m.id === msgId)
      if (msg) msg.status = 'failed'
      await dbUpdateMessageDelivery(msgId, 'failed').catch(() => {})
      return false
    }

    const timer = setTimeout(() => {
      ackTimers.delete(msgId)
      const msg = messages.value[toChatId]?.find(m => m.id === msgId)
      if (msg?.status === 'pending') {
        msg.status = 'failed'
        dbUpdateMessageDelivery(msgId, 'failed').catch(() => {})
      }
    }, MESSAGE_ACK_TIMEOUT_MS)
    ackTimers.set(msgId, timer)
    return true
  }

  // ── 文件传输 ──────────────────────────────────────────────────

  /**
   * 将文件明文加密后持久化到 IndexedDB（与消息记录分离，懒加载）。
   * 失败不影响消息收发，仅退化为「刷新后过期」。
   */
  async function persistFileBlob(chatId, msgId, arrayBuffer, filetype) {
    try {
      await ensureMessageKey()
      const { iv, ciphertext } = await encryptFileBytes(arrayBuffer, messageEncryptKey)
      await dbPutFile({ id: msgId, chatId, iv, ciphertext, filetype })
    } catch (e) {
      console.error('[chat] persist file blob failed:', msgId, e)
    }
  }

  /**
   * 释放消息持有的 blob URL（内存），避免泄漏。删除/过期消息时必须调用。
   */
  function releaseFileObjectUrl(msg) {
    if (msg && msg.type === 'file' && msg.objectUrl) {
      URL.revokeObjectURL(msg.objectUrl)
      msg.objectUrl = null
    }
  }

  /**
   * 删除一条消息时一并清理其文件副本：释放内存 blob URL + 删除 IndexedDB 文件体。
   * msg 可能为 undefined（内存中已不存在），此时仅清理持久化副本。
   */
  async function deleteFileArtifacts(msg, msgId) {
    releaseFileObjectUrl(msg)
    await dbDeleteFile(msgId).catch(() => {})
  }

  /**
   * 添加文件消息到内存和 IndexedDB（仅存元数据）
   */
  async function addFileMessage(chatId, msg) {
    if (isMsgIdExists(msg.id)) {
      // 重复消息：释放调用方传入的 objectUrl，避免泄漏
      if (msg.objectUrl) URL.revokeObjectURL(msg.objectUrl)
      return false
    }
    const fullMsg = { ...msg, type: 'file', read: msg.read || false, burnAt: msg.burnAt || null }
    const earlyReceipt = applyEarlyReadReceipt(fullMsg)
    ensureThread(chatId)
    messages.value[chatId].push(fullMsg)
    try {
      await ensureMessageKey()
      const metaText = JSON.stringify({ filename: msg.filename, filesize: msg.filesize, filetype: msg.filetype })
      const encryptedText = await encryptMessageText(metaText, messageEncryptKey)
      await dbAddMessage({
        id: msg.id,
        chatId,
        from: msg.from,
        type: 'file',
        text: encryptedText,
        ts: msg.ts,
        mine: msg.mine,
        // 从 fullMsg（即推入内存的同一对象）读取读已读/倒计时状态：
        // 收到文件后 markAsRead 可能在 dbAddMessage 之前就把它标记为已读并写入 burnAt，
        // 这样持久化时能捕获到该状态，避免重载后倒计时丢失（与 addMessage 行为一致）
        read: fullMsg.read || false,
        receiptSent: fullMsg.receiptSent || false,
        burnAfterRead: msg.burnAfterRead || false,
        readReceivedAt: fullMsg.readReceivedAt || null,
        burnAt: fullMsg.burnAt || null,
        status: fullMsg.status || (fullMsg.mine ? 'sent' : undefined)
      })
      if (earlyReceipt) confirmReadReceiptsApplied(chatId, [earlyReceipt.msg_id])
    } catch (e) {
      // DB 写入失败：保留内存中的消息（用户仍可见），清理孤儿文件体（刷新后消息丢失）
      await dbDeleteFile(msg.id).catch(() => {})
      console.error('[chat] persist file message failed, kept in memory:', e)
      return false
    }
    return true
  }

  /**
   * 等待 file_accept 或 file_reject（Promise 化）
   */
  function waitForFileAccept(transferId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off('file_accept', onAccept)
        off('file_reject', onReject)
        off('file_error', onErr)
        reject(new Error('对方未响应，请确认对方在线后重试'))
      }, timeoutMs)

      function cleanup() { clearTimeout(timer); off('file_accept', onAccept); off('file_reject', onReject); off('file_error', onErr) }
      function onAccept(p) { if (p.transfer_id === transferId) { cleanup(); resolve() } }
      function onReject(p) { if (p.transfer_id === transferId) { cleanup(); reject(new Error('对方拒绝了文件传输')) } }
      function onErr(p) { if (p.transfer_id === transferId) { cleanup(); reject(new Error(p.reason || '文件传输出错')) } }

      on('file_accept', onAccept)
      on('file_reject', onReject)
      on('file_error', onErr)
    })
  }

  /**
   * 等待接收端确认收齐并解密成功（file_done），或收到 file_error / 超时
   */
  function waitForFileDone(transferId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off('file_done', onDone)
        off('file_error', onErr)
        reject(new Error('对方未确认接收，文件可能未送达'))
      }, timeoutMs)

      function cleanup() { clearTimeout(timer); off('file_done', onDone); off('file_error', onErr) }
      function onDone(p) { if (p.transfer_id === transferId) { cleanup(); resolve(p.ts) } }
      function onErr(p) { if (p.transfer_id === transferId) { cleanup(); reject(new Error(p.reason || '对方接收失败')) } }

      on('file_done', onDone)
      on('file_error', onErr)
    })
  }

  // ── 接收端传输看门狗：检测分块停滞，避免某块丢失导致永久卡死 ──────────
  const RECEIVE_STALL_MS = 30000  // 30s 内无新进展则判定传输失败

  function armReceiveWatchdog(transferId) {
    const t = fileTransfers.value[transferId]
    if (!t) return
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      const tr = fileTransfers.value[transferId]
      if (!tr || tr.status === 'done' || tr.status === 'error') return
      tr.status = 'error'
      tr.errorReason = '传输超时'
      tr.errorAt = Date.now()
      scheduleTransferCleanup(transferId, 6000)
      send('file_error', { to: tr.fromChatId, transfer_id: transferId, reason: '接收超时' })
    }, RECEIVE_STALL_MS)
  }

  function clearReceiveWatchdog(transferId) {
    const t = fileTransfers.value[transferId]
    if (t && t.timer) { clearTimeout(t.timer); t.timer = null }
  }

  // ── 传输记录清理：终态后延迟删除，避免 fileTransfers 无限累积 ──────────
  // done：1s 后清理（给 UI 一瞬显示完成）；error：6s 后清理（覆盖 activeTransfer 的 5s 错误窗口）
  function scheduleTransferCleanup(transferId, delayMs) {
    setTimeout(() => {
      const t = fileTransfers.value[transferId]
      if (!t) return
      if (t.status === 'done' || t.status === 'error') {
        clearReceiveWatchdog(transferId)
        delete fileTransfers.value[transferId]
      }
    }, delayMs)
  }

  /**
   * 组装并解密接收到的文件数据块
   */
  async function assembleAndDecrypt(transfer) {
    if (transfer.status === 'done' || transfer.status === 'error') return
    if (transfer.receivedCount < transfer.totalChunks) return
    if (transfer.chunks.some(c => !c)) return

    transfer.status = 'done'
    clearReceiveWatchdog(transfer.id)
    try {
      let totalBytes = 0
      const bufs = transfer.chunks.map(c => { const b = new Uint8Array(b64ToBuf(c)); totalBytes += b.length; return b })
      const combined = new Uint8Array(totalBytes)
      let offset = 0
      for (const b of bufs) { combined.set(b, offset); offset += b.length }

      const plainBuf = await decryptFile({
        ephemeralPubKey: transfer.ephemeralPubKey,
        iv: transfer.iv,
        ciphertext: combined.buffer
      })
      if (plainBuf.byteLength !== transfer.filesize) {
        throw new Error('解密后的文件大小与发送方声明不一致')
      }

      const blob = new Blob([plainBuf], { type: transfer.filetype })
      const objectUrl = URL.createObjectURL(blob)
      transfer.objectUrl = objectUrl

      // 持久化加密文件体，刷新后仍可下载/预览
      await persistFileBlob(transfer.fromChatId, transfer.msgId, plainBuf, transfer.filetype)

      const added = await addFileMessage(transfer.fromChatId, {
        id: transfer.msgId,
        from: transfer.fromChatId,
        filename: transfer.filename,
        filesize: transfer.filesize,
        filetype: transfer.filetype,
        objectUrl,
        mine: false,
        burnAfterRead: transfer.burnAfterRead || false,
        ts: transfer.ts  // 时间戳，与发送端一致
      })
      if (!added) {
        // 消息未入库（重复 ID 或 DB 失败），但文件已成功接收解密，内存中可见
        // 重复 ID：消息已存在；DB 失败：消息在内存中（刷新后丢失）
        console.warn('[chat] file message not persisted:', transfer.msgId)
      }
      // 通知发送端：已收齐并解密成功，回带时间戳供发送端统一显示
      send('file_done', { to: transfer.fromChatId, transfer_id: transfer.id, ts: transfer.ts })
      scheduleTransferCleanup(transfer.id, 1000)
    } catch (e) {
      transfer.status = 'error'
      transfer.errorReason = '文件解密失败'
      transfer.errorAt = Date.now()
      clearReceiveWatchdog(transfer.id)
      scheduleTransferCleanup(transfer.id, 6000)
      send('file_error', { to: transfer.fromChatId, transfer_id: transfer.id, reason: '文件解密失败' })
      console.error('[chat] file decrypt failed:', e)
    }
  }

  /**
   * 验证文件类型和大小
   */
  function validateFile(file) {
    validateFileMetadata(file.name, file.type, file.size)
  }

  /**
   * 发送文件（P2P WebSocket 中继）
   * @param {string} toChatId
   * @param {string} recipientPubKey
   * @param {File} file
   * @param {boolean} burnAfterRead - 阅后即焚（对方阅读后2小时自动删除）
   */
  async function sendFile(toChatId, recipientPubKey, file, burnAfterRead = false) {
    validateFile(file)

    const transferId = crypto.randomUUID()
    const msgId = genMsgId()  // 消息记录 ID（符合已读回执格式），与 WebSocket 路由用的 UUID 分离
    fileTransfers.value[transferId] = {
      id: transferId,
      msgId,
      direction: 'send',
      toChatId,
      filename: file.name,
      filesize: file.size,
      filetype: file.type,
      totalChunks: 0,
      progress: 0,
      status: 'pending'
    }

    try {
      // 读取并加密文件
      const fileBuffer = await file.arrayBuffer()
      const { ephemeralPubKey, iv, ciphertext } = await encryptFile(fileBuffer, recipientPubKey)

      // 先建立发送方本地待确认记录并保存文件体。这样接收端的 file_done 即使在发送方
      // 瞬时断线后离线补投，重启应用也能凭 msg_id 把该文件恢复为发送成功。
      const localObjectUrl = URL.createObjectURL(new Blob([fileBuffer], { type: file.type }))
      await persistFileBlob(toChatId, msgId, fileBuffer, file.type)
      await addFileMessage(toChatId, {
        id: msgId,
        from: 'me',
        filename: file.name,
        filesize: file.size,
        filetype: file.type,
        objectUrl: localObjectUrl,
        mine: true,
        status: 'pending',
        burnAfterRead,
        ts: getServerNow()
      })

      // 分块
      const cipherArr = new Uint8Array(ciphertext)
      const chunks = []
      for (let i = 0; i < cipherArr.length; i += CHUNK_SIZE) {
        chunks.push(cipherArr.slice(i, i + CHUNK_SIZE))
      }
      const totalChunks = chunks.length
      fileTransfers.value[transferId].totalChunks = totalChunks

      // 发送 offer
      const ok = send('file_offer', {
        to: toChatId,
        transfer_id: transferId,
        msg_id: msgId,
        filename: file.name,
        filesize: file.size,
        filetype: file.type,
        total_chunks: totalChunks,
        ephemeral_pub_key: ephemeralPubKey,
        iv,
        burn_after_read: burnAfterRead,
        ts: Date.now()  // 发送方时间戳，供接收端用作消息时间（后端中继若注入 ts 则覆盖）
      })
      if (!ok) throw new Error('发送失败，请检查网络连接')

      // 等待对方接受
      await waitForFileAccept(transferId, 30000)
      fileTransfers.value[transferId].status = 'transferring'

      // 必须在发送第一块前监听完成回执。接收端收到最后一块就会立即解密并发送
      // file_done；若发送完所有块后才监听，极速回执会被 WebSocket 层丢弃。
      const doneResultPromise = waitForFileDone(transferId, 120000)
        .then(ts => ({ ok: true, ts }), error => ({ ok: false, error }))

      // 逐块发送
      for (let i = 0; i < chunks.length; i++) {
        if (fileTransfers.value[transferId]?.status === 'error') throw new Error('传输已中断')
        const sent = send('file_chunk', {
          to: toChatId,
          transfer_id: transferId,
          chunk_index: i,
          data: bufToB64(chunks[i].buffer)
        })
        if (!sent) throw new Error('网络中断，文件发送失败')
        fileTransfers.value[transferId].progress = Math.round((i + 1) / totalChunks * 95)
        // 每 10 块让出一次事件循环，避免阻塞 UI
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 0))
      }

      // 发送完成信号
      if (!send('file_complete', { to: toChatId, transfer_id: transferId })) {
        throw new Error('网络中断，文件完成信号发送失败')
      }
      fileTransfers.value[transferId].progress = 100

      // 等待接收端确认收齐并解密成功；超时或收到 file_error 则按失败处理
      // 返回的 ts 来自接收端，两端显示一致
      const doneResult = await doneResultPromise
      if (!doneResult.ok) throw doneResult.error
      const doneTs = doneResult.ts
      fileTransfers.value[transferId].status = 'done'
      scheduleTransferCleanup(transferId, 1000)

      // file_done 的时间戳由后端从 offer 会话中注入，两端统一；全局监听也会执行同样
      // 的幂等更新，以覆盖断线补投或页面重启后的完成通知。
      const finalTs = (typeof doneTs === 'number' && doneTs > 0) ? doneTs : getServerNow()
      const localMsg = messages.value[toChatId]?.find(m => m.id === msgId)
      if (localMsg) { localMsg.status = 'sent'; localMsg.ts = finalTs }
      await dbUpdateMessageDelivery(msgId, 'sent', finalTs).catch(() => {})

      return transferId
    } catch (e) {
      if (fileTransfers.value[transferId]) {
        fileTransfers.value[transferId].status = 'error'
        fileTransfers.value[transferId].errorReason = e.message
        fileTransfers.value[transferId].errorAt = Date.now()
        scheduleTransferCleanup(transferId, 6000)
      }
      const localMsg = messages.value[toChatId]?.find(m => m.id === msgId)
      if (localMsg?.status === 'pending') localMsg.status = 'failed'
      await dbUpdateMessageDelivery(msgId, 'failed').catch(() => {})
      send('file_error', { to: toChatId, transfer_id: transferId, reason: e.message })
      throw e
    }
  }

  async function recallMessage(chatId, msgId, toChatId) {
    // 本地删除
    const msgs = messages.value[chatId]
    let removed
    if (msgs) {
      const idx = msgs.findIndex(m => m.id === msgId)
      if (idx !== -1) removed = msgs.splice(idx, 1)[0]
    }
    await dbDeleteMessage(msgId)
    await deleteFileArtifacts(removed, msgId)
    // 通知对方撤回
    if (toChatId) {
      send('recall', { to: toChatId, msg_id: msgId })
    }
  }

  // ── 安全验证常量 ──────────────────────────────────────────────

const CHAT_ID_PATTERN = /^\d{4}-[A-Z]{4}$/
const MSG_ID_PATTERN = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/
const TRANSFER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 验证 payload 中的 chat_id 格式
 */
function validateChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return false
  return CHAT_ID_PATTERN.test(chatId)
}

/**
 * 验证 payload 中的 msg_id 格式
 */
function validateMsgId(msgId) {
  if (!msgId || typeof msgId !== 'string') return false
  return MSG_ID_PATTERN.test(msgId)
}

/**
 * 注册 WebSocket 消息监听（在聊天页面 mounted 时调用）
   */
  function startListening() {
    async function onMessage(payload) {
      // 安全验证：检查 payload 结构
      if (!payload) {
        console.warn('[chat] empty message payload')
        return
      }
      if (!validateChatId(payload.from)) {
        console.warn('[chat] invalid from in message:', payload.from)
        return
      }
      if (!validateMsgId(payload.msg_id)) {
        console.warn('[chat] invalid msg_id in message:', payload.msg_id)
        return
      }
      // 验证加密参数
      if (!payload.ephemeral_pub_key || !payload.iv || !payload.ciphertext) {
        console.warn('[chat] missing encryption params in message')
        return
      }
      // 验证时间戳（使用服务器时间）
      if (typeof payload.ts !== 'number' || payload.ts < 0) {
        console.warn('[chat] invalid ts in message:', payload.ts)
        return
      }

      // 提醒放在解密之前：锁定状态下私钥已清除、消息无法解密，
      // 但仍应让用户知道「收到新消息」并触发闪烁（通知文案通用，不含内容）
      notifyNewMessage()

      try {
        const text = await decryptMessage({
          ephemeralPubKey: payload.ephemeral_pub_key,
          iv: payload.iv,
          ciphertext: payload.ciphertext
        })
        await addMessage(payload.from, {
          id: payload.msg_id,
          from: payload.from,
          text,
          ts: payload.ts,  // 使用服务器时间
          mine: false,
          burnAfterRead: payload.burn_after_read || false,
          burnAt: null
        })
      } catch (e) {
        // 锁定态下私钥已清除，必然解密失败：暂存原始密文，解锁后补解密。
        // 非锁定态的解密失败属于真损坏，沿用原有「丢弃」行为。
        if (useIdentityStore().isLocked) {
          await dbAddPending({
            msg_id: payload.msg_id,
            from: payload.from,
            ephemeral_pub_key: payload.ephemeral_pub_key,
            iv: payload.iv,
            ciphertext: payload.ciphertext,
            ts: payload.ts,
            burn_after_read: payload.burn_after_read || false
          }).catch(err => console.error('[chat] stash pending failed', err))
        } else {
          console.error('[chat] decrypt failed', e)
        }
      }
    }

    async function onRecall(payload) {
      // 安全验证
      if (!payload) {
        console.warn('[chat] empty recall payload')
        return
      }
      if (!validateChatId(payload.from)) {
        console.warn('[chat] invalid from in recall:', payload.from)
        return
      }
      if (!validateMsgId(payload.msg_id)) {
        console.warn('[chat] invalid msg_id in recall:', payload.msg_id)
        return
      }

      const chatId = payload.from
      const msgId = payload.msg_id
      const msgs = messages.value[chatId]
      let removed
      if (msgs) {
        const idx = msgs.findIndex(m => m.id === msgId)
        if (idx !== -1) removed = msgs.splice(idx, 1)[0]
      }
      await dbDeleteMessage(msgId)
      await deleteFileArtifacts(removed, msgId)
    }

    async function onAck(payload) {
      // 安全验证
      if (!payload) {
        console.warn('[chat] empty ack payload')
        return
      }
      if (!validateMsgId(payload.msg_id)) {
        console.warn('[chat] invalid msg_id in ack:', payload.msg_id)
        return
      }
      if (typeof payload.ts !== 'number' || payload.ts < 0) {
        console.warn('[chat] invalid ts in ack:', payload.ts)
        return
      }

      const msgId = payload.msg_id
      const ts = payload.ts
      const timer = ackTimers.get(msgId)
      if (timer) {
        clearTimeout(timer)
        ackTimers.delete(msgId)
      }
      for (const chatId in messages.value) {
        const msg = messages.value[chatId].find(m => m.id === msgId)
        if (msg) { msg.ts = ts; msg.status = 'sent'; break }
      }
      await dbUpdateMessageDelivery(msgId, 'sent', ts)
    }

    async function onReadReceipt(payload) {
      // 安全验证
      if (!payload) {
        console.warn('[chat] empty read_receipt payload')
        return
      }
      if (!validateChatId(payload.from)) {
        console.warn('[chat] invalid from in read_receipt:', payload.from)
        return
      }
      let receipts = payload.receipts
      // 兼容滚动发布期间旧后端的仅 ID 格式；新后端始终提供权威 read_at。
      if (!Array.isArray(receipts) && Array.isArray(payload.msg_id)) {
        const fallbackTime = getServerNow()
        receipts = payload.msg_id.map(msg_id => ({ msg_id, read_at: fallbackTime }))
      }
      if (!Array.isArray(receipts) || receipts.length === 0) {
        console.warn('[chat] invalid receipts in read_receipt:', receipts)
        return
      }
      for (const receipt of receipts) {
        if (!validateMsgId(receipt?.msg_id) || !Number.isFinite(receipt?.read_at) || receipt.read_at <= 0) {
          console.warn('[chat] invalid read receipt item:', receipt)
          return
        }
      }
      await handleReadReceipt(payload.from, receipts, payload.replay !== true)
    }

    async function onReadAck(payload) {
      if (!validateChatId(payload?.to) || !Array.isArray(payload?.msg_id) || payload.msg_id.length === 0) return
      const ids = payload.msg_id.filter(validateMsgId)
      if (ids.length === 0) return
      confirmPendingReads(payload.to, ids)
      const idSet = new Set(ids)
      const msgs = messages.value[payload.to] || []
      for (const msg of msgs) {
        if (!msg.mine && idSet.has(msg.id)) msg.receiptSent = true
      }
      await Promise.all(ids.map(id => dbMarkReceiptSent(id).catch(() => {})))

      // 用服务器首次阅读时间校准阅读方自己的销毁时刻，覆盖认证前极短窗口内的本机时间退化值。
      const receipts = Array.isArray(payload.receipts) ? payload.receipts : []
      await Promise.all(receipts.map(async receipt => {
        if (!validateMsgId(receipt?.msg_id) || !Number.isFinite(receipt?.read_at) || receipt.read_at <= 0) return
        const msg = msgs.find(m => !m.mine && m.id === receipt.msg_id)
        if (msg?.burnAfterRead) {
          msg.readReceivedAt = receipt.read_at
          msg.burnAt = receipt.read_at + BURN_AFTER_READ_DELAY
        }
        await dbCorrectBurnCountdown(
          receipt.msg_id,
          receipt.read_at,
          receipt.read_at + BURN_AFTER_READ_DELAY
        ).catch(() => {})
      }))
    }

    // ── 文件传输事件 ────────────────────────────────────────────

    function failIncomingTransfer(transfer, reason) {
      if (!transfer || transfer.status === 'done' || transfer.status === 'error') return
      transfer.status = 'error'
      transfer.errorReason = reason
      transfer.errorAt = Date.now()
      clearReceiveWatchdog(transfer.id)
      scheduleTransferCleanup(transfer.id, 6000)
      send('file_error', { to: transfer.fromChatId, transfer_id: transfer.id, reason })
    }

    function onFileOffer(payload) {
      const { from, transfer_id, msg_id, filename, filesize, filetype, total_chunks, ephemeral_pub_key, iv } = payload
      if (!validateChatId(from) || !TRANSFER_ID_PATTERN.test(transfer_id)) return
      try {
        validateFileMetadata(filename, filetype, filesize)
        if (!validateMsgId(msg_id)) throw new Error('文件消息编号无效')
        if (!Number.isInteger(total_chunks) || total_chunks !== expectedFileChunks(filesize)) {
          throw new Error('文件分块数量与声明大小不匹配')
        }
        if (typeof ephemeral_pub_key !== 'string' || !ephemeral_pub_key || typeof iv !== 'string' || !iv) {
          throw new Error('缺少文件加密参数')
        }
        if (fileTransfers.value[transfer_id]) throw new Error('文件传输编号重复')
      } catch (error) {
        console.warn('[chat] rejected invalid file offer:', error.message)
        send('file_error', { to: from, transfer_id, reason: error.message })
        return
      }

      fileTransfers.value[transfer_id] = {
        id: transfer_id,
        msgId: msg_id,
        direction: 'receive',
        fromChatId: from,
        filename,
        filesize,
        filetype,
        totalChunks: total_chunks,
        chunks: new Array(total_chunks).fill(null),
        receivedCount: 0,
        progress: 0,
        status: 'transferring',
        ephemeralPubKey: ephemeral_pub_key,
        iv,
        burnAfterRead: payload.burn_after_read || false,
        ts: (typeof payload.ts === 'number' && payload.ts > 0) ? payload.ts : Date.now(),  // 服务器时间戳，两端统一
        timer: null
      }
      // 启动停滞看门狗，避免某块丢失导致永久卡在传输中
      armReceiveWatchdog(transfer_id)
      // 自动接受
      send('file_accept', { to: from, transfer_id })
    }

    function onFileChunk(payload) {
      const { from, transfer_id, chunk_index, data } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (!transfer || transfer.direction !== 'receive' || transfer.status !== 'transferring') return
      if (from !== transfer.fromChatId || !Number.isInteger(chunk_index) || chunk_index < 0 ||
          chunk_index >= transfer.totalChunks || transfer.chunks[chunk_index] || typeof data !== 'string') {
        failIncomingTransfer(transfer, '收到无效的文件分块')
        return
      }
      try {
        const decodedSize = b64ToBuf(data).byteLength
        if (decodedSize !== expectedFileChunkSize(transfer.filesize, chunk_index)) {
          throw new Error('文件分块长度不匹配')
        }
      } catch {
        failIncomingTransfer(transfer, '文件分块内容或长度无效')
        return
      }

      transfer.chunks[chunk_index] = data
      transfer.receivedCount++
      transfer.progress = Math.round(transfer.receivedCount / transfer.totalChunks * 95)
      armReceiveWatchdog(transfer_id)  // 有新进展则重置停滞计时

      // 全部到齐时自动组装（无需等 file_complete）
      if (transfer.receivedCount === transfer.totalChunks) {
        assembleAndDecrypt(transfer)
      }
    }

    function onFileComplete(payload) {
      const { from, transfer_id } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (!transfer || transfer.direction !== 'receive' || transfer.status !== 'transferring') return
      if (from !== transfer.fromChatId) {
        failIncomingTransfer(transfer, '无效的文件完成信号')
        return
      }
      // 收齐则组装；缺块则判定失败并通知发送方，避免发送端误以为成功
      if (transfer.receivedCount < transfer.totalChunks || transfer.chunks.some(c => !c)) {
        transfer.status = 'error'
        transfer.errorReason = '文件传输不完整'
        transfer.errorAt = Date.now()
        clearReceiveWatchdog(transfer_id)
        scheduleTransferCleanup(transfer_id, 6000)
        send('file_error', { to: transfer.fromChatId, transfer_id, reason: '接收不完整' })
        return
      }
      assembleAndDecrypt(transfer)
    }

    function onFileError(payload) {
      const { transfer_id, reason } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (transfer && transfer.status !== 'done') {
        transfer.status = 'error'
        transfer.errorReason = reason || '传输失败'
        transfer.errorAt = Date.now()
        clearReceiveWatchdog(transfer_id)
        scheduleTransferCleanup(transfer_id, 6000)
      }
    }

    async function onFileDone(payload) {
      const { from, transfer_id, msg_id, ts } = payload || {}
      if (!validateChatId(from) || !TRANSFER_ID_PATTERN.test(transfer_id) || !validateMsgId(msg_id)) return
      if (!Number.isFinite(ts) || ts <= 0) return
      const msg = messages.value[from]?.find(m => m.mine && m.id === msg_id)
      if (msg) { msg.status = 'sent'; msg.ts = ts }
      await dbUpdateMessageDelivery(msg_id, 'sent', ts).catch(() => {})
    }

    on('message', onMessage)
    on('recall', onRecall)
    on('ack', onAck)
    on('read_receipt', onReadReceipt)
    on('read_ack', onReadAck)
    on('file_offer', onFileOffer)
    on('file_chunk', onFileChunk)
    on('file_complete', onFileComplete)
    on('file_error', onFileError)
    on('file_done', onFileDone)
    return () => {
      off('message', onMessage)
      off('recall', onRecall)
      off('ack', onAck)
      off('read_receipt', onReadReceipt)
      off('read_ack', onReadAck)
      off('file_offer', onFileOffer)
      off('file_chunk', onFileChunk)
      off('file_complete', onFileComplete)
      off('file_error', onFileError)
      off('file_done', onFileDone)
    }
  }

  function getMessages(chatId) {
    return messages.value[chatId] || []
  }

  const totalUnread = computed(() => {
    let count = 0
    for (const msgs of Object.values(messages.value)) {
      for (const m of msgs) {
        if (!m.mine && !m.read) count++
      }
    }
    return count
  })

  async function clearAll() {
    for (const timer of ackTimers.values()) clearTimeout(timer)
    ackTimers.clear()
    // 释放所有内存中的文件 blob URL（deleteDatabase 会清空文件体存储）
    for (const cid in messages.value) {
      for (const m of messages.value[cid]) releaseFileObjectUrl(m)
    }
    await clearAllMessagesDB()
    messages.value = {}
  }

  /**
   * 从服务器拉取好友已读记录，补偿发送方离线期间丢失的已读回执
   */
  async function syncReadStatus(peerChatId) {
    try {
      const { friendApi } = await import('src/services/api')
      const { data } = await friendApi.getReadReceipts(peerChatId)
      if (Array.isArray(data.receipts) && data.receipts.length > 0) {
        await handleReadReceipt(peerChatId, data.receipts, false)
      } else if (Array.isArray(data.msg_ids) && data.msg_ids.length > 0) {
        const fallbackTime = getServerNow()
        await handleReadReceipt(peerChatId, data.msg_ids.map(msg_id => ({ msg_id, read_at: fallbackTime })), false)
      }
    } catch (e) {
      console.warn('[chat] syncReadStatus failed:', e)
    }
  }

  /**
   * 标记一组消息为已读，并发送已读回执给发送方
   */
  async function markAsRead(chatId) {
    const msgs = messages.value[chatId] || []
    const readReceivedAt = getServerNow()
    const newlyRead = []        // 本次新标记为已读的（用于持久化 read）
    const burnReads = []        // 接收端首次读到的阅后即焚消息，需启动销毁倒计时
    const pendingReceiptIds = []  // 需要（重）发回执的：本地已读但回执尚未确认送达
    for (const m of msgs) {
      if (m.mine) continue
      if (!m.read) {
        m.read = true
        newlyRead.push(m.id)
        // 阅后即焚：接收端读到后即启动销毁倒计时（销毁的是「看的人」这份）
        if (m.burnAfterRead) {
          m.readReceivedAt = readReceivedAt
          m.burnAt = readReceivedAt + BURN_AFTER_READ_DELAY
          burnReads.push(m.id)
        }
      }
      // 只要回执还没确认送达就需要补发——服务器 RecordRead 幂等，重发安全
      if (!m.receiptSent) pendingReceiptIds.push(m.id)
    }
    // 持久化新标记的已读状态到 IndexedDB
    if (newlyRead.length > 0) {
      const burnSet = new Set(burnReads)
      await Promise.all(newlyRead.map(id =>
        burnSet.has(id)
          ? dbStartBurnCountdown(id, readReceivedAt, readReceivedAt + BURN_AFTER_READ_DELAY).catch(() => {})
          : dbMarkMessageRead(id).catch(() => {})
      ))
    }
    if (pendingReceiptIds.length === 0) return
    // WebSocket 层统一去重、拆成每批最多 100 条并只 flush 一次，避免循环发送时把前面
    // 尚未 ACK 的批次反复发送，形成 O(n²) 请求风暴。
    send('read', { to: chatId, msg_id: pendingReceiptIds })
  }

  /**
   * 处理对方发来的已读回执通知（我发的消息被对方读了）
   * 对于阅后即焚消息，使用服务器记录的首次阅读时间。
   */
  async function handleReadReceipt(fromChatId, receipts, rememberMissing = true) {
    if (!validateChatId(fromChatId) || !Array.isArray(receipts)) return
    const validReceipts = receipts.filter(r => validateMsgId(r?.msg_id) && Number.isFinite(r?.read_at) && r.read_at > 0)
    if (validReceipts.length === 0) return
    const receiptByID = new Map(validReceipts.map(r => [r.msg_id, r]))
    for (const chatId in messages.value) {
      if (chatId !== fromChatId) continue
      for (const m of messages.value[chatId]) {
        const receipt = receiptByID.get(m.id)
        if (!(m.mine && receipt)) continue
        const timer = ackTimers.get(m.id)
        if (timer) {
          clearTimeout(timer)
          ackTimers.delete(m.id)
        }
        m.status = 'sent'
        m.read = true
        // 阅后即焚消息：仅在「首次」收到回执时启动销毁倒计时。
        // 服务器的 getReadReceipts 每次都会返回同一批已读 ID，若不加守卫，
        // 每次重新进入聊天/重连都会把 readReceivedAt 重置为当前时间，
        // 导致倒计时反复从 2 小时重新开始。
        if (m.burnAfterRead && !m.readReceivedAt) {
          m.readReceivedAt = receipt.read_at
          m.burnAt = receipt.read_at + BURN_AFTER_READ_DELAY
        }
      }
    }
    // 统一落库：dbStartBurnCountdown 内部会判断 burnAfterRead 且仅在未启动倒计时时写入，
    // 因此对非阅后即焚消息仅置 read=true，对已在内存中处理过的消息为幂等操作。
    // 关键修复：即使消息未加载进内存（发送方不在聊天页），也能正确启动销毁倒计时，
    // 避免 DB 记录停留在 read=true 但 readReceivedAt/burnAt 为空导致永不删除。
    const appliedIds = []
    await Promise.all(validReceipts.map(async receipt => {
      const found = await dbStartBurnCountdown(
        receipt.msg_id,
        receipt.read_at,
        receipt.read_at + BURN_AFTER_READ_DELAY
      ).catch(() => false)
      if (!found && rememberMissing) rememberEarlyReadReceipt(receipt)
      if (found || !rememberMissing) appliedIds.push(receipt.msg_id)
      await dbUpdateMessageDelivery(receipt.msg_id, 'sent').catch(() => {})
    }))
    confirmReadReceiptsApplied(fromChatId, appliedIds)
  }

  // ── 定时删除过期消息 ────────────────────────────────────────

  let burnTimer = null
  let burnCheckRunning = false

  /**
   * 启动定时删除检查（每分钟检查一次）
   * 使用认证时校准的服务器时间，防止修改设备系统时间绕过删除。
   */
  function startBurnTimer() {
    if (burnTimer) return
    burnTimer = setInterval(() => { checkExpiredMessages() }, 60000)
  }

  /**
   * 停止定时删除检查
   */
  function stopBurnTimer() {
    if (burnTimer) {
      clearInterval(burnTimer)
      burnTimer = null
    }
  }

  /**
   * 立即检查并删除过期消息
   * 同时扫描 IndexedDB 的 burnAt 索引，即使相关会话尚未加载进内存，也会删除消息
   * 元数据和加密文件体。应用关闭期间到期的数据会在下次启动后立即清理。
   */
  async function checkExpiredMessages() {
    if (burnCheckRunning) return
    burnCheckRunning = true
    try {
      const now = getServerNow()
      const expiredRecords = await dbGetExpiredBurnMessages(now).catch(() => [])
      const expiredIDs = new Set(expiredRecords.map(m => m.id))
      const memoryMessages = new Map()

      for (const chatId in messages.value) {
        const msgs = messages.value[chatId]
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          const expired = expiredIDs.has(m.id) ||
            (m.burnAfterRead && Number.isFinite(m.burnAt) && m.burnAt <= now) ||
            (m.burnAfterRead && !m.burnAt && m.readReceivedAt && now - m.readReceivedAt >= BURN_AFTER_READ_DELAY)
          if (!expired) continue
          expiredIDs.add(m.id)
          memoryMessages.set(m.id, m)
          msgs.splice(i, 1)
        }
      }

      for (const id of expiredIDs) {
        await dbDeleteMessage(id).catch(() => {})
        await deleteFileArtifacts(memoryMessages.get(id), id)
      }
    } finally {
      burnCheckRunning = false
    }
  }

  /**
   * 解锁后调用：补解密锁定期间暂存的密文。
   * 成功 → 入库并删暂存；解锁后仍失败 → 视为真损坏，删暂存（自清理）；
   * 仍处于锁定（私钥未就绪）→ 保留，下次解锁再试。
   */
  async function processPendingMessages() {
    let pending
    try {
      pending = await dbGetAllPending()
    } catch (e) {
      console.error('[chat] load pending failed', e)
      return
    }
    if (!pending.length) return

    // 按服务器时间排序，保证补显示顺序与发送顺序一致
    pending.sort((a, b) => a.ts - b.ts)

    for (const p of pending) {
      try {
        const text = await decryptMessage({
          ephemeralPubKey: p.ephemeral_pub_key,
          iv: p.iv,
          ciphertext: p.ciphertext
        })
        await addMessage(p.from, {
          id: p.msg_id,
          from: p.from,
          text,
          ts: p.ts,
          mine: false,
          burnAfterRead: p.burn_after_read || false,
          burnAt: null
        })
        await dbDeletePending(p.msg_id).catch(() => {})
      } catch (e) {
        // 解锁后仍失败：若仍锁定则保留待下次，否则是真损坏，删除
        if (useIdentityStore().isLocked) {
          break  // 私钥仍不可用，无需继续尝试
        }
        console.error('[chat] pending decrypt failed, dropping', p.msg_id, e)
        await dbDeletePending(p.msg_id).catch(() => {})
      }
    }
  }

  return {
    messages,
    totalUnread,
    fileTransfers,
    sendMessage,
    sendFile,
    validateFile,
    recallMessage,
    startListening,
    getMessages,
    loadMessages,
    loadAllMessages,
    clearChatMessages,
    clearAll,
    markAsRead,
    syncReadStatus,
    handleReadReceipt,
    startBurnTimer,
    stopBurnTimer,
    checkExpiredMessages,
    processPendingMessages
  }
})
