import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Notify } from 'quasar'
import { send, on, off } from 'src/services/websocket'

function randomId() { return Math.random().toString(36).slice(2, 10) }
function randomSeed() { return (Math.random() * 2 ** 31) >>> 0 }

export const useGameStore = defineStore('game', () => {
  // idle | inviting | invited | playing
  const state      = ref('idle')
  const opponentId = ref('')
  const opponentNickname = ref('')
  const roomId     = ref('')
  const seed       = ref(0)
  const isHost     = ref(false)

  let _router = null
  let _inviteTimer = null

  /** Call once in MainLayout so the store has access to the router */
  function setRouter(r) { _router = r }

  // ── Outgoing invite ────────────────────────────────────────────────────

  function invite(chatId, nickname) {
    if (state.value !== 'idle') return
    isHost.value = true
    opponentId.value = chatId
    opponentNickname.value = nickname || chatId
    roomId.value = randomId()
    state.value = 'inviting'

    send('game_invite', { to: chatId, game: 'bomberman', room_id: roomId.value })

    _inviteTimer = setTimeout(() => {
      if (state.value === 'inviting') {
        Notify.create({ type: 'warning', message: '对方未响应邀请', timeout: 2000 })
        reset()
      }
    }, 30_000)
  }

  function cancelInvite() {
    if (state.value !== 'inviting') return
    send('game_reject', { to: opponentId.value, room_id: roomId.value })
    reset()
  }

  // ── Incoming invite ────────────────────────────────────────────────────

  function acceptInvite() {
    if (state.value !== 'invited') return
    const s = randomSeed()
    seed.value = s
    send('game_accept', { to: opponentId.value, room_id: roomId.value, seed: s })
    state.value = 'playing'
    _router?.push({
      path: '/games/bomberman',
      query: { opponent: opponentId.value, room: roomId.value, seed: s, role: 'guest' },
    })
  }

  function rejectInvite() {
    if (state.value !== 'invited') return
    send('game_reject', { to: opponentId.value, room_id: roomId.value })
    reset()
  }

  // ── WS handlers ───────────────────────────────────────────────────────

  function _onInvite(payload) {
    if (state.value !== 'idle') {
      send('game_reject', { to: payload.from, room_id: payload.room_id, reason: 'busy' })
      return
    }
    isHost.value = false
    opponentId.value = payload.from
    opponentNickname.value = payload.from   // resolved to nickname by UI if available
    roomId.value = payload.room_id
    state.value = 'invited'
  }

  function _onAccept(payload) {
    if (state.value !== 'inviting') return
    clearTimeout(_inviteTimer)
    seed.value = payload.seed
    state.value = 'playing'
    _router?.push({
      path: '/games/bomberman',
      query: {
        opponent: opponentId.value,
        room: roomId.value,
        seed: payload.seed,
        role: 'host',
      },
    })
  }

  function _onReject(payload) {
    if (state.value !== 'inviting') return
    clearTimeout(_inviteTimer)
    const reason = payload.reason === 'busy' ? '对方正忙' : '对方拒绝了邀请'
    Notify.create({ type: 'warning', message: reason, timeout: 2000 })
    reset()
  }

  function reset() {
    clearTimeout(_inviteTimer)
    state.value = 'idle'
    opponentId.value = ''
    opponentNickname.value = ''
    roomId.value = ''
    seed.value = 0
    isHost.value = false
  }

  function startListening() {
    on('game_invite', _onInvite)
    on('game_accept', _onAccept)
    on('game_reject', _onReject)
    return () => {
      off('game_invite', _onInvite)
      off('game_accept', _onAccept)
      off('game_reject', _onReject)
    }
  }

  return {
    state, opponentId, opponentNickname, roomId, seed, isHost,
    setRouter, invite, cancelInvite, acceptInvite, rejectInvite, reset, startListening,
  }
})
