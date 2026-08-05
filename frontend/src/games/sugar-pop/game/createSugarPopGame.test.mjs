import test from 'node:test'
import assert from 'node:assert/strict'

test('createSugarPopConfig returns a responsive no-audio config with every scene', async () => {
  const { createSugarPopConfig } = await import('./sugarPopConfig.js')

  const scenes = ['BootScene', 'MapScene', 'LevelScene', 'OverlayScene', 'TransitionScene']
  const config = createSugarPopConfig(
    'sugar-pop-canvas',
    { AUTO: 'auto-renderer', Scale: { RESIZE: 'responsive-scale' } },
    scenes
  )

  assert.equal(config.type, 'auto-renderer')
  assert.equal(config.parent, 'sugar-pop-canvas')
  assert.equal(config.scale.mode, 'responsive-scale')
  assert.equal(config.audio.noAudio, true)
  assert.equal(config.width, '100%')
  assert.equal(config.height, '100%')
  assert.deepEqual(config.scene, scenes)
})
