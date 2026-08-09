import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createPinia, setActivePinia } from 'pinia'
import { Notify } from 'quasar'
import { createServer } from 'vite'

const CALL_STORE_PATH = '/src/stores/call.js'
const FRONTEND_PATH = fileURLToPath(new URL('../../', import.meta.url))
const SRC_PATH = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/')

function createTrack(kind, id = `${kind}-${crypto.randomUUID()}`) {
  return {
    id,
    kind,
    enabled: true,
    readyState: 'live',
    stopped: false,
    onended: null,
    stop() {
      this.stopped = true
      this.readyState = 'ended'
    },
  }
}

function createStream(id, kinds = ['audio', 'video']) {
  const tracks = kinds.map((kind) => createTrack(kind, `${id}-${kind}`))
  return {
    id,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(track => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter(track => track.kind === 'video'),
    addTrack: track => tracks.push(track),
    removeTrack: track => {
      const index = tracks.indexOf(track)
      if (index !== -1) tracks.splice(index, 1)
    },
  }
}

async function createCallHarness({ audio = null, camera = null } = {}) {
  const sent = []
  const listeners = new Map()
  const streams = []
  const peerConnections = []
  const notifications = []
  let mediaCalls = 0
  let audioCalls = 0
  let cameraCalls = 0
  let cameraResult = camera

  globalThis.__callTestSent = sent
  globalThis.__callTestListeners = listeners
  const originalNotifyCreate = Notify.create
  Notify.create = (options) => notifications.push(options)

  const boundaryPlugin = {
    name: 'call-test-boundaries',
    enforce: 'pre',
    resolveId(id) {
      const normalized = id.replaceAll('\\', '/').replace(/\/{2,}/g, '/')
      if (/^(?:src\/services\/websocket|.*\/src\/services\/websocket)(?:\.js)?$/.test(normalized)) {
        return '\0call-test-websocket'
      }
      if (/^(?:src\/services\/api|.*\/src\/services\/api)(?:\.js)?$/.test(normalized)) {
        return '\0call-test-api'
      }
    },
    load(id) {
      if (id === '\0call-test-websocket') {
        return `
          export const wsConnected = { value: true }
          export function send(type, payload) {
            globalThis.__callTestSent.push({ type, payload })
            return true
          }
          export function on(type, callback) {
            globalThis.__callTestListeners.set(type, callback)
          }
          export function off(type) {
            globalThis.__callTestListeners.delete(type)
          }
        `
      }
      if (id === '\0call-test-api') {
        return `
          export const callApi = {
            getTurnCredentials: async () => ({
              data: { uris: [], username: '', password: '' },
            }),
          }
        `
      }
    },
  }

  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalRTCPeerConnection = globalThis.RTCPeerConnection

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          mediaCalls++
          let stream
          if (constraints.audio === true && constraints.video === false) {
            audioCalls++
            if (audio instanceof Error) throw audio
            stream = audio || createStream(`audio-${audioCalls}`, ['audio'])
          } else if (constraints.audio === false && constraints.video) {
            cameraCalls++
            if (cameraResult instanceof Error) throw cameraResult
            stream = typeof cameraResult === 'function'
              ? await cameraResult(constraints)
              : cameraResult || createStream(`camera-${cameraCalls}`, ['video'])
          } else {
            if (constraints.video && cameraResult instanceof Error) throw cameraResult
            stream = createStream(`combined-${mediaCalls}`, constraints.video ? ['audio', 'video'] : ['audio'])
          }
          streams.push(stream)
          return stream
        },
      },
    },
  })

  class FakeRTCPeerConnection {
    constructor() {
      this.closed = false
      this.connectionState = 'new'
      this.localDescription = null
      this.remoteDescription = null
      this.senders = []
      this.transceivers = []
      this.videoTransceiver = null
      peerConnections.push(this)
    }

    createSender(track) {
      const sender = {
        track,
        async replaceTrack(nextTrack) {
          this.track = nextTrack
        },
      }
      this.senders.push(sender)
      return sender
    }

    addTrack(track) {
      if (track.kind === 'video' && this.videoTransceiver && !this.videoTransceiver.sender.track) {
        this.videoTransceiver.sender.track = track
        return this.videoTransceiver.sender
      }
      return this.createSender(track)
    }

    addTransceiver(trackOrKind, init = {}) {
      const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind
      const track = typeof trackOrKind === 'string' ? null : trackOrKind
      const sender = this.createSender(track)
      const transceiver = {
        direction: init.direction,
        sender,
        receiver: { track: createTrack(kind, `remote-${kind}`) },
      }
      this.transceivers.push(transceiver)
      if (kind === 'video') this.videoTransceiver = transceiver
      return transceiver
    }

    getTransceivers() {
      return [...this.transceivers]
    }

    getSenders() {
      return [...this.senders]
    }

    async createOffer() {
      return { type: 'offer', sdp: 'v=0\r\nm=video' }
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description
      if (description.type === 'offer' && description.sdp?.includes('m=video') && !this.videoTransceiver) {
        this.addTransceiver('video', { direction: 'sendrecv' })
      }
    }

    async createAnswer() {
      return { type: 'answer', sdp: 'v=0' }
    }

    async setLocalDescription(description) {
      this.localDescription = description
    }

    close() {
      this.closed = true
    }
  }

  globalThis.RTCPeerConnection = FakeRTCPeerConnection

  const server = await createServer({
    logLevel: 'silent',
    root: FRONTEND_PATH,
    plugins: [boundaryPlugin],
    resolve: { alias: { src: SRC_PATH } },
    server: { middlewareMode: true },
  })
  const { useCallStore } = await server.ssrLoadModule(CALL_STORE_PATH)
  setActivePinia(createPinia())
  const store = useCallStore()
  const stopListening = store.startListening()

  return {
    store,
    sent,
    streams,
    peerConnections,
    notifications,
    stopListening,
    getUserMediaCalls: () => mediaCalls,
    getAudioCalls: () => audioCalls,
    getCameraCalls: () => cameraCalls,
    setCameraResult(result) {
      cameraResult = result
    },
    emit(type, payload) {
      const listener = listeners.get(type)
      assert.equal(typeof listener, 'function', `missing ${type} listener`)
      return listener(payload)
    },
    async dispose() {
      if (store.state !== 'idle') store.hangup()
      stopListening()
      await server.close()
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
      else delete globalThis.navigator
      if (originalRTCPeerConnection === undefined) delete globalThis.RTCPeerConnection
      else globalThis.RTCPeerConnection = originalRTCPeerConnection
      Notify.create = originalNotifyCreate
      delete globalThis.__callTestSent
      delete globalThis.__callTestListeners
    },
  }
}

test('accepting one incoming call concurrently acquires media and answers once', async () => {
  const env = await createCallHarness()
  try {
    env.emit('call_offer', {
      from: 'peer-a',
      call_id: '11111111-1111-4111-8111-111111111111',
      sdp: { type: 'offer', sdp: 'v=0' },
      media: 'video',
      video_enabled: false,
    })

    assert.equal(env.store.remoteVideoOn, false)

    await Promise.all([env.store.answerCall(), env.store.answerCall()])

    assert.equal(env.getUserMediaCalls(), 2)
    assert.equal(env.peerConnections.length, 1)
    assert.equal(env.sent.filter(({ type }) => type === 'call_answer').length, 1)
    assert.equal(env.sent.find(({ type }) => type === 'call_answer').payload.video_enabled, true)
    assert.equal(env.store.answering, false)
  } finally {
    await env.dispose()
  }
})

test('a video caller without a camera still offers receive-capable video', async () => {
  const cameraError = Object.assign(new Error('missing camera'), { name: 'NotFoundError' })
  const env = await createCallHarness({ camera: cameraError })
  try {
    await env.store.startCall('peer-a', 'Peer A', 'video')

    assert.equal(env.store.state, 'calling')
    assert.equal(env.store.localVideoOn, false)
    assert.equal(env.store.localStream.getAudioTracks().length, 1)
    assert.equal(env.store.localStream.getVideoTracks().length, 0)
    assert.equal(env.peerConnections[0].videoTransceiver.direction, 'sendrecv')
    assert.equal(env.peerConnections[0].videoTransceiver.sender.track, null)
    const offer = env.sent.find(({ type }) => type === 'call_offer')
    assert.equal(offer.payload.media, 'video')
    assert.equal(offer.payload.video_enabled, false)
  } finally {
    await env.dispose()
  }
})

test('a video receiver without a camera answers with the offered video transceiver', async () => {
  const cameraError = Object.assign(new Error('missing camera'), { name: 'NotFoundError' })
  const env = await createCallHarness({ camera: cameraError })
  try {
    env.emit('call_offer', {
      from: 'peer-a',
      call_id: '33333333-3333-4333-8333-333333333333',
      sdp: { type: 'offer', sdp: 'v=0\r\nm=video' },
      media: 'video',
    })

    await env.store.answerCall()

    assert.equal(env.store.state, 'active')
    assert.equal(env.store.localVideoOn, false)
    assert.equal(env.sent.filter(({ type }) => type === 'call_answer').length, 1)
    assert.equal(env.sent.find(({ type }) => type === 'call_answer').payload.video_enabled, false)
    assert.equal(env.sent.filter(({ type }) => type === 'call_reject').length, 0)
    assert.equal(env.peerConnections[0].videoTransceiver.sender.track, null)
  } finally {
    await env.dispose()
  }
})

test('camera state updates only the matching call session', async () => {
  const env = await createCallHarness()
  try {
    await env.store.startCall('peer-a', 'Peer A', 'video')
    const callId = env.sent.find(({ type }) => type === 'call_offer').payload.call_id

    env.emit('call_media_state', {
      from: 'peer-a',
      call_id: callId,
      video_enabled: false,
    })
    assert.equal(env.store.remoteVideoOn, false)

    env.emit('call_media_state', {
      from: 'peer-a',
      call_id: '44444444-4444-4444-8444-444444444444',
      video_enabled: true,
    })
    assert.equal(env.store.remoteVideoOn, false)
  } finally {
    await env.dispose()
  }
})

test('a disconnected camera keeps the active call and microphone alive', async () => {
  const env = await createCallHarness()
  try {
    env.emit('call_offer', {
      from: 'peer-a',
      call_id: '55555555-5555-4555-8555-555555555555',
      sdp: { type: 'offer', sdp: 'v=0\r\nm=video' },
      media: 'video',
      video_enabled: true,
    })
    await env.store.answerCall()
    const videoTrack = env.store.localStream.getVideoTracks()[0]

    videoTrack.onended()

    assert.equal(env.store.state, 'active')
    assert.equal(env.store.localVideoOn, false)
    assert.equal(env.store.localStream.getAudioTracks().length, 1)
    assert.equal(env.sent.at(-1).type, 'call_media_state')
    assert.equal(env.sent.at(-1).payload.video_enabled, false)
  } finally {
    await env.dispose()
  }
})

test('an ended microphone still hangs up the active call', async () => {
  const env = await createCallHarness()
  try {
    env.emit('call_offer', {
      from: 'peer-a',
      call_id: '66666666-6666-4666-8666-666666666666',
      sdp: { type: 'offer', sdp: 'v=0\r\nm=video' },
      media: 'video',
      video_enabled: true,
    })
    await env.store.answerCall()

    env.store.localStream.getAudioTracks()[0].onended()

    assert.equal(env.store.state, 'idle')
    assert.equal(env.sent.at(-1).type, 'call_hangup')
  } finally {
    await env.dispose()
  }
})

test('camera retry attaches a new track to the negotiated sender', async () => {
  const cameraError = Object.assign(new Error('missing camera'), { name: 'NotFoundError' })
  const env = await createCallHarness({ camera: cameraError })
  try {
    await env.store.startCall('peer-a', 'Peer A', 'video')
    const retryStream = createStream('retry-camera', ['video'])
    const retryTrack = retryStream.getVideoTracks()[0]
    env.setCameraResult(retryStream)

    await env.store.setCameraEnabled(true)

    assert.equal(env.peerConnections[0].videoTransceiver.sender.track, retryTrack)
    assert.equal(env.store.localStream.getVideoTracks()[0], retryTrack)
    assert.equal(env.store.localVideoOn, true)
    assert.equal(env.store.cameraStarting, false)
    assert.equal(env.sent.at(-1).type, 'call_media_state')
    assert.equal(env.sent.at(-1).payload.video_enabled, true)
  } finally {
    await env.dispose()
  }
})

test('the caller republishes its current camera state after the answer', async () => {
  const env = await createCallHarness()
  try {
    await env.store.startCall('peer-a', 'Peer A', 'video')
    const offer = env.sent.find(({ type }) => type === 'call_offer')
    await env.store.setCameraEnabled(false)
    const mediaStatesBeforeAnswer = env.sent.filter(({ type }) => type === 'call_media_state').length

    await env.emit('call_answer', {
      from: 'peer-a',
      call_id: offer.payload.call_id,
      sdp: { type: 'answer', sdp: 'v=0' },
      video_enabled: true,
    })

    const mediaStates = env.sent.filter(({ type }) => type === 'call_media_state')
    assert.equal(mediaStates.length, mediaStatesBeforeAnswer + 1)
    assert.equal(mediaStates.at(-1).payload.video_enabled, false)
  } finally {
    await env.dispose()
  }
})

test('a negotiated live receiver track does not override explicit voice-only state', async () => {
  const env = await createCallHarness()
  try {
    env.emit('call_offer', {
      from: 'peer-a',
      call_id: '77777777-7777-4777-8777-777777777777',
      sdp: { type: 'offer', sdp: 'v=0\r\nm=video' },
      media: 'video',
      video_enabled: false,
    })
    await env.store.answerCall()
    const remoteVideoStream = createStream('remote-video', ['video'])

    env.peerConnections[0].ontrack({
      track: remoteVideoStream.getVideoTracks()[0],
      streams: [remoteVideoStream],
    })

    assert.equal(env.store.remoteVideoOn, false)
  } finally {
    await env.dispose()
  }
})

test('a late camera-switch result cannot attach to a newer call', async () => {
  const env = await createCallHarness()
  try {
    await env.store.startCall('peer-a', 'Peer A', 'video')
    let resolveLateCamera
    const lateCamera = createStream('late-camera', ['video'])
    const nextCallCamera = createStream('next-call-camera', ['video'])
    let cameraRequest = 0
    env.setCameraResult(() => {
      cameraRequest++
      if (cameraRequest === 1) {
        return new Promise(resolve => { resolveLateCamera = resolve })
      }
      return nextCallCamera
    })

    const switching = env.store.switchCamera()
    env.store.hangup()
    await env.store.startCall('peer-b', 'Peer B', 'video')
    resolveLateCamera(lateCamera)
    await switching

    assert.equal(env.store.peerId, 'peer-b')
    assert.equal(env.store.localStream.getVideoTracks()[0], nextCallCamera.getVideoTracks()[0])
    assert.equal(env.peerConnections.at(-1).videoTransceiver.sender.track, nextCallCamera.getVideoTracks()[0])
    assert.equal(lateCamera.getVideoTracks()[0].stopped, true)
  } finally {
    await env.dispose()
  }
})

test('a fatal audio acquisition error identifies the microphone, not the camera', async () => {
  const audioError = Object.assign(new Error('missing microphone'), { name: 'NotFoundError' })
  const env = await createCallHarness({ audio: audioError })
  try {
    await env.store.startCall('peer-a', 'Peer A', 'video')

    assert.equal(env.store.state, 'idle')
    assert.match(env.notifications.at(-1).message, /Microphone/i)
    assert.doesNotMatch(env.notifications.at(-1).message, /camera/i)
  } finally {
    await env.dispose()
  }
})

test('disposing call listeners hangs up and releases active media', async () => {
  const env = await createCallHarness()
  try {
    env.emit('call_offer', {
      from: 'peer-a',
      call_id: '22222222-2222-4222-8222-222222222222',
      sdp: { type: 'offer', sdp: 'v=0' },
      media: 'video',
    })
    await env.store.answerCall()

    env.stopListening()

    assert.equal(env.store.state, 'idle')
    assert.equal(env.sent.filter(({ type }) => type === 'call_hangup').length, 1)
    assert.ok(env.streams.every(stream => stream.getTracks().every(track => track.stopped)))
    assert.ok(env.peerConnections.every(connection => connection.closed))
  } finally {
    await env.dispose()
  }
})
