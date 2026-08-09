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

async function createWebSocketHarness() {
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalWebSocket = globalThis.WebSocket
  const sockets = []

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
        }))
      }
    }

    emit(type, payload) {
      this.onmessage?.({ data: JSON.stringify({ type, payload }) })
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.({ code: 1000 })
    }
  }

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage([['session_token', 'test-token']]),
  })
  globalThis.WebSocket = FakeWebSocket

  const moduleUrl = new URL('./websocket.js', import.meta.url)
  moduleUrl.searchParams.set('test', String(++harnessSequence))
  const websocket = await import(moduleUrl.href)

  return {
    websocket,
    get socket() {
      assert.equal(sockets.length, 1)
      return sockets[0]
    },
    restore() {
      if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
      else delete globalThis.localStorage
      if (originalWebSocket === undefined) delete globalThis.WebSocket
      else globalThis.WebSocket = originalWebSocket
    },
  }
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
