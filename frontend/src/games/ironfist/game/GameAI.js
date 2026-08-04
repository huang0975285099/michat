// Iron Fist - PvE AI decision-making (state-aware probabilistic model, see Section 11 of docs/ironfist.md)

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
 * The AI generates actions for this turn.
 * @param {object} ai { hp, charged } AI own status
 * @param {object} player { hp, charged } player status
 * @param {object} history { consecutiveChargeInterrupted }
 */
export function aiDecide(ai, player, history = {}) {
  let weights

  if (ai.charged) {
    // Use it when you have it to avoid wasting marks
    weights = { attack: 70, defend: 20, charge: 0, counter: 10 }
  } else if (player.charged) {
    // Tends to suppress possible charged attacks by players
    weights = { attack: 15, defend: 40, charge: 10, counter: 35 }
  } else {
    weights = { attack: 50, defend: 25, charge: 15, counter: 10 }
  }

  // Both sides have marks: take priority in the situation of mutual seconds.
  if (ai.charged && player.charged) {
    weights = { attack: 60, defend: 30, charge: 0, counter: 10 }
  }

  if (ai.hp < 30) weights.attack += 15                       //Residual blood strengthens the comeback
  if (player.hp < 20 && !ai.charged) weights.charge += 10     //Charge to break the shield; if there is already a mark, you will no longer waste turns to charge.

  if ((history.consecutiveChargeInterrupted || 0) >= 2) {
    weights.charge = 0
    weights.attack += 20
  }

  return weightedRandom(weights)
}

/**
 * AI history tracking: cumulative number of interrupted continuous charging times.
 * Called after the settlement of each round, the AI's actions for this round and whether it was interrupted are passed in.
 */
export function trackAiHistory(history, aiAction, aiInterrupted) {
  if (aiAction === ACTION.CHARGE && aiInterrupted) {
    history.consecutiveChargeInterrupted = (history.consecutiveChargeInterrupted || 0) + 1
  } else {
    history.consecutiveChargeInterrupted = 0
  }
  return history
}
