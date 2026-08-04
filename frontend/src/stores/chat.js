import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { encryptMessage, decryptMessage, encryptFile, decryptFile, bufToB64, b64ToBuf } from 'src/services/crypto'
import { send, on, off, confirmPendingReads, getServerNow } from 'src/services/websocket'
import { notifyNewMessage } from 'src/services/notify'
import { useIdentityStore } from 'src/stores/identity'

// ──Safety constants────────────────────────────────────────────

const DB_NAME = 'e2eechat_messages'
const DB_VERSION = 5  //v5: Added message_files persistent encrypted file body (can still be downloaded/previewed after refreshing)
const STORE_NAME = 'messages'
const KEY_STORE_NAME = 'message_key'  //Store message encryption key
const PENDING_STORE_NAME = 'pending_messages'  //The original ciphertext received during the lock period and to be decrypted after unlocking
const FILE_STORE_NAME = 'message_files'  //Encrypted file binary (separated from message records, lazy loading)
const BURN_AFTER_READ_DELAY = 2 * 60 * 60 * 1000  //2 hours

// ── File transfer constants ────────────────────────────────────────

const CHUNK_SIZE = 128 * 1024  //128KB binary chunks
const MAX_FILE_SIZE = 10 * 1024 * 1024  // 10MB
const MAX_FILENAME_BYTES = 255
const AES_GCM_TAG_SIZE = 16
// Browsers and operating systems report MIME inconsistently, so file eligibility is based
// only on the final filename extension. MIME is retained as display/download metadata.
const ALLOWED_FILE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg',
  'mp4', 'webm', 'mov',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf',
  'zip', 'rar', '7z', 'tar', 'gz', 'apk'
])

function expectedFileChunks(filesize) {
  return Math.ceil((filesize + AES_GCM_TAG_SIZE) / CHUNK_SIZE)
}

function expectedFileChunkSize(filesize, chunkIndex) {
  return Math.min(CHUNK_SIZE, filesize + AES_GCM_TAG_SIZE - chunkIndex * CHUNK_SIZE)
}

function validateFileMetadata(filename, _filetype, filesize) {
  if (typeof filename !== 'string' || !filename || new TextEncoder().encode(filename).length > MAX_FILENAME_BYTES) {
    throw new Error('File name is invalid or too long')
  }
  if (!Number.isInteger(filesize) || filesize <= 0) throw new Error('Cannot send empty files')
  if (filesize > MAX_FILE_SIZE) throw new Error('File exceeds 10MB Limit')

  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_FILE_EXTENSIONS.has(ext)) throw new Error('Unsupported file format')
}

// ── Message encryption key management ───────────────────────────────────────────

/**
 * Generate or load message encryption keys
 * The CryptoKey object is directly stored in IndexedDB (Structured Clone), and the raw bytes are never dropped.
 * The old format (raw bytes) is automatically migrated the first time it is read.
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
        // New format: CryptoKey objects stored directly
        if (record.cryptoKey) {
          resolve(record.cryptoKey)
          return
        }
        // Old format: raw bytes → migrated to CryptoKey storage
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
            tx2.onerror = () => resolve(key)  //Migration failure is still available
            return
          } catch (err) {
            reject(err)
            return
          }
        }
      }
      // Generate new non-extractable keys and store them directly in CryptoKey objects
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
 * Encrypted message text (for IndexedDB storage)
 */
async function encryptMessageText(plaintext, key) {
  if (!key) return plaintext  //No encryption when there is no key (downgrade processing)
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
 * Decrypt message text (when loading from IndexedDB)
 */
async function decryptMessageText(encryptedData, key) {
  if (!encryptedData.encrypted) return encryptedData  //unencrypted data
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
 * Encrypted file binary (for IndexedDB persistence).
 * Both iv and ciphertext are stored in the form of ArrayBuffer/TypedArray (structured cloning to avoid base64 expansion).
 */
async function encryptFileBytes(arrayBuffer, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer)
  return { iv, ciphertext }
}

/**
 * Decrypt the file binary (when loading from IndexedDB), returning a plaintext ArrayBuffer.
 */
async function decryptFileBytes(record, key) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.ciphertext)
}

// ── IndexedDB Auxiliary ───────────────────────────────────────────

function openMessagesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      // Check if object store already exists
      let store
      if (db.objectStoreNames.contains(STORE_NAME)) {
        // Already exists, get the existing store
        store = e.target.transaction.objectStore(STORE_NAME)
      } else {
        // Does not exist, create a new store
        store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
      // Add index if not present
      if (!store.indexNames.contains('burnAt')) {
        store.createIndex('burnAt', 'burnAt', { unique: false })
      }
      // Add message encryption key storage
      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
        db.createObjectStore(KEY_STORE_NAME, { keyPath: 'id' })
      }
      // Temporarily store the original ciphertext that cannot be decrypted during the lock period (complementary decryption after unlocking)
      if (!db.objectStoreNames.contains(PENDING_STORE_NAME)) {
        db.createObjectStore(PENDING_STORE_NAME, { keyPath: 'msg_id' })
      }
      // Encrypted file body: key = message ID, with chatId attached to facilitate cleaning by session
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

// ── File persistence ───────────────────────────────────────────

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

// Clear file body by session (with clearChatMessages)
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

// Mark the read receipt of a message as "confirmed" and persist it so that it is not lost after refreshing.
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

// When the receiving end reads the burn-after-read message for the first time, it starts the destruction countdown and persists it (retaining other fields of the record)
// Only set read=true for messages that are not ephemeral after reading; for messages that have started a countdown, the operation is idempotent.
// Therefore it can be safely called on any msg_id without requiring the caller to prejudge burnAfterRead.
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
        // Only set the destruction time for messages that will burn after reading and the countdown has not been started.
        // Avoid repeated receipts (syncReadStatus returns the same batch of IDs each time) causing the countdown to be reset repeatedly
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

// After the reader receives the server's read_ack, it corrects the local pre-start countdown with the first read time in the database.
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

// ── Temporary storage of ciphertext to be decrypted (locked period) ─────────────────────────────────

async function dbAddPending(payload) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE_NAME, 'readwrite')
    // put instead of add: overwrite when the same msg_id arrives repeatedly to avoid ConstraintError
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

// ── Store definition ──────────────────────────────────────────────

let msgCounter = 0

/**
 * Generate a globally unique message ID
 * Format: timestamp-base36 + counter + random
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

  // Text message waiting for server ACK. ACK timeout only changes the local display status and does not automatically resend to avoid repeated messages.
  const ackTimers = new Map()
  const MESSAGE_ACK_TIMEOUT_MS = 15000
  // Message storage is asynchronous; the other party may have opened a session and sent back a read notification within a very short window.
  // This type of early receipt is temporarily stored and used immediately when the local message is stored in the database.
  const earlyReadReceipts = new Map()
  const EARLY_READ_RECEIPT_MAX = 500

  // Message encryption key (used to encrypt IndexedDB storage)
  let messageEncryptKey = null
  // Singleton first key initialization: concurrent calls share the same Promise to avoid generating different keys.
  // Otherwise, during cold start, multiple offline messages enter addMessage concurrently and will each take the "no key → generate new key" branch.
  // A fork occurs, the last one is dropped, and decryption fails when reloading messages previously encrypted with other keys ([Decryption Failed]).
  let messageKeyPromise = null

  async function ensureMessageKey() {
    if (messageEncryptKey) return messageEncryptKey
    if (!messageKeyPromise) {
      messageKeyPromise = getOrCreateMessageEncryptKey()
        .then((k) => { messageEncryptKey = k; return k })
        .catch((e) => { messageKeyPromise = null; throw e })  //Retry if failed
    }
    return messageKeyPromise
  }

  function ensureThread(chatId) {
    if (!messages.value[chatId]) messages.value[chatId] = []
  }

  /**
   * Check if the message ID already exists (prevents replay attacks)
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
   * Add messages to memory and encrypt persistence to IndexedDB
   */
  async function addMessage(chatId, msg) {
    // Security Check: Preventing Replay Attacks
    if (isMsgIdExists(msg.id)) {
      console.warn('[chat] duplicate message id, ignoring:', msg.id)
      return false
    }

    const earlyReceipt = applyEarlyReadReceipt(msg)
    ensureThread(chatId)
    messages.value[chatId].push(msg)

    // Encrypted storage to IndexedDB
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
      // DB write failure: Keep message in memory (still visible to user), only lost after refresh.
      // Rolling back the memory will lead to the inconsistency of "the message has been sent but the sender cannot see it"——
      // The other party has received the message, but the sender has neither memory records nor DB records locally.
      console.error('[chat] persist message failed, kept in memory:', e)
      return false
    }
    return true
  }

  /**
   * Load the message with the specified chatId from IndexedDB and decrypt it
   */
  async function loadMessages(chatId) {
    try {
      // Initialize encryption keys
      await ensureMessageKey()

      // Keep the existing blob URL in memory (the store singleton still holds the valid URL when switching chats)
      const existingUrls = {}
      for (const m of messages.value[chatId] || []) {
        if (m.type === 'file' && m.objectUrl) existingUrls[m.id] = m.objectUrl
      }

      const allMsgs = await dbGetAllMessages()
      const chatMsgs = allMsgs.filter(m => m.chatId === chatId || m.from === chatId)

      // Decrypt message text
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
          return { ...m, text: '[Decryption failed]' }
        }
      }))

      // Lazy loading of file bodies: Rebuild from IndexedDB only for file messages with "no valid blob URL in memory".
      // Only works on the currently open session to avoid reading all files into memory at once.
      await Promise.all(decryptedMsgs.map(async (m) => {
        if (m.type !== 'file' || m.objectUrl) return
        try {
          const rec = await dbGetFile(m.id)
          if (!rec) return  //No persistent copy (old data/not saved successfully) → keep null and display "Expired"
          const buf = await decryptFileBytes(rec, messageEncryptKey)
          m.objectUrl = URL.createObjectURL(new Blob([buf], { type: m.filetype || rec.filetype }))
        } catch (e) {
          console.warn('[chat] rehydrate file blob failed:', m.id, e)
        }
      }))

      // Merge messages that are already in the memory but not in the DB snapshot (deletion by id) to avoid messages arriving during loading being
      // Clear the entire coverage. See the similar fix instructions in loadAllMessages for details.
      const ids = new Set(decryptedMsgs.map((m) => m.id))
      for (const m of messages.value[chatId] || []) {
        if (!ids.has(m.id)) decryptedMsgs.push(m)
      }

      decryptedMsgs.sort((a, b) => a.ts - b.ts)
      messages.value[chatId] = decryptedMsgs
    } catch (e) {
      console.error('[chat] load messages failed:', e)
      // Release existing blob URLs before discarding to avoid memory leaks in failed loading paths.
      for (const m of messages.value[chatId] || []) releaseFileObjectUrl(m)
      messages.value[chatId] = []
    }
  }

  /**
   * Load all messages from IndexedDB and decrypt (called when app starts)
   */
  async function loadAllMessages() {
    try {
      // Initialize encryption keys
      await ensureMessageKey()

      // Keep the blob URL already in memory
      const existingUrls = {}
      for (const cid in messages.value) {
        for (const m of messages.value[cid]) {
          if (m.type === 'file' && m.objectUrl) existingUrls[m.id] = m.objectUrl
        }
      }

      const allMsgs = await dbGetAllMessages()
      const grouped = {}

      // Decrypt and group
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
          grouped[cid].push({ ...m, text: '[Decryption failed]' })
        }
      }

      // Merge messages that are already in the memory but not in the DB snapshot (remove duplicates by id).
      // Key fix: dbGetAllMessages reads the DB snapshot "at the moment of reading" during cold start. If the message is offline
      // After "reading DB" and before "assigning messages.value", addMessage arrives and is stored in the database directly.
      // The overall coverage will clear these newly arrived messages from the memory (it actually exists in the DB, so it only appears after tab reloading).
      // Change to merge retention: messages that are in the memory but not in the snapshot are grouped. Recall/Destroy will clear the memory and
      // DB, so deleted messages will not be revived.
      for (const cid in messages.value) {
        const ids = new Set((grouped[cid] || []).map((m) => m.id))
        for (const m of messages.value[cid]) {
          if (!ids.has(m.id)) {
            if (!grouped[cid]) grouped[cid] = []
            grouped[cid].push(m)
          }
        }
      }

      // sort
      for (const cid in grouped) {
        grouped[cid].sort((a, b) => a.ts - b.ts)
      }
      messages.value = grouped
    } catch (e) {
      console.error('[chat] load all messages failed:', e)
    }
  }

  /**
   * Clear messages with specified chatId (clear IndexedDB and memory)
   */
  async function clearChatMessages(chatId) {
    // First release all file blob URLs of the session in memory to avoid leaks
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
   * Send encrypted messages
   * @param {string} toChatId - receiver chat_id
   * @param {string} recipientPubKey - recipient’s public key (Base64)
   * @param {string} text - plain text
   * @param {boolean} burnAfterRead - burn after reading (automatically deleted 2 hours after the other party reads it)
   */
  async function sendMessage(toChatId, recipientPubKey, text, burnAfterRead = false) {
    const msgId = genMsgId()
    const encrypted = await encryptMessage(text, recipientPubKey)

    // First establish a local pending record to ensure that the corresponding message can be found when the extremely fast ACK arrives.
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

  // ── File transfer ─────────────────────────────────────────────

  /**
   * Encrypt the plain text of the file and persist it to IndexedDB (separated from message records, lazy loading).
   * The failure does not affect message sending and receiving, but only degrades to "expire after refresh".
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
   * Release the blob URL (memory) held by the message to avoid leaks. Must be called when deleting/expiring a message.
   */
  function releaseFileObjectUrl(msg) {
    if (msg && msg.type === 'file' && msg.objectUrl) {
      URL.revokeObjectURL(msg.objectUrl)
      msg.objectUrl = null
    }
  }

  /**
   * When deleting a message, clean up its file copy: free memory blob URL + delete IndexedDB file body.
   * msg may be undefined (no longer exists in memory), in which case only the persistent copy is cleaned.
   */
  async function deleteFileArtifacts(msg, msgId) {
    releaseFileObjectUrl(msg)
    await dbDeleteFile(msgId).catch(() => {})
  }

  /**
   * Add file messages to memory and IndexedDB (metadata only)
   */
  async function addFileMessage(chatId, msg) {
    if (isMsgIdExists(msg.id)) {
      // Duplicate message: Release the objectUrl passed in by the caller to avoid leaks
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
        // Read read/countdown status from fullMsg (i.e. the same object pushed into memory):
        // After receiving the file, markAsRead may mark it as read and write burnAt before dbAddMessage.
        // In this way, the state can be captured during persistence to avoid losing the countdown after reloading (consistent with addMessage behavior)
        read: fullMsg.read || false,
        receiptSent: fullMsg.receiptSent || false,
        burnAfterRead: msg.burnAfterRead || false,
        readReceivedAt: fullMsg.readReceivedAt || null,
        burnAt: fullMsg.burnAt || null,
        status: fullMsg.status || (fullMsg.mine ? 'sent' : undefined)
      })
      if (earlyReceipt) confirmReadReceiptsApplied(chatId, [earlyReceipt.msg_id])
    } catch (e) {
      // DB write failure: retain messages in memory (still visible to users), clean up orphan file bodies (messages are lost after refresh)
      await dbDeleteFile(msg.id).catch(() => {})
      console.error('[chat] persist file message failed, kept in memory:', e)
      return false
    }
    return true
  }

  /**
   * Wait for file_accept or file_reject (Promise-ified)
   */
  function waitForFileAccept(transferId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off('file_accept', onAccept)
        off('file_reject', onReject)
        off('file_error', onErr)
        reject(new Error('The other party did not respond，Please confirm that the other party is online and try again'))
      }, timeoutMs)

      function cleanup() { clearTimeout(timer); off('file_accept', onAccept); off('file_reject', onReject); off('file_error', onErr) }
      function onAccept(p) { if (p.transfer_id === transferId) { cleanup(); resolve() } }
      function onReject(p) { if (p.transfer_id === transferId) { cleanup(); reject(new Error('The other party refused the file transfer')) } }
      function onErr(p) { if (p.transfer_id === transferId) { cleanup(); reject(new Error(p.reason || 'File transfer error')) } }

      on('file_accept', onAccept)
      on('file_reject', onReject)
      on('file_error', onErr)
    })
  }

  /**
   * Wait for the receiving end to confirm that it has been received and decrypted successfully (file_done), or receives file_error / timeout
   */
  function waitForFileDone(transferId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off('file_done', onDone)
        off('file_error', onErr)
        reject(new Error('The other party has not confirmed receipt，Document may not have been delivered'))
      }, timeoutMs)

      function cleanup() { clearTimeout(timer); off('file_done', onDone); off('file_error', onErr) }
      function onDone(p) { if (p.transfer_id === transferId) { cleanup(); resolve(p.ts) } }
      function onErr(p) { if (p.transfer_id === transferId) { cleanup(); reject(new Error(p.reason || 'The other party failed to receive')) } }

      on('file_done', onDone)
      on('file_error', onErr)
    })
  }

  // ── Receiver transmission watchdog: detect block stagnation to avoid permanent stuck due to loss of a certain block ──────────
  const RECEIVE_STALL_MS = 30000  //If there is no new progress within 30 seconds, the transmission will be deemed to have failed.

  function armReceiveWatchdog(transferId) {
    const t = fileTransfers.value[transferId]
    if (!t) return
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      const tr = fileTransfers.value[transferId]
      if (!tr || tr.status === 'done' || tr.status === 'error') return
      tr.status = 'error'
      tr.errorReason = 'Transmission timeout'
      tr.errorAt = Date.now()
      scheduleTransferCleanup(transferId, 6000)
      send('file_error', { to: tr.fromChatId, transfer_id: transferId, reason: 'receive timeout' })
    }, RECEIVE_STALL_MS)
  }

  function clearReceiveWatchdog(transferId) {
    const t = fileTransfers.value[transferId]
    if (t && t.timer) { clearTimeout(t.timer); t.timer = null }
  }

  // ── Transfer record cleaning: Delay deletion after final state to avoid infinite accumulation of fileTransfers ──────────
  // done: Clean up after 1s (give the UI a moment to show completion); error: Clean up after 6s (cover the 5s error window of activeTransfer)
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
   * Assemble and decrypt received file data blocks
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
        throw new Error('The decrypted file size does not match the size reported by the sender')
      }

      const blob = new Blob([plainBuf], { type: transfer.filetype })
      const objectUrl = URL.createObjectURL(blob)
      transfer.objectUrl = objectUrl

      // Persistent encrypted file body can still be downloaded/previewed after refreshing
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
        ts: transfer.ts  //Timestamp, consistent with the sender
      })
      if (!added) {
        // The message is not stored in the database (duplicate ID or DB failure), but the file is successfully received and decrypted and is visible in memory
        // Duplicate ID: message already exists; DB failure: message in memory (lost after refresh)
        console.warn('[chat] file message not persisted:', transfer.msgId)
      }
      // Notify the sending end: All has been collected and decrypted successfully, and a timestamp is returned for unified display by the sending end.
      send('file_done', { to: transfer.fromChatId, transfer_id: transfer.id, ts: transfer.ts })
      scheduleTransferCleanup(transfer.id, 1000)
    } catch (e) {
      transfer.status = 'error'
      transfer.errorReason = 'File decryption failed'
      transfer.errorAt = Date.now()
      clearReceiveWatchdog(transfer.id)
      scheduleTransferCleanup(transfer.id, 6000)
      send('file_error', { to: transfer.fromChatId, transfer_id: transfer.id, reason: 'File decryption failed' })
      console.error('[chat] file decrypt failed:', e)
    }
  }

  /**
   * Verify file type and size
   */
  function validateFile(file) {
    validateFileMetadata(file.name, file.type, file.size)
  }

  /**
   * Send files (P2P WebSocket relay)
   * @param {string} toChatId
   * @param {string} recipientPubKey
   * @param {File} file
   * @param {boolean} burnAfterRead - burn after reading (automatically deleted 2 hours after the other party reads it)
   */
  async function sendFile(toChatId, recipientPubKey, file, burnAfterRead = false) {
    validateFile(file)

    const transferId = crypto.randomUUID()
    const msgId = genMsgId()  //Message record ID (in read receipt format), separate from the UUID used for WebSocket routing
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
      // Read and encrypt files
      const fileBuffer = await file.arrayBuffer()
      const { ephemeralPubKey, iv, ciphertext } = await encryptFile(fileBuffer, recipientPubKey)

      // First create a local record of the sender to be confirmed and save the file body. In this way, the file_done on the receiving end is even on the sending side.
      // After a momentary disconnection, the file can be reposted offline and the file can be restored to successfully sent based on msg_id by restarting the application.
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

      // Chunking
      const cipherArr = new Uint8Array(ciphertext)
      const chunks = []
      for (let i = 0; i < cipherArr.length; i += CHUNK_SIZE) {
        chunks.push(cipherArr.slice(i, i + CHUNK_SIZE))
      }
      const totalChunks = chunks.length
      fileTransfers.value[transferId].totalChunks = totalChunks

      // Send offer
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
        ts: Date.now()  //The sender timestamp is used by the receiver as the message time (overridden by the backend relay if ts is injected)
      })
      if (!ok) throw new Error('Sending failed，Please check network connection')

      // Wait for the other party to accept
      await waitForFileAccept(transferId, 30000)
      fileTransfers.value[transferId].status = 'transferring'

      // Must listen for completion receipt before sending the first block. When the receiving end receives the last block, it will immediately decrypt it and send it.
      // file_done; if you listen after all blocks have been sent, the fast receipt will be discarded by the WebSocket layer.
      const doneResultPromise = waitForFileDone(transferId, 120000)
        .then(ts => ({ ok: true, ts }), error => ({ ok: false, error }))

      // Send chunk by chunk
      for (let i = 0; i < chunks.length; i++) {
        if (fileTransfers.value[transferId]?.status === 'error') throw new Error('Transfer interrupted')
        const sent = send('file_chunk', {
          to: toChatId,
          transfer_id: transferId,
          chunk_index: i,
          data: bufToB64(chunks[i].buffer)
        })
        if (!sent) throw new Error('Network outage，File sending failed')
        fileTransfers.value[transferId].progress = Math.round((i + 1) / totalChunks * 95)
        // Give way to the event loop every 10 blocks to avoid blocking the UI
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 0))
      }

      // Send completion signal
      if (!send('file_complete', { to: toChatId, transfer_id: transferId })) {
        throw new Error('Network outage，File completion signal failed to send')
      }
      fileTransfers.value[transferId].progress = 100

      // Wait for the receiving end to confirm that it has been received and decrypted successfully; if it times out or receives a file_error, it will be treated as a failure.
      // The returned ts comes from the receiving end, and both ends display the same
      const doneResult = await doneResultPromise
      if (!doneResult.ok) throw doneResult.error
      const doneTs = doneResult.ts
      fileTransfers.value[transferId].status = 'done'
      scheduleTransferCleanup(transferId, 1000)

      // The timestamp of file_done is injected from the offer session by the backend, and is unified at both ends; the global monitoring will also perform the same
      // Idempotent update to cover the completion notification after disconnection or page restart.
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
    // local delete
    const msgs = messages.value[chatId]
    let removed
    if (msgs) {
      const idx = msgs.findIndex(m => m.id === msgId)
      if (idx !== -1) removed = msgs.splice(idx, 1)[0]
    }
    await dbDeleteMessage(msgId)
    await deleteFileArtifacts(removed, msgId)
    // Notify the other party to withdraw
    if (toChatId) {
      send('recall', { to: toChatId, msg_id: msgId })
    }
  }

  // ── Security verification constants ───────────────────────────────────────────

const CHAT_ID_PATTERN = /^\d{4}-[A-Z]{4}$/
const MSG_ID_PATTERN = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/
const TRANSFER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Verify chat_id format in payload
 */
function validateChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return false
  return CHAT_ID_PATTERN.test(chatId)
}

/**
 * Verify msg_id format in payload
 */
function validateMsgId(msgId) {
  if (!msgId || typeof msgId !== 'string') return false
  return MSG_ID_PATTERN.test(msgId)
}

/**
 * Register WebSocket message listening (called when the chat page is mounted)
   */
  function startListening() {
    async function onMessage(payload) {
      // Security verification: check payload structure
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
      // Verify encryption parameters
      if (!payload.ephemeral_pub_key || !payload.iv || !payload.ciphertext) {
        console.warn('[chat] missing encryption params in message')
        return
      }
      // Verify timestamp (using server time)
      if (typeof payload.ts !== 'number' || payload.ts < 0) {
        console.warn('[chat] invalid ts in message:', payload.ts)
        return
      }

      // Reminder is placed before decryption: the private key has been cleared in the locked state and the message cannot be decrypted.
      // However, the user should still be informed of "received new message" and trigger a flash (the notification text is general and does not contain content)
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
          ts: payload.ts,  //Use server time
          mine: false,
          burnAfterRead: payload.burn_after_read || false,
          burnAt: null
        })
      } catch (e) {
        // If the private key has been cleared in the locked state, decryption must fail: the original ciphertext is temporarily stored and decrypted after unlocking.
        // Decryption failure in the non-locked state is considered true damage, and the original "discard" behavior is used.
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
      // Security verification
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
      // Security verification
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
      // Security verification
      if (!payload) {
        console.warn('[chat] empty read_receipt payload')
        return
      }
      if (!validateChatId(payload.from)) {
        console.warn('[chat] invalid from in read_receipt:', payload.from)
        return
      }
      let receipts = payload.receipts
      // Compatible with the old backend's ID-only format during rolling releases; the new backend always provides authoritative read_at.
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

      // Use the server's first reading time to calibrate the reader's own destruction time, covering the local time degradation value within a very short window before authentication.
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

    // ── File transfer event ─────────────────────────────────────────

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
        if (!validateMsgId(msg_id)) throw new Error('File message number is invalid')
        if (!Number.isInteger(total_chunks) || total_chunks !== expectedFileChunks(filesize)) {
          throw new Error('Number of file chunks does not match declared size')
        }
        if (typeof ephemeral_pub_key !== 'string' || !ephemeral_pub_key || typeof iv !== 'string' || !iv) {
          throw new Error('Missing file encryption parameters')
        }
        if (fileTransfers.value[transfer_id]) throw new Error('Duplicate file transfer number')
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
        ts: (typeof payload.ts === 'number' && payload.ts > 0) ? payload.ts : Date.now(),  //Server timestamp, unified on both ends
        timer: null
      }
      // Start the stall watchdog to avoid being permanently stuck in transmission due to the loss of a certain block.
      armReceiveWatchdog(transfer_id)
      // Automatically accept
      send('file_accept', { to: from, transfer_id })
    }

    function onFileChunk(payload) {
      const { from, transfer_id, chunk_index, data } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (!transfer || transfer.direction !== 'receive' || transfer.status !== 'transferring') return
      if (from !== transfer.fromChatId || !Number.isInteger(chunk_index) || chunk_index < 0 ||
          chunk_index >= transfer.totalChunks || transfer.chunks[chunk_index] || typeof data !== 'string') {
        failIncomingTransfer(transfer, 'Invalid file chunk received')
        return
      }
      try {
        const decodedSize = b64ToBuf(data).byteLength
        if (decodedSize !== expectedFileChunkSize(transfer.filesize, chunk_index)) {
          throw new Error('File chunk length mismatch')
        }
      } catch {
        failIncomingTransfer(transfer, 'File chunk content or length is invalid')
        return
      }

      transfer.chunks[chunk_index] = data
      transfer.receivedCount++
      transfer.progress = Math.round(transfer.receivedCount / transfer.totalChunks * 95)
      armReceiveWatchdog(transfer_id)  //When there is new progress, the stagnation timer will be reset.

      // Automatically assemble when everything is ready (no need to wait for file_complete)
      if (transfer.receivedCount === transfer.totalChunks) {
        assembleAndDecrypt(transfer)
      }
    }

    function onFileComplete(payload) {
      const { from, transfer_id } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (!transfer || transfer.direction !== 'receive' || transfer.status !== 'transferring') return
      if (from !== transfer.fromChatId) {
        failIncomingTransfer(transfer, 'Invalid file completion signal')
        return
      }
      // If all the blocks are collected, the assembly will be completed; if there are missing blocks, the failure will be determined and the sender will be notified to avoid the sender mistakenly thinking that it is successful.
      if (transfer.receivedCount < transfer.totalChunks || transfer.chunks.some(c => !c)) {
        transfer.status = 'error'
        transfer.errorReason = 'Incomplete file transfer'
        transfer.errorAt = Date.now()
        clearReceiveWatchdog(transfer_id)
        scheduleTransferCleanup(transfer_id, 6000)
        send('file_error', { to: transfer.fromChatId, transfer_id, reason: 'Incomplete reception' })
        return
      }
      assembleAndDecrypt(transfer)
    }

    function onFileError(payload) {
      const { transfer_id, reason } = payload
      const transfer = fileTransfers.value[transfer_id]
      if (transfer && transfer.status !== 'done') {
        transfer.status = 'error'
        transfer.errorReason = reason || 'Transfer failed'
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
    // Release all in-memory file blob URLs (deleteDatabase will clear the file body storage)
    for (const cid in messages.value) {
      for (const m of messages.value[cid]) releaseFileObjectUrl(m)
    }
    await clearAllMessagesDB()
    messages.value = {}
  }

  /**
   * Pull friends' read records from the server to compensate for the read receipts lost while the sender is offline
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
   * Mark a group of messages as read and send a read receipt to the sender
   */
  async function markAsRead(chatId) {
    const msgs = messages.value[chatId] || []
    const readReceivedAt = getServerNow()
    const newlyRead = []        //This new mark is read (for persistent read)
    const burnReads = []        //The first read-out message read by the receiving end needs to start the destruction countdown.
    const pendingReceiptIds = []  //Need to (re)send acknowledgment: The message has been read locally but the acknowledgment has not yet been confirmed as delivered.
    for (const m of msgs) {
      if (m.mine) continue
      if (!m.read) {
        m.read = true
        newlyRead.push(m.id)
        // Burn after reading: The receiving end starts a countdown to destruction after reading it (the "viewer" copy is destroyed)
        if (m.burnAfterRead) {
          m.readReceivedAt = readReceivedAt
          m.burnAt = readReceivedAt + BURN_AFTER_READ_DELAY
          burnReads.push(m.id)
        }
      }
      // As long as the receipt has not been confirmed as delivered, it needs to be reissued - the server RecordRead is idempotent and resending is safe.
      if (!m.receiptSent) pendingReceiptIds.push(m.id)
    }
    // Persist the read status of new tags to IndexedDB
    if (newlyRead.length > 0) {
      const burnSet = new Set(burnReads)
      await Promise.all(newlyRead.map(id =>
        burnSet.has(id)
          ? dbStartBurnCountdown(id, readReceivedAt, readReceivedAt + BURN_AFTER_READ_DELAY).catch(() => {})
          : dbMarkMessageRead(id).catch(() => {})
      ))
    }
    if (pendingReceiptIds.length === 0) return
    // The WebSocket layer uniformly deduplicates, splits each batch into a maximum of 100 items, and only flushes them once to avoid cyclically sending the previous items.
    // Batches that have not yet been ACKed are sent repeatedly, creating an O(n²) request storm.
    send('read', { to: chatId, msg_id: pendingReceiptIds })
  }

  /**
   * Handle the read receipt notification sent by the other party (the message I sent was read by the other party)
   * For messages that disappear after reading, the first reading time recorded by the server is used.
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
        // Messages that will burn after reading: The destruction countdown will only start when a receipt is received "for the first time".
        // The server's getReadReceipts will return the same batch of read IDs every time. If no guards are added,
        // Each time you re-enter the chat/reconnect, readReceivedAt will be reset to the current time.
        // Causes the countdown to repeatedly restart from 2 hours.
        if (m.burnAfterRead && !m.readReceivedAt) {
          m.readReceivedAt = receipt.read_at
          m.burnAt = receipt.read_at + BURN_AFTER_READ_DELAY
        }
      }
    }
    // Unified storage: dbStartBurnCountdown will internally determine burnAfterRead and only write when the countdown is not started.
    // Therefore, only read=true is set for messages that are not ephemeral after reading, and the operation is idempotent for messages that have been processed in memory.
    // Key fix: Even if the message is not loaded into memory (the sender is not on the chat page), the destruction countdown can be started correctly.
    // Avoid DB records staying with read=true but readReceivedAt/burnAt empty and never deleted.
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

  // ── Delete expired messages regularly ──────────────────────────────────────

  let burnTimer = null
  let burnCheckRunning = false

  /**
   * Start scheduled deletion check (check once every minute)
   * Use the server time calibrated during authentication to prevent modification of the device system time to bypass deletion.
   */
  function startBurnTimer() {
    if (burnTimer) return
    burnTimer = setInterval(() => { checkExpiredMessages() }, 60000)
  }

  /**
   * Stop scheduled deletion checks
   */
  function stopBurnTimer() {
    if (burnTimer) {
      clearInterval(burnTimer)
      burnTimer = null
    }
  }

  /**
   * Check and delete expired messages immediately
   * The burnAt index of IndexedDB is also scanned and messages are deleted even if the related session has not been loaded into memory.
   * Metadata and encrypted file body. Data that expired while the app was closed will be cleared immediately after the next startup.
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
   * Called after unlocking: Complementary decryption of the ciphertext temporarily stored during the lock period.
   * Successful → enter the database and delete the temporary storage; still fails after unlocking → treat it as really damaged and delete the temporary storage (self-cleaning);
   * Still locked (private key not ready) → Keep and try again next time you unlock.
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

    // Sort by server time to ensure that the supplementary display order is consistent with the sending order.
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
        // Still failed after unlocking: If it is still locked, keep it for next time, otherwise it is really damaged and delete it.
        if (useIdentityStore().isLocked) {
          break  //Private key is still unavailable, no need to continue trying
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
