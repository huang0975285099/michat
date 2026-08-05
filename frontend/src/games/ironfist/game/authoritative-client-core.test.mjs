import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorityOutcomeToLocal,
  createAuthoritativeClientCore,
  secondsRemaining,
  toPageState,
  toResolvedEvent,
} from './authoritative-client-core.mjs'

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

test('never exposes an unresolved opponent action', () => {
  assert.equal(toPageState({ opponent_locked: true, opponent_action: 'counter' }).opponentAction, null)
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
