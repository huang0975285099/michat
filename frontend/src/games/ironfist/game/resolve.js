// 铁拳 - 纯结算逻辑（无副作用，便于单测）
// 乘区顺序：基础 → 蓄力 → 残血强化 → 暴击(未实现) → 防御减伤 → 残血护盾
// 详见 docs/ironfist.md 第十五节（含已修正的 applyCharge 守卫）

import {
  DAMAGE_TABLE, BASE_DAMAGE, CHARGE_MULTIPLIER, CHARGE_HOLD_LIMIT,
  LOW_HP_THRESHOLD, LOW_HP_BUFF, SHIELD_HP_THRESHOLD, SHIELD_RATIO,
  STALE_NO_DMG_LIMIT, STALE_ENV_DMG, MAX_ROUNDS, BOTH_CHARGED_LIMIT,
} from './GameConstants.js'

// 蓄力攻击的伤害上限（防御减伤前）：基础 12 × 2 = 24。
// 用于阻止"蓄力 ×2"与"打断蓄力的 1.5× 惩罚"双重叠加（attack vs charge：18×2=36）。
// 残血强化(×1.1)在此之后另算，故残血蓄力攻击仍可到 27（符合设计）。
const MAX_CHARGED_HIT = BASE_DAMAGE * CHARGE_MULTIPLIER

/**
 * 蓄力标记老化：携带未消耗的标记每回合计时 +1，到 CHARGE_HOLD_LIMIT 即失效。
 * @returns {{charged: boolean, unused: number}}
 */
function ageCharge(wasCharged, newCharged, oldUnused = 0) {
  if (!newCharged) return { charged: false, unused: 0 } // 无标记 / 已被攻击消耗
  if (!wasCharged) return { charged: true, unused: 0 }  // 本回合新建标记，计时归零
  const unused = oldUnused + 1                            // 携带且未消耗 → 计时 +1
  if (unused >= CHARGE_HOLD_LIMIT) return { charged: false, unused: 0 } // 超期失效
  return { charged: true, unused }
}

/**
 * 结算一回合。输入双方动作 + 当前状态，输出新状态与本回合结果。
 * 纯函数：不修改入参，返回全新对象。
 *
 * @param {string} playerAction
 * @param {string} opponentAction
 * @param {object} s 当前状态 { playerHP, opponentHP, playerCharged, opponentCharged,
 *                              consecutiveNoDamageRounds, totalRounds, bothChargedStalemate }
 */
export function resolveRound(playerAction, opponentAction, s) {
  const { playerHP, opponentHP, playerCharged, opponentCharged } = s
  const base = DAMAGE_TABLE[playerAction][opponentAction]
  const result = { playerDmg: base.playerDmg, opponentDmg: base.opponentDmg }

  // === 乘区 1：蓄力加成（×2）===
  // 直接对表内伤害 ×2：attack/attack 12→24，attack/defend 5→10（= ceil(12×2×0.4)），
  // 整数倍率下与严格乘区顺序结果一致（见 docs 第十五节）。
  // 守卫 dmg > 0：避免蓄力攻击撞反击时把本应为 0 的伤害放大（被反击的一方不该挨打）。
  if (playerCharged && playerAction === 'attack' && result.opponentDmg > 0) {
    result.opponentDmg = Math.min(result.opponentDmg * CHARGE_MULTIPLIER, MAX_CHARGED_HIT)
  }
  if (opponentCharged && opponentAction === 'attack' && result.playerDmg > 0) {
    result.playerDmg = Math.min(result.playerDmg * CHARGE_MULTIPLIER, MAX_CHARGED_HIT)
  }

  // === 乘区 2：残血强化（攻击方 HP < 30）===
  if (playerHP < LOW_HP_THRESHOLD && result.opponentDmg > 0) {
    result.opponentDmg = Math.ceil(result.opponentDmg * LOW_HP_BUFF)
  }
  if (opponentHP < LOW_HP_THRESHOLD && result.playerDmg > 0) {
    result.playerDmg = Math.ceil(result.playerDmg * LOW_HP_BUFF)
  }

  // === 乘区 3：残血护盾（被攻击方 HP < 20，单次伤害上限）===
  if (playerHP < SHIELD_HP_THRESHOLD && result.playerDmg > 0) {
    result.playerDmg = Math.min(result.playerDmg, Math.ceil(playerHP * SHIELD_RATIO))
  }
  if (opponentHP < SHIELD_HP_THRESHOLD && result.opponentDmg > 0) {
    result.opponentDmg = Math.min(result.opponentDmg, Math.ceil(opponentHP * SHIELD_RATIO))
  }

  // === 蓄力标记更新（含 N 回合失效计时）===
  // 标记最多保留 CHARGE_HOLD_LIMIT 个可用回合：携带却不"攻击"消耗每回合计时 +1，到上限即失效。
  // 见 docs/ironfist.md 第五节（174↔176 矛盾已统一为"最多保留 2 回合"）。
  let newPlayerCharged = playerCharged
  if (playerAction === 'attack' && playerCharged) {
    newPlayerCharged = false                         // 消耗标记
  } else if (playerAction === 'charge' && result.playerDmg === 0) {
    newPlayerCharged = true                          // 蓄力成功（已有则保持，不叠加）
  }
  // charge 被打断 / defend / counter：保持原值（被打断时保留原标记）
  const pAge = ageCharge(playerCharged, newPlayerCharged, s.playerChargeUnused)
  newPlayerCharged = pAge.charged
  let newPlayerChargeUnused = pAge.unused

  let newOpponentCharged = opponentCharged
  if (opponentAction === 'attack' && opponentCharged) {
    newOpponentCharged = false
  } else if (opponentAction === 'charge' && result.opponentDmg === 0) {
    newOpponentCharged = true
  }
  const oAge = ageCharge(opponentCharged, newOpponentCharged, s.opponentChargeUnused)
  newOpponentCharged = oAge.charged
  let newOpponentChargeUnused = oAge.unused

  // === 僵局计数器 ===
  const noDamage = result.playerDmg === 0 && result.opponentDmg === 0
  const newConsecutiveNoDmg = noDamage ? s.consecutiveNoDamageRounds + 1 : 0
  const newTotalRounds = s.totalRounds + 1
  const bothCharged = newPlayerCharged && newOpponentCharged
  let newBothChargedStalemate = bothCharged ? s.bothChargedStalemate + 1 : 0

  // === 僵局机制 ===
  // 机制 A：连续无伤害 → 本回合即扣环境伤害，逐回合递增
  let envDmg = 0
  if (newConsecutiveNoDmg >= STALE_NO_DMG_LIMIT) {
    envDmg = STALE_ENV_DMG * (newConsecutiveNoDmg - STALE_NO_DMG_LIMIT + 1)
  }
  // 机制 C：双方蓄力僵局 → 清除双方标记，并重置计数器（periodic 清除，
  // 否则计数器永不归零会导致此后每回合都清标记，永久剥夺双蓄力窗口）
  if (newBothChargedStalemate > BOTH_CHARGED_LIMIT) {
    newPlayerCharged = false
    newOpponentCharged = false
    newPlayerChargeUnused = 0
    newOpponentChargeUnused = 0
    newBothChargedStalemate = 0
  }

  // === HP 更新（clamp 到 0）===
  const newPlayerHP = Math.max(0, playerHP - result.playerDmg - envDmg)
  const newOpponentHP = Math.max(0, opponentHP - result.opponentDmg - envDmg)

  // === 胜负判定 ===
  let gameResult = null
  if (newPlayerHP <= 0 && newOpponentHP <= 0) {
    gameResult = 'draw'
  } else if (newPlayerHP <= 0) {
    gameResult = 'lose'
  } else if (newOpponentHP <= 0) {
    gameResult = 'win'
  } else if (newTotalRounds >= MAX_ROUNDS) {
    // 机制 B：总回合上限
    if (newPlayerHP <= 5 && newOpponentHP <= 5) gameResult = 'doubleLose'
    else if (newPlayerHP > newOpponentHP) gameResult = 'win'
    else if (newPlayerHP < newOpponentHP) gameResult = 'lose'
    else gameResult = 'draw'
  }

  return {
    playerAction,
    opponentAction,
    playerDmg: result.playerDmg,
    opponentDmg: result.opponentDmg,
    envDmg,
    playerHP: newPlayerHP,
    opponentHP: newOpponentHP,
    playerCharged: newPlayerCharged,
    opponentCharged: newOpponentCharged,
    playerChargeUnused: newPlayerChargeUnused,
    opponentChargeUnused: newOpponentChargeUnused,
    consecutiveNoDamageRounds: newConsecutiveNoDmg,
    totalRounds: newTotalRounds,
    bothChargedStalemate: newBothChargedStalemate,
    gameResult,
  }
}

export function initialState() {
  return {
    playerHP: 100,
    opponentHP: 100,
    playerCharged: false,
    opponentCharged: false,
    playerChargeUnused: 0,
    opponentChargeUnused: 0,
    consecutiveNoDamageRounds: 0,
    totalRounds: 0,
    bothChargedStalemate: 0,
  }
}
