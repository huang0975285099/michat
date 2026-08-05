import test from 'node:test'
import assert from 'node:assert/strict'
import PhaserConstants from 'phaser/src/const.js'
import ScaleModes from 'phaser/src/scale/const/SCALE_MODE_CONST.js'
import BootScene from '../scenes/BootScene.js'
import MapScene from '../scenes/MapScene.js'
import LevelScene from '../scenes/LevelScene.js'
import OverlayScene from '../scenes/OverlayScene.js'
import TransitionScene from '../scenes/TransitionScene.js'

test('createSugarPopConfig returns a responsive no-audio config with concrete scenes', async () => {
  const { createSugarPopConfig } = await import('./sugarPopConfig.js')

  const config = createSugarPopConfig('sugar-pop-canvas')

  assert.equal(config.type, PhaserConstants.AUTO)
  assert.equal(config.parent, 'sugar-pop-canvas')
  assert.equal(config.scale.mode, ScaleModes.RESIZE)
  assert.equal(config.audio.noAudio, true)
  assert.equal(config.width, '100%')
  assert.equal(config.height, '100%')
  assert.deepEqual(config.scene, [BootScene, MapScene, LevelScene, OverlayScene, TransitionScene])
})
