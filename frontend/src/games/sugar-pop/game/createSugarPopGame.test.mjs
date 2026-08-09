import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import PhaserConstants from 'phaser/src/const.js'
import ScaleModes from 'phaser/src/scale/const/SCALE_MODE_CONST.js'
import BootScene from '../scenes/BootScene.js'
import MapScene from '../scenes/MapScene.js'
import LevelScene from '../scenes/LevelScene.js'
import OverlayScene from '../scenes/OverlayScene.js'
import TransitionScene from '../scenes/TransitionScene.js'
import { candyTextures } from '../assets/candies.js'

test('public createSugarPopGame module exposes the concrete Node-safe config', async () => {
  const { createSugarPopConfig } = await import('./createSugarPopGame.js')

  const config = createSugarPopConfig('sugar-pop-canvas')

  assert.equal(config.type, PhaserConstants.AUTO)
  assert.equal(config.parent, 'sugar-pop-canvas')
  assert.equal(config.scale.mode, ScaleModes.RESIZE)
  assert.equal(config.audio.noAudio, true)
  assert.equal(config.width, '100%')
  assert.equal(config.height, '100%')
  assert.deepEqual(config.scene, [BootScene, MapScene, LevelScene, OverlayScene, TransitionScene])
})

test('browser config builds every scene from the injected Phaser runtime', async () => {
  const { createSugarPopConfig } = await import('./createSugarPopGame.js')
  class RuntimeScene {}
  const runtime = { AUTO: 0, Scale: { RESIZE: 5 }, Scene: RuntimeScene }

  const config = createSugarPopConfig('sugar-pop-canvas', runtime)

  assert.equal(config.scene.length, 5)
  for (const SceneClass of config.scene) {
    assert.ok(SceneClass.prototype instanceof RuntimeScene)
  }
})

test('original SVG textures are valid Base64 sources for browser rasterization', () => {
  for (const data of Object.values(candyTextures)) {
    assert.match(data, /^data:image\/svg\+xml;base64,/)
    const svg = Buffer.from(data.split(',')[1], 'base64').toString('utf8')
    assert.match(svg, /^<svg [^>]*viewBox="0 0 100 100">/)
    assert.match(svg, /<\/svg>$/)
  }
})
