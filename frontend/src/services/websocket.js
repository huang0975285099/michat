/**
 * WebSocket service
 * Singleton mode, globally reusing a connection
 * Security improvement: Token is authenticated through the first message and is not exposed in the URL
 */

import { ref } from 'vue'

let socket = null
let reconnectTimer = null
let reconnectAttempt = 0
let reconnectSuppressed = false
let authPending = false
let authenticated = false
let pendingFlushTimer = null
let pendingRetryTimer = null
let pendingMessageRetryTimer = null
let readAckSupported = false
let messageSyncSupported = false
let healthCheckSupported = false
let reliableInboxSupported = false
let pendingMessageSync = false
let pendingMessageSyncTimer = null
let healthIntervalTimer = null
let healthTimeoutTimer = null
let healthNonce = null
let recoveryCleanup = null
const listeners = new Map() // type → Set<callback>
const PENDING_QUEUE_KEY = 'ws_pending_queue'  //A persistent queue for key messages such as read receipts
const READ_BATCH_SIZE = 100
const MAX_PENDING_MESSAGES = 100
const MAX_PENDING_RECALLS = 100
const MESSAGE_RETRY_MS = 15000
const MESSAGE_RETRY_MAX_MS = 120000
const HEALTH_INTERVAL_MS = 20000
const HEALTH_TIMEOUT_MS = 10000
const RECONNECT_MAX_MS = 15000
const DIAGNOSTIC_KEY = 'ws_connection_diagnostics_v1'
const DIAGNOSTIC_MAX = 100
let pendingMessageRetryDelay = MESSAGE_RETRY_MS
const pendingQueue = loadPendingQueue()        //Messages cached during disconnection (retained across refreshes)
const pendingReadInFlight = new Set()          //The ID of the current connection that has been written and is waiting for read_ack
const pendingMessageInFlight = new Set()       //Text messages written on the current connection and waiting for ACK
const pendingRecallInFlight = new Set()        //Recall tombstones waiting for server persistence ACK
let serverClock = null //{ epochMs, monotonicMs }, calibrated by the server during authentication

function browserOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export const wsConnected = ref(false)
export const wsConnectionState = ref(browserOnline() ? 'disconnected' : 'offline')

function loadDiagnostics() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DIAGNOSTIC_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.slice(-DIAGNOSTIC_MAX) : []
  } catch {
    return []
  }
}

const connectionDiagnostics = loadDiagnostics()

function recordDiagnostic(event, details = {}) {
  const safe = {}
  for (const key of ['state', 'reason', 'close_code', 'retry_ms', 'queue_size']) {
    const value = details[key]
    if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value
    else if (typeof value === 'string') safe[key] = value.slice(0, 40)
  }
  connectionDiagnostics.push({ ts: Date.now(), event: String(event).slice(0, 40), ...safe })
  if (connectionDiagnostics.length > DIAGNOSTIC_MAX) connectionDiagnostics.splice(0, connectionDiagnostics.length - DIAGNOSTIC_MAX)
  try {
    localStorage.setItem(DIAGNOSTIC_KEY, JSON.stringify(connectionDiagnostics))
  } catch {
    // Diagnostics remain in memory when persistent storage is unavailable.
  }
}

export function getConnectionDiagnostics() {
  return connectionDiagnostics.map(entry => ({ ...entry }))
}

function setConnectionState(state, reason) {
  if (wsConnectionState.value !== state) {
    wsConnectionState.value = state
    recordDiagnostic('state_change', { state, reason })
  }
  wsConnected.value = state === 'connected'
}

function clearHealthTimers() {
  if (healthIntervalTimer) clearInterval(healthIntervalTimer)
  if (healthTimeoutTimer) clearTimeout(healthTimeoutTimer)
  healthIntervalTimer = null
  healthTimeoutTimer = null
  healthNonce = null
}

let healthSequence = 0
function sendHealthProbe(force = false) {
  if (!healthCheckSupported) return false
  if (!(socket && socket.readyState === WebSocket.OPEN && authenticated)) return false
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  if (healthTimeoutTimer) {
    if (!force) return false
    clearTimeout(healthTimeoutTimer)
    healthTimeoutTimer = null
  }
  healthNonce = `${Date.now().toString(36)}${(++healthSequence).toString(36)}`.slice(-32)
  try {
    socket.send(JSON.stringify({ type: 'health_ping', payload: { nonce: healthNonce } }))
  } catch {
    forceReconnect('health_send_failed')
    return false
  }
  const expectedNonce = healthNonce
  healthTimeoutTimer = setTimeout(() => {
    healthTimeoutTimer = null
    if (healthNonce !== expectedNonce) return
    recordDiagnostic('health_timeout', { state: wsConnectionState.value })
    forceReconnect('health_timeout', true)
  }, HEALTH_TIMEOUT_MS)
  return true
}

function handleHealthPong(payload) {
  if (typeof payload?.nonce !== 'string' || payload.nonce !== healthNonce) return
  if (healthTimeoutTimer) clearTimeout(healthTimeoutTimer)
  healthTimeoutTimer = null
  healthNonce = null
}

function startHealthMonitor() {
  clearHealthTimers()
  if (!healthCheckSupported) return
  healthIntervalTimer = setInterval(() => sendHealthProbe(), HEALTH_INTERVAL_MS)
}

function scheduleReconnect(reason, immediate = false) {
  if (reconnectSuppressed || !localStorage.getItem('session_token')) {
    setConnectionState('disconnected', reason)
    return
  }
  if (!browserOnline()) {
    setConnectionState('offline', reason)
    return
  }
  const delay = immediate ? 0 : Math.min(1000 * (2 ** reconnectAttempt), RECONNECT_MAX_MS)
  if (reconnectTimer) {
    if (!immediate) return
    clearTimeout(reconnectTimer)
  }
  setConnectionState('reconnecting', reason)
  recordDiagnostic('reconnect_scheduled', { reason, retry_ms: delay })
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectAttempt++
    connect()
  }, delay)
}

function abandonCurrentSocket() {
  const staleSocket = socket
  socket = null
  if (!staleSocket) return
  staleSocket.onopen = null
  staleSocket.onmessage = null
  staleSocket.onerror = null
  staleSocket.onclose = null
  try { staleSocket.close() } catch { /* already closed */ }
}

function resetTransientConnectionState() {
  authPending = false
  authenticated = false
  pendingReadInFlight.clear()
  pendingMessageInFlight.clear()
  pendingRecallInFlight.clear()
  pendingMessageSync = false
  clearHealthTimers()
  if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null }
  if (pendingRetryTimer) { clearTimeout(pendingRetryTimer); pendingRetryTimer = null }
  if (pendingMessageRetryTimer) { clearTimeout(pendingMessageRetryTimer); pendingMessageRetryTimer = null }
  if (pendingMessageSyncTimer) { clearTimeout(pendingMessageSyncTimer); pendingMessageSyncTimer = null }
}

function forceReconnect(reason, immediate = false) {
  recordDiagnostic('connection_recycled', { reason, state: wsConnectionState.value })
  abandonCurrentSocket()
  resetTransientConnectionState()
  setConnectionState(browserOnline() ? 'reconnecting' : 'offline', reason)
  scheduleReconnect(reason, immediate)
}

// Inbound early arrival buffer: During cold start, the backend will flush offline messages immediately after successful authentication, while the chat listener will wait
// Registered only after MainLayout is mounted (onMounted → startListening). If the message arrives first and the listener has not been registered yet,
// Direct discarding will result in permanent loss of offline messages (the backend has deleted the queue from Redis). Therefore, for these types of projects that require supplementary investment
// The type is temporarily stored first and will be played back when the corresponding on(type) is registered. In addition to offline message types,
// call_offer is buffered only across this cold-start listener gap; session-bound call signaling remains transient.
// Avoid buffering high-frequency transient events such as status and game actions.
const BUFFERED_TYPES = new Set(['message', 'read_receipt', 'read_ack', 'ack', 'recall', 'file_done', 'call_offer'])
const EARLY_BUFFER_MAX = 500
const earlyBuffer = [] //[{ type, payload }] A message that arrives without a listener

function dispatchMessage(type, payload) {
  const cbs = listeners.get(type)
  if (cbs && cbs.size) {
    cbs.forEach((cb) => cb(payload))
    return
  }
  // There is no listener yet: only the types that need to be added are buffered and will be played back after the listener is registered.
  if (BUFFERED_TYPES.has(type)) {
    if (earlyBuffer.length >= EARLY_BUFFER_MAX) earlyBuffer.shift()
    earlyBuffer.push({ type, payload })
  }
}

function loadPendingQueue() {
  try {
    const raw = localStorage.getItem(PENDING_QUEUE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    // Compatible with overly large/duplicate batches that may be left behind by older versions, the specification when loading is a maximum of 100 IDs per batch.
    const result = []
    const readsByPeer = new Map()
    for (const item of parsed) {
      if (item?.type === 'message') {
        const loadedMessages = result.reduce((count, existing) => count + (existing.type === 'message' ? 1 : 0), 0)
        if (loadedMessages < MAX_PENDING_MESSAGES && isValidPendingMessage(item.payload) && !result.some(existing =>
          existing.type === 'message' && existing.payload.msg_id === item.payload.msg_id
        )) {
          result.push({ type: 'message', payload: { ...item.payload } })
        }
        continue
      }
      if (item?.type === 'recall') {
        const loadedRecalls = result.reduce((count, existing) => count + (existing.type === 'recall' ? 1 : 0), 0)
        if (loadedRecalls < MAX_PENDING_RECALLS && isValidPendingRecall(item.payload) && !result.some(existing =>
          existing.type === 'recall' && existing.payload.msg_id === item.payload.msg_id
        )) {
          result.push({ type: 'recall', payload: { ...item.payload } })
        }
        continue
      }
      if (item?.type !== 'read') {
        continue
      }
      const to = item.payload?.to
      if (typeof to !== 'string' || !Array.isArray(item.payload?.msg_id)) continue
      if (!readsByPeer.has(to)) readsByPeer.set(to, new Set())
      for (const id of item.payload.msg_id) {
        if (typeof id === 'string' && id) readsByPeer.get(to).add(id)
      }
    }
    for (const [to, ids] of readsByPeer) {
      const all = [...ids]
      for (let i = 0; i < all.length; i += READ_BATCH_SIZE) {
        result.push({ type: 'read', payload: { to, msg_id: all.slice(i, i + READ_BATCH_SIZE) } })
      }
    }
    return result
  } catch {
    return []
  }
}

function isValidPendingMessage(payload) {
  return Boolean(
    payload &&
    typeof payload.to === 'string' &&
    typeof payload.msg_id === 'string' &&
    typeof payload.ephemeral_pub_key === 'string' && payload.ephemeral_pub_key.length > 0 &&
    typeof payload.iv === 'string' && payload.iv.length > 0 &&
    typeof payload.ciphertext === 'string' && payload.ciphertext.length > 0 &&
    typeof payload.burn_after_read === 'boolean'
  )
}

function isValidPendingRecall(payload) {
  return Boolean(payload && typeof payload.to === 'string' && typeof payload.msg_id === 'string')
}

function queuePendingMessage(payload) {
  if (!isValidPendingMessage(payload)) return false
  const existing = pendingQueue.find(item => item.type === 'message' && item.payload?.msg_id === payload.msg_id)
  if (existing) {
    existing.payload = { ...payload }
    savePendingQueue()
    return true
  }
  const messageCount = pendingQueue.reduce((count, item) => count + (item.type === 'message' ? 1 : 0), 0)
  if (messageCount >= MAX_PENDING_MESSAGES) return false
  if (messageCount === 0) pendingMessageRetryDelay = MESSAGE_RETRY_MS
  pendingQueue.push({ type: 'message', payload: { ...payload } })
  savePendingQueue()
  return true
}

function queuePendingRecall(payload) {
  if (!isValidPendingRecall(payload)) return false
  const existing = pendingQueue.find(item => item.type === 'recall' && item.payload?.msg_id === payload.msg_id)
  if (existing) {
    existing.payload = { ...payload }
    savePendingQueue()
    return true
  }
  const count = pendingQueue.reduce((total, item) => total + (item.type === 'recall' ? 1 : 0), 0)
  if (count >= MAX_PENDING_RECALLS) return false
  pendingQueue.push({ type: 'recall', payload: { ...payload } })
  savePendingQueue()
  return true
}

export function hasPendingMessage(msgId) {
  return typeof msgId === 'string' && pendingQueue.some(item =>
    item.type === 'message' && item.payload?.msg_id === msgId
  )
}

export function confirmPendingMessage(msgId) {
  if (typeof msgId !== 'string' || !msgId) return
  pendingMessageInFlight.delete(msgId)
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    if (pendingQueue[i].type === 'message' && pendingQueue[i].payload?.msg_id === msgId) pendingQueue.splice(i, 1)
  }
  savePendingQueue()
  if (!pendingQueue.some(item => item.type === 'message' || item.type === 'recall')) {
    if (pendingMessageRetryTimer) clearTimeout(pendingMessageRetryTimer)
    pendingMessageRetryTimer = null
    pendingMessageRetryDelay = MESSAGE_RETRY_MS
  }
}

export function hasPendingRecall(msgId) {
  return typeof msgId === 'string' && pendingQueue.some(item =>
    item.type === 'recall' && item.payload?.msg_id === msgId
  )
}

export function confirmPendingRecall(msgId) {
  if (typeof msgId !== 'string' || !msgId) return
  pendingRecallInFlight.delete(msgId)
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    if (pendingQueue[i].type === 'recall' && pendingQueue[i].payload?.msg_id === msgId) pendingQueue.splice(i, 1)
  }
  savePendingQueue()
  if (!pendingQueue.some(item => item.type === 'message' || item.type === 'recall')) {
    if (pendingMessageRetryTimer) clearTimeout(pendingMessageRetryTimer)
    pendingMessageRetryTimer = null
    pendingMessageRetryDelay = MESSAGE_RETRY_MS
  }
}

export function discardPendingMessagesTo(chatId) {
  if (typeof chatId !== 'string' || !chatId) return
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    const item = pendingQueue[i]
    if (item.type === 'message' && item.payload?.to === chatId) {
      pendingMessageInFlight.delete(item.payload.msg_id)
      pendingQueue.splice(i, 1)
    }
  }
  savePendingQueue()
  if (!pendingQueue.some(item => item.type === 'message' || item.type === 'recall')) {
    if (pendingMessageRetryTimer) clearTimeout(pendingMessageRetryTimer)
    pendingMessageRetryTimer = null
    pendingMessageRetryDelay = MESSAGE_RETRY_MS
  }
}

export function retryPendingMessage(msgId) {
  if (!hasPendingMessage(msgId)) return false
  pendingMessageInFlight.delete(msgId)
  pendingMessageRetryDelay = MESSAGE_RETRY_MS
  schedulePendingFlush()
  return true
}

function syncServerClock(serverTime) {
  if (!Number.isFinite(serverTime) || serverTime <= 0) return
  serverClock = { epochMs: serverTime, monotonicMs: performance.now() }
}

// Using server authentication time + monotonic clock advancement, modifying the device time while the page is open will not extend the time it disappears after reading.
// It is degraded to the local time before the authentication is completed.
export function getServerNow() {
  return getCalibratedServerNow() ?? Date.now()
}

// Security-sensitive UI (such as screenshot watermarks) must not silently use
// the modifiable device wall clock before server calibration completes.
export function getCalibratedServerNow() {
  if (!serverClock) return null
  return serverClock.epochMs + (performance.now() - serverClock.monotonicMs)
}

function queuePendingRead(payload) {
  if (!payload || typeof payload.to !== 'string' || !Array.isArray(payload.msg_id)) return
  const ids = new Set()
  for (const item of pendingQueue) {
    if (item?.type === 'read' && item.payload?.to === payload.to && Array.isArray(item.payload.msg_id)) {
      item.payload.msg_id.forEach(id => { if (typeof id === 'string' && id) ids.add(id) })
    }
  }
  payload.msg_id.forEach(id => { if (typeof id === 'string' && id) ids.add(id) })

  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    if (pendingQueue[i]?.type === 'read' && pendingQueue[i].payload?.to === payload.to) pendingQueue.splice(i, 1)
  }
  const all = [...ids]
  for (let i = 0; i < all.length; i += READ_BATCH_SIZE) {
    pendingQueue.push({ type: 'read', payload: { to: payload.to, msg_id: all.slice(i, i + READ_BATCH_SIZE) } })
  }
  savePendingQueue()
}

// These read receipts are removed from the reliable resend queue only after the server explicitly confirms persistence.
export function confirmPendingReads(to, msgIds) {
  if (typeof to !== 'string' || !Array.isArray(msgIds) || msgIds.length === 0) return
  const confirmed = new Set(msgIds)
  for (const id of confirmed) pendingReadInFlight.delete(`${to}\u0000${id}`)
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    const item = pendingQueue[i]
    if (item?.type !== 'read' || item.payload?.to !== to || !Array.isArray(item.payload.msg_id)) continue
    item.payload.msg_id = item.payload.msg_id.filter(id => !confirmed.has(id))
    if (item.payload.msg_id.length === 0) pendingQueue.splice(i, 1)
  }
  savePendingQueue()
  if (!pendingQueue.some(item => item.type === 'read') && pendingRetryTimer) {
    clearTimeout(pendingRetryTimer)
    pendingRetryTimer = null
  }
}

function schedulePendingFlush() {
  if (pendingFlushTimer) return
  // Merge messages that arrive continuously within the same short period of time to avoid resending the entire batch to be confirmed every time a new ID is added.
  pendingFlushTimer = setTimeout(() => {
    pendingFlushTimer = null
    flushPendingQueue()
  }, 25)
}

function schedulePendingRetry() {
  if (!readAckSupported || !pendingQueue.some(item => item.type === 'read') || pendingRetryTimer) return
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = null
    // read_ack may be lost due to current limiting or instantaneous disconnection; the entire batch is allowed to be resent. Server-side writes are idempotent.
    pendingReadInFlight.clear()
    flushPendingQueue()
  }, 5000)
}

function schedulePendingMessageRetry() {
  if (!pendingQueue.some(item => item.type === 'message' || item.type === 'recall') || pendingMessageRetryTimer) return
  pendingMessageRetryTimer = setTimeout(() => {
    pendingMessageRetryTimer = null
    pendingMessageInFlight.clear()
    pendingRecallInFlight.clear()
    pendingMessageRetryDelay = Math.min(pendingMessageRetryDelay * 2, MESSAGE_RETRY_MAX_MS)
    flushPendingQueue()
  }, pendingMessageRetryDelay)
}

function pendingMessageIds() {
  return pendingQueue
    .filter(item => item.type === 'message' && typeof item.payload?.msg_id === 'string')
    .map(item => item.payload.msg_id)
    .slice(0, MAX_PENDING_MESSAGES)
}

function finishPendingMessageSync() {
  pendingMessageSync = false
  if (pendingMessageSyncTimer) clearTimeout(pendingMessageSyncTimer)
  pendingMessageSyncTimer = null
  flushPendingQueue()
}

function beginPendingMessageSync() {
  const ids = pendingMessageIds()
  if (!messageSyncSupported || ids.length === 0 || !(socket && socket.readyState === WebSocket.OPEN && authenticated)) {
    pendingMessageSync = false
    flushPendingQueue()
    return
  }
  pendingMessageSync = true
  try {
    socket.send(JSON.stringify({ type: 'message_status_query', payload: { msg_id: ids } }))
    // Read receipts do not depend on text-message reconciliation and may still be flushed now.
    flushPendingQueue()
    pendingMessageSyncTimer = setTimeout(finishPendingMessageSync, 3000)
  } catch (e) {
    console.error('[ws] message status sync failed', e)
    finishPendingMessageSync()
  }
}

function handleMessageStatus(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : []
  if (payload?.complete === true) {
    for (const result of results) {
      if (result?.status !== 'accepted' || typeof result.msg_id !== 'string' ||
          !Number.isFinite(result.ts) || result.ts <= 0) continue
      confirmPendingMessage(result.msg_id)
      // Reuse the normal ACK path so the local IndexedDB record is corrected too.
      dispatchMessage('ack', { msg_id: result.msg_id, status: 'duplicate', ts: result.ts })
    }
  }
  finishPendingMessageSync()
}

function processAckOutbox(payload) {
  if (typeof payload?.msg_id !== 'string') return
  const status = payload.status || 'accepted'
  if (status === 'accepted' || status === 'duplicate' || status === 'rejected') {
    confirmPendingMessage(payload.msg_id)
  } else if (status === 'retry' || payload.retryable === true) {
    pendingMessageInFlight.delete(payload.msg_id)
  }
}

function processRecallAckOutbox(payload) {
  if (typeof payload?.msg_id !== 'string') return
  const status = payload.status || 'accepted'
  if (status === 'accepted' || status === 'duplicate' || status === 'rejected') {
    confirmPendingRecall(payload.msg_id)
  } else if (status === 'retry' || payload.retryable === true) {
    pendingRecallInFlight.delete(payload.msg_id)
  }
}

function savePendingQueue() {
  try {
    if (pendingQueue.length === 0) localStorage.removeItem(PENDING_QUEUE_KEY)
    else localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(pendingQueue))
  } catch {
    // Ignore when storage is unavailable and degrade to memory queue
  }
}

// Clear the pending queue (memory + persistence). Called when logging out/deleting an account to prevent the read receipt of the old identity from being reissued by the new identity
export function clearPendingQueue() {
  if (pendingFlushTimer) {
    clearTimeout(pendingFlushTimer)
    pendingFlushTimer = null
  }
  if (pendingRetryTimer) {
    clearTimeout(pendingRetryTimer)
    pendingRetryTimer = null
  }
  if (pendingMessageRetryTimer) {
    clearTimeout(pendingMessageRetryTimer)
    pendingMessageRetryTimer = null
  }
  if (pendingMessageSyncTimer) {
    clearTimeout(pendingMessageSyncTimer)
    pendingMessageSyncTimer = null
  }
  pendingMessageSync = false
  pendingQueue.length = 0
  pendingReadInFlight.clear()
  pendingMessageInFlight.clear()
  pendingRecallInFlight.clear()
  pendingMessageRetryDelay = MESSAGE_RETRY_MS
  savePendingQueue()
  // Also clear the inbound early arrival buffer: otherwise unconsumed offline messages from the old identity may be played back when the new identity registers the listener.
  earlyBuffer.length = 0
}

export function connect() {
  if (socket && socket.readyState === WebSocket.OPEN && authenticated) {
    return Promise.resolve()
  }

  // Another caller may arrive while the singleton connection is opening/authenticating.
  // Let that attempt finish instead of replacing handlers or sending a second auth frame.
  if (socket && (socket.readyState === WebSocket.CONNECTING ||
      (socket.readyState === WebSocket.OPEN && authPending))) {
    return Promise.resolve()
  }

  const token = localStorage.getItem('session_token')
  if (!token) return Promise.resolve()
  reconnectSuppressed = false

  if (!browserOnline()) {
    setConnectionState('offline', 'browser_offline')
    return Promise.resolve()
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  return new Promise((resolve) => {
    const isDev = process.env.DEV
    const url = isDev
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      : 'wss://m.yzs88.com:8088/ws'

    const connectionSocket = new WebSocket(url)
    socket = connectionSocket
    authPending = true
    authenticated = false
    setConnectionState(reconnectAttempt > 0 ? 'reconnecting' : 'connecting', 'connect_start')
    recordDiagnostic('socket_created', { state: wsConnectionState.value })

    connectionSocket.onopen = () => {
      if (socket !== connectionSocket) return
      console.log('[ws] connected, sending auth...')
      setConnectionState('authenticating', 'socket_open')
      // After the connection is established, token authentication is sent through the message.
      sendAuth(token, resolve, connectionSocket)
    }

    connectionSocket.onmessage = (event) => {
      if (socket !== connectionSocket) return
      try {
        const msg = JSON.parse(event.data)

        // Handle authentication responses
        if (msg.type === 'auth_result') {
          authPending = false
          authenticated = msg.payload?.success === true
          syncServerClock(msg.payload?.server_time)
          readAckSupported = msg.payload?.read_ack === true
          messageSyncSupported = msg.payload?.message_sync === true
          healthCheckSupported = msg.payload?.health_check === true
          reliableInboxSupported = msg.payload?.reliable_inbox === true
          if (msg.payload && msg.payload.success) {
            console.log('[ws] auth success')
            reconnectAttempt = 0
            setConnectionState('connected', 'auth_success')
            startHealthMonitor()
            beginPendingMessageSync()
          } else {
            console.warn('[ws] auth failed:', msg.payload?.reason)
            // Authentication failed, disconnected
            disconnect()
          }
          return
        }

        if (msg.type === 'health_pong') {
          handleHealthPong(msg.payload)
          return
        }
        if (msg.type === 'message_status') {
          handleMessageStatus(msg.payload)
          return
        }
        if (msg.type === 'ack') processAckOutbox(msg.payload)
        if (msg.type === 'recall_ack') processRecallAckOutbox(msg.payload)
        dispatchMessage(msg.type, msg.payload)
      } catch (e) {
        console.error('[ws] parse error', e)
      }
    }

    connectionSocket.onclose = (e) => {
      if (socket !== connectionSocket) return
      console.log('[ws] closed', e.code)
      socket = null
      resetTransientConnectionState()
      recordDiagnostic('socket_closed', { close_code: e.code, reason: e.code === 1000 ? 'normal' : 'unexpected' })
      scheduleReconnect('socket_closed')
    }

    connectionSocket.onerror = (event) => {
      if (socket !== connectionSocket) return
      console.error('[ws] error', event)
      recordDiagnostic('socket_error', { state: wsConnectionState.value })
      resolve() //Does not block applications
      forceReconnect('socket_error')
    }
  })
}

/**
 * Send authentication message (Token is passed through the message body and is not exposed in the URL)
 */
function sendAuth(token, resolve, authenticatingSocket = socket) {
  if (authenticatingSocket && authenticatingSocket.readyState === WebSocket.OPEN) {
    authenticatingSocket.send(JSON.stringify({ type: 'auth', payload: { token, reliable_inbox: true } }))
    // Wait for auth_result response before resolving
    // Set a timeout to prevent the server from becoming unresponsive
    const timeout = setTimeout(() => {
      authPending = false
      authenticated = false
      resolve()  //The timeout is also resolved and does not block the application.
      if (socket === authenticatingSocket) forceReconnect('auth_timeout')
    }, 5000)

    // Listen for auth_result
    const origOnMessage = authenticatingSocket.onmessage
    authenticatingSocket.onmessage = (event) => {
      if (socket !== authenticatingSocket) return
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'auth_result') {
          clearTimeout(timeout)
          authPending = false
          authenticated = msg.payload?.success === true
          syncServerClock(msg.payload?.server_time)
          readAckSupported = msg.payload?.read_ack === true
          messageSyncSupported = msg.payload?.message_sync === true
          healthCheckSupported = msg.payload?.health_check === true
          reliableInboxSupported = msg.payload?.reliable_inbox === true
          if (msg.payload?.success) {
            console.log('[ws] auth success')
            reconnectAttempt = 0
            setConnectionState('connected', 'auth_success')
            startHealthMonitor()
            beginPendingMessageSync()
          } else {
            console.warn('[ws] auth failed:', msg.payload?.reason)
            setConnectionState('disconnected', 'auth_failed')
            recordDiagnostic('auth_failed')
          }
          // Restore original message processing
          authenticatingSocket.onmessage = origOnMessage
          resolve()
          if (!msg.payload?.success) disconnect()
          return
        }
        // Other messages are handed over to the original processing
        origOnMessage?.(event)
      } catch {
        origOnMessage?.(event)
      }
    }
  } else {
    authenticated = false
    resolve()
  }
}

export function disconnect() {
  reconnectSuppressed = true
  reconnectAttempt = 0
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  abandonCurrentSocket()
  resetTransientConnectionState()
  setConnectionState('disconnected', 'explicit_disconnect')
  readAckSupported = false
  messageSyncSupported = false
  healthCheckSupported = false
  reliableInboxSupported = false
}

export function reconnectNow(reason = 'manual') {
  if (!localStorage.getItem('session_token')) return false
  reconnectSuppressed = false
  if (!browserOnline()) {
    setConnectionState('offline', reason)
    return false
  }
  if (isConnected()) {
    startHealthMonitor()
    sendHealthProbe(true)
    flushPendingQueue()
    return true
  }
  if (socket && (socket.readyState === WebSocket.CONNECTING || authPending)) return true
  forceReconnect(reason, true)
  return true
}

export function startConnectionRecovery() {
  if (recoveryCleanup) return recoveryCleanup
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}

  const onOnline = () => {
    recordDiagnostic('network_online')
    reconnectAttempt = 0
    reconnectNow('network_online')
  }
  const onOffline = () => {
    recordDiagnostic('network_offline')
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    abandonCurrentSocket()
    resetTransientConnectionState()
    setConnectionState('offline', 'network_offline')
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      clearHealthTimers()
      return
    }
    recordDiagnostic('app_foreground')
    if (isConnected()) {
      startHealthMonitor()
      sendHealthProbe(true)
    } else {
      reconnectNow('app_foreground')
    }
  }
  const onPageShow = () => reconnectNow('page_show')

  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  window.addEventListener('pageshow', onPageShow)
  document.addEventListener('visibilitychange', onVisibilityChange)
  recoveryCleanup = () => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('pageshow', onPageShow)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    recoveryCleanup = null
  }
  return recoveryCleanup
}

/**
 * Send message
 * Security check: Make sure the connection is authenticated before sending business messages
 */
export function send(type, payload) {
  // read is an "at least once delivery" message: it is persisted first regardless of whether it is currently online, and then deleted after read_ack.
  if (type === 'read') {
    queuePendingRead(payload)
    const connected = Boolean(socket && socket.readyState === WebSocket.OPEN && authenticated)
    if (connected) schedulePendingFlush()
    return connected
  }
  // Text messages use an E2EE ciphertext outbox. Persist first, then send; reconnects and reloads can safely replay the same msg_id.
  if (type === 'message') {
    if (!queuePendingMessage(payload)) {
      console.warn('[ws] pending message queue is full or invalid')
      return false
    }
    const connected = Boolean(socket && socket.readyState === WebSocket.OPEN && authenticated)
    if (connected) schedulePendingFlush()
    return connected
  }
  // Recall is also an outbox operation: deleting locally while offline must not silently
  // lose the tombstone intended for the other device.
  if (type === 'recall') {
    if (!queuePendingRecall(payload)) {
      console.warn('[ws] pending recall queue is full or invalid')
      return false
    }
    const connected = Boolean(socket && socket.readyState === WebSocket.OPEN && authenticated)
    if (connected) schedulePendingFlush()
    return connected
  }
  if (!socket || socket.readyState !== WebSocket.OPEN || !authenticated) {
    console.warn('[ws] not connected or auth pending, message dropped')
    return false
  }
  try {
    socket.send(JSON.stringify({ type, payload }))
    return true
  } catch (e) {
    console.error('[ws] send failed', e)
    forceReconnect('send_failed')
    return false
  }
}

function flushPendingQueue() {
  if (!(socket && socket.readyState === WebSocket.OPEN && authenticated)) return
  const snapshot = pendingQueue.flatMap(item => {
    if (item.type === 'message') {
      return pendingMessageSync || pendingMessageInFlight.has(item.payload.msg_id)
        ? []
        : [{ type: item.type, payload: { ...item.payload } }]
    }
    if (item.type === 'recall') {
      return pendingRecallInFlight.has(item.payload.msg_id)
        ? []
        : [{ type: item.type, payload: { ...item.payload } }]
    }
    if (item.type !== 'read') return []
    const ids = (item.payload?.msg_id || []).filter(id => !pendingReadInFlight.has(`${item.payload.to}\u0000${id}`))
    return ids.length > 0 ? [{ type: item.type, payload: { ...item.payload, msg_id: ids } }] : []
  })
  const sentItems = []
  // Queue entries are retained until read_ack; connections that are disconnected immediately after sending will be safely retransmitted upon reconnection.
  for (const { type, payload } of snapshot) {
    try {
      socket.send(JSON.stringify({ type, payload }))
      sentItems.push({ type, payload })
      if (type === 'read') {
        for (const id of payload.msg_id) pendingReadInFlight.add(`${payload.to}\u0000${id}`)
      } else if (type === 'message') {
        pendingMessageInFlight.add(payload.msg_id)
      } else if (type === 'recall') {
        pendingRecallInFlight.add(payload.msg_id)
      }
    } catch (e) {
      console.error('[ws] pending send failed', e)
      forceReconnect('pending_send_failed')
      break
    }
  }
  schedulePendingMessageRetry()
  if (!readAckSupported) {
    // The old backend does not have read_ack: regresses to the old version of "write to WebSocket and acknowledge" to avoid permanent accumulation of queues during upgrades.
    for (const item of sentItems) {
      if (item.type !== 'read') continue
      confirmPendingReads(item.payload.to, item.payload.msg_id)
      dispatchMessage('read_ack', { to: item.payload.to, msg_id: item.payload.msg_id })
    }
  }
  if (!reliableInboxSupported) {
    // Compatibility with older servers that forward recalls but do not return recall_ack.
    for (const item of sentItems) {
      if (item.type === 'recall') confirmPendingRecall(item.payload.msg_id)
    }
  }
  schedulePendingRetry()
}

/**
 * Register message listening
 */
export function on(type, callback) {
  if (!listeners.has(type)) listeners.set(type, new Set())
  listeners.get(type).add(callback)
  // Play back messages of this type that arrived and were temporarily stored before the listener was registered (offline message cold start re-investment)
  if (earlyBuffer.length) {
    for (let i = 0; i < earlyBuffer.length; ) {
      if (earlyBuffer[i].type === type) {
        callback(earlyBuffer.splice(i, 1)[0].payload)
      } else {
        i++
      }
    }
  }
}

/**
 * Remove message listening
 */
export function off(type, callback) {
  listeners.get(type)?.delete(callback)
}

export function isConnected() {
  return socket?.readyState === WebSocket.OPEN && authenticated
}
