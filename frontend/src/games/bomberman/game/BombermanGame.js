import Phaser from 'phaser'
import GameScene from './scenes/GameScene.js'
import { CANVAS_W, CANVAS_H } from './GameConstants.js'

/**
 * Mount a Phaser Bomberman game into the given DOM element.
 * Returns the Phaser.Game instance.
 */
export function createBombermanGame(container, { isHost, seed, gameNet, onGameEnd }) {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: CANVAS_W,
    height: CANVAS_H,
    backgroundColor: '#1a1a2e',
    parent: container,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    // 不在此处注册 scene，避免 Phaser 自动启动（那样 init 收不到 data）
    audio: { noAudio: true },
  })

  // Phaser fires 'ready' once the renderer is initialised；
  // 手动 add scene 并 autoStart=true，第 4 个参数为传入 init() 的 data
  game.events.once('ready', () => {
    game.scene.add('GameScene', GameScene, true, { isHost, seed, gameNet, onGameEnd })
  })

  return game
}
