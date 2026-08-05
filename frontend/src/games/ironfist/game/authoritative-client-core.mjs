function defaultUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  throw new Error('crypto.randomUUID is required for authoritative actions')
}

export function createAuthoritativeClientCore({ view = {}, submit, refetch, uuid = defaultUUID, apply } = {}) {
  let currentView = view
  let pendingCommand = null
  let submitting = null
  let refetching = null

  function dispatchPending() {
    if (submitting) return submitting
    submitting = Promise.resolve(submit(pendingCommand)).then(accepted => {
      currentView = accepted
      apply?.(accepted)
      return accepted
    }).catch(async error => {
      if (error?.response?.status !== 409 || !refetch) throw error
      const latest = await refetch()
      currentView = latest || currentView
      apply?.(currentView)
      return currentView
    }).finally(() => { submitting = null })
    return submitting
  }

  const core = {
    get view() { return currentView },
    get locked() { return currentView?.my_locked === true },
    setView(next) { currentView = next || {} },
    async submit(action) {
      if (submitting) return submitting
      pendingCommand = {
        round: currentView.current_round,
        action,
        request_id: uuid(),
        expected_version: currentView.state_version,
      }
      return dispatchPending()
    },
    async retry() {
      if (!pendingCommand) throw new Error('no authoritative action to retry')
      return dispatchPending()
    },
    async onEvent(event) {
      const version = Number(event?.state_version || 0)
      const currentVersion = Number(currentView?.state_version || 0)
      if (version <= currentVersion) return 'ignored'
      if (version > currentVersion + 1) {
        if (!refetching) {
          refetching = Promise.resolve(refetch()).then(next => {
            currentView = next || currentView
            apply?.(currentView)
          }).finally(() => { refetching = null })
        }
        await refetching
        return 'refetched'
      }
      currentView = { ...currentView, ...event, state_version: version }
      apply?.(currentView)
      return 'applied'
    },
  }
  return core
}

export function createAuthoritativeTransitionCoordinator() {
  let lastResolvedRound = 0
  let lastAnnouncedRound = 0
  let pendingNextRoundView = null

  function announceRound(view) {
    if (!view || view.current_round <= lastAnnouncedRound) return []
    lastAnnouncedRound = view.current_round
    return [
      { type: 'phase', payload: 'round_start' },
      {
        type: 'round-start',
        payload: {
          round: view.current_round,
          state: toPageState(view),
          startedAt: Number.isFinite(Date.parse(view.action_deadline))
            ? Date.parse(view.action_deadline) - 30_000
            : Date.parse(view.server_time),
        },
      },
      { type: 'phase', payload: 'deciding' },
    ]
  }

  return {
    apply(view) {
      if (!view) return []
      const events = []
      if (view.last_round?.round > lastResolvedRound) {
        lastResolvedRound = view.last_round.round
        events.push(
          { type: 'phase', payload: 'resolving' },
          { type: 'resolved', payload: toResolvedEvent(view.last_round, view.seat) },
        )
        if (view.status === 'active') pendingNextRoundView = view
      }
      if (view.status === 'completed' || view.status === 'abandoned' || view.status === 'cancelled') {
        pendingNextRoundView = null
        events.push(
          { type: 'phase', payload: 'game_over' },
          {
            type: 'gameover',
            payload: authorityOutcomeToLocal(view.outcome, view.seat) || (view.status === 'abandoned' ? 'lose' : 'draw'),
          },
        )
        return events
      }
      if (pendingNextRoundView) {
        pendingNextRoundView = view
        return events
      }
      return events.concat(announceRound(view))
    },
    confirmNextRound() {
      const view = pendingNextRoundView
      pendingNextRoundView = null
      return announceRound(view)
    },
  }
}

export function toPageState(view = {}) {
  const neutral = view.state || {}
  const seatB = view.seat === 'b'
  return {
    playerHP: seatB ? neutral.hp_b : neutral.hp_a,
    opponentHP: seatB ? neutral.hp_a : neutral.hp_b,
    playerCharged: seatB ? neutral.charged_b : neutral.charged_a,
    opponentCharged: seatB ? neutral.charged_a : neutral.charged_b,
    playerChargeUnused: seatB ? neutral.charge_unused_b : neutral.charge_unused_a,
    opponentChargeUnused: seatB ? neutral.charge_unused_a : neutral.charge_unused_b,
    consecutiveNoDamageRounds: neutral.consecutive_no_damage_rounds,
    totalRounds: neutral.total_rounds,
    bothChargedStalemate: neutral.both_charged_stalemate,
    opponentReconnectDeadline: view.opponent_reconnect_deadline || null,
    myAction: view.my_action || null,
    opponentLocked: view.opponent_locked === true,
    opponentAction: null,
  }
}

export function secondsRemaining(view = {}, now = null) {
  if (!view.action_deadline) return 0
  const base = now == null ? Date.parse(view.server_time) : now
  return Math.max(0, Math.ceil((Date.parse(view.action_deadline) - base) / 1000))
}

export function toResolvedEvent(round = {}, seat = 'a') {
  const state = round.state || {}
  const seatB = seat === 'b'
  return {
    round: round.round,
    playerAction: round.my_action,
    opponentAction: round.opponent_action,
    playerDmg: round.damage_to_me,
    opponentDmg: round.damage_to_opponent,
    envDmg: round.environment_damage,
    playerHP: seatB ? state.hp_b : state.hp_a,
    opponentHP: seatB ? state.hp_a : state.hp_b,
    playerCharged: seatB ? state.charged_b : state.charged_a,
    opponentCharged: seatB ? state.charged_a : state.charged_b,
    gameResult: authorityOutcomeToLocal(round.outcome, seat),
  }
}

export function authorityOutcomeToLocal(outcome, seat = 'a') {
  if (outcome === 'win_a') return seat === 'b' ? 'lose' : 'win'
  if (outcome === 'win_b') return seat === 'b' ? 'win' : 'lose'
  return ({ draw: 'draw', doubleLose: 'doubleLose' })[outcome] || null
}
