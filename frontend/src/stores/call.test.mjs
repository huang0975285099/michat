import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

import { createPinia, setActivePinia } from 'pinia'
import { Notify } from 'quasar'
import { createServer } from 'vite'
import { createCallSignaling } from '../services/call-signaling.mjs'

const CALL_STORE_PATH = '/src/stores/call.js'
const FRONTEND_PATH = fileURLToPath(new URL('../../', import.meta.url))
const SRC_PATH = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/')

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for call signaling')
}

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

async function createCallHarness({ audio = null, camera = null, serverNow = Date.now } = {}) {
  globalThis.__callTestServerNow = serverNow
  const localKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const peerKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const localPublicKey = Buffer.from(await crypto.subtle.exportKey('spki', localKeys.publicKey)).toString('base64')
  const peerPublicKey = Buffer.from(await crypto.subtle.exportKey('spki', peerKeys.publicKey)).toString('base64')
  globalThis.__callTestKeys = localKeys
  globalThis.__callTestIdentity = { chatId: 'local', isLocked: false, getFriendPubKey: () => peerPublicKey }
  const peerSignaling = createCallSignaling({
    identity: { chatId: 'peer-a', isLocked: false, getFriendPubKey: () => localPublicKey },
    loadKeyPair: async () => peerKeys,
    now: serverNow,
  })
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
      if (/^(?:src\/services\/crypto|.*\/src\/services\/crypto)(?:\.js)?$/.test(normalized)) return '\0call-test-crypto'
      if (normalized === './identity') return '\0call-test-identity'
      if (/^(?:src\/services\/websocket|.*\/src\/services\/websocket)(?:\.js)?$/.test(normalized)) {
        return '\0call-test-websocket'
      }
      if (/^(?:src\/services\/api|.*\/src\/services\/api)(?:\.js)?$/.test(normalized)) {
        return '\0call-test-api'
      }
    },
    load(id) {
      if (id === '\0call-test-identity') return 'export const useIdentityStore = () => globalThis.__callTestIdentity'
      if (id === '\0call-test-crypto') return `
        export const loadKeyPair = async () => globalThis.__callTestKeyLoader ? globalThis.__callTestKeyLoader() : globalThis.__callTestKeys
        export const bufToB64 = value => Buffer.from(value).toString('base64')
        export const b64ToBuf = value => Buffer.from(value, 'base64')
      `
      if (id === '\0call-test-websocket') {
        return `
          export const wsConnected = { value: true }
          export const getServerNow = () => globalThis.__callTestServerNow()
          export function send(type, payload) {
            globalThis.__callTestSent.push({ type, payload })
            return true
          }
          export function on(type, callback) {
            globalThis.__callTestListeners.set(type, callback)
          }
          export function off(type, callback) {
            if (globalThis.__callTestListeners.get(type) === callback) globalThis.__callTestListeners.delete(type)
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
      this.signalingState = 'stable'
      this.candidates = []
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
      this.signalingState = description.type === 'answer' ? 'stable' : 'have-remote-offer'
      if (description.type === 'offer' && description.sdp?.includes('m=video') && !this.videoTransceiver) {
        this.addTransceiver('video', { direction: 'sendrecv' })
      }
    }

    async createAnswer() {
      return { type: 'answer', sdp: 'v=0' }
    }

    async setLocalDescription(description) {
      this.localDescription = description
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'
    }

    restartIce() {}

    async addIceCandidate(candidate) {
      this.candidates.push(candidate)
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
    async emit(type, payload) {
      const listener = listeners.get(type)
      assert.equal(typeof listener, 'function', `missing ${type} listener`)
      if (type.startsWith('call_')) {
        payload = { ...await peerSignaling.seal(type, { ...payload, to: 'local' }), from: payload.from }
      }
      return listener(payload)
    },
    emitRaw(type, payload) {
      return listeners.get(type)(payload)
    },
    peerSignaling,
    localPublicKey,
    setKeyLoader(loader) {
      globalThis.__callTestKeyLoader = () => loader(localKeys)
    },
    async dispose() {
      if (store.state !== 'idle') await store.hangup()
      stopListening()
      await server.close()
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
      else delete globalThis.navigator
      if (originalRTCPeerConnection === undefined) delete globalThis.RTCPeerConnection
      else globalThis.RTCPeerConnection = originalRTCPeerConnection
      Notify.create = originalNotifyCreate
      delete globalThis.__callTestSent
      delete globalThis.__callTestListeners
      delete globalThis.__callTestKeys
      delete globalThis.__callTestIdentity
      delete globalThis.__callTestKeyLoader
      delete globalThis.__callTestServerNow
    },
  }
}

test('accepting one incoming call concurrently acquires media and answers once', async () => {
  const env = await createCallHarness()
  try {
    await env.emit('call_offer', {
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
    await env.emit('call_offer', {
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

    await env.emit('call_media_state', {
      from: 'peer-a',
      call_id: callId,
      video_enabled: false,
    })
    assert.equal(env.store.remoteVideoOn, false)

    await env.emit('call_media_state', {
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
    await env.emit('call_offer', {
      from: 'peer-a',
      call_id: '55555555-5555-4555-8555-555555555555',
      sdp: { type: 'offer', sdp: 'v=0\r\nm=video' },
      media: 'video',
      video_enabled: true,
    })
    await env.store.answerCall()
    const videoTrack = env.store.localStream.getVideoTracks()[0]

    videoTrack.onended()
    await waitFor(() => env.sent.at(-1)?.type === 'call_media_state')

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
    await env.emit('call_offer', {
      from: 'peer-a',
      call_id: '66666666-6666-4666-8666-666666666666',
      sdp: { type: 'offer', sdp: 'v=0\r\nm=video' },
      media: 'video',
      video_enabled: true,
    })
    await env.store.answerCall()

    env.store.localStream.getAudioTracks()[0].onended()
    await waitFor(() => env.sent.at(-1)?.type === 'call_hangup')

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
    await env.emit('call_offer', {
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
    await env.emit('call_offer', {
      from: 'peer-a',
      call_id: '22222222-2222-4222-8222-222222222222',
      sdp: { type: 'offer', sdp: 'v=0' },
      media: 'video',
    })
    await env.store.answerCall()

    env.stopListening()
    await waitFor(() => env.sent.some(({ type }) => type === 'call_hangup'))

    assert.equal(env.store.state, 'idle')
    assert.equal(env.sent.filter(({ type }) => type === 'call_hangup').length, 1)
    assert.ok(env.streams.every(stream => stream.getTracks().every(track => track.stopped)))
    assert.ok(env.peerConnections.every(connection => connection.closed))
  } finally {
    await env.dispose()
  }
})

test('unsigned or substituted SDP cannot ring or activate a call, and an ended invitation cannot replay', async () => {
  const env = await createCallHarness()
  try {
    const invitation = { to: 'local', call_id: '88888888-8888-4888-8888-888888888888', sdp: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB' } }
    await env.emitRaw('call_offer', { ...invitation, from: 'peer-a' })
    assert.equal(env.store.state, 'idle')
    const wire = { ...await env.peerSignaling.seal('call_offer', invitation), from: 'peer-a' }
    await env.emitRaw('call_offer', { ...wire, call_id: '99999999-9999-4999-8999-999999999999' })
    assert.equal(env.store.state, 'idle')
    await env.emitRaw('call_offer', wire)
    assert.equal(env.store.state, 'ringing')
    env.store.hangup()
    await env.emitRaw('call_offer', wire)
    assert.equal(env.store.state, 'idle')
    await env.store.startCall('peer-a', 'Peer A')
    const offer = env.sent.find(({ type }) => type === 'call_offer')
    await env.emitRaw('call_answer', { from: 'peer-a', call_id: offer.payload.call_id, sdp: { type: 'answer', sdp: 'v=0' } })
    assert.equal(env.store.state, 'calling')
    assert.equal(env.peerConnections.at(-1).remoteDescription, null)
  } finally {
    await env.dispose()
  }
})

test('late signing cannot send an offer or revive a cleaned-up session', async () => {
  const env = await createCallHarness()
  try {
    let release
    env.setKeyLoader(keys => release ? Promise.resolve(keys) : new Promise(resolve => { release = () => resolve(keys) }))
    const starting = env.store.startCall('peer-a', 'Peer A')
    await waitFor(() => release)
    env.store.hangup()
    release()
    await starting
    assert.equal(env.store.state, 'idle')
    assert.equal(env.sent.filter(({ type }) => type === 'call_offer').length, 0)
    assert.equal(env.peerConnections.length, 0)
    assert.equal(env.getUserMediaCalls(), 0)
    assert.ok(env.streams.every(stream => stream.getTracks().every(track => track.stopped)))
  } finally {
    await env.dispose()
  }
})

test('listener disposal invalidates queued authenticated invitations', async () => {
  const env = await createCallHarness()
  try {
    const wire = { ...await env.peerSignaling.seal('call_offer', {
      to: 'local', call_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sdp: { type: 'offer', sdp: 'v=0' },
    }), from: 'peer-a' }
    const receiving = env.emitRaw('call_offer', wire)
    env.stopListening()
    await receiving
    assert.equal(env.store.state, 'idle')
    assert.equal(globalThis.__callTestListeners.size, 0)
  } finally {
    await env.dispose()
  }
})

test('restart answers must authenticate and match the outstanding negotiation', async () => {
  const env = await createCallHarness()
  try {
    await env.store.startCall('peer-a', 'Peer A')
    const callId = env.sent.find(({ type }) => type === 'call_offer').payload.call_id
    await env.emit('call_answer', { from: 'peer-a', call_id: callId, sdp: { type: 'answer', sdp: 'initial' } })
    const connection = env.peerConnections[0]
    connection.connectionState = 'disconnected'
    connection.onconnectionstatechange()
    await waitFor(() => env.sent.some(({ type }) => type === 'call_restart_offer'))
    const restart = env.sent.find(({ type }) => type === 'call_restart_offer')
    const signed = JSON.parse(JSON.parse(restart.payload.sdp.signature).content)
    await env.emit('call_restart_answer', { from: 'peer-a', call_id: callId, negotiation: 'old-restart', sdp: { type: 'answer', sdp: 'wrong' } })
    assert.equal(connection.remoteDescription.sdp, 'initial')
    await env.emit('call_restart_answer', { from: 'peer-a', call_id: callId, negotiation: signed.negotiation, sdp: { type: 'answer', sdp: 'restarted' } })
    assert.equal(connection.remoteDescription.sdp, 'restarted')
    await env.emit('call_restart_answer', { from: 'peer-a', call_id: callId, negotiation: signed.negotiation, sdp: { type: 'answer', sdp: 'unsolicited' } })
    assert.equal(connection.remoteDescription.sdp, 'restarted')
  } finally {
    await env.dispose()
  }
})

test('unsigned call controls and ICE cannot modify or terminate the current call', async () => {
  const env = await createCallHarness()
  try {
    await env.store.startCall('peer-a', 'Peer A', 'video')
    const callId = env.sent.find(({ type }) => type === 'call_offer').payload.call_id
    await env.emit('call_answer', { from: 'peer-a', call_id: callId, sdp: { type: 'answer', sdp: 'v=0' }, video_enabled: true })
    for (const type of ['call_hangup', 'call_reject', 'call_restart_request', 'call_media_state', 'call_ice']) {
      await env.emitRaw(type, { from: 'peer-a', call_id: callId, video_enabled: false, ice: { candidate: 'candidate:attacker' } })
    }
    assert.equal(env.store.state, 'active')
    assert.equal(env.store.remoteVideoOn, true)
    assert.deepEqual(env.peerConnections[0].candidates, [])
    await env.emit('call_ice', { from: 'peer-a', call_id: callId, ice: { candidate: 'candidate:valid' } })
    assert.equal(env.peerConnections[0].candidates[0].candidate, 'candidate:valid')
    await env.emit('call_hangup', { from: 'peer-a', call_id: callId })
    assert.equal(env.store.state, 'idle')
  } finally {
    await env.dispose()
  }
})

test('call signaling uses calibrated server time rather than skewed device time', async () => {
  const calibrated = Date.now() + 300000
  const env = await createCallHarness({ serverNow: () => calibrated })
  try {
    await env.store.startCall('peer-a', 'Peer A')
    const offer = env.sent.find(({ type }) => type === 'call_offer')
    const content = JSON.parse(JSON.parse(offer.payload.sdp.signature).content)
    assert.equal(content.issued, calibrated)
    await env.emit('call_answer', { from: 'peer-a', call_id: offer.payload.call_id, sdp: { type: 'answer', sdp: 'v=0' } })
    assert.equal(env.store.state, 'active')
  } finally {
    await env.dispose()
  }
})

test('hangup after locking sends its prepared proof and immediately stops local media without loading keys', async () => {
  let clock = 100000
  const env = await createCallHarness({ serverNow: () => clock })
  try {
    await env.store.startCall('peer-a', 'Peer A', 'video')
    let keyLoads = 0
    env.setKeyLoader(() => { keyLoads++; throw new Error('locked keys must not be loaded') })
    clock += 120000
    globalThis.__callTestIdentity.isLocked = true
    env.store.hangup()
    assert.equal(env.store.state, 'idle')
    assert.equal(env.store.localStream, null)
    assert.ok(env.peerConnections[0].closed)
    assert.ok(env.streams.every(stream => stream.getTracks().every(track => track.stopped)))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(keyLoads, 0)
    assert.equal(env.sent.filter(({ type }) => type === 'call_hangup').length, 1)
    const hangup = env.sent.find(({ type }) => type === 'call_hangup')
    const content = JSON.parse(JSON.parse(hangup.payload.sdp.signature).content)
    assert.equal(content.prepared, true)
    assert.equal(content.call_id, hangup.payload.call_id)
    const receiver = createCallSignaling({
      identity: { chatId: 'peer-a', isLocked: false, getFriendPubKey: () => env.localPublicKey },
      loadKeyPair: async () => null,
      now: () => clock,
      isCurrentCall: (callId, peer) => callId === hangup.payload.call_id && peer === 'local',
    })
    await receiver.open('call_hangup', { ...hangup.payload, from: 'local' })
  } finally {
    await env.dispose()
  }
})

test('a terminal signature already in flight is still delivered after locking', async () => {
  const env = await createCallHarness()
  const originalExport = crypto.subtle.exportKey
  let release
  try {
    await env.store.startCall('peer-a', 'Peer A')
    crypto.subtle.exportKey = function(format, key) {
      const exporting = originalExport.call(this, format, key)
      if (format !== 'pkcs8') return exporting
      return exporting.then(value => new Promise(resolve => { release = () => resolve(value) }))
    }
    env.store.rejectCall()
    assert.equal(env.store.state, 'idle')
    assert.ok(env.peerConnections[0].closed)
    await waitFor(() => release)
    globalThis.__callTestIdentity.isLocked = true
    release()
    await waitFor(() => env.sent.some(({ type }) => type === 'call_reject'))
    const hangup = env.sent.find(({ type }) => type === 'call_reject')
    assert.equal(typeof hangup.payload.sdp.signature, 'string')
    const content = JSON.parse(JSON.parse(hangup.payload.sdp.signature).content)
    assert.equal(content.call_id, env.sent.find(({ type }) => type === 'call_offer').payload.call_id)
  } finally {
    if (release) release()
    crypto.subtle.exportKey = originalExport
    await env.dispose()
  }
})

test('locking before key acquisition completes blocks terminal signing but not local cleanup', async () => {
  const env = await createCallHarness()
  try {
    await env.store.startCall('peer-a', 'Peer A')
    let release
    env.setKeyLoader(keys => new Promise(resolve => { release = () => resolve(keys) }))
    env.store.rejectCall()
    assert.equal(env.store.state, 'idle')
    assert.ok(env.peerConnections[0].closed)
    assert.ok(env.streams.every(stream => stream.getTracks().every(track => track.stopped)))
    assert.equal(typeof release, 'function')
    globalThis.__callTestIdentity.isLocked = true
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(env.sent.filter(({ type }) => type === 'call_reject').length, 0)
  } finally {
    await env.dispose()
  }
})
