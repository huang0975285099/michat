import PhaserConstants from 'phaser/src/const.js'
import ScaleModes from 'phaser/src/scale/const/SCALE_MODE_CONST.js'
import BootScene, { createBootScene } from '../scenes/BootScene.js'
import MapScene, { createMapScene } from '../scenes/MapScene.js'
import LevelScene, { createLevelScene } from '../scenes/LevelScene.js'
import OverlayScene, { createOverlayScene } from '../scenes/OverlayScene.js'
import TransitionScene, { createTransitionScene } from '../scenes/TransitionScene.js'

const defaultScenes = [BootScene, MapScene, LevelScene, OverlayScene, TransitionScene]
const sceneFactories = [createBootScene, createMapScene, createLevelScene, createOverlayScene, createTransitionScene]

export function createSugarPopConfig(parent, phaser) {
  const scenes = phaser?.Scene ? sceneFactories.map((createScene) => createScene(phaser.Scene)) : defaultScenes
  return {
    type: phaser?.AUTO ?? PhaserConstants.AUTO,
    parent,
    width: '100%',
    height: '100%',
    scale: {
      mode: phaser?.Scale?.RESIZE ?? ScaleModes.RESIZE,
      width: '100%',
      height: '100%',
    },
    audio: { noAudio: true },
    scene: scenes,
  }
}
