// Tekken - Event Sourcing Replay Tool (Option B)
// Legacy local replay helper for practice only. It is not an authoritative state source.
// Mathematically, a consistent state must be obtained. See Section 14 of docs/ironfist.md for details.

import { resolveRound, initialState } from './resolve.js'
import { ACTION, ACTIONS, MAX_ROUNDS } from './GameConstants.js'

/**
 * Pair the action list returned by the server into the [playerAction, opponentAction] sequence by round.
 *
 * Each action stored on the server is in the form of { round, action, from, ts }, and each party sends one.
 * During replay, groups are grouped by round, and each round is expected to have 2 entries; if one party has not arrived (extreme case), the round is incomplete.
 * Skip this round (not settled), wait for reconnection to complete the round, and then settle.
 *
 * @param {Array} actionLog action list returned by the server
 * @param {string} myChatId own chat_id (used to distinguish both parties)
 * @returns {Array<{round, playerAction, opponentAction, complete}>}
 */
export function pairActionsByRound(actionLog, myChatId) {
  const grouped = new Map()
  for (const item of actionLog) {
    const { round, action, from } = item
    if (!Number.isInteger(round) || round < 1 || round > MAX_ROUNDS) continue
    if (!ACTIONS.includes(action) || typeof from !== 'string' || !from) continue
    if (!grouped.has(round)) grouped.set(round, {})
    const slot = grouped.get(round)
    // from === myChatId → I sent → playerAction from the player's perspective
    // Otherwise → issued by the opponent → opponentAction
    // The first legal action is locking, which is consistent with the idempotent semantics of each round of the real-time engine/backend.
    if (from === myChatId) {
      if (slot.playerAction == null) slot.playerAction = action
    } else if (slot.opponentAction == null) {
      slot.opponentAction = action
    }
  }
  const rounds = [...grouped.keys()].sort((a, b) => a - b)
  return rounds.map((round) => {
    const slot = grouped.get(round)
    return {
      round,
      playerAction: slot.playerAction || null,
      opponentAction: slot.opponentAction || null,
      complete: slot.playerAction != null && slot.opponentAction != null,
    }
  })
}

/**
 * Replay the current game state from the action history.
 *
 * Process: replay local actions round by round and stop at an incomplete round.
 * This is the status of the current round when the connection is disconnected).
 *
 * @param {Array} actionLog action list returned by the server
 * @param {string} myChatId own chat_id
 * @returns {{
 * state: object, // Current game state (can be directly poured into IronFistGame.state)
 * lastResult: object|null, //The final round settlement result
 * completedRounds: number, // Number of completed rounds that have been settled
 * pendingRound: number|null, // The round number of this round (both sides have not completed their actions)
 * pendingPlayerAction: string|null, // The action you have chosen this round but the opponent has not yet arrived
 *   pendingOpponentAction: string|null,
 * counterSuccesses: number, // The cumulative number of successful counterattacks (counter vs attack) in the settled round
 * history: Array, // Round-by-turn results of settled rounds ({round,playerAction,opponentAction,playerDmg,opponentDmg})
 * }}
 */
export function replayGame(actionLog, myChatId) {
  const paired = pairActionsByRound(actionLog, myChatId)
  let state = initialState()
  let lastResult = null
  let completedRounds = 0
  let pendingRound = null
  let pendingPlayerAction = null
  let pendingOpponentAction = null
  let counterSuccesses = 0
  const history = []

  for (const item of paired) {
    if (item.complete) {
      lastResult = resolveRound(item.playerAction, item.opponentAction, state)
      // Populate new state (aligned with fields in IronFistGame._resolve)
      state = {
        playerHP: lastResult.playerHP,
        opponentHP: lastResult.opponentHP,
        playerCharged: lastResult.playerCharged,
        opponentCharged: lastResult.opponentCharged,
        playerChargeUnused: lastResult.playerChargeUnused,
        opponentChargeUnused: lastResult.opponentChargeUnused,
        consecutiveNoDamageRounds: lastResult.consecutiveNoDamageRounds,
        totalRounds: lastResult.totalRounds,
        bothChargedStalemate: lastResult.bothChargedStalemate,
      }
      completedRounds = item.round
      // Track the success of your own counterattack (consistent with the determination of IronFistGame._resolve, used for the "Counterattack Master" achievement)
      // Note: The final round is also counted in counterSuccesses (the achievement statistics must be complete), but the history below will skip it.
      if (item.playerAction === ACTION.COUNTER && item.opponentAction === ACTION.ATTACK) {
        counterSuccesses += 1
      }
      // Record the round-by-round results for restoration on the UI side after reconnection moveHistory (move statistics/accumulated damage/record details)
      // The final round does not enter history: the gameover branch of loadReplay will emit 'resolved',
      // Push the resolved listener on the Vue side into moveHistory to avoid duplication
      if (!lastResult.gameResult) {
        history.push({
          round: item.round,
          playerAction: item.playerAction,
          opponentAction: item.opponentAction,
          playerDmg: lastResult.playerDmg,
          opponentDmg: lastResult.opponentDmg,
        })
      }
      // If the round has ended the game, stop replaying
      if (lastResult.gameResult) break
    } else {
      // While this round is in progress, record the actions to be continued
      pendingRound = item.round
      pendingPlayerAction = item.playerAction
      pendingOpponentAction = item.opponentAction
      break
    }
  }

  return {
    state,
    lastResult,
    completedRounds,
    pendingRound,
    pendingPlayerAction,
    pendingOpponentAction,
    counterSuccesses,
    history,
  }
}
