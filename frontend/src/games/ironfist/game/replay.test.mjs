import test from 'node:test'
import assert from 'node:assert/strict'
import { pairActionsByRound, replayGame } from './replay.js'

test('replay locks the first valid action from each player in a round', () => {
  const log = [
    { round: 1, action: 'attack', from: 'me' },
    { round: 1, action: 'charge', from: 'me' },
    { round: 1, action: 'defend', from: 'opponent' },
    { round: 1, action: 'counter', from: 'opponent' },
  ]
  assert.deepEqual(pairActionsByRound(log, 'me'), [{
    round: 1,
    playerAction: 'attack',
    opponentAction: 'defend',
    complete: true,
  }])
})

test('replay ignores invalid actions and out-of-range rounds', () => {
  const log = [
    { round: 0, action: 'attack', from: 'me' },
    { round: 1, action: 'hack', from: 'me' },
    { round: 21, action: 'defend', from: 'opponent' },
  ]
  assert.deepEqual(pairActionsByRound(log, 'me'), [])
  assert.equal(replayGame(log, 'me').completedRounds, 0)
})
