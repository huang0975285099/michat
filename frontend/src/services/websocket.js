/**
 * WebSocket service
 * Singleton mode, globally reusing a connection
 * Security improvement: Token is authenticated through the first message and is not exposed in the URL
 */

import { ref } from 'vue'

let socket = null
let reconnectTimer = null
let authPending = false
let pendingFlushTimer = null
let pendingRetryTimer = null
let readAckSupported = false
const listeners = new Map() // type → Set<callback>
const PENDING_QUEUE_KEY = 'ws_pending_queue'  //A persistent queue for key messages such as read receipts
const READ_BATCH_SIZE = 100
const pendingQueue = loadPendingQueue()        //Messages cached during disconnection (retained across refreshes)
const pendingReadInFlight = new Set()          //The ID of the current connection that has been written and is waiting for read_ack
let serverClock = null //{ epochMs, monotonicMs }, calibrated by the server during authentication

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
      if (item?.type !== 'read') {
        result.push(item)
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

function syncServerClock(serverTime) {
  if (!Number.isFinite(serverTime) || serverTime <= 0) return
  serverClock = { epochMs: serverTime, monotonicMs: performance.now() }
}

// Using server authentication time + monotonic clock advancement, modifying the device time while the page is open will not extend the time it disappears after reading.
// It is degraded to the local time before the authentication is completed.
export function getServerNow() {
  if (!serverClock) return Date.now()
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
  if (pendingQueue.length === 0 && pendingRetryTimer) {
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
  if (!readAckSupported || pendingQueue.length === 0 || pendingRetryTimer) return
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = null
    // read_ack may be lost due to current limiting or instantaneous disconnection; the entire batch is allowed to be resent. Server-side writes are idempotent.
    pendingReadInFlight.clear()
    flushPendingQueue()
  }, 5000)
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
  pendingQueue.length = 0
  pendingReadInFlight.clear()
  savePendingQueue()
  // Also clear the inbound early arrival buffer: otherwise unconsumed offline messages from the old identity may be played back when the new identity registers the listener.
  earlyBuffer.length = 0
}

// Responsive connection status for UI monitoring
export const wsConnected = ref(false)

export function connect() {
  if (socket && socket.readyState === WebSocket.OPEN && !authPending) {
    return Promise.resolve()
  }

  const token = localStorage.getItem('session_token')
  if (!token) return Promise.resolve()

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  // If already connected, return Promise and wait
  if (socket && socket.readyState === WebSocket.CONNECTING) {
    return new Promise((resolve) => {
      const origOpen = socket.onopen
      socket.onopen = () => {
        origOpen?.()
        // Send authentication message
        sendAuth(token, resolve)
      }
    })
  }

  return new Promise((resolve) => {
    const isDev = process.env.DEV
    const url = isDev
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      : 'wss://yb.yzs88.com/ws'

    socket = new WebSocket(url)
    authPending = true

    socket.onopen = () => {
      console.log('[ws] connected, sending auth...')
      // After the connection is established, token authentication is sent through the message.
      sendAuth(token, resolve)
    }

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)

        // Handle authentication responses
        if (msg.type === 'auth_result') {
          authPending = false
          syncServerClock(msg.payload?.server_time)
          readAckSupported = msg.payload?.read_ack === true
          if (msg.payload && msg.payload.success) {
            console.log('[ws] auth success')
            flushPendingQueue()
          } else {
            console.warn('[ws] auth failed:', msg.payload?.reason)
            // Authentication failed, disconnected
            disconnect()
          }
          return
        }

        dispatchMessage(msg.type, msg.payload)
      } catch (e) {
        console.error('[ws] parse error', e)
      }
    }

    socket.onclose = (e) => {
      console.log('[ws] closed', e.code)
      socket = null
      authPending = false
      wsConnected.value = false
      pendingReadInFlight.clear()
      if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null }
      if (pendingRetryTimer) { clearTimeout(pendingRetryTimer); pendingRetryTimer = null }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, 3000)
    }

    socket.onerror = (e) => {
      console.error('[ws] error', e)
      authPending = false
      resolve() //Does not block applications
    }
  })
}

/**
 * Send authentication message (Token is passed through the message body and is not exposed in the URL)
 */
function sendAuth(token, resolve) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'auth', payload: { token } }))
    // Wait for auth_result response before resolving
    // Set a timeout to prevent the server from becoming unresponsive
    const timeout = setTimeout(() => {
      authPending = false
      resolve()  //The timeout is also resolved and does not block the application.
    }, 5000)

    // Listen for auth_result
    const origOnMessage = socket.onmessage
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'auth_result') {
          clearTimeout(timeout)
          authPending = false
          syncServerClock(msg.payload?.server_time)
          readAckSupported = msg.payload?.read_ack === true
          if (msg.payload?.success) {
            console.log('[ws] auth success')
            wsConnected.value = true
            flushPendingQueue()
          } else {
            console.warn('[ws] auth failed:', msg.payload?.reason)
            wsConnected.value = false
          }
          // Restore original message processing
          socket.onmessage = origOnMessage
          resolve()
          return
        }
        // Other messages are handed over to the original processing
        origOnMessage?.(event)
      } catch {
        origOnMessage?.(event)
      }
    }
  } else {
    resolve()
  }
}

export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  authPending = false
  wsConnected.value = false
  readAckSupported = false
  pendingReadInFlight.clear()
  if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null }
  if (pendingRetryTimer) { clearTimeout(pendingRetryTimer); pendingRetryTimer = null }
  if (socket) {
    socket.onclose = null //Prevent reconnection
    socket.close()
    socket = null
  }
}

/**
 * Send message
 * Security check: Make sure the connection is authenticated before sending business messages
 */
export function send(type, payload) {
  // read is an "at least once delivery" message: it is persisted first regardless of whether it is currently online, and then deleted after read_ack.
  if (type === 'read') {
    queuePendingRead(payload)
    const connected = Boolean(socket && socket.readyState === WebSocket.OPEN && !authPending)
    if (connected) schedulePendingFlush()
    return connected
  }
  if (!socket || socket.readyState !== WebSocket.OPEN || authPending) {
    console.warn('[ws] not connected or auth pending, message dropped')
    return false
  }
  try {
    socket.send(JSON.stringify({ type, payload }))
    return true
  } catch (e) {
    console.error('[ws] send failed', e)
    wsConnected.value = false
    return false
  }
}

function flushPendingQueue() {
  if (!(socket && socket.readyState === WebSocket.OPEN && !authPending)) return
  const snapshot = pendingQueue.flatMap(item => {
    if (item.type !== 'read') return [{ type: item.type, payload: { ...item.payload } }]
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
      }
    } catch (e) {
      console.error('[ws] pending send failed', e)
      wsConnected.value = false
      break
    }
  }
  if (!readAckSupported) {
    // The old backend does not have read_ack: regresses to the old version of "write to WebSocket and acknowledge" to avoid permanent accumulation of queues during upgrades.
    for (const item of sentItems) {
      if (item.type !== 'read') continue
      confirmPendingReads(item.payload.to, item.payload.msg_id)
      dispatchMessage('read_ack', { to: item.payload.to, msg_id: item.payload.msg_id })
    }
    return
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
  return socket?.readyState === WebSocket.OPEN && !authPending
}
