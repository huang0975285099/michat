// Tekken - Phase 2 Combat Renderer Factory (Phaser)
// Imitate bomberman's createBombermanGame mode: mount to the DOM container and return Phaser.Game.
// RESIZE zoom mode makes the canvas fill arena-slot; the callback returns the scene handle after the scene is ready.

import Phaser from 'phaser'
import BattleScene from './scenes/BattleScene.js'

export function createBattleRenderer(container, { playerCharged = false, opponentCharged = false, onReady } = {}) {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: container,
    backgroundColor: '#0e0a1e',
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: '100%',
      height: '100%',
    },
    audio: { noAudio: true },
  })

  // Manually add scene after 'ready' (autoStart=true, the 4th parameter is init() data)
  game.events.once('ready', () => {
    game.scene.add('BattleScene', BattleScene, true, { playerCharged, opponentCharged })
  })
  // Scenario create() returns the handle after completion
  game.events.once('battle-ready', () => {
    onReady?.(game.scene.getScene('BattleScene'))
  })

  return game
}
