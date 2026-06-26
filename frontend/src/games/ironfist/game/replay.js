// 铁拳 - 事件溯源重放工具（方案 B）
// 服务端只暂存 action 流（无游戏逻辑），客户端用纯函数 resolveRound 重放，
// 数学上必然得到一致状态。详见 docs/ironfist.md 第十四节。

import { resolveRound, initialState } from './resolve.js'

/**
 * 将服务端返回的 action 列表按 round 配对为 [playerAction, opponentAction] 序列。
 *
 * 服务端存的每条 action 形如 { round, action, from, ts }，双方各发一条。
 * 重放时按 round 分组，每 round 期望有 2 条；若某方未到（极端情况）则该 round 不完整，
 * 跳过该 round（不结算），等待重连后补齐再结算。
 *
 * @param {Array} actionLog 服务端返回的 action 列表
 * @param {string} myChatId 自己的 chat_id（用于区分双方）
 * @returns {Array<{round, playerAction, opponentAction, complete}>}
 */
export function pairActionsByRound(actionLog, myChatId) {
  const grouped = new Map()
  for (const item of actionLog) {
    const { round, action, from } = item
    if (!grouped.has(round)) grouped.set(round, {})
    const slot = grouped.get(round)
    // from === myChatId → 我发的 → 玩家视角的 playerAction
    // 否则 → 对手发的 → opponentAction
    if (from === myChatId) slot.playerAction = action
    else slot.opponentAction = action
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
 * 从 action 历史重放出当前游戏状态。
 *
 * 流程：逐 round 调用 resolveRound，遇到不完整的 round 停止（说明该 round 双方动作未齐，
 * 是断线时本回合进行中的状态）。
 *
 * @param {Array} actionLog 服务端返回的 action 列表
 * @param {string} myChatId 自己的 chat_id
 * @returns {{
 *   state: object,           // 当前游戏状态（可直接灌入 IronFistGame.state）
 *   lastResult: object|null, // 最后一回合结算结果
 *   completedRounds: number, // 已结算完成的回合数
 *   pendingRound: number|null, // 本回合（双方动作未齐）的 round 号
 *   pendingPlayerAction: string|null, // 本回合自己已选但对手未到的动作
 *   pendingOpponentAction: string|null,
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

  for (const item of paired) {
    if (item.complete) {
      lastResult = resolveRound(item.playerAction, item.opponentAction, state)
      // 灌入新状态（与 IronFistGame._resolve 中的字段对齐）
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
      // 若该 round 已结束游戏，停止重放
      if (lastResult.gameResult) break
    } else {
      // 本回合进行中，记录待续传的动作
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
  }
}
