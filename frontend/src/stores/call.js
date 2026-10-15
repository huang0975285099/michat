import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Notify } from 'quasar'
import { send, on, off, wsConnected, getServerNow } from 'src/services/websocket'
import { callApi } from 'src/services/api'
import { acquireCallMedia } from './call-media.mjs'
import { t } from 'src/i18n'
import { loadKeyPair } from 'src/services/crypto'
import { useIdentityStore } from './identity'
import { createCallSignaling } from '../services/call-signaling.mjs'

function deviceErrorMessage(e, video) {
  const noun = t(video ? 'call.deviceCameraMic' : 'call.deviceMic')
  if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
    return t('call.deviceNotFound', { device: noun })
  }
  if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
    return t('call.permissionDenied', { device: noun })
  }
  if (e.name === 'NotReadableError') {
    return t('call.deviceBusy', { device: noun })
  }
  return t('call.deviceAccessFailed', { device: noun, error: e.message || e.name })
}

// Video constraints: limit resolution to control bandwidth, 1:1 calls are sufficient
const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 } }
const CALL_TIMEOUT_MS = 30000
const INCOMING_TIMEOUT_MS = 35000
const DISCONNECT_GRACE_MS = 10000
const CONNECT_TIMEOUT_MS = 20000
const MAX_BUFFERED_ICE = 256
const CALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const useCallStore = defineStore('call', () => {
  const identity = useIdentityStore()
  const signaling = createCallSignaling({
    identity, loadKeyPair, now: getServerNow,
    isCurrentCall: (callId, peer) => callId === currentCallId && peer === peerId.value && state.value !== 'idle' && identity.chatId === callAccountId,
  })
  let preparedHangup = null
  let lifecycle = 0
  let incomingQueue = Promise.resolve()
  let outgoingQueue = Promise.resolve()

  function sendAuthenticated(type, payload, terminal = false) {
    const generation = lifecycle
    const account = identity.chatId
    const valid = () => terminal || generation === lifecycle
    const dispatch = async () => {
      if (!valid() || identity.chatId !== account) return false
      const signed = await signaling.seal(type, payload)
      if (!valid() || identity.chatId !== account || (!terminal && identity.isLocked)) return false
      return send(type, signed)
    }
    const task = terminal
      ? dispatch().finally(() => signaling.release(payload.call_id))
      : outgoingQueue.then(dispatch)
    if (!terminal) outgoingQueue = task.catch(() => {})
    return task
  }

  function sendControl(type, payload, terminal = false) {
    return sendAuthenticated(type, payload, terminal).catch(error => {
      console.warn('[call] sign control:', error)
      return false
    })
  }

  async function prepareHangup(callId, peer) {
    const account = identity.chatId
    const payload = await signaling.seal('call_hangup', { to: peer, call_id: callId, prepared: true })
    if (isCurrentSession(callId, peer) && identity.chatId === account) preparedHangup = { account, payload }
  }

  function authenticatedHandler(type, handler) {
    return payload => {
      const generation = lifecycle
      const task = incomingQueue.then(async () => {
        if (generation !== lifecycle) return
        const verified = await signaling.open(type, payload)
        if (generation !== lifecycle) return
        await handler(verified)
      })
      incomingQueue = task.catch(error => { console.warn('[call] authenticated signaling rejected:', error) })
      return incomingQueue
    }
  }
  const state = ref('idle')   // idle | calling | ringing | active
  const media = ref('audio')  //audio | video (type of this call)
  const peerId = ref('')
  const peerNickname = ref('')
  const remoteStream = ref(null)
  const localStream = ref(null)
  const localVideoOn = ref(false)
  const remoteVideoOn = ref(null)
  const cameraStarting = ref(false)
  const answering = ref(false)
  const connectionStatus = ref('idle') // idle | connecting | connected | reconnecting
  const reconnectSeconds = ref(0)

  let pc = null
  let pendingOffer = null
  let iceCandidateBuffer = []
  let callingTimer = null
  let incomingTimer = null
  let reconnectTicker = null
  let connectTimer = null
  let currentCallId = ''
  let callAccountId = ''
  let isInitiator = false
  let restartInFlight = false
  let awaitingRestartAnswer = false
  let restartToken = ''
  let lastRestartAttempt = 0
  let answerAttemptGeneration = 0
  let cameraAttemptGeneration = 0
  let facingMode = 'user' //Current camera orientation: user=front environment=rear

  const isVideo = () => media.value === 'video'

  async function getTurnConfig() {
    try {
      const { data } = await callApi.getTurnCredentials()
      return {
        iceServers: data.uris.map(uri => ({
          urls: uri,
          username: data.username,
          credential: data.password,
        }))
      }
    } catch (e) {
      console.warn('[call] getTurnConfig failed, P2P may fail across NAT:', e)
      return { iceServers: [] }
    }
  }

  function isCurrentSession(callId, fromId = peerId.value) {
    return !!callId && callId === currentCallId && fromId === peerId.value && state.value !== 'idle' &&
      identity.chatId === callAccountId && !identity.isLocked
  }

  function clearConnectTimer() {
    if (connectTimer) {
      clearTimeout(connectTimer)
      connectTimer = null
    }
  }

  function clearRecoveryState() {
    if (reconnectTicker) {
      clearInterval(reconnectTicker)
      reconnectTicker = null
    }
    reconnectSeconds.value = 0
    restartInFlight = false
    awaitingRestartAnswer = false
  }

  function startConnectTimeout(callId, targetPeerId) {
    if (connectionStatus.value === 'connected') return
    clearConnectTimer()
    connectionStatus.value = 'connecting'
    connectTimer = setTimeout(() => {
      connectTimer = null
      if (isCurrentSession(callId, targetPeerId) && connectionStatus.value !== 'connected') {
        hangup()
        Notify.create({ type: 'negative', message: t('call.mediaConnectFailed'), timeout: 3000 })
      }
    }, CONNECT_TIMEOUT_MS)
  }

  function bindTrackEndHandlers(stream, callId, targetPeerId) {
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (!isCurrentSession(callId, targetPeerId)) return
        if (track.kind === 'video') {
          if (!localStream.value?.getVideoTracks().includes(track)) return
          localStream.value.removeTrack(track)
          localVideoOn.value = false
          sendMediaState()
          Notify.create({ type: 'warning', message: t('call.cameraDisconnected'), timeout: 3000 })
        } else {
          Notify.create({ type: 'negative', message: t('call.microphoneDisconnected'), timeout: 3000 })
          hangup()
        }
      }
    }
  }

  async function attemptIceRestart(callId, targetPeerId) {
    const connection = pc
    if (!wsConnected.value || !connection || restartInFlight ||
        !isCurrentSession(callId, targetPeerId) || connectionStatus.value !== 'reconnecting') return
    const now = Date.now()
    if (!isInitiator) {
      if (now - lastRestartAttempt < 2000) return
      lastRestartAttempt = now
      sendControl('call_restart_request', { to: targetPeerId, call_id: callId })
      return
    }
    if (awaitingRestartAnswer && now - lastRestartAttempt < 2500) return
    lastRestartAttempt = now
    restartInFlight = true
    try {
      // If you did not receive an Answer during the last reconnection Offer, you must roll back before you can safely initiate the next round of negotiation.
      if (connection.signalingState === 'have-local-offer') {
        await connection.setLocalDescription({ type: 'rollback' })
        if (pc !== connection || !isCurrentSession(callId, targetPeerId)) return
      }
      connection.restartIce()
      const offer = await connection.createOffer({ iceRestart: true })
      if (pc !== connection || !isCurrentSession(callId, targetPeerId)) return
      await connection.setLocalDescription(offer)
      if (pc !== connection || !isCurrentSession(callId, targetPeerId) || connectionStatus.value !== 'reconnecting') return
      restartToken = crypto.randomUUID()
      const sent = await sendAuthenticated('call_restart_offer', { to: targetPeerId, call_id: callId, sdp: offer, negotiation: restartToken })
      if (pc === connection && isCurrentSession(callId, targetPeerId)) awaitingRestartAnswer = sent
    } catch (e) {
      console.warn('[call] ICE restart offer:', e)
    } finally {
      if (pc === connection && isCurrentSession(callId, targetPeerId)) restartInFlight = false
    }
  }

  function beginRecovery(callId, targetPeerId) {
    if (!isCurrentSession(callId, targetPeerId) || state.value !== 'active' || connectionStatus.value === 'reconnecting') return
    clearConnectTimer()
    connectionStatus.value = 'reconnecting'
    const deadline = Date.now() + DISCONNECT_GRACE_MS
    reconnectSeconds.value = Math.ceil(DISCONNECT_GRACE_MS / 1000)
    attemptIceRestart(callId, targetPeerId)

    reconnectTicker = setInterval(() => {
      if (!isCurrentSession(callId, targetPeerId) || connectionStatus.value !== 'reconnecting') {
        clearRecoveryState()
        return
      }
      const remaining = deadline - Date.now()
      reconnectSeconds.value = Math.max(0, Math.ceil(remaining / 1000))
      if (remaining <= 0) {
        clearRecoveryState()
        hangup()
        Notify.create({ type: 'negative', message: t('call.networkEnded'), timeout: 3000 })
        return
      }
      attemptIceRestart(callId, targetPeerId)
    }, 500)
  }

  function createPC(iceConfig, callId, targetPeerId) {
    const connection = new RTCPeerConnection(iceConfig)
    pc = connection

    connection.ontrack = (event) => {
      if (pc !== connection || !isCurrentSession(callId, targetPeerId)) return
      remoteStream.value = event.streams[0] || new MediaStream([event.track])
      if (event.track?.kind === 'video' && event.track.readyState !== 'ended' &&
          remoteVideoOn.value === null) {
        remoteVideoOn.value = true
      }
    }

    connection.onicecandidate = (event) => {
      if (event.candidate && pc === connection && isCurrentSession(callId, targetPeerId)) {
        sendAuthenticated('call_ice', { to: targetPeerId, call_id: callId, ice: event.candidate.toJSON() }).catch(error => console.warn('[call] sign ICE:', error))
      }
    }

    connection.onconnectionstatechange = () => {
      if (pc !== connection || !isCurrentSession(callId, targetPeerId)) return
      if (connection.connectionState === 'connected') {
        clearConnectTimer()
        clearRecoveryState()
        connectionStatus.value = 'connected'
      } else if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
        beginRecovery(callId, targetPeerId)
      }
    }

    return connection
  }

  async function flushIceCandidates() {
    const connection = pc
    while (pc === connection && iceCandidateBuffer.length && connection?.remoteDescription) {
      const ice = iceCandidateBuffer.shift()
      try { await connection.addIceCandidate(ice) } catch {}
    }
  }

  async function startCall(chatId, nickname, callMedia = 'audio') {
    if (state.value !== 'idle') return
    lifecycle++
    const callId = crypto.randomUUID()
    currentCallId = callId
    callAccountId = identity.chatId
    isInitiator = true
    media.value = callMedia === 'video' ? 'video' : 'audio'
    peerId.value = chatId
    peerNickname.value = nickname || chatId
    state.value = 'calling'

    try {
      await prepareHangup(callId, chatId)
      if (!isCurrentSession(callId, chatId)) return
      const { stream, videoError } = await acquireCallMedia(navigator.mediaDevices, {
        video: isVideo(),
        facingMode,
        videoConstraints: VIDEO_CONSTRAINTS,
      })
      // The user may have hung up during the permission pop-up window, and the late getUserMedia cannot be used to revive the old call.
      if (!isCurrentSession(callId, chatId) || state.value !== 'calling') {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      localStream.value = stream
      localVideoOn.value = stream.getVideoTracks().some(track => track.readyState !== 'ended')
      if (videoError) {
        Notify.create({ type: 'warning', message: t('call.cameraUnavailable'), timeout: 3000 })
      }
      bindTrackEndHandlers(stream, callId, chatId)
      const iceConfig = await getTurnConfig()
      if (!isCurrentSession(callId, chatId) || state.value !== 'calling') return
      const connection = createPC(iceConfig, callId, chatId)
      connectionStatus.value = 'connecting'
      localStream.value.getAudioTracks().forEach(track => connection.addTrack(track, localStream.value))
      if (isVideo()) {
        const videoTrack = localStream.value.getVideoTracks()[0]
        connection.addTransceiver(videoTrack || 'video', {
          direction: 'sendrecv',
          streams: [localStream.value],
        })
      }
      const offer = await connection.createOffer()
      if (pc !== connection || !isCurrentSession(callId, chatId)) return
      await connection.setLocalDescription(offer)
      if (pc !== connection || !isCurrentSession(callId, chatId) || state.value !== 'calling') return
      // The signaling carries the media type, and the called end decides whether to turn on the camera based on this.
      if (!await sendAuthenticated('call_offer', {
        to: chatId,
        call_id: callId,
        sdp: offer,
        media: media.value,
        video_enabled: isVideo() ? localVideoOn.value : undefined,
      })) {
        throw new Error('Signaling connection disconnected')
      }
      if (pc !== connection || !isCurrentSession(callId, chatId)) return
      callingTimer = setTimeout(() => {
        if (state.value === 'calling' && currentCallId === callId) {
          hangup()
          Notify.create({ type: 'warning', message: t('call.timeout') })
        }
      }, CALL_TIMEOUT_MS)
    } catch (e) {
      console.error('[call] startCall:', e)
      if (currentCallId === callId) {
        cleanup()
        const message = e.message === 'Signaling connection disconnected' ? e.message : deviceErrorMessage(e, false)
        Notify.create({ type: 'negative', message })
      }
    }
  }

  async function handleIncomingOffer(fromId, callId, sdp, callMedia, videoEnabled) {
    if (!CALL_ID_PATTERN.test(callId || '') || !fromId || !sdp) return
    if (state.value !== 'idle') {
      // When the same two parties call each other at the same time, if the call_id is kept smaller with certainty, both parties will reach the same conclusion.
      if (state.value === 'calling' && fromId === peerId.value && callId < currentCallId) {
        cleanup()
      } else {
        sendControl('call_reject', { to: fromId, call_id: callId, reason: fromId === peerId.value ? 'glare' : 'busy' }, true)
        return
      }
    }
    currentCallId = callId
    callAccountId = identity.chatId
    isInitiator = false
    media.value = callMedia === 'video' ? 'video' : 'audio'
    remoteVideoOn.value = isVideo() && typeof videoEnabled === 'boolean' ? videoEnabled : null
    peerId.value = fromId
    peerNickname.value = fromId
    pendingOffer = sdp
    state.value = 'ringing'
    incomingTimer = setTimeout(() => {
      if (state.value === 'ringing' && currentCallId === callId) {
        sendControl('call_reject', { to: fromId, call_id: callId, reason: 'timeout' }, true)
        cleanup()
      }
    }, INCOMING_TIMEOUT_MS)
    try {
      await prepareHangup(callId, fromId)
    } catch (error) {
      if (currentCallId === callId) cleanup()
      console.warn('[call] prepare terminal signaling failed:', error)
    }
  }

  async function answerCall() {
    if (state.value !== 'ringing' || !pendingOffer || answering.value) return
    const answerAttempt = ++answerAttemptGeneration
    answering.value = true
    const callId = currentCallId
    const fromId = peerId.value
    const offer = pendingOffer
    try {
      const { stream, videoError } = await acquireCallMedia(navigator.mediaDevices, {
        video: isVideo(),
        facingMode,
        videoConstraints: VIDEO_CONSTRAINTS,
      })
      if (!isCurrentSession(callId, fromId) || state.value !== 'ringing') {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      localStream.value = stream
      localVideoOn.value = stream.getVideoTracks().some(track => track.readyState !== 'ended')
      if (videoError) {
        Notify.create({ type: 'warning', message: t('call.cameraUnavailable'), timeout: 3000 })
      }
      bindTrackEndHandlers(stream, callId, fromId)
      const iceConfig = await getTurnConfig()
      if (!isCurrentSession(callId, fromId) || state.value !== 'ringing') return
      const connection = createPC(iceConfig, callId, fromId)
      connectionStatus.value = 'connecting'
      await connection.setRemoteDescription(offer)
      if (pc !== connection || !isCurrentSession(callId, fromId)) return
      await flushIceCandidates()
      if (pc !== connection || !isCurrentSession(callId, fromId)) return
      localStream.value.getAudioTracks().forEach(track => connection.addTrack(track, localStream.value))
      const videoTrack = localStream.value.getVideoTracks()[0]
      if (videoTrack) connection.addTrack(videoTrack, localStream.value)
      const answer = await connection.createAnswer()
      if (pc !== connection || !isCurrentSession(callId, fromId)) return
      await connection.setLocalDescription(answer)
      if (pc !== connection || !isCurrentSession(callId, fromId) || state.value !== 'ringing') return
      if (!await sendAuthenticated('call_answer', {
        to: fromId,
        call_id: callId,
        sdp: answer,
        video_enabled: isVideo() ? localVideoOn.value : undefined,
      })) {
        throw new Error('Signaling connection disconnected')
      }
      if (pc !== connection || !isCurrentSession(callId, fromId)) return
      state.value = 'active'
      pendingOffer = null
      if (incomingTimer) { clearTimeout(incomingTimer); incomingTimer = null }
      startConnectTimeout(callId, fromId)
    } catch (e) {
      console.error('[call] answerCall:', e)
      if (currentCallId === callId) {
        sendControl('call_reject', { to: fromId, call_id: callId, reason: 'device_error' }, true)
        cleanup()
        const message = e.message === 'Signaling connection disconnected' ? e.message : deviceErrorMessage(e, false)
        Notify.create({ type: 'negative', message })
      }
    } finally {
      if (answerAttemptGeneration === answerAttempt) answering.value = false
    }
  }

  function rejectCall() {
    if (state.value === 'idle') return
    sendControl('call_reject', { to: peerId.value, call_id: currentCallId, reason: 'rejected' }, true)
    cleanup()
  }

  function hangup() {
    let completion = Promise.resolve(false)
    if (state.value !== 'idle') {
      if (preparedHangup?.account === identity.chatId && preparedHangup.payload.call_id === currentCallId && preparedHangup.payload.to === peerId.value) {
        completion = Promise.resolve(send('call_hangup', preparedHangup.payload))
      } else {
        completion = sendControl('call_hangup', { to: peerId.value, call_id: currentCallId }, true)
      }
    }
    cleanup()
    return completion
  }

  function setMuted(val) {
    if (localStream.value) {
      localStream.value.getAudioTracks().forEach(t => { t.enabled = !val })
    }
  }

  // Turn on/off the local camera without renegotiating the existing video transceiver.
  async function setCameraEnabled(enabled) {
    if (!isVideo() || !localStream.value || !pc) return

    const existingTrack = localStream.value.getVideoTracks()
      .find(track => track.readyState !== 'ended')
    if (!enabled) {
      cameraAttemptGeneration++
      cameraStarting.value = false
      if (existingTrack) existingTrack.enabled = false
      localVideoOn.value = false
      await sendMediaState()
      return
    }
    if (existingTrack) {
      existingTrack.enabled = true
      localVideoOn.value = true
      await sendMediaState()
      return
    }
    if (cameraStarting.value) return

    const attempt = ++cameraAttemptGeneration
    const connection = pc
    const callId = currentCallId
    const targetPeerId = peerId.value
    let cameraStream = null
    cameraStarting.value = true
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...VIDEO_CONSTRAINTS, facingMode },
      })
      const newTrack = cameraStream.getVideoTracks()[0]
      if (!newTrack) throw Object.assign(new Error('camera returned no video track'), { name: 'NotFoundError' })
      if (attempt !== cameraAttemptGeneration || pc !== connection ||
          !isCurrentSession(callId, targetPeerId) || !localStream.value) {
        cameraStream.getTracks().forEach(track => track.stop())
        return
      }
      const videoSender = connection.getTransceivers()
        .find(transceiver => transceiver.receiver?.track?.kind === 'video')?.sender
      if (!videoSender) throw new Error('video sender not found')
      await videoSender.replaceTrack(newTrack)
      if (attempt !== cameraAttemptGeneration || pc !== connection ||
          !isCurrentSession(callId, targetPeerId) || !localStream.value) {
        newTrack.stop()
        return
      }
      cameraStream.getTracks()
        .filter(track => track !== newTrack)
        .forEach(track => track.stop())
      localStream.value.addTrack(newTrack)
      bindTrackEndHandlers({ getTracks: () => [newTrack] }, callId, targetPeerId)
      localVideoOn.value = true
      cameraStream = null
      await sendMediaState()
    } catch (e) {
      cameraStream?.getTracks().forEach(track => track.stop())
      console.warn('[call] enable camera:', e)
      if (attempt === cameraAttemptGeneration && isCurrentSession(callId, targetPeerId)) {
        localVideoOn.value = false
        Notify.create({ type: 'warning', message: t('call.cameraStartFailed'), timeout: 3000 })
      }
    } finally {
      if (attempt === cameraAttemptGeneration) cameraStarting.value = false
    }
  }

  // Switch front/rear camera (mobile browser)
  async function switchCamera() {
    if (!isVideo() || !localStream.value || !pc || cameraStarting.value) return
    if (connectionStatus.value === 'reconnecting') {
      Notify.create({ type: 'warning', message: t('call.waitReconnect'), timeout: 2000 })
      return
    }
    const attempt = ++cameraAttemptGeneration
    const connection = pc
    const callId = currentCallId
    const targetPeerId = peerId.value
    const stream = localStream.value
    const next = facingMode === 'user' ? 'environment' : 'user'
    let tmp = null
    cameraStarting.value = true
    try {
      tmp = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...VIDEO_CONSTRAINTS, facingMode: next } })
      const newTrack = tmp.getVideoTracks()[0]
      if (!newTrack) throw Object.assign(new Error('camera returned no video track'), { name: 'NotFoundError' })
      if (attempt !== cameraAttemptGeneration || pc !== connection || localStream.value !== stream ||
          !isCurrentSession(callId, targetPeerId)) {
        tmp.getTracks().forEach(track => track.stop())
        return
      }
      newTrack.enabled = localVideoOn.value
      const sender = connection.getTransceivers()
        .find(transceiver => transceiver.receiver?.track?.kind === 'video')?.sender
      if (!sender) throw new Error('video sender not found')
      await sender.replaceTrack(newTrack)
      if (attempt !== cameraAttemptGeneration || pc !== connection || localStream.value !== stream ||
          !isCurrentSession(callId, targetPeerId)) {
        newTrack.stop()
        return
      }
      // Synchronize local preview stream: remove old tracks and add new tracks
      const oldTrack = stream.getVideoTracks()[0]
      if (oldTrack) {
        oldTrack.onended = null
        stream.removeTrack(oldTrack)
        oldTrack.stop()
      }
      tmp.getTracks()
        .filter(track => track !== newTrack)
        .forEach(track => track.stop())
      stream.addTrack(newTrack)
      bindTrackEndHandlers({ getTracks: () => [newTrack] }, callId, targetPeerId)
      facingMode = next
      tmp = null
    } catch (e) {
      tmp?.getTracks().forEach(t => t.stop())
      console.warn('[call] switchCamera:', e)
      if (attempt === cameraAttemptGeneration && isCurrentSession(callId, targetPeerId)) {
        Notify.create({ type: 'warning', message: t('call.switchFailed') })
      }
    } finally {
      if (attempt === cameraAttemptGeneration) cameraStarting.value = false
    }
  }

  function cleanup() {
    preparedHangup = null
    signaling.release(currentCallId)
    lifecycle++
    answerAttemptGeneration++
    cameraAttemptGeneration++
    answering.value = false
    if (callingTimer) {
      clearTimeout(callingTimer)
      callingTimer = null
    }
    if (incomingTimer) {
      clearTimeout(incomingTimer)
      incomingTimer = null
    }
    clearConnectTimer()
    clearRecoveryState()
    if (localStream.value) {
      localStream.value.getTracks().forEach(t => { t.onended = null; t.stop() })
      localStream.value = null
    }
    if (pc) {
      pc.close()
      pc = null
    }
    remoteStream.value = null
    pendingOffer = null
    iceCandidateBuffer = []
    currentCallId = ''
    callAccountId = ''
    isInitiator = false
    restartInFlight = false
    awaitingRestartAnswer = false
    lastRestartAttempt = 0
    restartToken = ''
    facingMode = 'user'
    localVideoOn.value = false
    remoteVideoOn.value = null
    cameraStarting.value = false
    connectionStatus.value = 'idle'
    media.value = 'audio'
    state.value = 'idle'
    peerId.value = ''
    peerNickname.value = ''
  }

  // WS handlers
  function onCallOffer(payload) {
    if (!payload) return
    return handleIncomingOffer(payload.from, payload.call_id, payload.sdp, payload.media, payload.video_enabled)
  }

  async function onCallAnswer(payload) {
    if (!payload || state.value !== 'calling' || !pc ||
        !isCurrentSession(payload.call_id, payload.from) || !payload.sdp) return
    const connection = pc
    try {
      remoteVideoOn.value = typeof payload.video_enabled === 'boolean' ? payload.video_enabled : null
      await connection.setRemoteDescription(payload.sdp)
      if (pc !== connection || !isCurrentSession(payload.call_id, payload.from)) return
      await flushIceCandidates()
      if (pc !== connection || !isCurrentSession(payload.call_id, payload.from)) return
      state.value = 'active'
      await sendMediaState()
      if (pc !== connection || !isCurrentSession(payload.call_id, payload.from)) return
      if (callingTimer) { clearTimeout(callingTimer); callingTimer = null }
      startConnectTimeout(payload.call_id, payload.from)
    } catch (e) {
      console.error('[call] apply answer:', e)
      if (pc === connection && isCurrentSession(payload.call_id, payload.from)) {
        Notify.create({ type: 'negative', message: t('call.connectionFailed') })
        hangup()
      }
    }
  }

  function sendMediaState() {
    if (!isVideo() || !isCurrentSession(currentCallId)) return false
    return sendControl('call_media_state', {
      to: peerId.value,
      call_id: currentCallId,
      video_enabled: localVideoOn.value,
    })
  }

  function onCallMediaState(payload) {
    if (typeof payload?.video_enabled !== 'boolean' ||
        !isCurrentSession(payload.call_id, payload.from)) return
    remoteVideoOn.value = payload.video_enabled
  }

  async function onCallIce(payload) {
    if (!payload?.ice?.candidate || !isCurrentSession(payload.call_id, payload.from)) return
    if (pc?.remoteDescription) {
      try { await pc.addIceCandidate(payload.ice) }
      catch (e) { console.warn('[call] addIceCandidate:', e) }
    } else if (iceCandidateBuffer.length < MAX_BUFFERED_ICE) {
      iceCandidateBuffer.push(payload.ice)
    } else {
      console.warn('[call] ICE candidate buffer full, dropping candidate')
    }
  }

  async function onCallRestartOffer(payload) {
    if (!payload?.sdp || isInitiator || !pc || state.value !== 'active' ||
        !isCurrentSession(payload.call_id, payload.from)) return
    const connection = pc
    beginRecovery(payload.call_id, payload.from)
    try {
      await connection.setRemoteDescription(payload.sdp)
      if (pc !== connection || !isCurrentSession(payload.call_id, payload.from)) return
      await flushIceCandidates()
      if (pc !== connection || !isCurrentSession(payload.call_id, payload.from)) return
      const answer = await connection.createAnswer()
      if (pc !== connection || !isCurrentSession(payload.call_id, payload.from)) return
      await connection.setLocalDescription(answer)
      if (pc === connection && isCurrentSession(payload.call_id, payload.from)) {
        await sendAuthenticated('call_restart_answer', { to: payload.from, call_id: payload.call_id, sdp: answer, negotiation: payload.negotiation })
      }
    } catch (e) {
      console.warn('[call] ICE restart answer:', e)
    }
  }

  function onCallRestartRequest(payload) {
    if (!payload || !isInitiator || state.value !== 'active' || !isCurrentSession(payload.call_id, payload.from)) return
    if (connectionStatus.value !== 'reconnecting') beginRecovery(payload.call_id, payload.from)
    else attemptIceRestart(payload.call_id, payload.from)
  }

  async function onCallRestartAnswer(payload) {
    if (!payload?.sdp || !isInitiator || !awaitingRestartAnswer || !pc || state.value !== 'active' ||
        !isCurrentSession(payload.call_id, payload.from) || payload.negotiation !== restartToken) return
    const connection = pc
    const negotiation = restartToken
    restartInFlight = true
    try {
      await connection.setRemoteDescription(payload.sdp)
      if (pc !== connection || !isCurrentSession(payload.call_id, payload.from) || restartToken !== negotiation) return
      awaitingRestartAnswer = false
      await flushIceCandidates()
    } catch (e) {
      console.warn('[call] apply ICE restart answer:', e)
      if (pc === connection && isCurrentSession(payload.call_id, payload.from) && restartToken === negotiation) awaitingRestartAnswer = false
    } finally {
      if (pc === connection && isCurrentSession(payload.call_id, payload.from) && restartToken === negotiation) restartInFlight = false
    }
  }

  function onCallHangup(payload) {
    if (!payload || !isCurrentSession(payload.call_id, payload.from)) return
    if (state.value === 'active') {
      Notify.create({ type: 'info', message: t('call.ended'), timeout: 2000 })
    }
    cleanup()
  }

  function onCallReject(payload) {
    if (!payload || state.value !== 'calling' || !isCurrentSession(payload.call_id, payload.from)) return
    const reason = payload?.reason
    let message
    if (reason === 'busy') {
      message = t('call.peerBusy')
    } else if (reason === 'device_error') {
      message = t('call.peerDeviceError')
    } else if (reason === 'timeout') {
      message = t('call.peerNoAnswer')
    } else if (reason === 'glare') {
      message = t('call.glare')
    } else {
      message = t('call.declined')
    }
    Notify.create({ type: 'warning', message })
    cleanup()
  }

  function startListening() {
    const handlers = {
      call_offer: onCallOffer,
      call_answer: onCallAnswer,
      call_ice: onCallIce,
      call_hangup: onCallHangup,
      call_reject: onCallReject,
      call_restart_offer: onCallRestartOffer,
      call_restart_answer: onCallRestartAnswer,
      call_restart_request: onCallRestartRequest,
      call_media_state: onCallMediaState,
    }
    const bindings = Object.entries(handlers).map(([type, handler]) => [type, authenticatedHandler(type, handler)])
    for (const [type, handler] of bindings) on(type, handler)
    return () => {
      if (state.value !== 'idle') hangup()
      else lifecycle++
      for (const [type, handler] of bindings) off(type, handler)
    }
  }

  return {
    state, media, peerId, peerNickname, remoteStream, localStream,
    localVideoOn, remoteVideoOn, cameraStarting, answering,
    connectionStatus, reconnectSeconds,
    startCall, answerCall, rejectCall, hangup,
    setMuted, setCameraEnabled, switchCamera, startListening,
  }
})
