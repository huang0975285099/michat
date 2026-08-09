import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Notify } from 'quasar'
import { send, on, off, wsConnected } from 'src/services/websocket'
import { callApi } from 'src/services/api'
import { acquireCallMedia } from './call-media.mjs'

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

export const useCallStore = defineStore('call', () => {
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
  let isInitiator = false
  let restartInFlight = false
  let awaitingRestartAnswer = false
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
        if (track.kind === 'video') {
          if (!localStream.value?.getVideoTracks().includes(track)) return
          localStream.value.removeTrack(track)
          localVideoOn.value = false
          sendMediaState()
          Notify.create({ type: 'warning', message: 'Camera disconnected; continuing with voice', timeout: 3000 })
        } else {
          Notify.create({ type: 'negative', message: 'MicrophoneDisconnected，The call has ended', timeout: 3000 })
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
      remoteStream.value = event.streams[0] || new MediaStream([event.track])
      if (event.track?.kind === 'video' && event.track.readyState !== 'ended' &&
          remoteVideoOn.value === null) {
        remoteVideoOn.value = true
      }
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
        Notify.create({ type: 'warning', message: 'Camera unavailable; continuing with voice', timeout: 3000 })
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
      await connection.setLocalDescription(offer)
      if (pc !== connection || !isCurrentSession(callId, chatId) || state.value !== 'calling') return
      // The signaling carries the media type, and the called end decides whether to turn on the camera based on this.
      if (!send('call_offer', {
        to: chatId,
        call_id: callId,
        sdp: offer,
        media: media.value,
        video_enabled: isVideo() ? localVideoOn.value : undefined,
      })) {
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
        cleanup()
        const message = e.message === 'Signaling connection disconnected' ? e.message : deviceErrorMessage(e, false)
        Notify.create({ type: 'negative', message })
      }
    }
  }

  function handleIncomingOffer(fromId, callId, sdp, callMedia, videoEnabled) {
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
    remoteVideoOn.value = isVideo() && typeof videoEnabled === 'boolean' ? videoEnabled : null
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
        Notify.create({ type: 'warning', message: 'Camera unavailable; continuing with voice', timeout: 3000 })
      }
      bindTrackEndHandlers(stream, callId, fromId)
      const iceConfig = await getTurnConfig()
      if (!isCurrentSession(callId, fromId) || state.value !== 'ringing') return
      const connection = createPC(iceConfig, callId, fromId)
      connectionStatus.value = 'connecting'
      await connection.setRemoteDescription(offer)
      await flushIceCandidates()
      localStream.value.getAudioTracks().forEach(track => connection.addTrack(track, localStream.value))
      const videoTrack = localStream.value.getVideoTracks()[0]
      if (videoTrack) connection.addTrack(videoTrack, localStream.value)
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      if (pc !== connection || !isCurrentSession(callId, fromId) || state.value !== 'ringing') return
      if (!send('call_answer', {
        to: fromId,
        call_id: callId,
        sdp: answer,
        video_enabled: isVideo() ? localVideoOn.value : undefined,
      })) {
        throw new Error('Signaling connection disconnected')
      }
      state.value = 'active'
      pendingOffer = null
      if (incomingTimer) { clearTimeout(incomingTimer); incomingTimer = null }
      startConnectTimeout(callId, fromId)
    } catch (e) {
      console.error('[call] answerCall:', e)
      if (currentCallId === callId) {
        send('call_reject', { to: fromId, call_id: callId, reason: 'device_error' })
        cleanup()
        const message = e.message === 'Signaling connection disconnected' ? e.message : deviceErrorMessage(e, false)
        Notify.create({ type: 'negative', message })
      }
    } finally {
      if (answerAttemptGeneration === answerAttempt) answering.value = false
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
      sendMediaState()
      return
    }
    if (existingTrack) {
      existingTrack.enabled = true
      localVideoOn.value = true
      sendMediaState()
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
      sendMediaState()
    } catch (e) {
      cameraStream?.getTracks().forEach(track => track.stop())
      console.warn('[call] enable camera:', e)
      if (attempt === cameraAttemptGeneration && isCurrentSession(callId, targetPeerId)) {
        localVideoOn.value = false
        Notify.create({ type: 'warning', message: 'Unable to start camera; continuing with voice', timeout: 3000 })
      }
    } finally {
      if (attempt === cameraAttemptGeneration) cameraStarting.value = false
    }
  }

  // Switch front/rear camera (mobile browser)
  async function switchCamera() {
    if (!isVideo() || !localStream.value || !pc || cameraStarting.value) return
    if (connectionStatus.value === 'reconnecting') {
      Notify.create({ type: 'warning', message: 'Reconnecting, please try again later', timeout: 2000 })
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
        Notify.create({ type: 'warning', message: 'Failed to switch camera' })
      }
    } finally {
      if (attempt === cameraAttemptGeneration) cameraStarting.value = false
    }
  }

  function cleanup() {
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
    isInitiator = false
    restartInFlight = false
    awaitingRestartAnswer = false
    lastRestartAttempt = 0
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
    handleIncomingOffer(payload.from, payload.call_id, payload.sdp, payload.media, payload.video_enabled)
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
      state.value = 'active'
      sendMediaState()
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

  function sendMediaState() {
    if (!isVideo() || !isCurrentSession(currentCallId)) return false
    return send('call_media_state', {
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
      awaitingRestartAnswer = false
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
    on('call_media_state', onCallMediaState)
    return () => {
      if (state.value !== 'idle') hangup()
      off('call_offer', onCallOffer)
      off('call_answer', onCallAnswer)
      off('call_ice', onCallIce)
      off('call_hangup', onCallHangup)
      off('call_reject', onCallReject)
      off('call_restart_offer', onCallRestartOffer)
      off('call_restart_answer', onCallRestartAnswer)
      off('call_restart_request', onCallRestartRequest)
      off('call_media_state', onCallMediaState)
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
