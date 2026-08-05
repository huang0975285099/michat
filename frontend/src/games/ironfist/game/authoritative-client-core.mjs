function defaultUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  throw new Error('crypto.randomUUID is required for authoritative actions')
}

export function createAuthoritativeClientCore({ view = {}, submit, refetch, uuid = defaultUUID, apply } = {}) {
  let currentView = view
  let pendingCommand = null
  let refetching = null

  const core = {
    get view() { return currentView },
    get locked() { return currentView?.my_locked === true },
    setView(next) { currentView = next || {} },
    async submit(action) {
      pendingCommand = {
        round: currentView.current_round,
        action,
        request_id: uuid(),
        expected_version: currentView.state_version,
      }
      const accepted = await submit(pendingCommand)
      currentView = accepted
      apply?.(accepted)
      return accepted
    },
    async retry() {
      if (!pendingCommand) throw new Error('no authoritative action to retry')
      const accepted = await submit(pendingCommand)
      currentView = accepted
      apply?.(accepted)
      return accepted
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
    gameResult: authorityOutcomeToLocal(round.outcome),
  }
}

export function authorityOutcomeToLocal(outcome) {
  return ({ win_a: 'win', win_b: 'lose', draw: 'draw', doubleLose: 'doubleLose' })[outcome] || null
}
