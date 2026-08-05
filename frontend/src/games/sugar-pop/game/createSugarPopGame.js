import Phaser from 'phaser'
import BootScene from '../scenes/BootScene.js'
import MapScene from '../scenes/MapScene.js'
import LevelScene from '../scenes/LevelScene.js'
import OverlayScene from '../scenes/OverlayScene.js'
import TransitionScene from '../scenes/TransitionScene.js'
import { createSugarPopConfig as buildSugarPopConfig } from './sugarPopConfig.js'

export function createSugarPopConfig(parent) {
  return buildSugarPopConfig(parent, Phaser, [
    BootScene,
    MapScene,
    LevelScene,
    OverlayScene,
    TransitionScene,
  ])
}

export function createSugarPopGame(container, { onReady } = {}) {
  const game = new Phaser.Game(createSugarPopConfig(container))
  if (onReady) game.events.once('ready', () => onReady(game))
  return game
}
