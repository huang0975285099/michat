// 门派 PK · 梦幻西游风 - Phaser 实例工厂
// 仿 slg 的 createSlgGame 模式：挂载到 DOM 容器，返回 Phaser.Game。
// 仅自动启动 RaceSelectScene；选定种族→门派后由 SelectScene 启动 Battle + UI 场景。
// 场景间通过 game.registry 共享 BattleEngine 实例，通过 game.events 通信。

import Phaser from 'phaser'
import { RaceSelectScene } from './scenes/RaceSelectScene.js'
import { SelectScene } from './scenes/SelectScene.js'
import { BattleScene } from './scenes/BattleScene.js'
import { UIScene } from './scenes/UIScene.js'

/**
 * @param {HTMLElement} container 挂载容器
 * @param {object} [opts] 预留选项
 */
export function createMenpaiGame(container, opts = {}) {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: container,
    backgroundColor: '#1a1428',
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: '100%',
      height: '100%',
    },
    render: { antialias: true, pixelArt: false },
    disableVisibilityChange: true,
  })
  // 预注册四个场景，仅 RaceSelect 自动启动：
  // RaceSelect（选种族）→ Select（按种族过滤门派）→ Battle/UI（选定门派后 launch/start）
  game.scene.add('RaceSelect', RaceSelectScene, true, { ...opts })
  game.scene.add('Select', SelectScene, false)
  game.scene.add('Battle', BattleScene, false)
  game.scene.add('UI', UIScene, false)
  return game
}
