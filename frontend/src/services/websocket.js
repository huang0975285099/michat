/**
 * WebSocket 服务
 * 单例模式，全局复用一个连接
 * 安全改进：Token 通过首条消息认证，不暴露在 URL 中
 */

import { ref } from 'vue'

let socket = null
let reconnectTimer = null
let authPending = false
let pendingFlushTimer = null
let pendingRetryTimer = null
let readAckSupported = false
const listeners = new Map() // type → Set<callback>
const PENDING_QUEUE_KEY = 'ws_pending_queue'  // 已读回执等关键消息的持久化队列
const READ_BATCH_SIZE = 100
const pendingQueue = loadPendingQueue()        // 断连期间缓存的消息（跨刷新保留）
const pendingReadInFlight = new Set()          // 已写入当前连接、正等待 read_ack 的 ID
let serverClock = null // { epochMs, monotonicMs }，认证时由服务器校准

// 入站早到缓冲：冷启动时后端在认证成功后会立即 flush 离线消息，而聊天监听器要等
// MainLayout 挂载（onMounted → startListening）才注册。若消息先到、监听器还没注册，
// 直接丢弃会导致离线消息永久丢失（后端已从 Redis 删除队列）。故对这类需要补投的
// 类型先暂存，待对应 on(type) 注册时回放。仅缓冲会进离线队列/需补投的类型，
// 避免缓冲 status、游戏动作等高频瞬时事件。
const BUFFERED_TYPES = new Set(['message', 'read_receipt', 'read_ack', 'ack', 'recall', 'file_done'])
const EARLY_BUFFER_MAX = 500
const earlyBuffer = [] // [{ type, payload }] 到达时尚无监听器的消息

function dispatchMessage(type, payload) {
  const cbs = listeners.get(type)
  if (cbs && cbs.size) {
    cbs.forEach((cb) => cb(payload))
    return
  }
  // 尚无监听器：仅对需补投的类型入缓冲，等监听器注册后回放
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
    // 兼容旧版本可能留下的超大/重复批次，加载时即规范为每批最多 100 个 ID。
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

// 使用服务器认证时间 + 单调时钟推进，页面打开期间修改设备时间不会延长阅后即焚。
// 尚未完成认证时才退化为本机时间。
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

// 服务端明确确认持久化后，才从可靠重发队列移除这些已读回执。
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
  // 合并同一小段时间内连续到达的消息，避免每新增一个 ID 就重发整个待确认批次。
  pendingFlushTimer = setTimeout(() => {
    pendingFlushTimer = null
    flushPendingQueue()
  }, 25)
}

function schedulePendingRetry() {
  if (!readAckSupported || pendingQueue.length === 0 || pendingRetryTimer) return
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = null
    // read_ack 可能因限流或瞬时断线丢失；允许整批重新发送。服务端写入是幂等的。
    pendingReadInFlight.clear()
    flushPendingQueue()
  }, 5000)
}

function savePendingQueue() {
  try {
    if (pendingQueue.length === 0) localStorage.removeItem(PENDING_QUEUE_KEY)
    else localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(pendingQueue))
  } catch {
    // 存储不可用时忽略，退化为内存队列
  }
}

// 清空待发队列（内存 + 持久化）。注销/删除账号时调用，避免旧身份的已读回执被新身份重发
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
  // 一并清空入站早到缓冲：否则旧身份未消费的离线消息可能在新身份注册监听器时被回放
  earlyBuffer.length = 0
}

// 响应式连接状态，供 UI 监听
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

  // 如果已在连接中，返回 Promise 等待
  if (socket && socket.readyState === WebSocket.CONNECTING) {
    return new Promise((resolve) => {
      const origOpen = socket.onopen
      socket.onopen = () => {
        origOpen?.()
        // 发送认证消息
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
      // 连接建立后通过消息发送 token 认证
      sendAuth(token, resolve)
    }

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)

        // 处理认证响应
        if (msg.type === 'auth_result') {
          authPending = false
          syncServerClock(msg.payload?.server_time)
          readAckSupported = msg.payload?.read_ack === true
          if (msg.payload && msg.payload.success) {
            console.log('[ws] auth success')
            flushPendingQueue()
          } else {
            console.warn('[ws] auth failed:', msg.payload?.reason)
            // 认证失败，断开连接
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
      resolve() // 不阻塞应用
    }
  })
}

/**
 * 发送认证消息（Token 通过消息体传递，不在 URL 中暴露）
 */
function sendAuth(token, resolve) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'auth', payload: { token } }))
    // 等待 auth_result 响应后才 resolve
    // 设置超时，防止服务器无响应
    const timeout = setTimeout(() => {
      authPending = false
      resolve()  // 超时也 resolve，不阻塞应用
    }, 5000)

    // 监听 auth_result
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
          // 恢复原始消息处理
          socket.onmessage = origOnMessage
          resolve()
          return
        }
        // 其他消息交给原始处理
        origOnMessage?.(event)
      } catch (e) {
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
    socket.onclose = null // 阻止重连
    socket.close()
    socket = null
  }
}

/**
 * 发送消息
 * 安全检查：确保连接已认证后才发送业务消息
 */
export function send(type, payload) {
  // read 是“至少投递一次”消息：无论当前是否在线都先持久化，read_ack 后再删除。
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
  // 队列项保留到 read_ack；连接在发送后立刻断开也会在重连时安全重发。
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
    // 旧后端没有 read_ack：退化为旧版“写入 WebSocket 即确认”，避免升级期间队列永久累积。
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
 * 注册消息监听
 */
export function on(type, callback) {
  if (!listeners.has(type)) listeners.set(type, new Set())
  listeners.get(type).add(callback)
  // 回放该类型在监听器注册前到达并暂存的消息（离线消息冷启动补投）
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
 * 移除消息监听
 */
export function off(type, callback) {
  listeners.get(type)?.delete(callback)
}

export function isConnected() {
  return socket?.readyState === WebSocket.OPEN && !authPending
}
