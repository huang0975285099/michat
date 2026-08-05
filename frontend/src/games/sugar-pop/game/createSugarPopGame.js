import { createSugarPopConfig } from './sugarPopConfig.js'

export { createSugarPopConfig }

export function createSugarPopGame(container, { onReady, phaser } = {}) {
  if (!phaser) throw new Error('createSugarPopGame requires a Phaser runtime')

  const game = new phaser.Game(createSugarPopConfig(container))
  if (onReady) game.events.once('ready', () => onReady(game))
  return game
}
