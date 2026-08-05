import assert from 'node:assert/strict'
import test from 'node:test'

import { engineKindForMode, requireAuthoritativeGameID } from './mode-routing.mjs'

test('only explicit practice mode may use the local engine', () => {
  assert.equal(engineKindForMode('practice'), 'local')
  for (const mode of ['pve', 'pvp', 'friend']) assert.equal(engineKindForMode(mode), 'authoritative')
})

test('rewarded and multiplayer modes reject a missing server game id', () => {
  assert.equal(requireAuthoritativeGameID('pve', 'game-123'), 'game-123')
  assert.throws(() => requireAuthoritativeGameID('pvp', ''), /server-issued game_id/)
  assert.equal(requireAuthoritativeGameID('practice', ''), '')
})
