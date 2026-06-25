// 铁拳 - PvE AI 决策（状态感知概率模型，见 docs/ironfist.md 第十一节）

import { ACTION } from './GameConstants.js'

function weightedRandom(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0)
  const total = entries.reduce((sum, [, w]) => sum + w, 0)
  if (total <= 0) return ACTION.ATTACK
  let r = Math.random() * total
  for (const [action, w] of entries) {
    r -= w
    if (r < 0) return action
  }
  return entries[entries.length - 1][0]
}

/**
 * AI 生成本回合动作。
 * @param {object} ai     { hp, charged }   AI 自身状态
 * @param {object} player { hp, charged }   玩家状态
 * @param {object} history { consecutiveChargeInterrupted }
 */
export function aiDecide(ai, player, history = {}) {
  let weights

  if (ai.charged) {
    // 有大就要用，避免浪费标记
    weights = { attack: 70, defend: 20, charge: 0, counter: 10 }
  } else if (player.charged) {
    // 倾向克制玩家可能的蓄力攻击
    weights = { attack: 15, defend: 40, charge: 10, counter: 35 }
  } else {
    weights = { attack: 50, defend: 25, charge: 15, counter: 10 }
  }

  // 双方都有标记：互秒局面优先出手
  if (ai.charged && player.charged) {
    weights = { attack: 60, defend: 30, charge: 0, counter: 10 }
  }

  if (ai.hp < 30) weights.attack += 15                       // 残血强化翻盘
  if (player.hp < 20 && !ai.charged) weights.charge += 10     // 蓄力破护盾；已有标记则不再浪费回合去蓄力

  if ((history.consecutiveChargeInterrupted || 0) >= 2) {
    weights.charge = 0
    weights.attack += 20
  }

  return weightedRandom(weights)
}

/**
 * AI 历史追踪：累计被打断的连续蓄力次数。
 * 在每回合结算后调用，传入 AI 本回合动作与是否被打断。
 */
export function trackAiHistory(history, aiAction, aiInterrupted) {
  if (aiAction === ACTION.CHARGE && aiInterrupted) {
    history.consecutiveChargeInterrupted = (history.consecutiveChargeInterrupted || 0) + 1
  } else {
    history.consecutiveChargeInterrupted = 0
  }
  return history
}
