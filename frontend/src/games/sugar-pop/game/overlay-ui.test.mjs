import test from 'node:test'
import assert from 'node:assert/strict'
import { createLevelResult } from '../scenes/LevelScene.js'
import TransitionScene from '../scenes/TransitionScene.js'
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

test('win result calculates stars from score already earned by bonus waves', () => {
  assert.deepEqual(createLevelResult(
    { score: 340, movesLeft: 0, bonusMoves: 3, bonusScore: 150 },
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

test('an active bonus transition re-centers its Phaser objects after resize', () => {
  const positions = {}
  const scene = {
    root: {},
    glow: {
      setPosition: (x, y) => { positions.glow = [x, y]; return scene.glow },
      setDisplaySize: (width, height) => { positions.glowSize = [width, height]; return scene.glow },
    },
    title: {
      setPosition: (x, y) => { positions.title = [x, y]; return scene.title },
      setFontSize: (size) => { positions.titleFontSize = size; return scene.title },
    },
    counter: { setPosition: (x, y) => { positions.counter = [x, y]; return scene.counter } },
  }

  TransitionScene.prototype.handleResize?.call(scene, { width: 390, height: 844 })

  assert.deepEqual(positions, {
    glow: [195, 422],
    glowSize: [390, 844],
    title: [195, 388],
    titleFontSize: 39,
    counter: [195, 456],
  })
})

test('transition scene unregisters its resize listener on shutdown', () => {
  const events = []
  const scene = {
    scale: {
      on: (name, handler, context) => events.push(['on', name, handler, context]),
      off: (name, handler, context) => events.push(['off', name, handler, context]),
    },
    events: { once: (name, handler, context) => events.push(['once', name, handler, context]) },
    handleResize() {},
  }

  TransitionScene.prototype.create?.call(scene)
  TransitionScene.prototype.shutdown?.call(scene)

  assert.deepEqual(events.map(([operation, name]) => [operation, name]), [
    ['on', 'resize'],
    ['once', 'shutdown'],
    ['off', 'resize'],
  ])
})
