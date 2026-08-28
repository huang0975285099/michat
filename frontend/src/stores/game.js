import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Notify } from 'quasar'
import { send, on, off } from 'src/services/websocket'
import { useIdentityStore } from 'src/stores/identity'
import { ironFistAcceptCommand, ironFistReadyRoute } from './ironfist-invite-core.mjs'
import { t } from 'src/i18n'

function randomId() { return Math.random().toString(36).slice(2, 10) }
function randomSeed() { return (Math.random() * 2 ** 31) >>> 0 }

export const useGameStore = defineStore('game', () => {
  // idle | inviting | invited | waiting | playing
  const state      = ref('idle')
  const opponentId = ref('')
  const opponentNickname = ref('')
  const roomId     = ref('')
  const seed       = ref(0)
  const isHost     = ref(false)
  const game       = ref('bomberman')   //The type of game you are currently playing against

  let _router = null
  let _inviteTimer = null

  /** Call once in MainLayout so the store has access to the router */
  function setRouter(r) { _router = r }

  // ── Outgoing invite ────────────────────────────────────────────────────

  function invite(chatId, nickname, gameType = 'bomberman') {
    if (state.value !== 'idle') return
    isHost.value = true
    opponentId.value = chatId
    opponentNickname.value = nickname || chatId
    roomId.value = randomId()
    game.value = gameType
    state.value = 'inviting'

    // Carrying the inviter's own nickname: the invitee (guest) displays the opponent's nickname accordingly.
    // Otherwise, you can only get the other party's chat_id, causing the ID instead of the nickname to be displayed in the results.
    send('game_invite', {
      to: chatId,
      game: gameType,
      room_id: roomId.value,
      from_nickname: useIdentityStore().nickname,
    })

    _inviteTimer = setTimeout(() => {
      if (state.value === 'inviting') {
        Notify.create({ type: 'warning', message: t('system.inviteTimeout'), timeout: 2000 })
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
    if (game.value === 'ironfist') {
      send('game_accept', ironFistAcceptCommand(opponentId.value, roomId.value))
      state.value = 'waiting'
      return
    }
    const s = randomSeed()
    seed.value = s
    send('game_accept', { to: opponentId.value, room_id: roomId.value, seed: s })
    state.value = 'playing'
    _router?.push({
      path: `/games/${game.value}`,
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
    // Priority will be given to the nickname carried by the inviter; otherwise, the friend's nickname cache will be rolled back; then it will be degraded to chat_id.
    opponentNickname.value =
      payload.from_nickname ||
      useIdentityStore().getFriendName(payload.from) ||
      payload.from
    roomId.value = payload.room_id
    game.value = payload.game || 'bomberman'
    state.value = 'invited'
  }

  function _onAccept(payload) {
    if (state.value !== 'inviting') return
    if (game.value === 'ironfist') return
    clearTimeout(_inviteTimer)
    seed.value = payload.seed
    state.value = 'playing'
    _router?.push({
      path: `/games/${game.value}`,
      query: {
        opponent: opponentId.value,
        room: roomId.value,
        seed: payload.seed,
        role: 'host',
      },
    })
  }

  function _onReady(payload) {
    if (payload.game !== 'ironfist' || payload.room_id !== roomId.value) return
    if (state.value !== 'inviting' && state.value !== 'waiting') return
    if (!payload.game_id) return
    clearTimeout(_inviteTimer)
    state.value = 'playing'
    opponentId.value = payload.opponent || opponentId.value
    _router?.push(ironFistReadyRoute(payload))
  }

  function _onReject(payload) {
    if (state.value !== 'inviting') return
    clearTimeout(_inviteTimer)
    const reason = payload.reason === 'busy' ? t('system.opponentBusy') : t('system.inviteDeclined')
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
    game.value = 'bomberman'
  }

  function startListening() {
    on('game_invite', _onInvite)
    on('game_accept', _onAccept)
    on('game_ready', _onReady)
    on('game_reject', _onReject)
    return () => {
      off('game_invite', _onInvite)
      off('game_accept', _onAccept)
      off('game_ready', _onReady)
      off('game_reject', _onReject)
    }
  }

  return {
    state, opponentId, opponentNickname, roomId, seed, isHost, game,
    setRouter, invite, cancelInvite, acceptInvite, rejectInvite, reset, startListening,
  }
})
