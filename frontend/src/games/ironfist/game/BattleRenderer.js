// 铁拳 - 二期 战斗渲染器工厂（Phaser）
// 仿 bomberman 的 createBombermanGame 模式：挂载到 DOM 容器，返回 Phaser.Game。
// RESIZE 缩放模式让 canvas 充满 arena-slot；场景就绪后回调返回 scene 句柄。

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

  // 'ready' 后手动 add scene（autoStart=true，第 4 参为 init() 数据）
  game.events.once('ready', () => {
    game.scene.add('BattleScene', BattleScene, true, { playerCharged, opponentCharged })
  })
  // 场景 create() 完成后回传句柄
  game.events.once('battle-ready', () => {
    onReady?.(game.scene.getScene('BattleScene'))
  })

  return game
}
