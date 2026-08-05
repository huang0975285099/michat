import assert from 'node:assert/strict'
import test from 'node:test'

import { ironFistAcceptCommand, ironFistReadyRoute } from './ironfist-invite-core.mjs'

test('IronFist accept sends no client seed', () => {
  assert.deepEqual(ironFistAcceptCommand('1111-AAAA', 'room-1'), {
    to: '1111-AAAA',
    room_id: 'room-1',
    game: 'ironfist',
  })
})

test('IronFist navigation waits for server game_ready and uses game id', () => {
  assert.deepEqual(
    ironFistReadyRoute({ game_id: 'game-1', opponent: '1111-AAAA', seat: 'b' }),
    {
      path: '/games/ironfist',
      query: { game_id: 'game-1', opponent: '1111-AAAA', seat: 'b' },
    },
  )
})
