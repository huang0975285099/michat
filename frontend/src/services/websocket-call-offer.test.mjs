import assert from 'node:assert/strict'
import test from 'node:test'

let harnessSequence = 0

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries)
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null
  }

  setItem(key, value) {
    this.values.set(key, String(value))
  }

  removeItem(key) {
    this.values.delete(key)
  }
}

async function createWebSocketHarness({ messageSync = false, healthCheck = false, reliableInbox = false, acceptedMessageIds = [], autoHealthPong = true } = {}) {
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalWebSocket = globalThis.WebSocket
  const sockets = []
  const sentMessages = []
  const controlMessages = []
  const storage = new MemoryStorage([['session_token', 'test-token']])
  const accepted = new Set(acceptedMessageIds)

  class FakeEventTarget {
    constructor() {
      this.listeners = new Map()
    }

    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(callback)
    }

    removeEventListener(type, callback) {
      this.listeners.get(type)?.delete(callback)
    }

    dispatch(type) {
      this.listeners.get(type)?.forEach(callback => callback({ type }))
    }
  }

  const fakeWindow = new FakeEventTarget()
  const fakeDocument = new FakeEventTarget()
  fakeDocument.visibilityState = 'visible'
  const fakeNavigator = { onLine: true }

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3

    constructor(url) {
      this.url = url
      this.readyState = FakeWebSocket.CONNECTING
      sockets.push(this)
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN
        this.onopen?.()
      })
    }

    send(raw) {
      const message = JSON.parse(raw)
      if (message.type === 'auth') {
        queueMicrotask(() => this.emit('auth_result', {
          success: true,
          server_time: Date.now(),
          read_ack: true,
          message_sync: messageSync,
          health_check: healthCheck,
          reliable_inbox: reliableInbox,
        }))
      } else if (message.type === 'message_status_query') {
        controlMessages.push(message)
        queueMicrotask(() => this.emit('message_status', {
          complete: true,
          results: message.payload.msg_id.map(msgId => accepted.has(msgId)
            ? { msg_id: msgId, status: 'accepted', ts: 1234000 }
            : { msg_id: msgId, status: 'unknown' }),
        }))
      } else if (message.type === 'health_ping') {
        controlMessages.push(message)
        if (autoHealthPong) queueMicrotask(() => this.emit('health_pong', { nonce: message.payload.nonce }))
      } else {
        sentMessages.push(message)
      }
    }

    emit(type, payload) {
      this.onmessage?.({ data: JSON.stringify({ type, payload }) })
    }

    fail() {
      this.onerror?.({ type: 'error' })
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code: 1000 })
    }
  }

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  globalThis.WebSocket = FakeWebSocket

  const moduleUrl = new URL('./websocket.js', import.meta.url)
  moduleUrl.searchParams.set('test', String(++harnessSequence))
  const websocket = await import(moduleUrl.href)

  // Define browser lifecycle globals only after Vue has loaded. Vue's Node runtime deliberately
  // selects its non-DOM path when document is absent during import.
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: fakeNavigator })

  return {
    websocket,
    get socket() {
      assert.ok(sockets.length > 0)
      return sockets.at(-1)
    },
    sockets,
    sentMessages,
    controlMessages,
    storage,
    setOnline(online) {
      fakeNavigator.onLine = online
      fakeWindow.dispatch(online ? 'online' : 'offline')
    },
    setVisibility(state) {
      fakeDocument.visibilityState = state
      fakeDocument.dispatch('visibilitychange')
    },
    restore() {
      if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
      else delete globalThis.localStorage
      if (originalWebSocket === undefined) delete globalThis.WebSocket
      else globalThis.WebSocket = originalWebSocket
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
      else delete globalThis.window
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
      else delete globalThis.document
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
      else delete globalThis.navigator
    },
  }
}

function waitForTimers(ms = 40) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('replays an incoming call offer that arrived before listener registration', async () => {
  const env = await createWebSocketHarness()
  try {
    await env.websocket.connect()
    env.socket.emit('call_offer', { from: 'peer-a', call_id: 'call-1' })

    const received = []
    env.websocket.on('call_offer', payload => received.push(payload))

    assert.deepEqual(received, [{ from: 'peer-a', call_id: 'call-1' }])
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})

test('does not replay session-bound ICE received without a call listener', async () => {
  const env = await createWebSocketHarness()
  try {
    await env.websocket.connect()
    env.socket.emit('call_ice', {
      from: 'peer-a',
      call_id: 'call-1',
      ice: { candidate: 'candidate:1' },
    })

    const received = []
    env.websocket.on('call_ice', payload => received.push(payload))

    assert.deepEqual(received, [])
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})

test('does not replay camera state received without a call listener', async () => {
  const env = await createWebSocketHarness()
  try {
    await env.websocket.connect()
    env.socket.emit('call_media_state', {
      from: 'peer-a',
      call_id: 'call-1',
      video_enabled: false,
    })

    const received = []
    env.websocket.on('call_media_state', payload => received.push(payload))

    assert.deepEqual(received, [])
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})

test('persists an offline encrypted text message and flushes it after authentication', async () => {
  const env = await createWebSocketHarness()
  const payload = {
    to: '1234-ABCD',
    msg_id: 'abc-1-abcdef',
    ephemeral_pub_key: 'encrypted-key',
    iv: 'encrypted-iv',
    ciphertext: 'encrypted-body',
    burn_after_read: false,
  }
  try {
    assert.equal(env.websocket.send('message', payload), false)
    assert.equal(env.websocket.hasPendingMessage(payload.msg_id), true)
    assert.match(env.storage.getItem('ws_pending_queue'), /encrypted-body/)

    await env.websocket.connect()
    await waitForTimers()
    assert.deepEqual(env.sentMessages, [{ type: 'message', payload }])

    env.websocket.confirmPendingMessage(payload.msg_id)
    assert.equal(env.websocket.hasPendingMessage(payload.msg_id), false)
    assert.equal(env.storage.getItem('ws_pending_queue'), null)
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})

test('persists an offline recall until the server confirms its tombstone', async () => {
  const env = await createWebSocketHarness({ reliableInbox: true })
  const payload = { to: '1234-ABCD', msg_id: 'abc-9-abcdef' }
  try {
    assert.equal(env.websocket.send('recall', payload), false)
    assert.equal(env.websocket.hasPendingRecall(payload.msg_id), true)
    assert.match(env.storage.getItem('ws_pending_queue'), /recall/)

    await env.websocket.connect()
    await waitForTimers()
    assert.deepEqual(env.sentMessages, [{ type: 'recall', payload }])
    assert.equal(env.websocket.hasPendingRecall(payload.msg_id), true)

    env.socket.emit('recall_ack', { msg_id: payload.msg_id, status: 'accepted' })
    assert.equal(env.websocket.hasPendingRecall(payload.msg_id), false)
    assert.equal(env.storage.getItem('ws_pending_queue'), null)
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})

test('sends recipient persistence acknowledgements after authentication', async () => {
  const env = await createWebSocketHarness({ reliableInbox: true })
  try {
    await env.websocket.connect()
    assert.equal(env.websocket.send('message_received_ack', {
      from: '1234-ABCD', msg_id: ['abc-10-abcdef'],
    }), true)
    assert.deepEqual(env.sentMessages, [{
      type: 'message_received_ack',
      payload: { from: '1234-ABCD', msg_id: ['abc-10-abcdef'] },
    }])
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})

test('deduplicates pending messages by msg_id and allows immediate retry', async () => {
  const env = await createWebSocketHarness()
  const payload = {
    to: '1234-ABCD',
    msg_id: 'abc-2-abcdef',
    ephemeral_pub_key: 'encrypted-key',
    iv: 'encrypted-iv',
    ciphertext: 'first-body',
    burn_after_read: true,
  }
  try {
    env.websocket.send('message', payload)
    env.websocket.send('message', { ...payload, ciphertext: 'latest-body' })
    const queued = JSON.parse(env.storage.getItem('ws_pending_queue'))
    assert.equal(queued.filter(item => item.type === 'message').length, 1)
    assert.equal(queued[0].payload.ciphertext, 'latest-body')

    await env.websocket.connect()
    await waitForTimers()
    assert.equal(env.sentMessages.length, 1)
    assert.equal(env.sentMessages[0].payload.ciphertext, 'latest-body')

    assert.equal(env.websocket.retryPendingMessage(payload.msg_id), true)
    await waitForTimers()
    assert.equal(env.sentMessages.length, 2)
  } finally {
    env.websocket.confirmPendingMessage(payload.msg_id)
    env.websocket.disconnect()
    env.restore()
  }
})

test('reconciles an already accepted message before replaying the outbox', async () => {
  const msgId = 'abc-3-abcdef'
  const env = await createWebSocketHarness({ messageSync: true, acceptedMessageIds: [msgId] })
  const payload = {
    to: '1234-ABCD',
    msg_id: msgId,
    ephemeral_pub_key: 'encrypted-key',
    iv: 'encrypted-iv',
    ciphertext: 'encrypted-body',
    burn_after_read: false,
  }
  try {
    env.websocket.send('message', payload)
    const acknowledgements = []
    env.websocket.on('ack', ack => acknowledgements.push(ack))

    await env.websocket.connect()
    await waitForTimers()

    assert.equal(env.controlMessages.length, 1)
    assert.deepEqual(env.controlMessages[0].payload.msg_id, [msgId])
    assert.deepEqual(env.sentMessages, [])
    assert.equal(env.websocket.hasPendingMessage(msgId), false)
    assert.deepEqual(acknowledgements, [{ msg_id: msgId, status: 'duplicate', ts: 1234000 }])
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})

test('keeps retryable failures queued and drops permanently rejected outbox entries', async () => {
  const env = await createWebSocketHarness()
  const retryId = 'abc-4-abcdef'
  const rejectedId = 'abc-5-abcdef'
  const base = {
    to: '1234-ABCD',
    ephemeral_pub_key: 'encrypted-key',
    iv: 'encrypted-iv',
    ciphertext: 'encrypted-body',
    burn_after_read: false,
  }
  try {
    env.websocket.send('message', { ...base, msg_id: retryId })
    env.websocket.send('message', { ...base, msg_id: rejectedId })
    await env.websocket.connect()
    await waitForTimers()

    env.socket.emit('ack', { msg_id: retryId, status: 'retry', code: 'temporary_failure', retryable: true })
    env.socket.emit('ack', { msg_id: rejectedId, status: 'rejected', code: 'not_friends' })

    assert.equal(env.websocket.hasPendingMessage(retryId), true)
    assert.equal(env.websocket.hasPendingMessage(rejectedId), false)
  } finally {
    env.websocket.confirmPendingMessage(retryId)
    env.websocket.disconnect()
    env.restore()
  }
})

test('stops reconnect churn while offline and immediately flushes after network recovery', async () => {
  const env = await createWebSocketHarness()
  const payload = {
    to: '1234-ABCD',
    msg_id: 'abc-6-abcdef',
    ephemeral_pub_key: 'encrypted-key',
    iv: 'encrypted-iv',
    ciphertext: 'encrypted-body',
    burn_after_read: false,
  }
  const stopRecovery = env.websocket.startConnectionRecovery()
  try {
    await env.websocket.connect()
    env.setOnline(false)
    assert.equal(env.websocket.wsConnectionState.value, 'offline')
    assert.equal(env.websocket.send('message', payload), false)
    assert.equal(env.websocket.hasPendingMessage(payload.msg_id), true)

    env.setOnline(true)
    await waitForTimers()

    assert.equal(env.sockets.length, 2)
    assert.equal(env.websocket.wsConnectionState.value, 'connected')
    assert.deepEqual(env.sentMessages, [{ type: 'message', payload }])
  } finally {
    stopRecovery()
    env.websocket.confirmPendingMessage(payload.msg_id)
    env.websocket.disconnect()
    env.restore()
  }
})

test('probes the WebSocket immediately when the app returns to foreground', async () => {
  const env = await createWebSocketHarness({ healthCheck: true })
  const stopRecovery = env.websocket.startConnectionRecovery()
  try {
    await env.websocket.connect()
    env.setVisibility('hidden')
    env.setVisibility('visible')
    await waitForTimers()

    const probes = env.controlMessages.filter(message => message.type === 'health_ping')
    assert.equal(probes.length, 1)
    assert.match(probes[0].payload.nonce, /^[a-z0-9]{1,32}$/)
    assert.equal(env.websocket.wsConnectionState.value, 'connected')
  } finally {
    stopRecovery()
    env.websocket.disconnect()
    env.restore()
  }
})

test('does not probe an older server that did not advertise health checks', async () => {
  const env = await createWebSocketHarness({ healthCheck: false })
  const stopRecovery = env.websocket.startConnectionRecovery()
  try {
    await env.websocket.connect()
    env.setVisibility('hidden')
    env.setVisibility('visible')
    await waitForTimers()

    assert.equal(env.controlMessages.some(message => message.type === 'health_ping'), false)
    assert.equal(env.websocket.wsConnectionState.value, 'connected')
  } finally {
    stopRecovery()
    env.websocket.disconnect()
    env.restore()
  }
})

test('connection diagnostics contain only bounded connection metadata', async () => {
  const env = await createWebSocketHarness()
  try {
    await env.websocket.connect()
    const diagnostics = env.websocket.getConnectionDiagnostics()
    assert.ok(diagnostics.length > 0)
    for (const entry of diagnostics) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        Object.keys(entry).filter(key => ['ts', 'event', 'state', 'reason', 'close_code', 'retry_ms', 'queue_size'].includes(key)).sort(),
      )
      assert.doesNotMatch(JSON.stringify(entry), /test-token|encrypted-body|1234-ABCD/)
    }
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})

test('socket errors use reconnect backoff instead of creating a reconnect storm', async () => {
  const env = await createWebSocketHarness()
  try {
    await env.websocket.connect()
    env.socket.fail()
    await waitForTimers()

    assert.equal(env.sockets.length, 1)
    assert.equal(env.websocket.wsConnectionState.value, 'reconnecting')
    const scheduled = env.websocket.getConnectionDiagnostics().filter(entry => entry.event === 'reconnect_scheduled')
    assert.equal(scheduled.at(-1)?.retry_ms, 1000)
  } finally {
    env.websocket.disconnect()
    env.restore()
  }
})
