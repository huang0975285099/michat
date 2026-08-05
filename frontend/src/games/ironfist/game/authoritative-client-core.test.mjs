import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorityOutcomeToLocal,
  createAuthoritativeTransitionCoordinator,
  createAuthoritativeClientCore,
  secondsRemaining,
  toPageState,
  toResolvedEvent,
} from './authoritative-client-core.mjs'

test('holds the next round until the resolved animation is confirmed', () => {
  const transitions = createAuthoritativeTransitionCoordinator()
  const initial = transitions.apply({
    current_round: 1, state_version: 0, status: 'active', seat: 'a',
    server_time: '2026-08-04T00:00:00Z', state: { hp_a: 100, hp_b: 100 },
  })
  assert.deepEqual(initial.map(event => event.type), ['phase', 'round-start', 'phase'])

  const resolved = transitions.apply({
    current_round: 2, state_version: 1, status: 'active', seat: 'a',
    server_time: '2026-08-04T00:00:01Z', state: { hp_a: 100, hp_b: 95 },
    last_round: {
      round: 1, my_action: 'attack', opponent_action: 'defend',
      damage_to_me: 0, damage_to_opponent: 5, environment_damage: 0,
      state: { hp_a: 100, hp_b: 95 }, outcome: '',
    },
  })
  assert.deepEqual(resolved.map(event => event.type), ['phase', 'resolved'])

  const confirmed = transitions.confirmNextRound()
  assert.deepEqual(confirmed.map(event => event.type), ['phase', 'round-start', 'phase'])
  assert.equal(confirmed[1].payload.round, 2)
})

test('uses the authoritative deadline to restore a reconnected round timer', () => {
  const transitions = createAuthoritativeTransitionCoordinator()
  const events = transitions.apply({
    current_round: 4, state_version: 9, status: 'active', seat: 'a',
    server_time: '2026-08-04T00:00:20Z',
    action_deadline: '2026-08-04T00:00:29Z',
    state: { hp_a: 100, hp_b: 100 },
  })

  assert.equal(events[1].payload.startedAt, Date.parse('2026-08-03T23:59:59Z'))
})

test('translates outcomes from the current player seat', () => {
  assert.equal(authorityOutcomeToLocal('win_a', 'a'), 'win')
  assert.equal(authorityOutcomeToLocal('win_a', 'b'), 'lose')
  assert.equal(authorityOutcomeToLocal('win_b', 'a'), 'lose')
  assert.equal(authorityOutcomeToLocal('win_b', 'b'), 'win')
})

test('discards old events and refetches on a version gap', async () => {
  const calls = []
  const core = createAuthoritativeClientCore({
    view: { state_version: 4, current_round: 2 },
    refetch: async () => { calls.push('refetch'); return { state_version: 6, current_round: 3 } },
  })
  await core.onEvent({ state_version: 3 })
  await core.onEvent({ state_version: 6 })
  assert.deepEqual(calls, ['refetch'])
})

test('locks only after HTTP acceptance and reuses request id on retry', async () => {
  const sent = []
  let release
  const core = createAuthoritativeClientCore({
    view: { state_version: 1, current_round: 1 },
    uuid: () => '6e7060d4-0c83-49fc-815a-800ad3b84a2e',
    submit: async (body) => {
      sent.push(body)
      if (sent.length === 1) await new Promise(resolve => { release = resolve })
      return { state_version: 1, current_round: 1, my_locked: true, my_action: 'attack' }
    },
  })
  const pending = core.submit('attack')
  assert.equal(core.locked, false)
  release()
  await pending
  assert.equal(core.locked, true)
  await core.retry()
  assert.equal(sent[0].request_id, sent[1].request_id)
})

test('coalesces rapid action clicks while the first submission is pending', async () => {
  const sent = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const accepted = { state_version: 2, current_round: 2, my_locked: false }
  const core = createAuthoritativeClientCore({
    view: { state_version: 1, current_round: 1 },
    uuid: () => '6e7060d4-0c83-49fc-815a-800ad3b84a2e',
    submit: async body => { sent.push(body); await gate; return accepted },
  })

  const first = core.submit('attack')
  const second = core.submit('counter')
  release()
  const results = await Promise.all([first, second])

  assert.equal(sent.length, 1)
  assert.deepEqual(results, [accepted, accepted])
})

test('refetches authoritative state when an action loses a deadline race', async () => {
  const applied = []
  const latest = { state_version: 2, current_round: 2, my_locked: false }
  const conflict = Object.assign(new Error('stale state'), { response: { status: 409 } })
  const core = createAuthoritativeClientCore({
    view: { state_version: 1, current_round: 1 },
    uuid: () => '6e7060d4-0c83-49fc-815a-800ad3b84a2e',
    submit: async () => { throw conflict },
    refetch: async () => latest,
    apply: view => applied.push(view),
  })

  const result = await core.submit('attack')

  assert.deepEqual(result, latest)
  assert.deepEqual(core.view, latest)
  assert.deepEqual(applied, [latest])
})

test('never exposes an unresolved opponent action', () => {
  assert.equal(toPageState({ opponent_locked: true, opponent_action: 'counter' }).opponentAction, null)
})

test('preserves the opponent reconnect deadline for the battle adapter', () => {
  const deadline = '2026-08-04T00:01:00Z'
  assert.equal(toPageState({ opponent_reconnect_deadline: deadline }).opponentReconnectDeadline, deadline)
})

test('uses server time to derive deadline countdown', () => {
  assert.equal(secondsRemaining({ server_time: '2026-08-04T00:00:10Z', action_deadline: '2026-08-04T00:00:25Z' }), 15)
})

test('translates a resolved round literally', () => {
  assert.deepEqual(toResolvedEvent({
    round: 3, my_action: 'attack', opponent_action: 'defend',
    damage_to_me: 0, damage_to_opponent: 5, environment_damage: 0,
    state: { hp_a: 90, hp_b: 80, charged_a: false, charged_b: true }, outcome: '',
  }), {
    round: 3, playerAction: 'attack', opponentAction: 'defend',
    playerDmg: 0, opponentDmg: 5, envDmg: 0,
    playerHP: 90, opponentHP: 80, gameResult: null,
    playerCharged: false, opponentCharged: true,
  })
})
