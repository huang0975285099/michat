import PhaserConstants from 'phaser/src/const.js'
import ScaleModes from 'phaser/src/scale/const/SCALE_MODE_CONST.js'
import BootScene from '../scenes/BootScene.js'
import MapScene from '../scenes/MapScene.js'
import LevelScene from '../scenes/LevelScene.js'
import OverlayScene from '../scenes/OverlayScene.js'
import TransitionScene from '../scenes/TransitionScene.js'

export function createSugarPopConfig(parent) {
  return {
    type: PhaserConstants.AUTO,
    parent,
    width: '100%',
    height: '100%',
    scale: {
      mode: ScaleModes.RESIZE,
      width: '100%',
      height: '100%',
    },
    audio: { noAudio: true },
    scene: [BootScene, MapScene, LevelScene, OverlayScene, TransitionScene],
  }
}
