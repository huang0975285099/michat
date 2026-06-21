import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Notify } from 'quasar'
import { send, on, off } from 'src/services/websocket'
import { callApi } from 'src/services/api'

function deviceErrorMessage(e, video) {
  const noun = video ? '摄像头/麦克风' : '麦克风'
  if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
    return `未找到${noun}设备，请检查设备连接`
  }
  if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
    return `${noun}权限被拒绝，请在浏览器设置中允许访问`
  }
  if (e.name === 'NotReadableError') {
    return `${noun}被其他程序占用，请关闭后重试`
  }
  return `无法访问${noun}：` + (e.message || e.name)
}

// 视频约束：限制分辨率以控制带宽，1:1 通话足够
const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 } }

function mediaConstraints(video, facing) {
  return {
    audio: true,
    video: video ? { ...VIDEO_CONSTRAINTS, facingMode: facing } : false,
  }
}

export const useCallStore = defineStore('call', () => {
  const state = ref('idle')   // idle | calling | ringing | active
  const media = ref('audio')  // audio | video（本次通话类型）
  const peerId = ref('')
  const peerNickname = ref('')
  const remoteStream = ref(null)
  const localStream = ref(null)
  const cameraOn = ref(true)

  let pc = null
  let pendingOffer = null
  let iceCandidateBuffer = []
  let callingTimer = null
  let facingMode = 'user' // 当前摄像头朝向：user=前置 environment=后置

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

  function createPC(iceConfig) {
    pc = new RTCPeerConnection(iceConfig)

    pc.ontrack = (event) => {
      remoteStream.value = event.streams[0]
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        send('call_ice', { to: peerId.value, ice: event.candidate.toJSON() })
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        Notify.create({ type: 'negative', message: '通话连接中断，请检查网络后重试', timeout: 3000 })
        hangup()
      } else if (pc.connectionState === 'disconnected') {
        hangup()
      }
    }

    return pc
  }

  async function flushIceCandidates() {
    while (iceCandidateBuffer.length && pc?.remoteDescription) {
      const ice = iceCandidateBuffer.shift()
      try { await pc.addIceCandidate(ice) } catch {}
    }
  }

  async function startCall(chatId, nickname, callMedia = 'audio') {
    if (state.value !== 'idle') return
    media.value = callMedia === 'video' ? 'video' : 'audio'
    peerId.value = chatId
    peerNickname.value = nickname || chatId
    state.value = 'calling'

    callingTimer = setTimeout(() => {
      if (state.value === 'calling') {
        hangup()
        Notify.create({ type: 'warning', message: '呼叫超时，对方未接听' })
      }
    }, 30000)

    try {
      localStream.value = await navigator.mediaDevices.getUserMedia(mediaConstraints(isVideo(), facingMode))
      const iceConfig = await getTurnConfig()
      createPC(iceConfig)
      localStream.value.getTracks().forEach(track => pc.addTrack(track, localStream.value))
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      // 信令携带 media 类型，被叫端据此决定是否开启摄像头
      send('call_offer', { to: chatId, sdp: offer, media: media.value })
    } catch (e) {
      console.error('[call] startCall:', e)
      cleanup()
      Notify.create({ type: 'negative', message: deviceErrorMessage(e, isVideo()) })
    }
  }

  function handleIncomingOffer(fromId, sdp, callMedia) {
    if (state.value !== 'idle') {
      send('call_reject', { to: fromId, reason: 'busy' })
      return
    }
    media.value = callMedia === 'video' ? 'video' : 'audio'
    peerId.value = fromId
    peerNickname.value = fromId
    pendingOffer = sdp
    state.value = 'ringing'
  }

  async function answerCall() {
    if (state.value !== 'ringing' || !pendingOffer) return
    try {
      localStream.value = await navigator.mediaDevices.getUserMedia(mediaConstraints(isVideo(), facingMode))
      const iceConfig = await getTurnConfig()
      createPC(iceConfig)
      localStream.value.getTracks().forEach(track => pc.addTrack(track, localStream.value))
      await pc.setRemoteDescription(pendingOffer)
      await flushIceCandidates()
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      send('call_answer', { to: peerId.value, sdp: answer })
      state.value = 'active'
      pendingOffer = null
    } catch (e) {
      console.error('[call] answerCall:', e)
      send('call_reject', { to: peerId.value, reason: 'device_error' })
      cleanup()
      Notify.create({ type: 'negative', message: deviceErrorMessage(e, isVideo()) })
    }
  }

  function rejectCall() {
    send('call_reject', { to: peerId.value, reason: 'rejected' })
    cleanup()
  }

  function hangup() {
    if (state.value !== 'idle') {
      send('call_hangup', { to: peerId.value })
    }
    cleanup()
  }

  function setMuted(val) {
    if (localStream.value) {
      localStream.value.getAudioTracks().forEach(t => { t.enabled = !val })
    }
  }

  // 开/关本地摄像头（仅暂停画面，不结束通话）
  function setCameraEnabled(val) {
    cameraOn.value = val
    if (localStream.value) {
      localStream.value.getVideoTracks().forEach(t => { t.enabled = val })
    }
  }

  // 切换前置/后置摄像头（移动端浏览器）
  async function switchCamera() {
    if (!isVideo() || !localStream.value || !pc) return
    const next = facingMode === 'user' ? 'environment' : 'user'
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...VIDEO_CONSTRAINTS, facingMode: next } })
      const newTrack = tmp.getVideoTracks()[0]
      if (!newTrack) return
      newTrack.enabled = cameraOn.value
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
      if (sender) await sender.replaceTrack(newTrack)
      // 同步本地预览流：移除旧轨、加入新轨
      const oldTrack = localStream.value.getVideoTracks()[0]
      if (oldTrack) {
        localStream.value.removeTrack(oldTrack)
        oldTrack.stop()
      }
      localStream.value.addTrack(newTrack)
      facingMode = next
    } catch (e) {
      console.warn('[call] switchCamera:', e)
      Notify.create({ type: 'warning', message: '切换摄像头失败' })
    }
  }

  function cleanup() {
    if (callingTimer) {
      clearTimeout(callingTimer)
      callingTimer = null
    }
    if (localStream.value) {
      localStream.value.getTracks().forEach(t => t.stop())
      localStream.value = null
    }
    if (pc) {
      pc.close()
      pc = null
    }
    remoteStream.value = null
    pendingOffer = null
    iceCandidateBuffer = []
    facingMode = 'user'
    cameraOn.value = true
    media.value = 'audio'
    state.value = 'idle'
    peerId.value = ''
    peerNickname.value = ''
  }

  // WS handlers
  function onCallOffer(payload) {
    handleIncomingOffer(payload.from, payload.sdp, payload.media)
  }

  async function onCallAnswer(payload) {
    if (!pc) return
    await pc.setRemoteDescription(payload.sdp)
    await flushIceCandidates()
    state.value = 'active'
  }

  async function onCallIce(payload) {
    if (!payload.ice || !payload.ice.candidate) return
    if (pc?.remoteDescription) {
      try { await pc.addIceCandidate(payload.ice) } catch {}
    } else {
      iceCandidateBuffer.push(payload.ice)
    }
  }

  function onCallHangup() {
    if (state.value === 'active') {
      Notify.create({ type: 'info', message: '通话已结束', timeout: 2000 })
    }
    cleanup()
  }

  function onCallReject(payload) {
    if (state.value !== 'calling') { cleanup(); return }
    const reason = payload?.reason
    let message
    if (reason === 'busy') {
      message = '对方正在通话中，请稍后再试'
    } else if (reason === 'device_error') {
      message = '对方设备无法接听通话（麦克风或权限问题）'
    } else {
      message = '对方已拒绝通话'
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
    return () => {
      off('call_offer', onCallOffer)
      off('call_answer', onCallAnswer)
      off('call_ice', onCallIce)
      off('call_hangup', onCallHangup)
      off('call_reject', onCallReject)
    }
  }

  return {
    state, media, peerId, peerNickname, remoteStream, localStream, cameraOn,
    startCall, answerCall, rejectCall, hangup,
    setMuted, setCameraEnabled, switchCamera, startListening,
  }
})
