// 门派 PK · 梦幻西游风 - 开战准备
// SelectScene（首次开战）与 BattleScene（再战一局）共用，保证两条路径构造出的
// BattleEngine 完全一致：等级换算属性、敌方门派随机、敌方等级跟随玩家 ±1。

import Phaser from 'phaser'
import { FACTIONS } from './factions.js'
import { BattleEngine } from './BattleEngine.js'
import { computeStats, rollEnemyLevel } from './leveling.js'

/**
 * 构造新一局战斗并写入 registry。
 * @param {Phaser.Game} game
 * @param {object} playerFaction
 * @returns {BattleEngine}
 */
export function prepareBattle(game, playerFaction) {
  const character = game.registry.get('menpai-character')
  // 敌方门派全 7 门派随机（可与玩家同门派），其种族即该门派固有种族
  const enemyFaction = Phaser.Math.RND.pick(FACTIONS)
  const enemyLevel = rollEnemyLevel(character.level)

  const engine = new BattleEngine(playerFaction, enemyFaction, Date.now(), {
    playerLevel: character.level,
    enemyLevel,
    playerStats: computeStats(playerFaction, character.raceId, character.level),
    enemyStats: computeStats(enemyFaction, enemyFaction.race, enemyLevel),
  })

  game.registry.set('menpai-engine', engine)
  game.registry.set('menpai-player-faction', playerFaction)
  game.registry.set('menpai-enemy-faction', enemyFaction)
  game.registry.set('menpai-enemy-level', enemyLevel)
  return engine
}
