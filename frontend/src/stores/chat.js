import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { encryptMessage, decryptMessage, encryptFile, decryptFile, bufToB64, b64ToBuf } from 'src/services/crypto'
import { send, on, off } from 'src/services/websocket'
import { notifyNewMessage } from 'src/services/notify'

// ── 安全常量 ──────────────────────────────────────────────

const DB_NAME = 'e2eechat_messages'
const DB_VERSION = 3  // 升级版本以支持加密存储
const STORE_NAME = 'messages'
const KEY_STORE_NAME = 'message_key'  // 存储消息加密密钥
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

      decryptedMsgs.sort((a, b) => a.ts - b.ts)
      messages.value[chatId] = decryptedMsgs
    } catch (e) {
      console.error('[chat] load messages failed:', e)
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
    try {
      await dbClearMessages(chatId)
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
        read: false
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
   * 组装并解密接收到的文件数据块
   */
  async function assembleAndDecrypt(transfer) {
    if (transfer.status === 'done' || transfer.status === 'error') return
    if (transfer.receivedCount < transfer.totalChunks) return
    if (transfer.chunks.some(c => !c)) return

    transfer.status = 'done'
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

      await addFileMessage(transfer.fromChatId, {
        id: transfer.msgId,
        from: transfer.fromChatId,
        filename: transfer.filename,
        filesize: transfer.filesize,
        filetype: transfer.filetype,
        objectUrl,
        mine: false,
        ts: Date.now()
      })
    } catch (e) {
      transfer.status = 'error'
      transfer.errorReason = '文件解密失败'
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
      fileTransfers.value[transferId].status = 'done'

      // 发送方本地展示
      const blob = new Blob([fileBuffer], { type: file.type })
      const objectUrl = URL.createObjectURL(blob)
      await addFileMessage(toChatId, {
        id: msgId,
        from: 'me',
        filename: file.name,
        filesize: file.size,
        filetype: file.type,
        objectUrl,
        mine: true,
        ts: Date.now()
      })

      return transferId
    } catch (e) {
      if (fileTransfers.value[transferId]) {
        fileTransfers.value[transferId].status = 'error'
        fileTransfers.value[transferId].errorReason = e.message
      }
      send('file_error', { to: toChatId, transfer_id: transferId, reason: e.message })
      throw e
    }
  }

  async function recallMessage(chatId, msgId, toChatId) {
    // 本地删除
    const msgs = messages.value[chatId]
    if (msgs) {
      const idx = msgs.findIndex(m => m.id === msgId)
      if (idx !== -1) msgs.splice(idx, 1)
    }
    await dbDeleteMessage(msgId)
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

      try {
        const text = await decryptMessage({
          ephemeralPubKey: payload.ephemeral_pub_key,
          iv: payload.iv,
          ciphertext: payload.ciphertext
        })
        notifyNewMessage()
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
        console.error('[chat] decrypt failed', e)
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
      if (msgs) {
        const idx = msgs.findIndex(m => m.id === msgId)
        if (idx !== -1) msgs.splice(idx, 1)
      }
      await dbDeleteMessage(msgId)
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
        iv
      }
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

      // 全部到齐时自动组装（无需等 file_complete）
      if (transfer.receivedCount === transfer.totalChunks) {
        assembleAndDecrypt(transfer)
      }
    }

    function onFileComplete(payload) {
      const { transfer_id } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (!transfer || transfer.direction !== 'receive') return
      assembleAndDecrypt(transfer)
    }

    function onFileError(payload) {
      const { transfer_id, reason } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (transfer && transfer.status !== 'done') {
        transfer.status = 'error'
        transfer.errorReason = reason || '传输失败'
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
    const unreadIds = []
    for (const m of msgs) {
      if (!m.mine && !m.read) {
        m.read = true
        unreadIds.push(m.id)
      }
    }
    if (unreadIds.length === 0) return
    // 持久化已读状态到 IndexedDB
    await Promise.all(unreadIds.map(id => dbMarkMessageRead(id).catch(() => {})))
    // 发送已读回执到服务器，to 是消息发送者（对方）
    const { send } = await import('src/services/websocket')
    send('read', { to: chatId, msg_id: unreadIds })
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
              toDelete.push(m.id)
              msgs.splice(i, 1)
            }
          }
          // 兼容旧数据：使用 burnAt
          else if (m.burnAt && m.burnAt <= now) {
            toDelete.push(m.id)
            msgs.splice(i, 1)
          }
        }
        // 删除 IndexedDB 中的过期消息
        for (const msgId of toDelete) {
          await dbDeleteMessage(msgId).catch(() => {})
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
            toDelete.push(m.id)
            msgs.splice(i, 1)
          }
        }
        // 兼容旧数据
        else if (m.burnAt && m.burnAt <= now) {
          toDelete.push(m.id)
          msgs.splice(i, 1)
        }
      }
      for (const msgId of toDelete) {
        await dbDeleteMessage(msgId).catch(() => {})
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
    checkExpiredMessages
  }
})
