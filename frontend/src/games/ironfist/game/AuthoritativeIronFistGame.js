import { ironfistApi } from 'src/services/api'
import { on, off } from 'src/services/websocket'
import {
  authorityOutcomeToLocal,
  createAuthoritativeClientCore,
  toPageState,
  toResolvedEvent,
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
    this._lastResolvedRound = 0
    this._lastAnnouncedRound = 0
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

  confirmNextRound() {}

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
    await this.resume(this.gameId)
  }

  _applyView(view) {
    if (this._disposed || !view) return
    this.view = view
    const pageState = toPageState(view)
    if (view.last_round?.round > this._lastResolvedRound) {
      this._lastResolvedRound = view.last_round.round
      this._emit('resolved', toResolvedEvent(view.last_round, view.seat))
    }
    if (view.status === 'completed' || view.status === 'abandoned' || view.status === 'cancelled') {
      this._emit('phase', 'game_over')
      this._emit('gameover', authorityOutcomeToLocal(view.outcome, view.seat) || (view.status === 'abandoned' ? 'lose' : 'draw'))
      return
    }
    if (view.current_round > this._lastAnnouncedRound) {
      this._lastAnnouncedRound = view.current_round
      this._emit('phase', 'round_start')
      this._emit('round-start', { round: view.current_round, state: pageState, startedAt: Date.parse(view.server_time) })
      this._emit('phase', 'deciding')
    }
    if (view.my_locked && view.my_action) {
      this._emit('locked', { side: 'player', action: view.my_action })
      this._emit('phase', 'locked')
    }
  }

  destroy() {
    this._disposed = true
    for (const event of EVENT_TYPES) off(event, this._boundEvent)
    this._listeners = {}
  }

  dispose() { this.destroy() }
}
