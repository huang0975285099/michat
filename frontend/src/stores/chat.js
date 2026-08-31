import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { encryptMessage, decryptMessage, encryptFile, decryptFile, bufToB64, b64ToBuf } from 'src/services/crypto'
import {
  send, on, off, confirmPendingReads, confirmPendingMessage,
  discardPendingMessagesTo, retryPendingMessage, hasPendingMessage,
  isConnected, getServerNow
} from 'src/services/websocket'
import { notifyNewMessage } from 'src/services/notify'
import { buildEncryptedFileOfferPayload, openFileOfferMetadata, sealFileMetadata, validateFileMetadata } from 'src/services/file-metadata.mjs'
import {
  normalizeReplyReference,
  parseChatMessageContent,
  parseReplyReference,
  serializeChatMessageContent,
  serializeReplyReference,
} from 'src/services/chat-message-content.mjs'
import { useIdentityStore } from 'src/stores/identity'
import { attachmentApi } from 'src/services/api'
import { classifyAttachmentError, isStorageQuotaError } from 'src/services/attachment-errors.mjs'
import { loadAttachmentAutoClean } from 'src/services/chat-preferences.mjs'
import {
  assertLocalAttachmentSpace,
  binarySize,
  estimateLocalStorage,
} from 'src/services/attachment-storage.mjs'
import {
  acknowledgeOfflineAttachment,
  createOfflineAttachmentUpload,
  downloadOfflineAttachment,
  parseOfflineAttachmentContent,
  serializeOfflineAttachmentContent,
  uploadOfflineAttachment,
} from 'src/services/offline-attachment.mjs'

// ──Safety constants────────────────────────────────────────────

const DB_NAME = 'e2eechat_messages'
const DB_VERSION = 7  //v7: Added chunk-encrypted local file copies for large attachments
const STORE_NAME = 'messages'
const KEY_STORE_NAME = 'message_key'  //Store message encryption key
const PENDING_STORE_NAME = 'pending_messages'  //The original ciphertext received during the lock period and to be decrypted after unlocking
const FILE_STORE_NAME = 'message_files'  //Encrypted file binary (separated from message records, lazy loading)
const ATTACHMENT_CHUNK_STORE_NAME = 'attachment_cipher_chunks'
const FILE_CHUNK_STORE_NAME = 'message_file_chunks'
const LOCAL_FILE_CHUNK_SIZE = 1024 * 1024
const AUTO_PREVIEW_FILE_BYTES = 20 * 1024 * 1024
const REALTIME_MAX_FILE_SIZE = 100 * 1024 * 1024
const BURN_AFTER_READ_DELAY = 2 * 60 * 60 * 1000  //2 hours

// ── File transfer constants ────────────────────────────────────────

const CHUNK_SIZE = 128 * 1024  //128KB binary chunks
const AES_GCM_TAG_SIZE = 16

function expectedFileChunks(filesize) {
  return Math.ceil((filesize + AES_GCM_TAG_SIZE) / CHUNK_SIZE)
}

function expectedFileChunkSize(filesize, chunkIndex) {
  return Math.min(CHUNK_SIZE, filesize + AES_GCM_TAG_SIZE - chunkIndex * CHUNK_SIZE)
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

async function encryptReplyReference(reply, recipientPubKey) {
  const plaintext = serializeReplyReference(reply)
  return plaintext ? encryptMessage(plaintext, recipientPubKey) : null
}

function replyEncryptionPayload(encryptedReply) {
  if (!encryptedReply) return {}
  return {
    reply_ephemeral_pub_key: encryptedReply.ephemeralPubKey,
    reply_iv: encryptedReply.iv,
    reply_ciphertext: encryptedReply.ciphertext,
  }
}

async function decryptReplyReference(payload, fallback = null) {
  const hasEncryptedReply =
    typeof payload?.reply_ephemeral_pub_key === 'string' && payload.reply_ephemeral_pub_key &&
    typeof payload?.reply_iv === 'string' && payload.reply_iv &&
    typeof payload?.reply_ciphertext === 'string' && payload.reply_ciphertext
  if (!hasEncryptedReply) return fallback

  try {
    const plaintext = await decryptMessage({
      ephemeralPubKey: payload.reply_ephemeral_pub_key,
      iv: payload.reply_iv,
      ciphertext: payload.reply_ciphertext,
    })
    return parseReplyReference(plaintext) || fallback
  } catch (error) {
    console.warn('[chat] decrypt reply reference failed', error)
    return fallback
  }
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

function localFileChunkAAD(msgId, index) {
  return new TextEncoder().encode(`yunmi.local-file-chunk|1|${msgId}|${index}`)
}

async function encryptLocalFileChunk(arrayBuffer, key, msgId, index) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: localFileChunkAAD(msgId, index),
  }, key, arrayBuffer)
  return { iv, ciphertext }
}

async function decryptLocalFileChunk(record, key, msgId, index) {
  return crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: record.iv,
    additionalData: localFileChunkAAD(msgId, index),
  }, key, record.ciphertext)
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
      if (!db.objectStoreNames.contains(ATTACHMENT_CHUNK_STORE_NAME)) {
        const chunkStore = db.createObjectStore(ATTACHMENT_CHUNK_STORE_NAME, { keyPath: 'id' })
        chunkStore.createIndex('msgId', 'msgId', { unique: false })
        chunkStore.createIndex('chatId', 'chatId', { unique: false })
      }
      if (!db.objectStoreNames.contains(FILE_CHUNK_STORE_NAME)) {
        const fileChunkStore = db.createObjectStore(FILE_CHUNK_STORE_NAME, { keyPath: 'id' })
        fileChunkStore.createIndex('msgId', 'msgId', { unique: false })
        fileChunkStore.createIndex('chatId', 'chatId', { unique: false })
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
    tx.objectStore(STORE_NAME).add(msg)
    // ACK the server only after the IndexedDB transaction has actually committed.
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
    tx.onabort = (e) => reject(e.target.error || new Error('message persistence aborted'))
  })
}

async function dbHasMessage(msgId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getKey(msgId)
    req.onsuccess = () => resolve(req.result !== undefined)
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
    tx.objectStore(FILE_STORE_NAME).put({ ...record, updatedAt: Date.now() })
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

async function dbPutAttachmentCipherChunk(chatId, msgId, attachmentId, index, ciphertext) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACHMENT_CHUNK_STORE_NAME, 'readwrite')
    tx.objectStore(ATTACHMENT_CHUNK_STORE_NAME).put({
      id: `${msgId}:${index}`,
      chatId,
      msgId,
      attachmentId,
      index,
      ciphertext,
      updatedAt: Date.now(),
    })
    tx.oncomplete = () => resolve()
    tx.onerror = event => reject(event.target.error)
  })
}

async function dbPutFileChunk(chatId, msgId, index, encrypted) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_CHUNK_STORE_NAME, 'readwrite')
    tx.objectStore(FILE_CHUNK_STORE_NAME).put({
      id: `${msgId}:${index}`,
      chatId,
      msgId,
      index,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      updatedAt: Date.now(),
    })
    tx.oncomplete = () => resolve()
    tx.onerror = event => reject(event.target.error)
  })
}

async function dbGetFileChunk(msgId, index) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_CHUNK_STORE_NAME, 'readonly')
    const request = tx.objectStore(FILE_CHUNK_STORE_NAME).get(`${msgId}:${index}`)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = event => reject(event.target.error)
  })
}

async function dbDeleteIndexedRecords(storeName, indexName, value) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const index = tx.objectStore(storeName).index(indexName)
    const request = index.openCursor(IDBKeyRange.only(value))
    request.onsuccess = event => {
      const cursor = event.target.result
      if (cursor) { cursor.delete(); cursor.continue() }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = event => reject(event.target.error)
  })
}

function dbDeleteFileChunksByMessage(msgId) {
  return dbDeleteIndexedRecords(FILE_CHUNK_STORE_NAME, 'msgId', msgId)
}

function dbDeleteFileChunksByChat(chatId) {
  return dbDeleteIndexedRecords(FILE_CHUNK_STORE_NAME, 'chatId', chatId)
}

async function dbGetAttachmentCipherChunk(msgId, index) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACHMENT_CHUNK_STORE_NAME, 'readonly')
    const request = tx.objectStore(ATTACHMENT_CHUNK_STORE_NAME).get(`${msgId}:${index}`)
    request.onsuccess = () => resolve(request.result?.ciphertext || null)
    request.onerror = event => reject(event.target.error)
  })
}

async function dbDeleteAttachmentCipherChunk(msgId, index) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACHMENT_CHUNK_STORE_NAME, 'readwrite')
    tx.objectStore(ATTACHMENT_CHUNK_STORE_NAME).delete(`${msgId}:${index}`)
    tx.oncomplete = () => resolve()
    tx.onerror = event => reject(event.target.error)
  })
}

async function dbDeleteAttachmentCipherChunks(indexName, value) {
  return dbDeleteIndexedRecords(ATTACHMENT_CHUNK_STORE_NAME, indexName, value)
}

function dbDeleteAttachmentCipherChunksByMessage(msgId) {
  return dbDeleteAttachmentCipherChunks('msgId', msgId)
}

function dbDeleteAttachmentCipherChunksByChat(chatId) {
  return dbDeleteAttachmentCipherChunks('chatId', chatId)
}

async function dbGetAllStoreRecords(storeName) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = event => reject(event.target.error)
  })
}

async function dbDeleteStoreRecords(storeName, ids) {
  if (!ids.length) return
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    for (const id of ids) store.delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = event => reject(event.target.error)
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

async function dbUpdateMessageDelivery(msgId, status, ts, failureCode) {
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
        if (failureCode !== undefined) record.failureCode = failureCode
        store.put(record)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = (e) => reject(e.target.error)
  })
}

async function dbUpdateMessageAttachmentStatus(msgId, attachmentStatus, failureCode) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(msgId)
    request.onsuccess = () => {
      const record = request.result
      if (record) {
        record.attachmentStatus = attachmentStatus
        if (failureCode !== undefined) record.failureCode = failureCode
        store.put(record)
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = event => reject(event.target.error)
  })
}

async function dbMarkFileAttachmentReceived(msgId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(msgId)
    let isFile = false
    request.onsuccess = () => {
      const record = request.result
      if (record?.mine && record.type === 'file') {
        isFile = true
        record.attachmentStatus = 'received'
        store.put(record)
      }
    }
    tx.oncomplete = () => resolve(isFile)
    tx.onerror = event => reject(event.target.error)
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

async function dbGetPending(msgId) {
  const db = await openMessagesDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE_NAME, 'readonly')
    const request = tx.objectStore(PENDING_STORE_NAME).get(msgId)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = event => reject(event.target.error)
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

  // Text messages awaiting server ACK. The WebSocket outbox handles retransmission; this timer only updates the visible status.
  const ackTimers = new Map()
  const MESSAGE_ACK_TIMEOUT_MS = 15000
  // Message storage is asynchronous; the other party may have opened a session and sent back a read notification within a very short window.
  // This type of early receipt is temporarily stored and used immediately when the local message is stored in the database.
  const earlyReadReceipts = new Map()
  const EARLY_READ_RECEIPT_MAX = 500
  // Large offline attachments are decrypted one at a time. WebSocket listener
  // callbacks are otherwise concurrent and could allocate several 100MB files.
  const offlineAttachmentReceives = new Map()
  let offlineAttachmentReceiveQueue = Promise.resolve()
  const offlineUploadOperations = new Map()
  const offlineDownloadOperations = new Map()
  const canceledOfflineDownloadMessages = new Set()
  const attachmentStatusTimers = new Map()

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

  function findLocalMessage(msgId) {
    for (const chatId in messages.value) {
      const msg = messages.value[chatId].find(item => item.id === msgId)
      if (msg) return msg
    }
    return null
  }

  async function setMessageAttachmentStatus(msg, status, failureCode) {
    if (!msg) return
    msg.attachmentStatus = status
    if (failureCode !== undefined) msg.failureCode = failureCode
    await dbUpdateMessageAttachmentStatus(msg.id, status, failureCode).catch(() => {})
  }

  async function maybeAutoCleanReceivedAttachment(msg) {
    if (!msg?.mine || !loadAttachmentAutoClean(useIdentityStore().chatId)) return false
    await deleteFileArtifacts(msg, msg.id)
    return true
  }

  function stopAttachmentStatusWatch(attachmentId) {
    const timer = attachmentStatusTimers.get(attachmentId)
    if (timer) clearTimeout(timer)
    attachmentStatusTimers.delete(attachmentId)
  }

  function watchOutgoingAttachment(msg, delay = 15000) {
    const attachmentId = msg?.offlineAttachment?.attachmentId || msg?.attachmentId
    if (!msg?.mine || !attachmentId || ['received', 'expired'].includes(msg.attachmentStatus)) return
    stopAttachmentStatusWatch(attachmentId)
    const check = async () => {
      try {
        const response = await attachmentApi.get(attachmentId)
        const status = response?.data?.status
        if (status === 'consumed') {
          await setMessageAttachmentStatus(msg, 'received')
          await maybeAutoCleanReceivedAttachment(msg)
          return
        }
        if (status === 'expired' || status === 'canceled') {
          await setMessageAttachmentStatus(msg, 'expired', 'attachment_expired')
          return
        }
      } catch (error) {
        if (error?.response?.status === 404 || error?.response?.status === 410) {
          await setMessageAttachmentStatus(msg, 'expired', 'attachment_expired')
          return
        }
      }
      attachmentStatusTimers.set(attachmentId, setTimeout(check, 30000))
    }
    attachmentStatusTimers.set(attachmentId, setTimeout(check, delay))
  }

  function armMessageAckTimer(msgId) {
    const previous = ackTimers.get(msgId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      ackTimers.delete(msgId)
      const msg = findLocalMessage(msgId)
      if (msg?.status !== 'pending') return
      msg.status = hasPendingMessage(msgId) ? 'queued' : 'failed'
      dbUpdateMessageDelivery(msgId, msg.status).catch(() => {})
    }, MESSAGE_ACK_TIMEOUT_MS)
    ackTimers.set(msgId, timer)
  }

  function restoreOutgoingStatus(record) {
    if (!record.mine) return undefined
    if (hasPendingMessage(record.id)) return 'queued'
    return record.status === 'pending' || record.status === 'queued'
      ? 'failed'
      : (record.status || 'sent')
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

  function stopOfflineUploadOperation(attachmentId) {
    const operation = offlineUploadOperations.get(attachmentId)
    if (!operation) return false
    operation.canceled = true
    operation.paused = false
    operation.controller?.abort()
    operation.resume?.()
    return true
  }

  function stopOfflineDownloadByMessage(msgId) {
    canceledOfflineDownloadMessages.add(msgId)
    for (const [attachmentId, operation] of offlineDownloadOperations) {
      const transfer = fileTransfers.value[attachmentId]
      if (transfer?.msgId !== msgId) continue
      operation.canceled = true
      operation.paused = false
      operation.controller?.abort()
      operation.resume?.()
      return true
    }
    return false
  }

  function applyEarlyReadReceipt(msg) {
    if (!msg.mine) return null
    const receipt = earlyReadReceipts.get(msg.id)
    if (!receipt) return null
    msg.read = true
    msg.status = 'sent'
    if (msg.type === 'file') msg.attachmentStatus = 'received'
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
  async function addMessage(chatId, msg, rollbackOnPersistenceFailure = false) {
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
      const encryptedText = await encryptMessageText(
        serializeChatMessageContent(msg.text, msg.reply),
        messageEncryptKey,
      )
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
        status: msg.status || (msg.mine ? 'sent' : undefined),
        failureCode: msg.failureCode || null
      })
      if (earlyReceipt) confirmReadReceiptsApplied(chatId, [earlyReceipt.msg_id])
    } catch (e) {
      // DB write failure: Keep message in memory (still visible to user), only lost after refresh.
      // Rolling back the memory will lead to the inconsistency of "the message has been sent but the sender cannot see it"——
      // The other party has received the message, but the sender has neither memory records nor DB records locally.
      console.error('[chat] persist message failed:', e)
      if (rollbackOnPersistenceFailure) {
        const index = messages.value[chatId]?.findIndex(item => item.id === msg.id) ?? -1
        if (index >= 0) messages.value[chatId].splice(index, 1)
        if (earlyReceipt) rememberEarlyReadReceipt(earlyReceipt)
      }
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
          return { ...m, ...parseChatMessageContent(decryptedText), status: restoreOutgoingStatus(m) }
        } catch (e) {
          console.warn('[chat] decrypt message failed:', m.id, e)
          return { ...m, text: null, decryptionFailed: true }
        }
      }))

      // Lazy loading of file bodies: Rebuild from IndexedDB only for file messages with "no valid blob URL in memory".
      // Only works on the currently open session to avoid reading all files into memory at once.
      await Promise.all(decryptedMsgs.map(async (m) => {
        if (m.type !== 'file') return
        try {
          const rec = await dbGetFile(m.id)
          m.localFileAvailable = !!rec
          if (!rec || m.objectUrl) return  //No persistent copy (old data/not saved successfully) → keep null and display "Expired"
          if (rec.chunked && rec.filesize > AUTO_PREVIEW_FILE_BYTES) return
          const blob = await loadStoredFileBlob(m.id, m.filetype || rec.filetype)
          if (blob) m.objectUrl = URL.createObjectURL(blob)
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
            const storedFile = await dbGetFile(m.id)
            grouped[cid].push({
              ...m,
              text: null,
              objectUrl: existingUrls[m.id] || null,
              localFileAvailable: !!storedFile,
              ...meta,
            })
          } else {
            grouped[cid].push({ ...m, ...parseChatMessageContent(decryptedText), status: restoreOutgoingStatus(m) })
          }
        } catch (e) {
          console.warn('[chat] decrypt message failed:', m.id, e)
          grouped[cid].push({ ...m, text: null, decryptionFailed: true })
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
      for (const thread of Object.values(grouped)) {
        for (const msg of thread) {
          if (msg.mine && msg.type === 'file' && msg.offlineAttachment && msg.attachmentStatus === 'waiting') {
            watchOutgoingAttachment(msg, 1000)
          }
        }
      }
      cleanupStaleAttachmentStorage().catch(error => {
        console.warn('[chat] stale attachment cleanup failed:', error)
      })
    } catch (e) {
      console.error('[chat] load all messages failed:', e)
    }
  }

  /**
   * Clear messages with specified chatId (clear IndexedDB and memory)
   */
  async function clearChatMessages(chatId) {
    const attachmentIDs = (messages.value[chatId] || [])
      .filter(message => message.mine && message.offlineAttachment && message.status !== 'sent')
      .map(message => message.offlineAttachment.attachmentId)
    for (const attachmentID of attachmentIDs) {
      stopOfflineUploadOperation(attachmentID)
      attachmentApi.cancel(attachmentID).catch(() => {})
    }
    // First release all file blob URLs of the session in memory to avoid leaks
    for (const m of messages.value[chatId] || []) releaseFileObjectUrl(m)
    try {
      discardPendingMessagesTo(chatId)
      await dbClearMessages(chatId)
      await dbClearChatFiles(chatId)
      await dbDeleteFileChunksByChat(chatId)
      await dbDeleteAttachmentCipherChunksByChat(chatId)
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
   * @param {object|null} reply - encrypted reference to the replied-to message
   */
  async function sendMessage(toChatId, recipientPubKey, text, burnAfterRead = false, reply = null) {
    const msgId = genMsgId()
    const normalizedReply = normalizeReplyReference(reply)
    const [encrypted, encryptedReply] = await Promise.all([
      encryptMessage(text, recipientPubKey),
      encryptReplyReference(normalizedReply, recipientPubKey),
    ])

    // First establish a local pending record to ensure that the corresponding message can be found when the extremely fast ACK arrives.
    await addMessage(toChatId, {
      id: msgId,
      from: 'me',
      text,
      reply: normalizedReply,
      ts: getServerNow(),
      mine: true,
      read: false,
      status: 'pending',
      burnAfterRead,
      burnAt: null
    })

    const payload = {
      to: toChatId,
      msg_id: msgId,
      ephemeral_pub_key: encrypted.ephemeralPubKey,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      ...replyEncryptionPayload(encryptedReply),
      burn_after_read: burnAfterRead
    }
    const sentNow = send('message', payload)
    const queued = hasPendingMessage(msgId)
    const msg = messages.value[toChatId]?.find(m => m.id === msgId)
    if (!sentNow && !queued) {
      if (msg) msg.status = 'failed'
      await dbUpdateMessageDelivery(msgId, 'failed').catch(() => {})
      return false
    }
    const status = sentNow ? 'pending' : 'queued'
    if (msg) msg.status = status
    await dbUpdateMessageDelivery(msgId, status).catch(() => {})
    if (sentNow) armMessageAckTimer(msgId)
    return true
  }

  async function retryMessage(toChatId, recipientPubKey, msgId) {
    const msg = messages.value[toChatId]?.find(item => item.id === msgId)
    if (!msg?.mine || msg.type === 'file' || typeof msg.text !== 'string') return false

    let queued = hasPendingMessage(msgId)
    if (queued) {
      retryPendingMessage(msgId)
    } else {
      const [encrypted, encryptedReply] = await Promise.all([
        encryptMessage(msg.text, recipientPubKey),
        encryptReplyReference(msg.reply, recipientPubKey),
      ])
      send('message', {
        to: toChatId,
        msg_id: msgId,
        ephemeral_pub_key: encrypted.ephemeralPubKey,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        ...replyEncryptionPayload(encryptedReply),
        burn_after_read: msg.burnAfterRead || false
      })
      queued = hasPendingMessage(msgId)
    }

    if (!queued) {
      msg.status = 'failed'
      msg.failureCode = 'client_error'
      await dbUpdateMessageDelivery(msgId, 'failed', undefined, msg.failureCode).catch(() => {})
      return false
    }
    msg.status = isConnected() ? 'pending' : 'queued'
    msg.failureCode = null
    await dbUpdateMessageDelivery(msgId, msg.status, undefined, null).catch(() => {})
    if (msg.status === 'pending') armMessageAckTimer(msgId)
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
      return true
    } catch (e) {
      console.error('[chat] persist file blob failed:', msgId, e)
      return false
    }
  }

  async function prepareChunkedFile(msgId) {
    await dbDeleteFile(msgId).catch(() => {})
    await dbDeleteFileChunksByMessage(msgId).catch(() => {})
  }

  async function persistPlainFileChunk(chatId, msgId, index, plaintext) {
    const { iv, ciphertext } = await encryptLocalFileChunk(plaintext, messageEncryptKey, msgId, index)
    await dbPutFileChunk(chatId, msgId, index, { iv, ciphertext })
  }

  async function finalizeChunkedFile(chatId, msgId, filetype, filesize, chunkSize, chunkCount) {
    await dbPutFile({
      id: msgId,
      chatId,
      filetype,
      filesize,
      chunked: true,
      chunkSize,
      chunkCount,
    })
  }

  async function persistFileSource(chatId, msgId, source, filetype, chunkSize = LOCAL_FILE_CHUNK_SIZE) {
    try {
      await ensureMessageKey()
      await prepareChunkedFile(msgId)
      const chunkCount = Math.ceil(source.size / chunkSize)
      for (let index = 0; index < chunkCount; index++) {
        const start = index * chunkSize
        const end = Math.min(source.size, start + chunkSize)
        const plaintext = await source.slice(start, end).arrayBuffer()
        if (plaintext.byteLength !== end - start) throw new Error('Local attachment source changed')
        await persistPlainFileChunk(chatId, msgId, index, plaintext)
      }
      await finalizeChunkedFile(chatId, msgId, filetype, source.size, chunkSize, chunkCount)
      return true
    } catch (e) {
      await dbDeleteFile(msgId).catch(() => {})
      await dbDeleteFileChunksByMessage(msgId).catch(() => {})
      console.error('[chat] persist chunked file failed:', msgId, e)
      if (isStorageQuotaError(e)) {
        const storageError = new Error('Local attachment storage is full')
        storageError.code = 'local_attachment_storage_full'
        storageError.cause = e
        throw storageError
      }
      throw e
    }
  }

  async function loadStoredFileBlob(msgId, fallbackType = '') {
    await ensureMessageKey()
    const record = await dbGetFile(msgId)
    if (!record) return null
    if (!record.chunked) {
      const plaintext = await decryptFileBytes(record, messageEncryptKey)
      return new Blob([plaintext], { type: fallbackType || record.filetype || '' })
    }
    const plaintextChunks = []
    let totalBytes = 0
    for (let index = 0; index < record.chunkCount; index++) {
      const chunk = await dbGetFileChunk(msgId, index)
      if (!chunk) throw new Error('The local attachment copy is incomplete')
      const plaintext = await decryptLocalFileChunk(chunk, messageEncryptKey, msgId, index)
      plaintextChunks.push(plaintext)
      totalBytes += plaintext.byteLength
    }
    if (totalBytes !== record.filesize) throw new Error('The local attachment copy is incomplete')
    return new Blob(plaintextChunks, { type: fallbackType || record.filetype || '' })
  }

  async function createStoredFileSource(msg) {
    await ensureMessageKey()
    const record = await dbGetFile(msg.id)
    if (!record) throw new Error('The local attachment copy is unavailable')
    if (!record.chunked) {
      const plaintext = await decryptFileBytes(record, messageEncryptKey)
      return new File([plaintext], msg.filename, { type: msg.filetype, lastModified: Date.now() })
    }
    return {
      name: msg.filename,
      type: msg.filetype || '',
      size: record.filesize,
      slice(start, end) {
        return {
          arrayBuffer: async () => {
            const index = Math.floor(start / record.chunkSize)
            const expectedStart = index * record.chunkSize
            const expectedEnd = Math.min(record.filesize, expectedStart + record.chunkSize)
            if (start !== expectedStart || end !== expectedEnd) {
              throw new Error('Local attachment chunk size is incompatible')
            }
            const chunk = await dbGetFileChunk(msg.id, index)
            if (!chunk) throw new Error('The local attachment copy is incomplete')
            return decryptLocalFileChunk(chunk, messageEncryptKey, msg.id, index)
          },
        }
      },
    }
  }

  async function ensureFileObjectUrl(msg) {
    if (!msg || msg.type !== 'file') return null
    if (msg.objectUrl) return msg.objectUrl
    const blob = await loadStoredFileBlob(msg.id, msg.filetype)
    if (!blob) return null
    msg.objectUrl = URL.createObjectURL(blob)
    return msg.objectUrl
  }

  async function getStoredFileDescriptor(msg) {
    if (!msg || msg.type !== 'file') throw new Error('Attachment message is invalid')
    await ensureMessageKey()
    const record = await dbGetFile(msg.id)
    if (!record) throw new Error('The local attachment copy is unavailable')
    if (!record.chunked) {
      return {
        size: msg.filesize,
        chunkCount: 1,
        async readChunk(index) {
          if (index !== 0) throw new Error('Attachment chunk index is invalid')
          return new Uint8Array(await decryptFileBytes(record, messageEncryptKey))
        },
      }
    }
    return {
      size: record.filesize,
      chunkCount: record.chunkCount,
      async readChunk(index) {
        if (!Number.isInteger(index) || index < 0 || index >= record.chunkCount) {
          throw new Error('Attachment chunk index is invalid')
        }
        const chunk = await dbGetFileChunk(msg.id, index)
        if (!chunk) throw new Error('The local attachment copy is incomplete')
        return new Uint8Array(await decryptLocalFileChunk(chunk, messageEncryptKey, msg.id, index))
      },
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
    const stoppedActiveDownload = stopOfflineDownloadByMessage(msgId)
    const activeDownloadTask = stoppedActiveDownload ? offlineAttachmentReceives.get(msgId) : null
    if (activeDownloadTask) await activeDownloadTask.catch(() => {})
    releaseFileObjectUrl(msg)
    await dbDeleteFile(msgId).catch(() => {})
    await dbDeleteFileChunksByMessage(msgId).catch(() => {})
    await dbDeleteAttachmentCipherChunksByMessage(msgId).catch(() => {})
    if (msg) msg.localFileAvailable = false
  }

  function attachmentRecordBytes(record) {
    return binarySize(record?.ciphertext) + binarySize(record?.iv)
  }

  async function getAttachmentStorageStats() {
    const [files, fileChunks, receiveChunks, storage] = await Promise.all([
      dbGetAllStoreRecords(FILE_STORE_NAME),
      dbGetAllStoreRecords(FILE_CHUNK_STORE_NAME),
      dbGetAllStoreRecords(ATTACHMENT_CHUNK_STORE_NAME),
      estimateLocalStorage().catch(() => ({ supported: false, usage: null, quota: null, available: null })),
    ])
    const chats = new Map()
    const messageIds = new Set()
    let localBytes = 0
    let temporaryBytes = 0
    const add = (record, bytes, temporary = false) => {
      const chatId = record.chatId || ''
      if (!chatId) return
      const current = chats.get(chatId) || { chatId, bytes: 0, temporaryBytes: 0, messageIds: new Set() }
      current.bytes += bytes
      if (temporary) current.temporaryBytes += bytes
      if (record.msgId || record.id) current.messageIds.add(record.msgId || record.id)
      chats.set(chatId, current)
    }
    for (const record of files) {
      const bytes = record.chunked ? 0 : attachmentRecordBytes(record)
      localBytes += bytes
      messageIds.add(record.id)
      add(record, bytes)
    }
    for (const record of fileChunks) {
      const bytes = attachmentRecordBytes(record)
      localBytes += bytes
      messageIds.add(record.msgId)
      add(record, bytes)
    }
    for (const record of receiveChunks) {
      const bytes = attachmentRecordBytes(record)
      temporaryBytes += bytes
      messageIds.add(record.msgId)
      add(record, bytes, true)
    }
    return {
      attachmentBytes: localBytes + temporaryBytes,
      localBytes,
      temporaryBytes,
      messageCount: messageIds.size,
      storage,
      chats: [...chats.values()]
        .map(item => ({ ...item, messageCount: item.messageIds.size, messageIds: undefined }))
        .sort((a, b) => b.bytes - a.bytes),
    }
  }

  async function clearAttachmentStorage(chatId = null) {
    const activeTransfers = Object.values(fileTransfers.value).filter(transfer =>
      transfer.transport === 'offline' &&
      (!chatId || transfer.toChatId === chatId || transfer.fromChatId === chatId),
    )
    for (const transfer of activeTransfers) {
      await cancelOfflineTransfer(transfer.id).catch(() => {})
    }
    const matches = record => !chatId || record.chatId === chatId
    const [files, fileChunks, receiveChunks] = await Promise.all([
      dbGetAllStoreRecords(FILE_STORE_NAME),
      dbGetAllStoreRecords(FILE_CHUNK_STORE_NAME),
      dbGetAllStoreRecords(ATTACHMENT_CHUNK_STORE_NAME),
    ])
    const messageIds = new Set()
    for (const record of [...files, ...fileChunks, ...receiveChunks]) {
      if (matches(record)) messageIds.add(record.msgId || record.id)
    }
    for (const msgId of messageIds) {
      const msg = findLocalMessage(msgId)
      if (msg?.mine && msg.offlineAttachment && ['pending', 'queued', 'paused', 'failed'].includes(msg.status)) {
        stopOfflineUploadOperation(msg.attachmentId)
        attachmentApi.cancel(msg.attachmentId).catch(() => {})
        msg.status = 'failed'
        msg.failureCode = 'attachment_local_copy_removed'
        await dbUpdateMessageDelivery(msg.id, 'failed', undefined, msg.failureCode).catch(() => {})
      }
      releaseFileObjectUrl(msg)
      if (msg) msg.localFileAvailable = false
    }
    await Promise.all([
      dbDeleteStoreRecords(FILE_STORE_NAME, files.filter(matches).map(record => record.id)),
      dbDeleteStoreRecords(FILE_CHUNK_STORE_NAME, fileChunks.filter(matches).map(record => record.id)),
      dbDeleteStoreRecords(ATTACHMENT_CHUNK_STORE_NAME, receiveChunks.filter(matches).map(record => record.id)),
    ])
    return getAttachmentStorageStats()
  }

  async function cleanupStaleAttachmentStorage(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    if (maxAgeMs === 0) {
      const incompleteTransfers = Object.values(fileTransfers.value).filter(transfer =>
        transfer.transport === 'offline' && ['paused', 'error'].includes(transfer.status),
      )
      for (const transfer of incompleteTransfers) {
        await cancelOfflineTransfer(transfer.id).catch(() => {})
      }
    }
    const cutoff = Date.now() - maxAgeMs
    const [storedMessages, files, fileChunks, receiveChunks] = await Promise.all([
      dbGetAllMessages(),
      dbGetAllStoreRecords(FILE_STORE_NAME),
      dbGetAllStoreRecords(FILE_CHUNK_STORE_NAME),
      dbGetAllStoreRecords(ATTACHMENT_CHUNK_STORE_NAME),
    ])
    const messageIds = new Set(storedMessages.map(record => record.id))
    const manifestIds = new Set(files.map(record => record.id))
    const stale = record => maxAgeMs === 0 || (Number.isFinite(record.updatedAt) && record.updatedAt < cutoff)
    const failedMessageIds = new Set(storedMessages
      .filter(record => record.type === 'file' && record.status === 'failed' && (maxAgeMs === 0 || (Number(record.ts) || 0) < cutoff))
      .map(record => record.id))
    const staleFiles = files.filter(record => failedMessageIds.has(record.id) || (!messageIds.has(record.id) && stale(record)))
    const staleFileChunks = fileChunks.filter(record =>
      failedMessageIds.has(record.msgId) || (stale(record) && (!messageIds.has(record.msgId) || !manifestIds.has(record.msgId))),
    )
    const staleReceiveChunks = receiveChunks.filter(record => stale(record))
    for (const msgId of failedMessageIds) {
      const msg = findLocalMessage(msgId)
      if (msg?.attachmentId) {
        stopOfflineUploadOperation(msg.attachmentId)
        attachmentApi.cancel(msg.attachmentId).catch(() => {})
      }
      releaseFileObjectUrl(msg)
      if (msg) msg.localFileAvailable = false
    }
    await Promise.all([
      dbDeleteStoreRecords(FILE_STORE_NAME, staleFiles.map(record => record.id)),
      dbDeleteStoreRecords(FILE_CHUNK_STORE_NAME, staleFileChunks.map(record => record.id)),
      dbDeleteStoreRecords(ATTACHMENT_CHUNK_STORE_NAME, staleReceiveChunks.map(record => record.id)),
    ])
    return {
      removedRecords: staleFiles.length + staleFileChunks.length + staleReceiveChunks.length,
      removedBytes: [...staleFiles, ...staleFileChunks, ...staleReceiveChunks]
        .reduce((total, record) => total + attachmentRecordBytes(record), 0),
    }
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
    const fullMsg = {
      ...msg,
      type: 'file',
      read: msg.read || false,
      burnAt: msg.burnAt || null,
      localFileAvailable: msg.localFileAvailable !== false,
      attachmentStatus: msg.attachmentStatus || (msg.mine ? 'waiting' : 'received'),
    }
    const earlyReceipt = applyEarlyReadReceipt(fullMsg)
    ensureThread(chatId)
    messages.value[chatId].push(fullMsg)
    try {
      await ensureMessageKey()
      const metaText = JSON.stringify({
        filename: msg.filename,
        filesize: msg.filesize,
        filetype: msg.filetype,
        ...(msg.attachmentId ? { attachmentId: msg.attachmentId } : {}),
        ...(msg.offlineAttachment ? { offlineAttachment: msg.offlineAttachment } : {}),
        ...(msg.kind === 'voice' ? { kind: 'voice', durationMs: msg.durationMs } : {})
      })
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
        status: fullMsg.status || (fullMsg.mine ? 'sent' : undefined),
        attachmentStatus: fullMsg.attachmentStatus || (fullMsg.mine ? 'waiting' : 'received'),
        failureCode: fullMsg.failureCode || null,
      })
      if (earlyReceipt) {
        confirmReadReceiptsApplied(chatId, [earlyReceipt.msg_id])
        await maybeAutoCleanReceivedAttachment(fullMsg)
      }
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
    if (transfer.status === 'processing' || transfer.status === 'done' || transfer.status === 'error') return
    if (transfer.receivedCount < transfer.totalChunks) return
    if (transfer.chunks.some(c => !c)) return

    transfer.status = 'processing'
    transfer.progress = 95
    clearReceiveWatchdog(transfer.id)
    try {
      const combined = new Uint8Array(transfer.filesize + AES_GCM_TAG_SIZE)
      let offset = 0
      for (let i = 0; i < transfer.chunks.length; i++) {
        const chunk = new Uint8Array(b64ToBuf(transfer.chunks[i]))
        combined.set(chunk, offset)
        offset += chunk.length
        transfer.chunks[i] = null
      }
      if (offset !== combined.byteLength) throw new Error('The encrypted file size does not match the declared size')

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
        kind: transfer.kind,
        durationMs: transfer.durationMs,
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
      transfer.progress = 100
      transfer.status = 'done'
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

  function createOfflineReceiveTransfer(payload, metadata, status = 'transferring') {
    return {
      id: metadata.attachmentId,
      msgId: payload.msg_id,
      direction: 'receive',
      transport: 'offline',
      fromChatId: payload.from,
      filename: metadata.filename,
      filesize: metadata.fileSize,
      filetype: metadata.filetype,
      kind: metadata.kind,
      durationMs: metadata.durationMs,
      totalChunks: metadata.chunkCount,
      progress: 0,
      status,
      payload,
      metadata,
    }
  }

  async function performOfflineAttachmentReceive(payload, metadata) {
    if (canceledOfflineDownloadMessages.has(payload.msg_id)) return false
    const transferId = metadata.attachmentId
    const transfer = createOfflineReceiveTransfer(payload, metadata)
    fileTransfers.value[transferId] = transfer
    const operation = { controller: null, paused: false, pauseRequested: false, canceled: false, resume: null }
    offlineDownloadOperations.set(transferId, operation)
    let objectUrl = null
    try {
      await assertLocalAttachmentSpace(metadata.fileSize)
      await ensureMessageKey()
      // Keep already authenticated local chunks so a process restart resumes
      // without downloading or decrypting them again. The manifest is written
      // only after every chunk is present.
      await dbDeleteFile(payload.msg_id).catch(() => {})
      const collectPlaintext = metadata.fileSize <= AUTO_PREVIEW_FILE_BYTES
      let blob
      while (true) {
        if (operation.canceled) throw new Error('Attachment download canceled')
        await waitForOfflineUploadResume(operation)
        if (operation.canceled) throw new Error('Attachment download canceled')
        transfer.status = 'transferring'
        operation.controller = new AbortController()
        try {
          blob = await downloadOfflineAttachment(metadata, {
            api: attachmentApi,
            signal: operation.controller.signal,
            getStoredCiphertextChunk: index => dbGetAttachmentCipherChunk(payload.msg_id, index),
            getStoredPlaintextChunk: async index => {
              const chunk = await dbGetFileChunk(payload.msg_id, index)
              return chunk ? decryptLocalFileChunk(chunk, messageEncryptKey, payload.msg_id, index) : null
            },
            onCiphertextChunk: (index, ciphertext) => dbPutAttachmentCipherChunk(
              payload.from,
              payload.msg_id,
              metadata.attachmentId,
              index,
              ciphertext,
            ),
            onPlaintextChunk: async (index, plaintext) => {
              await persistPlainFileChunk(payload.from, payload.msg_id, index, plaintext)
              await dbDeleteAttachmentCipherChunk(payload.msg_id, index)
            },
            collectPlaintext,
            onProgress: progress => { transfer.progress = progress },
          })
          break
        } catch (error) {
          if (operation.canceled) throw error
          if (!operation.pauseRequested) throw error
          operation.pauseRequested = false
          transfer.status = operation.paused ? 'paused' : 'transferring'
        }
      }
      transfer.status = 'processing'
      transfer.progress = 95
      await finalizeChunkedFile(
        payload.from,
        payload.msg_id,
        metadata.filetype,
        metadata.fileSize,
        metadata.chunkSize,
        metadata.chunkCount,
      )
      if (blob) objectUrl = URL.createObjectURL(blob)
      const added = await addFileMessage(payload.from, {
        id: payload.msg_id,
        from: payload.from,
        filename: metadata.filename,
        filesize: metadata.fileSize,
        filetype: metadata.filetype,
        kind: metadata.kind,
        durationMs: metadata.durationMs,
        attachmentId: metadata.attachmentId,
        objectUrl,
        mine: false,
        localFileAvailable: true,
        attachmentStatus: 'received',
        burnAfterRead: payload.burn_after_read || false,
        ts: payload.ts,
      })
      if (!added) {
        objectUrl = null // addFileMessage releases duplicate object URLs itself.
        throw new Error('Unable to persist the received attachment message')
      }
      objectUrl = null // The message now owns this URL.

      // The local body and message record are durable before ciphertext deletion.
      // If this best-effort ACK fails, the server's seven-day expiry remains the fallback.
      await acknowledgeOfflineAttachment(metadata, { api: attachmentApi }).catch(error => {
        console.warn('[chat] attachment acknowledgement will rely on expiry:', error)
      })
      await dbDeleteAttachmentCipherChunksByMessage(payload.msg_id).catch(() => {})
      transfer.progress = 100
      transfer.status = 'done'
      scheduleTransferCleanup(transferId, 1000)
      return true
    } catch (error) {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      if (operation.canceled || canceledOfflineDownloadMessages.has(payload.msg_id)) {
        await dbDeleteFile(payload.msg_id).catch(() => {})
        await dbDeleteFileChunksByMessage(payload.msg_id).catch(() => {})
        delete fileTransfers.value[transferId]
        return false
      }
      transfer.status = 'error'
      transfer.errorReason = error?.message || 'Attachment download failed'
      const reason = classifyAttachmentError(error, 'local')
      transfer.errorCode = reason === 'local_storage'
        ? 'local_attachment_storage_full'
        : reason === 'expired'
          ? 'attachment_expired'
          : reason === 'corrupted'
            ? 'attachment_corrupted'
            : reason === 'network'
              ? 'network_error'
              : error?.response?.data?.code
      transfer.errorAt = Date.now()
      if (error?.response?.status === 404 || error?.response?.status === 410) {
        await dbDeleteFile(payload.msg_id).catch(() => {})
        await dbDeleteFileChunksByMessage(payload.msg_id).catch(() => {})
        await dbDeleteAttachmentCipherChunksByMessage(payload.msg_id).catch(() => {})
        const added = await addFileMessage(payload.from, {
          id: payload.msg_id,
          from: payload.from,
          filename: metadata.filename,
          filesize: metadata.fileSize,
          filetype: metadata.filetype,
          kind: metadata.kind,
          durationMs: metadata.durationMs,
          attachmentId: metadata.attachmentId,
          objectUrl: null,
          localFileAvailable: false,
          attachmentStatus: 'expired',
          failureCode: 'attachment_expired',
          mine: false,
          burnAfterRead: payload.burn_after_read || false,
          ts: payload.ts,
        })
        if (added) return true
      }
      await dbAddPending({
        ...payload,
        attachment_failed: true,
        attachment_failure_code: transfer.errorCode,
      }).catch(persistError => {
        console.warn('[chat] persist failed attachment transfer failed:', persistError)
      })
      throw error
    } finally {
      offlineDownloadOperations.delete(transferId)
    }
  }

  function receiveOfflineAttachmentMessage(payload, metadata) {
    const existing = offlineAttachmentReceives.get(payload.msg_id)
    if (existing) return existing
    const task = offlineAttachmentReceiveQueue.then(() => performOfflineAttachmentReceive(payload, metadata))
    offlineAttachmentReceiveQueue = task.catch(() => {})
    offlineAttachmentReceives.set(payload.msg_id, task)
    task.finally(() => {
      if (offlineAttachmentReceives.get(payload.msg_id) === task) {
        offlineAttachmentReceives.delete(payload.msg_id)
      }
    }).catch(() => {})
    return task
  }

  function pauseOfflineDownload(transferId, reason = 'user') {
    const operation = offlineDownloadOperations.get(transferId)
    const transfer = fileTransfers.value[transferId]
    if (!operation || !transfer || transfer.status !== 'transferring') return false
    operation.paused = true
    operation.pauseReason = reason
    operation.pauseRequested = true
    transfer.status = 'paused'
    if (reason === 'user' && transfer.payload) {
      dbAddPending({ ...transfer.payload, attachment_paused: true }).catch(error => {
        console.warn('[chat] persist paused attachment failed:', error)
      })
    }
    operation.controller?.abort()
    return true
  }

  function resumeOfflineDownload(transferId) {
    const operation = offlineDownloadOperations.get(transferId)
    const transfer = fileTransfers.value[transferId]
    if (operation && transfer) {
      operation.paused = false
      operation.pauseReason = null
      transfer.status = 'transferring'
      if (transfer.msgId) dbDeletePending(transfer.msgId).catch(() => {})
      const resume = operation.resume
      operation.resume = null
      resume?.()
      return true
    }
    if (!transfer?.payload || !transfer?.metadata) return false
    dbDeletePending(transfer.payload.msg_id).catch(() => {})
    offlineAttachmentReceives.delete(transfer.payload.msg_id)
    receiveOfflineAttachmentMessage(transfer.payload, transfer.metadata).catch(error => {
      console.warn('[chat] retry offline attachment download failed:', error)
    })
    return true
  }

  async function cancelOfflineTransfer(transferId) {
    const transfer = fileTransfers.value[transferId]
    if (!transfer || transfer.transport !== 'offline') return false
    if (transfer.direction === 'send') {
      const msg = findLocalMessage(transfer.msgId)
      stopOfflineUploadOperation(transferId)
      stopAttachmentStatusWatch(transferId)
      await attachmentApi.cancel(transferId).catch(() => {})
      if (msg) {
        const thread = messages.value[transfer.toChatId] || []
        const index = thread.findIndex(item => item.id === msg.id)
        if (index >= 0) thread.splice(index, 1)
        await dbDeleteMessage(msg.id).catch(() => {})
        await deleteFileArtifacts(msg, msg.id)
      }
    } else {
      canceledOfflineDownloadMessages.add(transfer.msgId)
      const operation = offlineDownloadOperations.get(transferId)
      if (operation) {
        operation.canceled = true
        operation.paused = false
        operation.controller?.abort()
        operation.resume?.()
      }
      await dbDeletePending(transfer.msgId).catch(() => {})
      await attachmentApi.acknowledge(transferId).catch(() => {})
      await dbDeleteFile(transfer.msgId).catch(() => {})
      await dbDeleteFileChunksByMessage(transfer.msgId).catch(() => {})
      await dbDeleteAttachmentCipherChunksByMessage(transfer.msgId).catch(() => {})
    }
    delete fileTransfers.value[transferId]
    return true
  }

  function pauseAllOfflineDownloads() {
    for (const transferId of offlineDownloadOperations.keys()) pauseOfflineDownload(transferId, 'lock')
  }

  function resumeLockedOfflineDownloads() {
    for (const [transferId, operation] of offlineDownloadOperations) {
      if (operation.pauseReason === 'lock') resumeOfflineDownload(transferId)
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
   * @param {{kind?: 'voice', durationMs?: number, batchId?: string, batchIndex?: number, batchTotal?: number}} options - encrypted attachment metadata and local batch tracking
   */
  async function sendRealtimeFile(toChatId, recipientPubKey, file, burnAfterRead = false, options = {}) {
    validateFile(file)
    if (file.size > REALTIME_MAX_FILE_SIZE) throw new Error('Realtime file transfer is limited to 100 MB')
    await assertLocalAttachmentSpace(file.size)

    const kind = options.kind === 'voice' ? 'voice' : undefined
    const durationMs = kind === 'voice' ? Math.round(options.durationMs) : undefined
    const batchId = typeof options.batchId === 'string' && options.batchId ? options.batchId : undefined
    const batchIndex = Number.isInteger(options.batchIndex) && options.batchIndex >= 0
      ? options.batchIndex
      : undefined
    const batchTotal = Number.isInteger(options.batchTotal) && options.batchTotal > 0
      ? options.batchTotal
      : undefined

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
      kind,
      durationMs,
      batchId,
      batchIndex,
      batchTotal,
      totalChunks: 0,
      progress: 0,
      status: 'pending'
    }

    try {
      // Read and encrypt files
      const fileBuffer = await file.arrayBuffer()
      const { ephemeralPubKey, iv, ciphertext } = await encryptFile(fileBuffer, recipientPubKey)
      const sealedMetadata = await sealFileMetadata({
        filename: file.name,
        filetype: file.type,
        kind,
        durationMs
      }, recipientPubKey)

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
        kind,
        durationMs,
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
      const ok = send('file_offer', buildEncryptedFileOfferPayload({
        to: toChatId,
        transferId,
        msgId,
        filesize: file.size,
        totalChunks,
        ephemeralPubKey,
        iv,
        burnAfterRead,
        sealedMetadata
      }))
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
      // Ciphertext has been uploaded, but the recipient still needs to assemble,
      // decrypt and persist it. Keep the UI below 100% until file_done arrives.
      fileTransfers.value[transferId].progress = 95
      fileTransfers.value[transferId].status = 'processing'

      // Wait for the receiving end to confirm that it has been received and decrypted successfully; if it times out or receives a file_error, it will be treated as a failure.
      // The returned ts comes from the receiving end, and both ends display the same
      const doneResult = await doneResultPromise
      if (!doneResult.ok) throw doneResult.error
      const doneTs = doneResult.ts
      fileTransfers.value[transferId].progress = 100
      fileTransfers.value[transferId].status = 'done'
      scheduleTransferCleanup(transferId, 1000)

      // The timestamp of file_done is injected from the offer session by the backend, and is unified at both ends; the global monitoring will also perform the same
      // Idempotent update to cover the completion notification after disconnection or page restart.
      const finalTs = (typeof doneTs === 'number' && doneTs > 0) ? doneTs : getServerNow()
      const localMsg = messages.value[toChatId]?.find(m => m.id === msgId)
      if (localMsg) { localMsg.status = 'sent'; localMsg.ts = finalTs }
      await dbUpdateMessageDelivery(msgId, 'sent', finalTs).catch(() => {})
      await maybeAutoCleanReceivedAttachment(localMsg)

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

  function createOfflineTransfer(toChatId, msg, metadata, options = {}) {
    return {
      id: metadata.attachmentId,
      msgId: msg.id,
      direction: 'send',
      transport: 'offline',
      toChatId,
      filename: msg.filename,
      filesize: msg.filesize,
      filetype: msg.filetype,
      kind: msg.kind,
      durationMs: msg.durationMs,
      batchId: options.batchId,
      batchIndex: options.batchIndex,
      batchTotal: options.batchTotal,
      totalChunks: metadata.chunkCount,
      progress: 0,
      status: 'pending',
    }
  }

  function waitForOfflineUploadResume(operation) {
    if (!operation.paused) return Promise.resolve()
    return new Promise(resolve => { operation.resume = resolve })
  }

  async function runOfflineUpload(toChatId, recipientPubKey, file, msg, metadata, options = {}) {
    const transferId = metadata.attachmentId
    const existingOperation = offlineUploadOperations.get(transferId)
    if (existingOperation) return existingOperation.promise

    const transfer = fileTransfers.value[transferId] || createOfflineTransfer(toChatId, msg, metadata, options)
    fileTransfers.value[transferId] = transfer
    const operation = { controller: null, paused: false, pauseRequested: false, canceled: false, resume: null, promise: null }
    operation.promise = (async () => {
      try {
        while (true) {
          if (operation.canceled) throw new Error('Attachment upload canceled')
          await waitForOfflineUploadResume(operation)
          if (operation.canceled) throw new Error('Attachment upload canceled')
          transfer.status = 'transferring'
          await setMessageAttachmentStatus(msg, 'uploading')
          msg.status = 'pending'
          await dbUpdateMessageDelivery(msg.id, 'pending').catch(() => {})
          operation.controller = new AbortController()
          try {
            await uploadOfflineAttachment(file, metadata, {
              api: attachmentApi,
              signal: operation.controller.signal,
              onProgress: progress => { transfer.progress = progress },
            })
            break
          } catch (error) {
            if (!operation.pauseRequested) throw error
            operation.pauseRequested = false
            transfer.status = operation.paused ? 'paused' : 'transferring'
            msg.status = operation.paused ? 'paused' : 'pending'
            await dbUpdateMessageDelivery(msg.id, msg.status).catch(() => {})
          }
        }

        transfer.progress = 95
        transfer.status = 'processing'
        const encrypted = await encryptMessage(serializeOfflineAttachmentContent(metadata), recipientPubKey)
        const sentNow = send('message', {
          to: toChatId,
          msg_id: msg.id,
          ephemeral_pub_key: encrypted.ephemeralPubKey,
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          burn_after_read: msg.burnAfterRead || false,
        })
        const queued = hasPendingMessage(msg.id)
        if (!sentNow && !queued) throw new Error('Unable to queue the encrypted attachment message')

        msg.status = sentNow ? 'pending' : 'queued'
        await setMessageAttachmentStatus(msg, 'waiting')
        await dbUpdateMessageDelivery(msg.id, msg.status).catch(() => {})
        if (sentNow) armMessageAckTimer(msg.id)
        transfer.progress = 100
        transfer.status = 'done'
        scheduleTransferCleanup(transferId, 1000)
        watchOutgoingAttachment(msg)
        return transferId
      } catch (error) {
        transfer.status = 'error'
        transfer.errorReason = error?.message || 'Attachment upload failed'
        const reason = classifyAttachmentError(error, 'local')
        transfer.errorCode = reason === 'local_storage'
          ? 'local_attachment_storage_full'
          : reason === 'expired'
            ? 'attachment_expired'
            : reason === 'corrupted'
              ? 'attachment_corrupted'
              : reason === 'network'
                ? 'network_error'
                : (error?.code || error?.response?.data?.code)
        transfer.errorAt = Date.now()
        msg.status = 'failed'
        await setMessageAttachmentStatus(msg, reason === 'expired' ? 'expired' : 'failed', transfer.errorCode)
        await dbUpdateMessageDelivery(msg.id, 'failed', undefined, transfer.errorCode).catch(() => {})
        scheduleTransferCleanup(transferId, 6000)
        throw error
      } finally {
        offlineUploadOperations.delete(transferId)
      }
    })()
    offlineUploadOperations.set(transferId, operation)
    return operation.promise
  }

  /**
   * Upload independently authenticated ciphertext chunks, then send only the
   * attachment key and private metadata through the reliable E2EE chat inbox.
   * The recipient no longer needs to be online while this function runs.
   */
  async function sendOfflineFile(toChatId, recipientPubKey, file, burnAfterRead = false, options = {}) {
    validateFile(file)
    await assertLocalAttachmentSpace(file.size)
    const msgId = genMsgId()
    const kind = options.kind === 'voice' ? 'voice' : undefined
    const durationMs = kind === 'voice' ? Math.round(options.durationMs) : undefined
    const metadata = await createOfflineAttachmentUpload(file, toChatId, {
      api: attachmentApi,
      kind,
      durationMs,
    })
    const preparationMessage = {
      id: msgId,
      filename: file.name,
      filesize: file.size,
      filetype: file.type,
      kind,
      durationMs,
    }
    const preparationTransfer = createOfflineTransfer(toChatId, preparationMessage, metadata, options)
    preparationTransfer.status = 'processing'
    fileTransfers.value[metadata.attachmentId] = preparationTransfer
    const localObjectUrl = URL.createObjectURL(file)
    try {
      await persistFileSource(toChatId, msgId, file, file.type, metadata.chunkSize)
    } catch (error) {
      await attachmentApi.cancel(metadata.attachmentId).catch(() => {})
      delete fileTransfers.value[metadata.attachmentId]
      URL.revokeObjectURL(localObjectUrl)
      throw error
    }
    const added = await addFileMessage(toChatId, {
      id: msgId,
      from: 'me',
      filename: file.name,
      filesize: file.size,
      filetype: file.type,
      kind,
      durationMs,
      attachmentId: metadata.attachmentId,
      offlineAttachment: metadata,
      objectUrl: localObjectUrl,
      mine: true,
      status: 'pending',
      attachmentStatus: 'preparing',
      burnAfterRead,
      ts: getServerNow(),
    })
    if (!added) {
      await attachmentApi.cancel(metadata.attachmentId).catch(() => {})
      const index = messages.value[toChatId]?.findIndex(message => message.id === msgId) ?? -1
      if (index >= 0) messages.value[toChatId].splice(index, 1)
      await dbDeleteFile(msgId).catch(() => {})
      await dbDeleteFileChunksByMessage(msgId).catch(() => {})
      delete fileTransfers.value[metadata.attachmentId]
      URL.revokeObjectURL(localObjectUrl)
      throw new Error('Unable to save the attachment message')
    }
    const msg = messages.value[toChatId]?.find(message => message.id === msgId)
    preparationTransfer.status = 'pending'
    preparationTransfer.progress = 0
    return runOfflineUpload(toChatId, recipientPubKey, file, msg, metadata, options)
  }

  async function restoreOfflineUploadFile(msg) {
    return createStoredFileSource(msg)
  }

  async function retryOfflineFile(toChatId, recipientPubKey, msgId) {
    const msg = messages.value[toChatId]?.find(message => message.id === msgId)
    if (!msg?.mine || msg.type !== 'file' || !msg.offlineAttachment) return false
    if (hasPendingMessage(msgId)) {
      retryPendingMessage(msgId)
      msg.status = isConnected() ? 'pending' : 'queued'
      await dbUpdateMessageDelivery(msgId, msg.status).catch(() => {})
      if (msg.status === 'pending') armMessageAckTimer(msgId)
      return true
    }
    const file = await restoreOfflineUploadFile(msg)
    fileTransfers.value[msg.attachmentId] = createOfflineTransfer(toChatId, msg, msg.offlineAttachment)
    await runOfflineUpload(toChatId, recipientPubKey, file, msg, msg.offlineAttachment)
    return true
  }

  function pauseOfflineTransfer(transferId, reason = 'user') {
    const operation = offlineUploadOperations.get(transferId)
    const transfer = fileTransfers.value[transferId]
    if (!operation || !transfer || transfer.status !== 'transferring') return false
    operation.paused = true
    operation.pauseReason = reason
    operation.pauseRequested = true
    transfer.status = 'paused'
    const msg = findLocalMessage(transfer.msgId)
    if (msg) {
      msg.status = 'paused'
      setMessageAttachmentStatus(msg, 'paused').catch(() => {})
      dbUpdateMessageDelivery(msg.id, 'paused').catch(() => {})
    }
    operation.controller?.abort()
    return true
  }

  function pauseAllOfflineUploads() {
    for (const transferId of offlineUploadOperations.keys()) pauseOfflineTransfer(transferId, 'lock')
  }

  async function resumeOfflineTransfer(transferId, recipientPubKey) {
    const operation = offlineUploadOperations.get(transferId)
    const transfer = fileTransfers.value[transferId]
    if (operation && transfer) {
      operation.paused = false
      operation.pauseReason = null
      transfer.status = 'transferring'
      const msg = findLocalMessage(transfer.msgId)
      if (msg) {
        msg.status = 'pending'
        setMessageAttachmentStatus(msg, 'uploading').catch(() => {})
      }
      const resume = operation.resume
      operation.resume = null
      resume?.()
      return true
    }
    if (!transfer?.msgId) return false
    return retryOfflineFile(transfer.toChatId, recipientPubKey, transfer.msgId)
  }

  function resumeLockedOfflineUploads() {
    for (const [transferId, operation] of offlineUploadOperations) {
      if (operation.pauseReason === 'lock') resumeOfflineTransfer(transferId)
    }
  }

  async function recoverOfflineUploads(friends = []) {
    if (useIdentityStore().isLocked) return
    const publicKeys = new Map(friends.map(friend => [friend.chat_id, friend.public_key]))
    for (const [chatId, thread] of Object.entries(messages.value)) {
      const recipientPubKey = publicKeys.get(chatId) || useIdentityStore().getFriendPubKey(chatId)
      if (!recipientPubKey) continue
      for (const msg of thread) {
        if (!msg.mine || msg.type !== 'file' || !msg.offlineAttachment || msg.status !== 'pending' || hasPendingMessage(msg.id)) continue
        try {
          await retryOfflineFile(chatId, recipientPubKey, msg.id)
        } catch (error) {
          console.warn('[chat] recover offline attachment upload failed:', error)
        }
      }
    }
  }

  async function sendFile(toChatId, recipientPubKey, file, burnAfterRead = false, options = {}) {
    if (options.transport === 'realtime') {
      return sendRealtimeFile(toChatId, recipientPubKey, file, burnAfterRead, options)
    }
    return sendOfflineFile(toChatId, recipientPubKey, file, burnAfterRead, options)
  }

  async function recallMessage(chatId, msgId, toChatId) {
    confirmPendingMessage(msgId)
    const pendingTimer = ackTimers.get(msgId)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      ackTimers.delete(msgId)
    }
    // local delete
    const msgs = messages.value[chatId]
    let removed
    if (msgs) {
      const idx = msgs.findIndex(m => m.id === msgId)
      if (idx !== -1) removed = msgs.splice(idx, 1)[0]
    }
    if (removed?.attachmentId) stopOfflineUploadOperation(removed.attachmentId)
    if (removed?.mine && removed.attachmentId) {
      await attachmentApi.cancel(removed.attachmentId).catch(error => {
        console.warn('[chat] cancel recalled attachment failed:', error)
      })
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
    const recalledMessageIds = new Set()
    const rememberRecall = (msgId) => {
      if (recalledMessageIds.size >= 1000 && !recalledMessageIds.has(msgId)) {
        recalledMessageIds.delete(recalledMessageIds.values().next().value)
      }
      recalledMessageIds.add(msgId)
    }
    const confirmIncoming = (type, from, msgId) => {
      send(type, { from, msg_id: [msgId] })
    }

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

      // Replays are expected when a previous ACK was lost. Confirm only after
      // proving the message is already durable on this device.
      try {
        if (await dbHasMessage(payload.msg_id)) {
          confirmIncoming('message_received_ack', payload.from, payload.msg_id)
          return
        }
        const pending = await dbGetPending(payload.msg_id)
        if (pending?.attachment_paused || pending?.attachment_failed) return
      } catch (e) {
        console.error('[chat] check persisted message failed', e)
        return
      }
      if (recalledMessageIds.has(payload.msg_id)) {
        confirmIncoming('message_received_ack', payload.from, payload.msg_id)
        return
      }
      // A concurrent replay of this ID is already being persisted and will ACK.
      if (isMsgIdExists(payload.msg_id)) return

      // Reminder is placed before decryption: the private key has been cleared in the locked state and the message cannot be decrypted.
      // However, the user should still be informed of "received new message" and trigger a flash (the notification text is general and does not contain content)
      notifyNewMessage()

      try {
        const decryptedContent = await decryptMessage({
          ephemeralPubKey: payload.ephemeral_pub_key,
          iv: payload.iv,
          ciphertext: payload.ciphertext
        })
        const offlineAttachment = parseOfflineAttachmentContent(decryptedContent)
        if (offlineAttachment) {
          await receiveOfflineAttachmentMessage(payload, offlineAttachment)
          confirmIncoming('message_received_ack', payload.from, payload.msg_id)
          return
        }
        const content = parseChatMessageContent(decryptedContent)
        content.reply = await decryptReplyReference(payload, content.reply)
        if (recalledMessageIds.has(payload.msg_id)) {
          confirmIncoming('message_received_ack', payload.from, payload.msg_id)
          return
        }
        const persisted = await addMessage(payload.from, {
          id: payload.msg_id,
          from: payload.from,
          ...content,
          ts: payload.ts,  //Use server time
          mine: false,
          burnAfterRead: payload.burn_after_read || false,
          burnAt: null
        }, true)
        if (persisted) confirmIncoming('message_received_ack', payload.from, payload.msg_id)
      } catch (e) {
        // If the private key has been cleared in the locked state, decryption must fail: the original ciphertext is temporarily stored and decrypted after unlocking.
        // Decryption failure in the non-locked state is considered true damage, and the original "discard" behavior is used.
        if (useIdentityStore().isLocked) {
          try {
            await dbAddPending({
              msg_id: payload.msg_id,
              from: payload.from,
              ephemeral_pub_key: payload.ephemeral_pub_key,
              iv: payload.iv,
              ciphertext: payload.ciphertext,
              reply_ephemeral_pub_key: payload.reply_ephemeral_pub_key,
              reply_iv: payload.reply_iv,
              reply_ciphertext: payload.reply_ciphertext,
              ts: payload.ts,
              burn_after_read: payload.burn_after_read || false
            })
            confirmIncoming('message_received_ack', payload.from, payload.msg_id)
          } catch (err) {
            console.error('[chat] stash pending failed', err)
          }
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
      rememberRecall(msgId)
      const msgs = messages.value[chatId]
      let removed
      if (msgs) {
        const idx = msgs.findIndex(m => m.id === msgId)
        if (idx !== -1) removed = msgs.splice(idx, 1)[0]
      }
      await dbDeleteMessage(msgId)
      await dbDeletePending(msgId)
      await deleteFileArtifacts(removed, msgId)
      confirmIncoming('recall_received_ack', chatId, msgId)
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
      const msgId = payload.msg_id
      const status = payload.status || 'accepted'
      const timer = ackTimers.get(msgId)
      if (timer) {
        clearTimeout(timer)
        ackTimers.delete(msgId)
      }

      const msg = findLocalMessage(msgId)
      if (status === 'accepted' || status === 'duplicate') {
        if (typeof payload.ts !== 'number' || payload.ts <= 0) {
          console.warn('[chat] invalid ts in ack:', payload.ts)
          return
        }
        confirmPendingMessage(msgId)
        if (msg) {
          msg.ts = payload.ts
          msg.status = 'sent'
          msg.failureCode = null
        }
        await dbUpdateMessageDelivery(msgId, 'sent', payload.ts, null)
        return
      }

      if (status === 'retry' || payload.retryable === true) {
        if (msg) {
          msg.status = 'queued'
          msg.failureCode = payload.code || 'temporary_failure'
        }
        await dbUpdateMessageDelivery(msgId, 'queued', undefined, payload.code || 'temporary_failure')
        return
      }

      if (status === 'rejected') {
        confirmPendingMessage(msgId)
        if (msg) {
          msg.status = 'failed'
          msg.failureCode = payload.code || 'rejected'
          if (msg.offlineAttachment) {
            attachmentApi.cancel(msg.offlineAttachment.attachmentId).catch(error => {
              console.warn('[chat] cancel rejected attachment failed:', error)
            })
          }
        }
        await dbUpdateMessageDelivery(msgId, 'failed', undefined, payload.code || 'rejected')
        return
      }

      console.warn('[chat] invalid ack status:', status)
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

    async function onFileOffer(payload) {
      const { from, transfer_id, msg_id, filesize, total_chunks, ephemeral_pub_key, iv } = payload
      if (!validateChatId(from) || !TRANSFER_ID_PATTERN.test(transfer_id)) return
      let metadata
      try {
        metadata = await openFileOfferMetadata(payload)
        if (!validateMsgId(msg_id)) throw new Error('File message number is invalid')
        if (!Number.isInteger(total_chunks) || total_chunks !== expectedFileChunks(filesize)) {
          throw new Error('Number of file chunks does not match declared size')
        }
        if (typeof ephemeral_pub_key !== 'string' || !ephemeral_pub_key || typeof iv !== 'string' || !iv) {
          throw new Error('Missing file encryption parameters')
        }
        if (fileTransfers.value[transfer_id]) throw new Error('Duplicate file transfer number')
        await assertLocalAttachmentSpace(filesize)
      } catch (error) {
        console.warn('[chat] rejected invalid file offer')
        send('file_error', {
          to: from,
          transfer_id,
          reason: error?.code === 'local_attachment_storage_full'
            ? 'Recipient local attachment storage is full'
            : 'File metadata is invalid',
        })
        return
      }

      fileTransfers.value[transfer_id] = {
        id: transfer_id,
        msgId: msg_id,
        direction: 'receive',
        fromChatId: from,
        filename: metadata.filename,
        filesize,
        filetype: metadata.filetype,
        kind: metadata.kind,
        durationMs: metadata.durationMs,
        totalChunks: total_chunks,
        chunks: new Array(total_chunks).fill(null),
        receivedCount: 0,
        progress: 0,
        status: 'transferring',
        ephemeralPubKey: ephemeral_pub_key,
        iv,
        burnAfterRead: payload.burn_after_read || false,
        ts: (typeof payload.ts === 'number' && payload.ts > 0) ? payload.ts : getServerNow(),  //Server timestamp, unified on both ends
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
      await maybeAutoCleanReceivedAttachment(msg)
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
    for (const timer of attachmentStatusTimers.values()) clearTimeout(timer)
    attachmentStatusTimers.clear()
    for (const thread of Object.values(messages.value)) {
      for (const message of thread) {
        if (!message.mine || !message.offlineAttachment || message.status === 'sent') continue
        stopOfflineUploadOperation(message.offlineAttachment.attachmentId)
        attachmentApi.cancel(message.offlineAttachment.attachmentId).catch(() => {})
      }
    }
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
    validReceipts.forEach(receipt => confirmPendingMessage(receipt.msg_id))
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
        if (m.type === 'file') {
          m.attachmentStatus = 'received'
          if (m.attachmentId) stopAttachmentStatusWatch(m.attachmentId)
        }
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
      const isFile = await dbMarkFileAttachmentReceived(receipt.msg_id).catch(() => false)
      if (isFile) {
        const msg = findLocalMessage(receipt.msg_id) || { id: receipt.msg_id, mine: true, type: 'file' }
        await maybeAutoCleanReceivedAttachment(msg)
      }
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
        if (await dbHasMessage(p.msg_id)) {
          await dbDeletePending(p.msg_id).catch(() => {})
          continue
        }
        const decryptedContent = await decryptMessage({
          ephemeralPubKey: p.ephemeral_pub_key,
          iv: p.iv,
          ciphertext: p.ciphertext
        })
        const offlineAttachment = parseOfflineAttachmentContent(decryptedContent)
        if (offlineAttachment) {
          if (p.attachment_paused || p.attachment_failed) {
            const status = p.attachment_paused ? 'paused' : 'error'
            const transfer = createOfflineReceiveTransfer(p, offlineAttachment, status)
            if (p.attachment_failed) {
              transfer.errorCode = p.attachment_failure_code
              transfer.errorReason = p.attachment_failure_code
              transfer.errorAt = Date.now()
            }
            fileTransfers.value[offlineAttachment.attachmentId] = transfer
            continue
          }
          await receiveOfflineAttachmentMessage(p, offlineAttachment)
          await dbDeletePending(p.msg_id).catch(() => {})
          continue
        }
        const content = parseChatMessageContent(decryptedContent)
        content.reply = await decryptReplyReference(p, content.reply)
        const persisted = await addMessage(p.from, {
          id: p.msg_id,
          from: p.from,
          ...content,
          ts: p.ts,
          mine: false,
          burnAfterRead: p.burn_after_read || false,
          burnAt: null
        }, true)
        if (persisted) await dbDeletePending(p.msg_id).catch(() => {})
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
    retryMessage,
    sendFile,
    ensureFileObjectUrl,
    getStoredFileDescriptor,
    getAttachmentStorageStats,
    clearAttachmentStorage,
    cleanupStaleAttachmentStorage,
    retryOfflineFile,
    pauseOfflineTransfer,
    pauseAllOfflineUploads,
    resumeLockedOfflineUploads,
    resumeOfflineTransfer,
    pauseOfflineDownload,
    resumeOfflineDownload,
    cancelOfflineTransfer,
    pauseAllOfflineDownloads,
    resumeLockedOfflineDownloads,
    recoverOfflineUploads,
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
