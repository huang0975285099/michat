import assert from 'node:assert/strict'
import test from 'node:test'

import { matchedQueuePayload } from './pvp-match-recovery.mjs'

test('returns a navigation payload when polling discovers a match', () => {
  const payload = matchedQueuePayload({
    status: 'matched', room_id: 42, game_id: 'game-42', tier: 'gold', stake: 100,
    opponent: { chat_id: '1000-TEST' },
  })

  assert.deepEqual(payload, {
    roomId: 42, gameId: 'game-42', tier: 'gold', stake: 100,
    opponent: { chat_id: '1000-TEST' },
  })
})

test('does not navigate when cancellation review finds no match', () => {
  assert.equal(matchedQueuePayload({ status: 'idle' }), null)
})
