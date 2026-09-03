import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDragonTigerPayout, isValidDragonTigerAmount, phaseDeadline, shouldApplyDragonTigerEvent } from './dragon-tiger-core.mjs'

test('validates documented stake increments', () => {
  assert.equal(isValidDragonTigerAmount(20), true)
  assert.equal(isValidDragonTigerAmount(10_000), true)
  assert.equal(isValidDragonTigerAmount(19), false)
  assert.equal(isValidDragonTigerAmount(21), false)
})

test('calculates integer payouts', () => {
  assert.equal(calculateDragonTigerPayout(100, 'dragon'), 195)
  assert.equal(calculateDragonTigerPayout(20, 'tiger'), 39)
  assert.equal(calculateDragonTigerPayout(100, 'draw'), 800)
})

test('uses only the current phase deadline', () => {
  const round = { betting_ends_at: 'bet', battle_ends_at: 'battle', display_ends_at: 'display' }
  assert.equal(phaseDeadline({ ...round, status: 'betting' }), 'bet')
  assert.equal(phaseDeadline({ ...round, status: 'playing' }), 'battle')
  assert.equal(phaseDeadline({ ...round, status: 'settled' }), 'display')
  assert.equal(phaseDeadline({ ...round, status: 'locked' }), null)
})

test('drops stale websocket notifications', () => {
  const current = { id: 12, state_version: 4 }
  assert.equal(shouldApplyDragonTigerEvent(current, { round_id: 11, state_version: 99 }), false)
  assert.equal(shouldApplyDragonTigerEvent(current, { round_id: 12, state_version: 4 }), false)
  assert.equal(shouldApplyDragonTigerEvent(current, { round_id: 12, state_version: 5 }), true)
  assert.equal(shouldApplyDragonTigerEvent(current, { round_id: 13, state_version: 1 }), true)
})
