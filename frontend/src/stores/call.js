import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Notify } from 'quasar'
import { send, on, off, wsConnected } from 'src/services/websocket'
import { callApi } from 'src/services/api'

function deviceErrorMessage(e, video) {
  const noun = video ? 'camera/Microphone' : 'Microphone'
  if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
    return `not found${noun}Equipment，Please check device connection`
  }
  if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
    return `${noun}Permission denied，Please allow access in your browser settings`
  }
  if (e.name === 'NotReadableError') {
    return `${noun}occupied by other programs，Please close and try again`
  }
  return `Unable to access${noun}：` + (e.message || e.name)
}

// Video constraints: limit resolution to control bandwidth, 1:1 calls are sufficient
const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 } }
const CALL_TIMEOUT_MS = 30000
const INCOMING_TIMEOUT_MS = 35000
const DISCONNECT_GRACE_MS = 10000
const CONNECT_TIMEOUT_MS = 20000
const MAX_BUFFERED_ICE = 256
const CALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function mediaConstraints(video, facing) {
  return {
    audio: true,
    video: video ? { ...VIDEO_CONSTRAINTS, facingMode: facing } : false,
  }
}

export const useCallStore = defineStore('call', () => {
  const state = ref('idle')   // idle | calling | ringing | active
  const media = ref('audio')  //audio | video (type of this call)
  const peerId = ref('')
  const peerNickname = ref('')
  const remoteStream = ref(null)
  const localStream = ref(null)
  const cameraOn = ref(true)
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
  let isInitiator = false
  let restartInFlight = false
  let awaitingRestartAnswer = false
  let lastRestartAttempt = 0
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
    } catch {
      return { iceServers: [] }
    }
  }

  function isCurrentSession(callId, fromId = peerId.value) {
    return !!callId && callId === currentCallId && fromId === peerId.value && state.value !== 'idle'
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
        Notify.create({ type: 'negative', message: 'Unable to establish media connection，Please check the network and try again', timeout: 3000 })
      }
    }, CONNECT_TIMEOUT_MS)
  }

  function bindTrackEndHandlers(stream, callId, targetPeerId) {
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (!isCurrentSession(callId, targetPeerId)) return
        const device = track.kind === 'video' ? 'camera' : 'Microphone'
        Notify.create({ type: 'negative', message: `${device}Disconnected，The call has ended`, timeout: 3000 })
        hangup()
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
      send('call_restart_request', { to: targetPeerId, call_id: callId })
      return
    }
    if (awaitingRestartAnswer && now - lastRestartAttempt < 2500) return
    lastRestartAttempt = now
    restartInFlight = true
    try {
      // If you did not receive an Answer during the last reconnection Offer, you must roll back before you can safely initiate the next round of negotiation.
      if (connection.signalingState === 'have-local-offer') {
        await connection.setLocalDescription({ type: 'rollback' })
      }
      connection.restartIce()
      const offer = await connection.createOffer({ iceRestart: true })
      await connection.setLocalDescription(offer)
      if (pc !== connection || !isCurrentSession(callId, targetPeerId) || connectionStatus.value !== 'reconnecting') return
      awaitingRestartAnswer = send('call_restart_offer', { to: targetPeerId, call_id: callId, sdp: offer })
    } catch (e) {
      console.warn('[call] ICE restart offer:', e)
    } finally {
      restartInFlight = false
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
        Notify.create({ type: 'negative', message: 'Network outage，The call has ended', timeout: 3000 })
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
      remoteStream.value = event.streams[0]
    }

    connection.onicecandidate = (event) => {
      if (event.candidate && pc === connection && isCurrentSession(callId, targetPeerId)) {
        send('call_ice', { to: targetPeerId, call_id: callId, ice: event.candidate.toJSON() })
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
    while (iceCandidateBuffer.length && pc?.remoteDescription) {
      const ice = iceCandidateBuffer.shift()
      try { await pc.addIceCandidate(ice) } catch {}
    }
  }

  async function startCall(chatId, nickname, callMedia = 'audio') {
    if (state.value !== 'idle') return
    const callId = crypto.randomUUID()
    currentCallId = callId
    isInitiator = true
    media.value = callMedia === 'video' ? 'video' : 'audio'
    peerId.value = chatId
    peerNickname.value = nickname || chatId
    state.value = 'calling'

    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(isVideo(), facingMode))
      // The user may have hung up during the permission pop-up window, and the late getUserMedia cannot be used to revive the old call.
      if (!isCurrentSession(callId, chatId) || state.value !== 'calling') {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      localStream.value = stream
      bindTrackEndHandlers(stream, callId, chatId)
      const iceConfig = await getTurnConfig()
      if (!isCurrentSession(callId, chatId) || state.value !== 'calling') return
      const connection = createPC(iceConfig, callId, chatId)
      connectionStatus.value = 'connecting'
      localStream.value.getTracks().forEach(track => pc.addTrack(track, localStream.value))
      const offer = await connection.createOffer()
      await connection.setLocalDescription(offer)
      if (pc !== connection || !isCurrentSession(callId, chatId) || state.value !== 'calling') return
      // The signaling carries the media type, and the called end decides whether to turn on the camera based on this.
      if (!send('call_offer', { to: chatId, call_id: callId, sdp: offer, media: media.value })) {
        throw new Error('Signaling connection disconnected')
      }
      callingTimer = setTimeout(() => {
        if (state.value === 'calling' && currentCallId === callId) {
          hangup()
          Notify.create({ type: 'warning', message: 'call timeout，The other party did not answer' })
        }
      }, CALL_TIMEOUT_MS)
    } catch (e) {
      console.error('[call] startCall:', e)
      if (currentCallId === callId) {
        const video = isVideo()
        cleanup()
        const message = e.message === 'Signaling connection disconnected' ? e.message : deviceErrorMessage(e, video)
        Notify.create({ type: 'negative', message })
      }
    }
  }

  function handleIncomingOffer(fromId, callId, sdp, callMedia) {
    if (!CALL_ID_PATTERN.test(callId || '') || !fromId || !sdp) return
    if (state.value !== 'idle') {
      // When the same two parties call each other at the same time, if the call_id is kept smaller with certainty, both parties will reach the same conclusion.
      if (state.value === 'calling' && fromId === peerId.value && callId < currentCallId) {
        cleanup()
      } else {
        send('call_reject', { to: fromId, call_id: callId, reason: fromId === peerId.value ? 'glare' : 'busy' })
        return
      }
    }
    currentCallId = callId
    isInitiator = false
    media.value = callMedia === 'video' ? 'video' : 'audio'
    peerId.value = fromId
    peerNickname.value = fromId
    pendingOffer = sdp
    state.value = 'ringing'
    incomingTimer = setTimeout(() => {
      if (state.value === 'ringing' && currentCallId === callId) {
        send('call_reject', { to: fromId, call_id: callId, reason: 'timeout' })
        cleanup()
      }
    }, INCOMING_TIMEOUT_MS)
  }

  async function answerCall() {
    if (state.value !== 'ringing' || !pendingOffer) return
    const callId = currentCallId
    const fromId = peerId.value
    const offer = pendingOffer
    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(isVideo(), facingMode))
      if (!isCurrentSession(callId, fromId) || state.value !== 'ringing') {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      localStream.value = stream
      bindTrackEndHandlers(stream, callId, fromId)
      const iceConfig = await getTurnConfig()
      if (!isCurrentSession(callId, fromId) || state.value !== 'ringing') return
      const connection = createPC(iceConfig, callId, fromId)
      connectionStatus.value = 'connecting'
      localStream.value.getTracks().forEach(track => pc.addTrack(track, localStream.value))
      await connection.setRemoteDescription(offer)
      await flushIceCandidates()
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      if (pc !== connection || !isCurrentSession(callId, fromId) || state.value !== 'ringing') return
      if (!send('call_answer', { to: fromId, call_id: callId, sdp: answer })) {
        throw new Error('Signaling connection disconnected')
      }
      state.value = 'active'
      pendingOffer = null
      if (incomingTimer) { clearTimeout(incomingTimer); incomingTimer = null }
      startConnectTimeout(callId, fromId)
    } catch (e) {
      console.error('[call] answerCall:', e)
      if (currentCallId === callId) {
        const video = isVideo()
        send('call_reject', { to: fromId, call_id: callId, reason: 'device_error' })
        cleanup()
        const message = e.message === 'Signaling connection disconnected' ? e.message : deviceErrorMessage(e, video)
        Notify.create({ type: 'negative', message })
      }
    }
  }

  function rejectCall() {
    send('call_reject', { to: peerId.value, call_id: currentCallId, reason: 'rejected' })
    cleanup()
  }

  function hangup() {
    if (state.value !== 'idle') {
      send('call_hangup', { to: peerId.value, call_id: currentCallId })
    }
    cleanup()
  }

  function setMuted(val) {
    if (localStream.value) {
      localStream.value.getAudioTracks().forEach(t => { t.enabled = !val })
    }
  }

  // Turn on/off the local camera (only pauses the picture, does not end the call)
  function setCameraEnabled(val) {
    cameraOn.value = val
    if (localStream.value) {
      localStream.value.getVideoTracks().forEach(t => { t.enabled = val })
    }
  }

  // Switch front/rear camera (mobile browser)
  async function switchCamera() {
    if (!isVideo() || !localStream.value || !pc) return
    const next = facingMode === 'user' ? 'environment' : 'user'
    let tmp = null
    try {
      tmp = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...VIDEO_CONSTRAINTS, facingMode: next } })
      const newTrack = tmp.getVideoTracks()[0]
      if (!newTrack) return
      newTrack.enabled = cameraOn.value
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
      if (!sender) throw new Error('video sender not found')
      await sender.replaceTrack(newTrack)
      // Synchronize local preview stream: remove old tracks and add new tracks
      const oldTrack = localStream.value.getVideoTracks()[0]
      if (oldTrack) {
        oldTrack.onended = null
        localStream.value.removeTrack(oldTrack)
        oldTrack.stop()
      }
      localStream.value.addTrack(newTrack)
      bindTrackEndHandlers(new MediaStream([newTrack]), currentCallId, peerId.value)
      facingMode = next
    } catch (e) {
      tmp?.getTracks().forEach(t => t.stop())
      console.warn('[call] switchCamera:', e)
      Notify.create({ type: 'warning', message: 'Failed to switch camera' })
    }
  }

  function cleanup() {
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
    isInitiator = false
    restartInFlight = false
    awaitingRestartAnswer = false
    lastRestartAttempt = 0
    facingMode = 'user'
    cameraOn.value = true
    connectionStatus.value = 'idle'
    media.value = 'audio'
    state.value = 'idle'
    peerId.value = ''
    peerNickname.value = ''
  }

  // WS handlers
  function onCallOffer(payload) {
    if (!payload) return
    handleIncomingOffer(payload.from, payload.call_id, payload.sdp, payload.media)
  }

  async function onCallAnswer(payload) {
    if (!payload || state.value !== 'calling' || !pc ||
        !isCurrentSession(payload.call_id, payload.from) || !payload.sdp) return
    const connection = pc
    try {
      await connection.setRemoteDescription(payload.sdp)
      if (pc !== connection || !isCurrentSession(payload.call_id, payload.from)) return
      await flushIceCandidates()
      state.value = 'active'
      if (callingTimer) { clearTimeout(callingTimer); callingTimer = null }
      startConnectTimeout(payload.call_id, payload.from)
    } catch (e) {
      console.error('[call] apply answer:', e)
      if (pc === connection && isCurrentSession(payload.call_id, payload.from)) {
        Notify.create({ type: 'negative', message: 'Unable to establish call connection，Please try again' })
        hangup()
      }
    }
  }

  async function onCallIce(payload) {
    if (!payload?.ice?.candidate || !isCurrentSession(payload.call_id, payload.from)) return
    if (pc?.remoteDescription) {
      try { await pc.addIceCandidate(payload.ice) } catch {}
    } else if (iceCandidateBuffer.length < MAX_BUFFERED_ICE) {
      iceCandidateBuffer.push(payload.ice)
    }
  }

  async function onCallRestartOffer(payload) {
    if (!payload?.sdp || isInitiator || !pc || state.value !== 'active' ||
        !isCurrentSession(payload.call_id, payload.from)) return
    const connection = pc
    beginRecovery(payload.call_id, payload.from)
    try {
      await connection.setRemoteDescription(payload.sdp)
      await flushIceCandidates()
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      if (pc === connection && isCurrentSession(payload.call_id, payload.from)) {
        send('call_restart_answer', { to: payload.from, call_id: payload.call_id, sdp: answer })
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
    if (!payload?.sdp || !isInitiator || !pc || state.value !== 'active' ||
        !isCurrentSession(payload.call_id, payload.from)) return
    const connection = pc
    try {
      await connection.setRemoteDescription(payload.sdp)
      awaitingRestartAnswer = false
      await flushIceCandidates()
    } catch (e) {
      console.warn('[call] apply ICE restart answer:', e)
    }
  }

  function onCallHangup(payload) {
    if (!payload || !isCurrentSession(payload.call_id, payload.from)) return
    if (state.value === 'active') {
      Notify.create({ type: 'info', message: 'The call has ended', timeout: 2000 })
    }
    cleanup()
  }

  function onCallReject(payload) {
    if (!payload || state.value !== 'calling' || !isCurrentSession(payload.call_id, payload.from)) return
    const reason = payload?.reason
    let message
    if (reason === 'busy') {
      message = 'The other party is on the call，Please try again later'
    } else if (reason === 'device_error') {
      message = 'The other device cannot answer the call (microphone or permission issue)'
    } else if (reason === 'timeout') {
      message = 'The other party did not answer'
    } else if (reason === 'glare') {
      message = 'Processing calls initiated by both parties at the same time'
    } else {
      message = 'The other party has declined the call'
    }
    Notify.create({ type: 'warning', message })
    cleanup()
  }

  function startListening() {
    on('call_offer', onCallOffer)
    on('call_answer', onCallAnswer)
    on('call_ice', onCallIce)
    on('call_hangup', onCallHangup)
    on('call_reject', onCallReject)
    on('call_restart_offer', onCallRestartOffer)
    on('call_restart_answer', onCallRestartAnswer)
    on('call_restart_request', onCallRestartRequest)
    return () => {
      off('call_offer', onCallOffer)
      off('call_answer', onCallAnswer)
      off('call_ice', onCallIce)
      off('call_hangup', onCallHangup)
      off('call_reject', onCallReject)
      off('call_restart_offer', onCallRestartOffer)
      off('call_restart_answer', onCallRestartAnswer)
      off('call_restart_request', onCallRestartRequest)
    }
  }

  return {
    state, media, peerId, peerNickname, remoteStream, localStream, cameraOn,
    connectionStatus, reconnectSeconds,
    startCall, answerCall, rejectCall, hangup,
    setMuted, setCameraEnabled, switchCamera, startListening,
  }
})
