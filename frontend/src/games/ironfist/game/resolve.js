// Iron Fist practice-only resolver. Online trusted games never resolve in JavaScript.
// Order of riding area: Basic → Charge → Remaining Health Enhancement → Critical Hit (not implemented) → Defense Damage Reduction → Remaining Health Shield
// See Section 15 of docs/ironfist.md for details (including corrected applyCharge guard)

import {
  DAMAGE_TABLE, BASE_DAMAGE, CHARGE_MULTIPLIER, CHARGE_HOLD_LIMIT,
  LOW_HP_THRESHOLD, LOW_HP_BUFF, SHIELD_HP_THRESHOLD, SHIELD_RATIO,
  STALE_NO_DMG_LIMIT, STALE_ENV_DMG, MAX_ROUNDS, BOTH_CHARGED_LIMIT,
} from './GameConstants.js'

// The maximum damage of charged attacks (before defense damage reduction): base 12 × 2 = 24.
// Used to prevent the double stacking of "charge ×2" and "1.5× penalty for interrupting charge" (attack vs charge: 18×2=36).
// The remaining health enhancement (×1.1) is calculated separately after this, so the remaining health charge attack can still reach 27 (in line with the design).
const MAX_CHARGED_HIT = BASE_DAMAGE * CHARGE_MULTIPLIER

/**
 * Charging mark aging: Carrying unconsumed marks will count +1 each round and will expire when CHARGE_HOLD_LIMIT is reached.
 * @returns {{charged: boolean, unused: number}}
 */
function ageCharge(wasCharged, newCharged, oldUnused = 0) {
  if (!newCharged) return { charged: false, unused: 0 } //Unmarked/consumed by attack
  if (!wasCharged) return { charged: true, unused: 0 }  //Create a new mark this round and reset the timer to zero
  const unused = oldUnused + 1                            //Carry and not consumed → Timer +1
  if (unused >= CHARGE_HOLD_LIMIT) return { charged: false, unused: 0 } //Expiration date
  return { charged: true, unused }
}

/**
 * Settle one round. Input the actions of both parties + the current state, and output the new state and the result of this round.
 * Pure function: does not modify the input parameters and returns a new object.
 *
 * @param {string} playerAction
 * @param {string} opponentAction
 * @param {object} s current state { playerHP, opponentHP, playerCharged, opponentCharged,
 *                              consecutiveNoDamageRounds, totalRounds, bothChargedStalemate }
 */
export function resolveRound(playerAction, opponentAction, s) {
  const { playerHP, opponentHP, playerCharged, opponentCharged } = s
  const base = DAMAGE_TABLE[playerAction][opponentAction]
  const result = { playerDmg: base.playerDmg, opponentDmg: base.opponentDmg }

  // === Multiplication Zone 1: Charge Bonus (×2) ===
  // Direct damage to the table ×2: attack/attack 12→24, attack/defend 5→10 (= ceil(12×2×0.4)),
  // At integer multiples, the results are consistent with strict multiplication zone order (see docs Section 15).
  // Guard dmg > 0: Avoid amplifying the damage that should be 0 when a charged attack hits a counterattack (the side being counterattacked should not be hit).
  if (playerCharged && playerAction === 'attack' && result.opponentDmg > 0) {
    result.opponentDmg = Math.min(result.opponentDmg * CHARGE_MULTIPLIER, MAX_CHARGED_HIT)
  }
  if (opponentCharged && opponentAction === 'attack' && result.playerDmg > 0) {
    result.playerDmg = Math.min(result.playerDmg * CHARGE_MULTIPLIER, MAX_CHARGED_HIT)
  }

  // === Multiplication area 2: Residual blood enhancement (attacker HP < 30) ===
  if (playerHP < LOW_HP_THRESHOLD && result.opponentDmg > 0) {
    result.opponentDmg = Math.ceil(result.opponentDmg * LOW_HP_BUFF)
  }
  if (opponentHP < LOW_HP_THRESHOLD && result.playerDmg > 0) {
    result.playerDmg = Math.ceil(result.playerDmg * LOW_HP_BUFF)
  }

  // === Multiplication area 3: Residual health shield (attacked party’s HP < 20, single damage limit) ===
  if (playerHP < SHIELD_HP_THRESHOLD && result.playerDmg > 0) {
    result.playerDmg = Math.min(result.playerDmg, Math.ceil(playerHP * SHIELD_RATIO))
  }
  if (opponentHP < SHIELD_HP_THRESHOLD && result.opponentDmg > 0) {
    result.opponentDmg = Math.min(result.opponentDmg, Math.ceil(opponentHP * SHIELD_RATIO))
  }

  // === Charge mark update (including N round expiration time) ===
  // The mark can be retained for up to CHARGE_HOLD_LIMIT available turns: carrying but not "attacking" consumes +1 timer per turn, and will expire when the upper limit is reached.
  // Charge aging follows the current rules specification: at most two unused turns.
  let newPlayerCharged = playerCharged
  if (playerAction === 'attack' && playerCharged) {
    newPlayerCharged = false                         //consumption mark
  } else if (playerAction === 'charge' && result.playerDmg === 0) {
    newPlayerCharged = true                          //Accumulation is successful (keep it if it already exists, no superposition)
  }
  // charge is interrupted / defend / counter: keep the original value (retain the original mark when interrupted)
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

  // === Deadlock Counter ===
  const noDamage = result.playerDmg === 0 && result.opponentDmg === 0
  const newConsecutiveNoDmg = noDamage ? s.consecutiveNoDamageRounds + 1 : 0
  const newTotalRounds = s.totalRounds + 1
  const bothCharged = newPlayerCharged && newOpponentCharged
  let newBothChargedStalemate = bothCharged ? s.bothChargedStalemate + 1 : 0

  // === Deadlock Mechanism ===
  // Mechanism A: Continuous no damage → Environmental damage will be deducted this round, increasing each round.
  let envDmg = 0
  if (newConsecutiveNoDmg >= STALE_NO_DMG_LIMIT) {
    envDmg = STALE_ENV_DMG * (newConsecutiveNoDmg - STALE_NO_DMG_LIMIT + 1)
  }
  // Mechanism C: Both sides charge deadlock → Clear both sides’ marks and reset the counter (periodic clear,
  // Otherwise, the counter will never return to zero, which will cause the mark to be cleared every round thereafter, permanently depriving the double charging window)
  if (newBothChargedStalemate > BOTH_CHARGED_LIMIT) {
    newPlayerCharged = false
    newOpponentCharged = false
    newPlayerChargeUnused = 0
    newOpponentChargeUnused = 0
    newBothChargedStalemate = 0
  }

  // === HP update (clamp to 0) ===
  const newPlayerHP = Math.max(0, playerHP - result.playerDmg - envDmg)
  const newOpponentHP = Math.max(0, opponentHP - result.opponentDmg - envDmg)

  // === Determination of victory ===
  let gameResult = null
  if (newPlayerHP <= 0 && newOpponentHP <= 0) {
    gameResult = 'draw'
  } else if (newPlayerHP <= 0) {
    gameResult = 'lose'
  } else if (newOpponentHP <= 0) {
    gameResult = 'win'
  } else if (newTotalRounds >= MAX_ROUNDS) {
    // Mechanism B: Total round limit
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

// Adapter used only to keep offline practice aligned with the server's neutral
// seat-based rules fixtures. Trusted online games never resolve in JavaScript.
export function resolveAuthoritativeRound(actionA, actionB, before) {
  const resolved = resolveRound(actionA, actionB, {
    playerHP: before.hp_a,
    opponentHP: before.hp_b,
    playerCharged: before.charged_a,
    opponentCharged: before.charged_b,
    playerChargeUnused: before.charge_unused_a,
    opponentChargeUnused: before.charge_unused_b,
    consecutiveNoDamageRounds: before.consecutive_no_damage_rounds,
    totalRounds: before.total_rounds,
    bothChargedStalemate: before.both_charged_stalemate,
  })

  const outcome = {
    win: 'win_a',
    lose: 'win_b',
    draw: 'draw',
    doubleLose: 'doubleLose',
  }[resolved.gameResult] || ''

  return {
    damageA: resolved.playerDmg,
    damageB: resolved.opponentDmg,
    environmentDamage: resolved.envDmg,
    state: {
      hp_a: resolved.playerHP,
      hp_b: resolved.opponentHP,
      charged_a: resolved.playerCharged,
      charged_b: resolved.opponentCharged,
      charge_unused_a: resolved.playerChargeUnused,
      charge_unused_b: resolved.opponentChargeUnused,
      consecutive_no_damage_rounds: resolved.consecutiveNoDamageRounds,
      total_rounds: resolved.totalRounds,
      both_charged_stalemate: resolved.bothChargedStalemate,
      ai_charge_interrupted:
        actionB === 'charge' && resolved.opponentDmg > 0
          ? before.ai_charge_interrupted + 1
          : 0,
    },
    outcome,
  }
}
