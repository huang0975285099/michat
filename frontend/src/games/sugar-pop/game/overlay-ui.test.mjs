import test from 'node:test'
import assert from 'node:assert/strict'
import { createLevelResult } from '../scenes/LevelScene.js'
import { createOverlayModel } from '../ui/OverlayView.js'
import { getHudControls } from '../ui/HudView.js'

test('lose overlay offers one recovery use only when extra moves are available', () => {
  assert.deepEqual(
    createOverlayModel('lose', { canUseExtraMoves: true }).actions.map(({ key }) => key),
    ['extraMoves', 'retry', 'map'],
  )
  assert.deepEqual(
    createOverlayModel('lose', { canUseExtraMoves: false }).actions.map(({ key }) => key),
    ['retry', 'map'],
  )
})

test('every overlay kind exposes a safe labeled action path', () => {
  assert.deepEqual(createOverlayModel('pause').actions.map(({ key }) => key), ['resume', 'retry', 'map'])
  assert.deepEqual(createOverlayModel('recover-save').actions.map(({ key }) => key), ['recover'])
  assert.deepEqual(createOverlayModel('win', { hasNextLevel: true }).actions.map(({ key }) => key), ['next', 'retry', 'map'])
  assert.deepEqual(createOverlayModel('win', { hasNextLevel: false }).actions.map(({ key }) => key), ['retry', 'map'])
})

test('HUD disables unavailable boosters and marks hammer selection mode', () => {
  const controls = getHudControls({ hammer: 1, shuffle: 0, extraMoves: 2 }, { extraMovesUsed: true, hammerSelecting: true })

  assert.deepEqual(controls.map(({ key, enabled, active }) => ({ key, enabled, active })), [
    { key: 'hammer', enabled: true, active: true },
    { key: 'shuffle', enabled: false, active: false },
    { key: 'extraMoves', enabled: false, active: false },
  ])
})

test('win result adds remaining-move bonus before calculating stars', () => {
  assert.deepEqual(createLevelResult(
    { score: 190, movesLeft: 3 },
    { id: 2, starScores: [200, 300, 400] },
  ), {
    levelId: 2,
    score: 340,
    stars: 2,
    movesLeft: 3,
    bonusScore: 150,
  })
})

test('a completed level earns at least one star below its first score threshold', () => {
  const result = createLevelResult(
    { score: 10, movesLeft: 0 },
    { id: 1, starScores: [200, 300, 400] },
  )

  assert.equal(result.stars, 1)
})
