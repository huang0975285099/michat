import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { encryptMessage, decryptMessage, encryptFile, decryptFile, bufToB64, b64ToBuf } from 'src/services/crypto'
import { send, on, off } from 'src/services/websocket'
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
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/pdf',
  'application/zip', 'application/x-zip-compressed', 'application/x-zip',
  'application/x-rar-compressed', 'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-tar', 'application/gzip', 'application/x-gzip',
  'application/octet-stream',  // 部分浏览器对未知格式统一上报此类型
  'application/vnd.android.package-archive',
])

const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg',
  'mp4', 'webm', 'mov',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf',
  'zip', 'rar', '7z', 'tar', 'gz',
  'apk'
])

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
async function dbStartBurnCountdown(msgId, readReceivedAt, burnAt) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(msgId)
    req.onsuccess = (e) => {
      const record = e.target.result
      if (record) {
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

async function dbUpdateMessageTs(msgId, ts) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(msgId)
    req.onsuccess = (e) => {
      const record = e.target.result
      if (record) { record.ts = ts; store.put(record) }
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

  // 消息加密密钥（用于加密 IndexedDB 存储）
  let messageEncryptKey = null

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

  /**
   * 添加消息到内存并加密持久化到 IndexedDB
   */
  async function addMessage(chatId, msg) {
    // 安全检查：防止重放攻击
    if (isMsgIdExists(msg.id)) {
      console.warn('[chat] duplicate message id, ignoring:', msg.id)
      return false
    }

    ensureThread(chatId)
    messages.value[chatId].push(msg)

    // 加密存储到 IndexedDB
    try {
      if (!messageEncryptKey) {
        messageEncryptKey = await getOrCreateMessageEncryptKey()
      }
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
        burnAt: msg.burnAt || null
      })
    } catch (e) {
      // DB add failed (e.g. ConstraintError on duplicate) — roll back in-memory addition
      const idx = messages.value[chatId]?.findIndex(m => m.id === msg.id)
      if (idx !== undefined && idx !== -1) messages.value[chatId].splice(idx, 1)
      console.error('[chat] persist message failed, rolled back:', e)
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
      if (!messageEncryptKey) {
        messageEncryptKey = await getOrCreateMessageEncryptKey()
      }

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
          return { ...m, text: decryptedText }
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
      if (!messageEncryptKey) {
        messageEncryptKey = await getOrCreateMessageEncryptKey()
      }

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
            grouped[cid].push({ ...m, text: decryptedText })
          }
        } catch (e) {
          console.warn('[chat] decrypt message failed:', m.id, e)
          grouped[cid].push({ ...m, text: '[解密失败]' })
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
    const ok = send('message', {
      to: toChatId,
      msg_id: msgId,
      ephemeral_pub_key: encrypted.ephemeralPubKey,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      burn_after_read: burnAfterRead
    })
    if (ok) {
      await addMessage(toChatId, {
        id: msgId,
        from: 'me',
        text,
        ts: Date.now(),
        mine: true,
        burnAfterRead: burnAfterRead,
        burnAt: null  // 阅读后才设置删除时间
      })
    }
    return ok
  }

  // ── 文件传输 ──────────────────────────────────────────────────

  /**
   * 将文件明文加密后持久化到 IndexedDB（与消息记录分离，懒加载）。
   * 失败不影响消息收发，仅退化为「刷新后过期」。
   */
  async function persistFileBlob(chatId, msgId, arrayBuffer, filetype) {
    try {
      if (!messageEncryptKey) messageEncryptKey = await getOrCreateMessageEncryptKey()
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
    if (isMsgIdExists(msg.id)) return false
    ensureThread(chatId)
    const fullMsg = { ...msg, type: 'file', read: false }
    messages.value[chatId].push(fullMsg)
    try {
      if (!messageEncryptKey) messageEncryptKey = await getOrCreateMessageEncryptKey()
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
        read: false,
        receiptSent: false
      })
    } catch (e) {
      console.error('[chat] persist file message failed:', e)
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
      send('file_error', { to: tr.fromChatId, transfer_id: transferId, reason: '接收超时' })
    }, RECEIVE_STALL_MS)
  }

  function clearReceiveWatchdog(transferId) {
    const t = fileTransfers.value[transferId]
    if (t && t.timer) { clearTimeout(t.timer); t.timer = null }
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

      const blob = new Blob([plainBuf], { type: transfer.filetype })
      const objectUrl = URL.createObjectURL(blob)
      transfer.objectUrl = objectUrl

      // 持久化加密文件体，刷新后仍可下载/预览
      await persistFileBlob(transfer.fromChatId, transfer.msgId, plainBuf, transfer.filetype)

      await addFileMessage(transfer.fromChatId, {
        id: transfer.msgId,
        from: transfer.fromChatId,
        filename: transfer.filename,
        filesize: transfer.filesize,
        filetype: transfer.filetype,
        objectUrl,
        mine: false,
        ts: transfer.ts  // 服务器时间戳，与发送端一致
      })
      // 通知发送端：已收齐并解密成功，回带服务器时间戳供发送端统一显示
      send('file_done', { to: transfer.fromChatId, transfer_id: transfer.id, ts: transfer.ts })
    } catch (e) {
      transfer.status = 'error'
      transfer.errorReason = '文件解密失败'
      transfer.errorAt = Date.now()
      clearReceiveWatchdog(transfer.id)
      send('file_error', { to: transfer.fromChatId, transfer_id: transfer.id, reason: '文件解密失败' })
      console.error('[chat] file decrypt failed:', e)
    }
  }

  /**
   * 验证文件类型和大小
   */
  function validateFile(file) {
    if (file.size > MAX_FILE_SIZE) throw new Error('文件超过 10MB 限制')
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_MIME_TYPES.has(file.type) && !ALLOWED_EXTENSIONS.has(ext)) throw new Error('不支持的文件格式')
  }

  /**
   * 发送文件（P2P WebSocket 中继）
   * @param {string} toChatId
   * @param {string} recipientPubKey
   * @param {File} file
   */
  async function sendFile(toChatId, recipientPubKey, file) {
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
        iv
      })
      if (!ok) throw new Error('发送失败，请检查网络连接')

      // 等待对方接受
      await waitForFileAccept(transferId, 30000)
      fileTransfers.value[transferId].status = 'transferring'

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
      send('file_complete', { to: toChatId, transfer_id: transferId })
      fileTransfers.value[transferId].progress = 100

      // 等待接收端确认收齐并解密成功；超时或收到 file_error 则按失败处理
      // 返回的 ts 为服务器时间戳，与接收端显示一致
      const doneTs = await waitForFileDone(transferId, 30000)
      fileTransfers.value[transferId].status = 'done'

      // 发送方本地展示
      const blob = new Blob([fileBuffer], { type: file.type })
      const objectUrl = URL.createObjectURL(blob)
      // 持久化加密文件体，刷新后仍可下载/预览
      await persistFileBlob(toChatId, msgId, fileBuffer, file.type)
      await addFileMessage(toChatId, {
        id: msgId,
        from: 'me',
        filename: file.name,
        filesize: file.size,
        filetype: file.type,
        objectUrl,
        mine: true,
        ts: (typeof doneTs === 'number' && doneTs > 0) ? doneTs : Date.now()  // 服务器时间戳，与接收端一致
      })

      return transferId
    } catch (e) {
      if (fileTransfers.value[transferId]) {
        fileTransfers.value[transferId].status = 'error'
        fileTransfers.value[transferId].errorReason = e.message
        fileTransfers.value[transferId].errorAt = Date.now()
      }
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
          burnAt: null,
          receivedAt: Date.now()  // 记录本地接收时间用于相对计时
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
            burn_after_read: payload.burn_after_read || false,
            receivedAt: Date.now()
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
      for (const chatId in messages.value) {
        const msg = messages.value[chatId].find(m => m.id === msgId)
        if (msg) { msg.ts = ts; break }
      }
      await dbUpdateMessageTs(msgId, ts)
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
      if (!Array.isArray(payload.msg_id) || payload.msg_id.length === 0) {
        console.warn('[chat] invalid msg_id in read_receipt:', payload.msg_id)
        return
      }
      for (const id of payload.msg_id) {
        if (!validateMsgId(id)) {
          console.warn('[chat] invalid msg_id item:', id)
          return
        }
      }
      await handleReadReceipt(payload.from, payload.msg_id)
    }

    // ── 文件传输事件 ────────────────────────────────────────────

    function onFileOffer(payload) {
      const { from, transfer_id, msg_id, filename, filesize, filetype, total_chunks, ephemeral_pub_key, iv } = payload
      if (!validateChatId(from) || !transfer_id || !filename || !total_chunks) return

      fileTransfers.value[transfer_id] = {
        id: transfer_id,
        msgId: (msg_id && validateMsgId(msg_id)) ? msg_id : genMsgId(),  // 优先使用发送方的 msgId，确保两端 ID 一致
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
        ts: (typeof payload.ts === 'number' && payload.ts > 0) ? payload.ts : Date.now(),  // 服务器时间戳，两端统一
        timer: null
      }
      // 启动停滞看门狗，避免某块丢失导致永久卡在传输中
      armReceiveWatchdog(transfer_id)
      // 自动接受
      send('file_accept', { to: from, transfer_id })
    }

    function onFileChunk(payload) {
      const { transfer_id, chunk_index, data } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (!transfer || transfer.direction !== 'receive' || transfer.status !== 'transferring') return
      if (chunk_index < 0 || chunk_index >= transfer.totalChunks || transfer.chunks[chunk_index]) return

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
      const { transfer_id } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (!transfer || transfer.direction !== 'receive' || transfer.status !== 'transferring') return
      // 收齐则组装；缺块则判定失败并通知发送方，避免发送端误以为成功
      if (transfer.receivedCount < transfer.totalChunks || transfer.chunks.some(c => !c)) {
        transfer.status = 'error'
        transfer.errorReason = '文件传输不完整'
        transfer.errorAt = Date.now()
        clearReceiveWatchdog(transfer_id)
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
      }
    }

    on('message', onMessage)
    on('recall', onRecall)
    on('ack', onAck)
    on('read_receipt', onReadReceipt)
    on('file_offer', onFileOffer)
    on('file_chunk', onFileChunk)
    on('file_complete', onFileComplete)
    on('file_error', onFileError)
    return () => {
      off('message', onMessage)
      off('recall', onRecall)
      off('ack', onAck)
      off('read_receipt', onReadReceipt)
      off('file_offer', onFileOffer)
      off('file_chunk', onFileChunk)
      off('file_complete', onFileComplete)
      off('file_error', onFileError)
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
      if (Array.isArray(data.msg_ids) && data.msg_ids.length > 0) {
        await handleReadReceipt(peerChatId, data.msg_ids)
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
    const readReceivedAt = Date.now()
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
    // 发送已读回执到服务器，to 是消息发送者（对方）（send 已在文件顶部静态导入）
    const ok = send('read', { to: chatId, msg_id: pendingReceiptIds })
    // 仅在确认成功发出后才记录 receiptSent；否则保持 false，下次打开聊天会重发，
    // 避免「本地已读但回执丢失」导致发送方永远停在单勾
    if (ok) {
      const sentSet = new Set(pendingReceiptIds)
      for (const m of msgs) {
        if (sentSet.has(m.id)) m.receiptSent = true
      }
      await Promise.all(pendingReceiptIds.map(id => dbMarkReceiptSent(id).catch(() => {})))
    }
  }

  /**
   * 处理对方发来的已读回执通知（我发的消息被对方读了）
   * 对于阅后即焚消息，使用相对计时（防止系统时间篡改）
   */
  async function handleReadReceipt(fromChatId, msgIds) {
    // 使用相对计时：记录收到回执的时间，而不是计算绝对删除时间
    const readReceivedAt = Date.now()
    for (const chatId in messages.value) {
      if (chatId === fromChatId) {
        for (const m of messages.value[chatId]) {
          if (m.mine && msgIds.includes(m.id)) {
            m.read = true
            // 阅后即焚消息：记录收到回执时间（相对计时）
            if (m.burnAfterRead) {
              m.readReceivedAt = readReceivedAt
              m.burnAt = readReceivedAt + BURN_AFTER_READ_DELAY  // 仍保留用于显示倒计时
              // 更新 IndexedDB
              const record = {
                id: m.id,
                chatId: chatId,
                from: m.from,
                text: m.text,
                ts: m.ts,
                mine: m.mine,
                read: true,
                burnAfterRead: true,
                readReceivedAt: readReceivedAt,
                burnAt: m.burnAt
              }
              await dbPutMessage(record).catch(() => {})
            }
          }
        }
      }
    }
    await Promise.all(msgIds.map(id => dbMarkMessageRead(id).catch(() => {})))
  }

  // ── 定时删除过期消息 ────────────────────────────────────────

  let burnTimer = null

  /**
   * 启动定时删除检查（每分钟检查一次）
   * 使用相对计时，防止系统时间篡改绕过删除
   */
  function startBurnTimer() {
    if (burnTimer) return
    burnTimer = setInterval(async () => {
      const now = Date.now()
      for (const chatId in messages.value) {
        const msgs = messages.value[chatId]
        const toDelete = []
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          // 使用相对计时：检查从收到已读回执后是否超过2小时
          if (m.burnAfterRead && m.readReceivedAt) {
            const elapsed = now - m.readReceivedAt
            if (elapsed >= BURN_AFTER_READ_DELAY) {
              toDelete.push(m)
              msgs.splice(i, 1)
            }
          }
          // 兼容旧数据：使用 burnAt
          else if (m.burnAt && m.burnAt <= now) {
            toDelete.push(m)
            msgs.splice(i, 1)
          }
        }
        // 删除 IndexedDB 中的过期消息，并清理文件副本（内存 blob + 文件体）
        for (const m of toDelete) {
          await dbDeleteMessage(m.id).catch(() => {})
          await deleteFileArtifacts(m, m.id)
        }
      }
    }, 60000)  // 每分钟检查一次
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
   * 使用相对计时，防止系统时间篡改绕过删除
   */
  async function checkExpiredMessages() {
    const now = Date.now()
    for (const chatId in messages.value) {
      const msgs = messages.value[chatId]
      const toDelete = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        // 使用相对计时
        if (m.burnAfterRead && m.readReceivedAt) {
          const elapsed = now - m.readReceivedAt
          if (elapsed >= BURN_AFTER_READ_DELAY) {
            toDelete.push(m)
            msgs.splice(i, 1)
          }
        }
        // 兼容旧数据
        else if (m.burnAt && m.burnAt <= now) {
          toDelete.push(m)
          msgs.splice(i, 1)
        }
      }
      for (const m of toDelete) {
        await dbDeleteMessage(m.id).catch(() => {})
        await deleteFileArtifacts(m, m.id)
      }
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
          burnAt: null,
          receivedAt: p.receivedAt || Date.now()
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
