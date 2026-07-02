// 九州征途 - Phaser 实例工厂
// 仿 bomberman 的 createBombermanGame 模式：挂载到 DOM 容器，返回 Phaser.Game。
// GameState 由页面创建并传入，Vue UI 与场景共享同一逻辑实例。

import Phaser from 'phaser'
import { WorldScene } from './scenes/WorldScene.js'
import { UIScene } from './scenes/UIScene.js'

/**
 * @param {HTMLElement} container 挂载容器
 * @param {import('./core/GameState.js').GameState} state 逻辑层实例
 */
export function createSlgGame(container, state) {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: container,
    backgroundColor: '#1a2419',
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: '100%',
      height: '100%',
    },
    render: { antialias: true, pixelArt: false },
  })
  game.scene.add('World', WorldScene, true, { state })
  game.scene.add('UI', UIScene, true, { state })   // 后添加 → 渲染在上层
  return game
}
