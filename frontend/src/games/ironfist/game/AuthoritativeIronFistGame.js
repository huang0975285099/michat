import { ironfistApi } from 'src/services/api'
import { on, off } from 'src/services/websocket'
import {
  createAuthoritativeClientCore,
  createAuthoritativeTransitionCoordinator,
} from './authoritative-client-core.mjs'

const EVENT_TYPES = [
  'ironfist_player_locked',
  'ironfist_round_resolved',
  'ironfist_presence_changed',
  'ironfist_game_finished',
]

function unwrap(response) { return response?.data ?? response }

export class AuthoritativeIronFistGame {
  constructor({ gameId = '', view = null } = {}) {
    this.gameId = gameId
    this.view = view
    this._listeners = {}
    this._disposed = false
    this.transitions = createAuthoritativeTransitionCoordinator()
    this._boundEvent = payload => this._onServerEvent(payload)
    this.core = createAuthoritativeClientCore({
      view: view || {},
      submit: body => ironfistApi.submitAction(this.gameId, body).then(unwrap),
      refetch: () => ironfistApi.getGame(this.gameId).then(unwrap),
      apply: next => this._applyView(next),
    })
    for (const event of EVENT_TYPES) on(event, this._boundEvent)
  }

  on(event, callback) {
    ;(this._listeners[event] ||= []).push(callback)
    return () => { this._listeners[event] = (this._listeners[event] || []).filter(item => item !== callback) }
  }

  _emit(event, payload) {
    for (const callback of this._listeners[event] || []) callback(payload)
  }

  async startPVE(replace = false) {
    const view = unwrap(await ironfistApi.startPVESession(replace))
    this.gameId = view.game_id
    this.core.setView(view)
    this._applyView(view)
    return view
  }

  async resume(gameId = this.gameId) {
    this.gameId = gameId
    const view = unwrap(await ironfistApi.getGame(gameId))
    this.core.setView(view)
    this._applyView(view)
    return view
  }

  start() {
    if (this.view) this._applyView(this.view)
    else if (this.gameId) void this.resume(this.gameId)
  }

  async selectAction(action) {
    if (this._disposed || this.core.locked) return
    return this.core.submit(action)
  }

  async retryAction() { return this.core.retry() }

  confirmNextRound() {
    this._dispatchTransitions(this.transitions.confirmNextRound())
  }

  async resign() {
    const view = unwrap(await ironfistApi.resignGame(this.gameId))
    this.core.setView(view)
    this._applyView(view)
    return view
  }

  async _onServerEvent(payload) {
    if (this._disposed || payload?.game_id !== this.gameId) return
    await this.core.onEvent(payload)
    // Notifications are intentionally disposable and partial; MySQL state is
    // fetched before rendering any authoritative transition.
    const view = await this.resume(this.gameId)
    if (typeof payload?.connected !== 'boolean' || payload.seat === view.seat) return
    if (!payload.connected) {
      const deadline = Date.parse(view.opponent_reconnect_deadline || payload.reconnect_deadline)
      const serverTime = Date.parse(view.server_time)
      const timeoutMs = Number.isFinite(deadline) && Number.isFinite(serverTime)
        ? Math.max(0, deadline - serverTime)
        : 60_000
      this._emit('phase', 'waiting_reconnect')
      this._emit('opponent-disconnected', { timeoutMs })
      return
    }
    this._emit('phase', 'deciding')
    this._emit('round-resume', {
      round: view.current_round,
      startedAt: view.action_deadline ? Date.parse(view.action_deadline) - 30_000 : Date.parse(view.server_time),
    })
  }

  _applyView(view) {
    if (this._disposed || !view) return
    this.view = view
    this._dispatchTransitions(this.transitions.apply(view))
    if (view.my_locked && view.my_action) {
      this._emit('locked', { side: 'player', action: view.my_action })
      this._emit('phase', 'locked')
    }
  }

  _dispatchTransitions(events) {
    for (const event of events) this._emit(event.type, event.payload)
  }

  destroy() {
    this._disposed = true
    for (const event of EVENT_TYPES) off(event, this._boundEvent)
    this._listeners = {}
  }

  dispose() { this.destroy() }
}
