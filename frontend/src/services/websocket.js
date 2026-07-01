/**
 * WebSocket 服务
 * 单例模式，全局复用一个连接
 * 安全改进：Token 通过首条消息认证，不暴露在 URL 中
 */

import { ref } from 'vue'

let socket = null
let reconnectTimer = null
let authPending = false
const listeners = new Map() // type → Set<callback>
const PENDING_QUEUE_KEY = 'ws_pending_queue'  // 已读回执等关键消息的持久化队列
const pendingQueue = loadPendingQueue()        // 断连期间缓存的消息（跨刷新保留）

// 入站早到缓冲：冷启动时后端在认证成功后会立即 flush 离线消息，而聊天监听器要等
// MainLayout 挂载（onMounted → startListening）才注册。若消息先到、监听器还没注册，
// 直接丢弃会导致离线消息永久丢失（后端已从 Redis 删除队列）。故对这类需要补投的
// 类型先暂存，待对应 on(type) 注册时回放。仅缓冲会进离线队列/需补投的类型，
// 避免缓冲 status、游戏动作等高频瞬时事件。
const BUFFERED_TYPES = new Set(['message', 'read_receipt', 'recall'])
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
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
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
  pendingQueue.length = 0
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
  if (!socket || socket.readyState !== WebSocket.OPEN || authPending) {
    if (type === 'read') {
      pendingQueue.push({ type, payload })
      savePendingQueue()
    }
    console.warn('[ws] not connected or auth pending, message dropped')
    return false
  }
  socket.send(JSON.stringify({ type, payload }))
  return true
}

function flushPendingQueue() {
  while (pendingQueue.length > 0) {
    if (!(socket && socket.readyState === WebSocket.OPEN && !authPending)) break
    const { type, payload } = pendingQueue[0]
    socket.send(JSON.stringify({ type, payload }))
    pendingQueue.shift()
  }
  savePendingQueue()
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
