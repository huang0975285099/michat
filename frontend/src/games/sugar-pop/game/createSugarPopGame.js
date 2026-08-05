import Phaser from 'phaser'
import { createSugarPopConfig } from './sugarPopConfig.js'

export { createSugarPopConfig }

export function createSugarPopGame(container, { onReady } = {}) {
  const game = new Phaser.Game(createSugarPopConfig(container))
  if (onReady) game.events.once('ready', () => onReady(game))
  return game
}
