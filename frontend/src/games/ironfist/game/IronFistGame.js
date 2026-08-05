// IronFist local practice engine only.
// Trusted PvE/PvP/friend games must use AuthoritativeIronFistGame and the server API.
// The rendering layer/UI subscribes to event-driven animation through on(event, cb) and does not directly read the internal state.
// See docs/ironfist.md Section 13/15 (Decoupling logic and rendering)

import { PHASE, ACTION, ACTIONS, MAX_ROUNDS, OPPONENT_GRACE_MS, RECONNECT_WINDOW_MS, LS_PENDING_KEY, LS_ROUND_KEY } from './GameConstants.js'
import { resolveRound, initialState } from './resolve.js'
import { aiDecide, trackAiHistory } from './GameAI.js'
import { replayGame } from './replay.js'

export class IronFistGame {
  /**
   * @param {object} opts
   * @param {'pve'|'pvp'} opts.mode
   * @param {object} [opts.net] PvP network layer (GameNet instance), requires on/send
   * @param {string} [opts.roomId] Legacy practice identifier; never used for trusted settlement.
   * @param {string} [opts.myChatId] PvP’s own chat_id (used to distinguish the actions of both parties during replay)
   */
  constructor({ mode = 'pve', net = null, roomId = null, myChatId = null } = {}) {
    this.mode = mode
    this.net = net
    this.roomId = roomId
    this.myChatId = myChatId
    this.state = initialState()
    this.phase = PHASE.ROUND_START
    this.round = 0
    this.lastResult = null

    this._myAction = null
    this._oppAction = null
    this._aiHistory = { consecutiveChargeInterrupted: 0 }
    this._counterSuccesses = 0 //The number of successful counterattacks in this game (used for the "Counterattack Master" achievement)
    this._pendingOppByRound = new Map() //PvP: The opponent's actions that arrive early are temporarily saved by round.
    this._listeners = {}
    this._disposed = false
    this._graceTimer = null             //PvP: Grace timer to wait for the opponent's action after making a move
    this._reconnectTimer = null         //PvP: timer to wait for reconnection after the opponent disconnects (60s)
    this._roundStartedAt = 0            //This round’s DECIDING start timestamp (local clock), used for countdown anchoring and reconnection recovery

    if (this.mode === 'pve') this._opponentName = 'AI'

    if (this.net) {
      this.net.on('ironfist_action', (p) => this._onNetAction(p))
      this.net.on('ironfist_replay', (p) => this._onReplay(p))
      this.net.on('game_resign', () => {
        if (this.phase === PHASE.GAME_OVER) return
        this._clearGrace()
        this._clearReconnectTimer()
        this._setPhase(PHASE.GAME_OVER) //Stop the local countdown/selectAction to avoid being able to operate after the game is over
        this._emit('gameover', 'win')
      })
    }
  }

  // ──Events────────────────────────────────────────────────────────
  on(event, cb) {
    (this._listeners[event] ||= []).push(cb)
    return () => {
      this._listeners[event] = (this._listeners[event] || []).filter((f) => f !== cb)
    }
  }

  _emit(event, payload) {
    ;(this._listeners[event] || []).forEach((cb) => cb(payload))
  }

  _setPhase(phase) {
    this.phase = phase
    this._emit('phase', phase)
  }

  // ──Process ──────────────────────────────────────────────────────────
  start() {
    this._startRound()
  }

  _startRound() {
    if (this._disposed) return
    this.round += 1
    this._myAction = null
    this._oppAction = null
    // Anchor the DECIDING start time of this round (local clock). This is where the round actually starts, a new timestamp is recorded and persisted,
    // This is so that the countdown can be resumed after the local client refreshes and reconnects, instead of getting a new 30s.
    this._markRoundStart(Date.now())
    this._setPhase(PHASE.ROUND_START)
    this._emit('round-start', { round: this.round, state: { ...this.state }, startedAt: this._roundStartedAt })
    this._setPhase(PHASE.DECIDING)

    // PvP: If the opponent's action has arrived in advance, take it immediately
    const buffered = this._pendingOppByRound.get(this.round)
    if (buffered) {
      this._pendingOppByRound.delete(this.round)
      this._oppAction = buffered
    }
  }

  /** Local player selects actions (valid during DECIDING phase). The timeout is determined by the UI calling selectAction('defend'). */
  selectAction(action) {
    if (this.phase !== PHASE.DECIDING || this._myAction || !ACTIONS.includes(action)) return
    this._myAction = action
    this._emit('locked', { side: 'player', action })

    if (this.mode === 'pvp' && this.net) {
    // Legacy local persistence is retained only for old practice/replay callers.
      if (this.roomId) {
        try {
          localStorage.setItem(LS_PENDING_KEY(this.roomId), JSON.stringify({
            round: this.round,
            action,
            ts: Date.now(),
          }))
        } catch { /* Downgrade when localStorage is unavailable: rely only on server-side action flow */ }
      }
      this.net.send('ironfist_action', { round: this.round, action, ts: Date.now() })
    } else if (this.mode === 'pve') {
      // AI instant decision-making (simulating simultaneous choices)
      this._oppAction = aiDecide(
        { hp: this.state.opponentHP, charged: this.state.opponentCharged },
        { hp: this.state.playerHP, charged: this.state.playerCharged },
        this._aiHistory,
      )
    }

    if (this._oppAction) {
      this._resolve()
    } else {
      this._setPhase(PHASE.LOCKED) //Wait for each other (PvP)
      if (this.mode === 'pvp') this._startGrace()
    }
  }

  // Legacy local replay behavior. This class is not used for authoritative online games.
  // Enter WAITING_RECONNECT to wait for reconnection (60s) instead of directly interrupting the game.
  // Once PVP starts, there must be a result. If there is no reconnection within 60 seconds → the opponent will be judged as a loser (your side wins).
  _startGrace() {
    this._clearGrace()
    this._graceTimer = setTimeout(() => {
      if (this._disposed || this.phase !== PHASE.LOCKED) return
      this._setPhase(PHASE.WAITING_RECONNECT)
      this._emit('opponent-disconnected', { timeoutMs: RECONNECT_WINDOW_MS })
      this._startReconnectWait()
    }, OPPONENT_GRACE_MS)
  }

  _clearGrace() {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null }
  }

  // 60s reconnection window: The other party does not reconnect → the other party loses (our side wins).
  // During this period, "giving up and waiting to admit defeat" is not allowed. You must wait for the window to be full or the other party to reconnect (PVP must have a result).
  _startReconnectWait() {
    this._clearReconnectTimer()
    this._reconnectTimer = setTimeout(() => {
      if (this._disposed || this.phase !== PHASE.WAITING_RECONNECT) return
      this._setPhase(PHASE.GAME_OVER)
      this._emit('gameover', 'win') //The opponent loses
    }, RECONNECT_WINDOW_MS)
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
  }

  _onNetAction(payload) {
    if (this._disposed) return
    // The game is over: discard any subsequent actions to avoid re-settlement and overturning the determined result.
    // (After the 60s reconnection window times out and is judged as a loss, the opponent’s delayed reconnection reissue action will be intercepted here)
    if (this.phase === PHASE.GAME_OVER) return
    const { round, action } = payload
    if (!Number.isInteger(round) || round < 1 || round > MAX_ROUNDS) return
    if (!ACTIONS.includes(action)) return

    // Received any message from the other party = The other party has reconnected (if in WAITING_RECONNECT)
    if (this.phase === PHASE.WAITING_RECONNECT) {
      this._clearReconnectTimer()
      this._clearGrace()
    }

    // Discard expired/abnormal future actions to avoid unbounded growth of _pendingOppByRound (memory leak fix)
    if (round < this.round) return
    if (round > this.round + 1) return

    if (round !== this.round) {
      // The actions of the next round that arrive early are temporarily stored.
      this._pendingOppByRound.set(round, action)
      return
    }
    // Each side's first legal action of each round is locked. The backend also performs atomic idempotent checks; this is defense in depth,
    // Avoiding old server or abnormal replay allows messages sent later in the same round to overwrite already received actions.
    if (this._oppAction) return
    this._oppAction = action
    if (this._myAction) {
      this._resolve()
    } else {
      // The other party has chosen, but I haven’t chosen yet → Return to DECIDING and let me continue to choose.
      // Carry an anchored start time of the round to avoid the UI resetting the countdown to a new 30s (especially if the opponent moves first).
      this._setPhase(PHASE.DECIDING)
      this._emit('round-resume', { round: this.round, startedAt: this._roundStartedAt })
    }
  }

  /**
   * Consume a legacy replay payload for local practice recovery.
   * Use replayGame to replay the current state and return to the interrupted round.
   */
  _onReplay(payload) {
    if (this._disposed) return
    const { actions } = payload
    if (!this.myChatId) {
      console.warn('[IronFistGame] loadReplay need myChatId To distinguish the actions of both parties')
      return
    }
    this.loadReplay(actions, this.myChatId)
  }

  /**
   * Replay and restore state from action history. For _onReplay to be called internally or actively called externally.
   * See docs/ironfist.md for details, Section 14 Plan B.
   */
  loadReplay(actionLog, myChatId) {
    this._clearGrace()
    this._clearReconnectTimer()

    const {
      state, lastResult, completedRounds,
      pendingRound, pendingPlayerAction, pendingOpponentAction,
      counterSuccesses, history,
    } = replayGame(actionLog, myChatId)

    this.state = state
    // Restore turn-level derived data: recalculate the number of counterattack successes and turn-by-turn history when replaying a completed turn,
    // Otherwise, _counterSuccesses will be reset to zero after reconnection (the "Counterattack Master" achievement will be missed), and UI moveHistory will be missing.
    this._counterSuccesses = counterSuccesses
    if (history.length) this._emit('replay-history', history)

    if (lastResult?.gameResult) {
      // The game has ended during replay (the winner is determined in the last round)
      this.lastResult = lastResult
      this.round = completedRounds
      this._setPhase(PHASE.GAME_OVER)
      this._emit('resolved', lastResult)
      this._emit('gameover', lastResult.gameResult)
      return
    }

    if (pendingRound != null) {
      // This round is in progress (both sides have not completed their actions)
      this.round = pendingRound
      this._myAction = pendingPlayerAction
      this._oppAction = pendingOpponentAction

      // localStorage: If the server does not receive my action this round (it did not send it out before going offline),
      // Recover from local (resends are handled by the notification logic below to avoid repeated sending)
      if (!this._myAction && this.roomId) {
        try {
          const saved = JSON.parse(localStorage.getItem(LS_PENDING_KEY(this.roomId)) || 'null')
          if (saved && saved.round === this.round) {
            this._myAction = saved.action
          }
        } catch { /* ignore */ }
      }

      // After the reconnection is restored, notify the opponent: Resend the selected actions of this round and let the opponent recover from WAITING_RECONNECT.
      // Otherwise, the other party is still in WAITING_RECONNECT and will only temporarily store and not restore the subsequent round action, resulting in a deadlock.
      if (this._myAction && this.mode === 'pvp' && this.net) {
        this.net.send('ironfist_action', { round: this.round, action: this._myAction, ts: Date.now() })
      }

      if (this._myAction && this._oppAction) {
        // Both parties have chosen (extreme: both parties are offline but the server has actions on both sides), direct settlement
        this._resolve()
      } else if (this._myAction) {
        // I have chosen, waiting for the other party
        this._setPhase(PHASE.LOCKED)
        this._emit('locked', { side: 'player', action: this._myAction })
        // The other party may also be offline, activate grace
        if (this.mode === 'pvp') this._startGrace()
      } else {
        // The other party has chosen to wait for me/no one has chosen → Enter decision-making.
        // The round has started before refreshing: the persistence starting timestamp is restored, and the countdown is continued based on the actual elapsed time.
        // No new information will be issued for 30s (if it cannot be retrieved, it will fall back to now).
        const startedAt = this._restoreRoundStart(this.round)
        this._setPhase(PHASE.DECIDING)
        this._emit('round-start', { round: this.round, state: { ...this.state }, startedAt })
      }
    } else {
      // There is no round in progress, all selected actions have been resolved, and the next round begins
      // Align the round counter first (completedRounds is the last settled round number)
      this.round = completedRounds
      this._myAction = null
      this._oppAction = null
      this._startRound()
    }
  }

  /**
   * Actively request reconnection (uncompleted game call detected when the page is mounted).
   * The server returns ironfist_replay and is processed by _onReplay.
   */
  requestReconnect() {
    if (this.mode !== 'pvp' || !this.net) return
    this.net.send('ironfist_reconnect', { last_round: this.round })
  }

  _resolve() {
    if (this.phase === PHASE.RESOLVING || this.phase === PHASE.WAITING_CONFIRM || this.phase === PHASE.GAME_OVER) return
    this._clearGrace()
    this._setPhase(PHASE.RESOLVING)

    const myAction = this._myAction
    const oppAction = this._oppAction
    const result = resolveRound(myAction, oppAction, this.state)

    // PvE: Tracking AI charge interruption history
    if (this.mode === 'pve') {
      const aiInterrupted = oppAction === ACTION.CHARGE && result.opponentDmg > 0
      trackAiHistory(this._aiHistory, oppAction, aiInterrupted)
    }

    // Track the success of your own counterattack (counter vs attack = counterattack hit), used for the "Counterattack Master" achievement
    if (myAction === ACTION.COUNTER && oppAction === ACTION.ATTACK) {
      this._counterSuccesses += 1
    }

    // Submit new status
    this.state = {
      playerHP: result.playerHP,
      opponentHP: result.opponentHP,
      playerCharged: result.playerCharged,
      opponentCharged: result.opponentCharged,
      playerChargeUnused: result.playerChargeUnused,
      opponentChargeUnused: result.opponentChargeUnused,
      consecutiveNoDamageRounds: result.consecutiveNoDamageRounds,
      totalRounds: result.totalRounds,
      bothChargedStalemate: result.bothChargedStalemate,
    }
    this.lastResult = result
    this._emit('resolved', result)
    this._setPhase(PHASE.WAITING_CONFIRM)
  }

  /** The player clicks "Next Round", or confirm is called automatically after timeout. */
  confirmNextRound() {
    if (this.phase !== PHASE.WAITING_CONFIRM) return
    if (this.lastResult?.gameResult) {
      this._setPhase(PHASE.GAME_OVER)
      this._clearPendingAction()
      this._emit('gameover', this.lastResult.gameResult)
    } else {
      this._startRound()
    }
  }

  /**
   * Return the local practice summary. Trusted results are produced by the server.
   * Excludes result: result is provided by the gameover event callback parameter (in scenarios such as admitting defeat/timeout judgment, etc.
   * lastResult.gameResult is unreliable).
   */
  getMatchSummary() {
    return {
      playerHP: this.state.playerHP,
      counterSuccesses: this._counterSuccesses,
      rounds: this.state.totalRounds,
    }
  }

  resign() {
    if (this.mode === 'pvp' && this.net) this.net.send('game_resign', { room_id: this.roomId })
    this._clearGrace()
    this._clearReconnectTimer()
    this._clearPendingAction()
    this._setPhase(PHASE.GAME_OVER)
    this._emit('gameover', 'lose')
  }

  /** Clean up the pending action of this room in localStorage (called when the game ends/admits defeat). */
  _clearPendingAction() {
    if (!this.roomId) return
    try {
      localStorage.removeItem(LS_PENDING_KEY(this.roomId))
      localStorage.removeItem(LS_ROUND_KEY(this.roomId))
    } catch { /* ignore */ }
  }

  /** Record the DECIDING start timestamp of this round and persist it (PvP) to support countdown recovery after refresh and reconnection. */
  _markRoundStart(ts) {
    this._roundStartedAt = ts
    if (this.mode !== 'pvp' || !this.roomId) return
    try {
      localStorage.setItem(LS_ROUND_KEY(this.roomId), JSON.stringify({ round: this.round, ts }))
    } catch { /* Downgrade when localStorage is unavailable: reconnect and fall back to a new countdown */ }
  }

  /**
   * Read the persistent start timestamp of this round. Valid only if the stored round is consistent with the target round,
   * Used to refresh the countdown for reconnection recovery "round in progress" (the local end has the same clock, no cross-end clock drift).
   * If it cannot be obtained, it will return to now, so that the reconnecting party will return to a new countdown (not better but not worse).
   */
  _restoreRoundStart(round) {
    if (this.roomId) {
      try {
        const saved = JSON.parse(localStorage.getItem(LS_ROUND_KEY(this.roomId)) || 'null')
        if (saved && saved.round === round && Number.isFinite(saved.ts)) {
          this._roundStartedAt = saved.ts
          return saved.ts
        }
      } catch { /* ignore */ }
    }
    this._roundStartedAt = Date.now()
    return this._roundStartedAt
  }

  dispose() {
    this._disposed = true
    this._clearGrace()
    this._clearReconnectTimer()
    this._listeners = {}
    this._pendingOppByRound.clear()
  }
}
