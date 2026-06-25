// 铁拳 - 游戏核心引擎（状态机 + 结算编排，渲染无关）
// 渲染层/UI 通过 on(event, cb) 订阅事件驱动动画，不直接读内部状态。
// 见 docs/ironfist.md 第十三/十五节（逻辑与渲染解耦）

import { PHASE, ACTION, OPPONENT_GRACE_MS } from './GameConstants.js'
import { resolveRound, initialState } from './resolve.js'
import { aiDecide, trackAiHistory } from './GameAI.js'

export class IronFistGame {
  /**
   * @param {object} opts
   * @param {'pve'|'pvp'} opts.mode
   * @param {object} [opts.net]  PvP 网络层（GameNet 实例），需有 on/send
   */
  constructor({ mode = 'pve', net = null } = {}) {
    this.mode = mode
    this.net = net
    this.state = initialState()
    this.phase = PHASE.ROUND_START
    this.round = 0
    this.lastResult = null

    this._myAction = null
    this._oppAction = null
    this._aiHistory = { consecutiveChargeInterrupted: 0 }
    this._pendingOppByRound = new Map() // PvP: 提前到达的对方动作按 round 暂存
    this._listeners = {}
    this._disposed = false
    this._graceTimer = null             // PvP: 已出招后等待对方动作的宽限计时器

    if (this.mode === 'pve') this._opponentName = 'AI'

    if (this.net) {
      this.net.on('ironfist_action', (p) => this._onNetAction(p))
      this.net.on('game_resign', () => {
        if (this.phase === PHASE.GAME_OVER) return
        this._clearGrace()
        this._setPhase(PHASE.GAME_OVER) // 停止本地倒计时/selectAction，避免对局结束后仍可操作
        this._emit('gameover', 'win')
      })
    }
  }

  // ── 事件 ────────────────────────────────────────────────────────────────
  on(event, cb) {
    (this._listeners[event] ||= []).push(cb)
    return () => {
      this._listeners[event] = (this._listeners[event] || []).filter((f) => f !== cb)
    }
  }

  _emit(event, payload) {
    ;(this._listeners[event] || []).forEach((cb) => cb(payload))
  }

  _setPhase(phase) {
    this.phase = phase
    this._emit('phase', phase)
  }

  // ── 流程 ────────────────────────────────────────────────────────────────
  start() {
    this._startRound()
  }

  _startRound() {
    if (this._disposed) return
    this.round += 1
    this._myAction = null
    this._oppAction = null
    this._setPhase(PHASE.ROUND_START)
    this._emit('round-start', { round: this.round, state: { ...this.state } })
    this._setPhase(PHASE.DECIDING)

    // PvP：若对方动作已提前到达，立即取用
    const buffered = this._pendingOppByRound.get(this.round)
    if (buffered) {
      this._pendingOppByRound.delete(this.round)
      this._oppAction = buffered
    }
  }

  /** 本地玩家选择动作（DECIDING 阶段有效）。超时由 UI 调用 selectAction('defend')。 */
  selectAction(action) {
    if (this.phase !== PHASE.DECIDING || this._myAction) return
    this._myAction = action
    this._emit('locked', { side: 'player', action })

    if (this.mode === 'pvp' && this.net) {
      this.net.send('ironfist_action', { round: this.round, action })
    } else if (this.mode === 'pve') {
      // AI 即时决策（模拟同时选择）
      this._oppAction = aiDecide(
        { hp: this.state.opponentHP, charged: this.state.opponentCharged },
        { hp: this.state.playerHP, charged: this.state.playerCharged },
        this._aiHistory,
      )
    }

    if (this._oppAction) {
      this._resolve()
    } else {
      this._setPhase(PHASE.LOCKED) // 等待对方（PvP）
      if (this.mode === 'pvp') this._startGrace()
    }
  }

  // PvP：本地已出招后，若对方在宽限期内仍未送达动作，视为掉线，结束对局（中断）。
  _startGrace() {
    this._clearGrace()
    this._graceTimer = setTimeout(() => {
      if (this._disposed || this.phase !== PHASE.LOCKED) return
      this._setPhase(PHASE.GAME_OVER)
      this._emit('gameover', 'aborted') // 对手掉线 → 对局中断（不记胜负）
    }, OPPONENT_GRACE_MS)
  }

  _clearGrace() {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null }
  }

  _onNetAction(payload) {
    if (this._disposed) return
    const { round, action } = payload
    if (round !== this.round) {
      // 回合不一致：暂存，等本地推进到该回合再用（简化版回合校验）
      this._pendingOppByRound.set(round, action)
      return
    }
    this._oppAction = action
    if (this._myAction) this._resolve()
  }

  _resolve() {
    if (this.phase === PHASE.RESOLVING || this.phase === PHASE.WAITING_CONFIRM) return
    this._clearGrace()
    this._setPhase(PHASE.RESOLVING)

    const myAction = this._myAction
    const oppAction = this._oppAction
    const result = resolveRound(myAction, oppAction, this.state)

    // PvE：追踪 AI 蓄力被打断历史
    if (this.mode === 'pve') {
      const aiInterrupted = oppAction === ACTION.CHARGE && result.opponentDmg > 0
      trackAiHistory(this._aiHistory, oppAction, aiInterrupted)
    }

    // 提交新状态
    this.state = {
      playerHP: result.playerHP,
      opponentHP: result.opponentHP,
      playerCharged: result.playerCharged,
      opponentCharged: result.opponentCharged,
      playerChargeUnused: result.playerChargeUnused,
      opponentChargeUnused: result.opponentChargeUnused,
      consecutiveNoDamageRounds: result.consecutiveNoDamageRounds,
      totalRounds: result.totalRounds,
      bothChargedStalemate: result.bothChargedStalemate,
    }
    this.lastResult = result
    this._emit('resolved', result)
    this._setPhase(PHASE.WAITING_CONFIRM)
  }

  /** 玩家点击「下一回合」，或 confirm 超时自动调用。 */
  confirmNextRound() {
    if (this.phase !== PHASE.WAITING_CONFIRM) return
    if (this.lastResult?.gameResult) {
      this._setPhase(PHASE.GAME_OVER)
      this._emit('gameover', this.lastResult.gameResult)
    } else {
      this._startRound()
    }
  }

  resign() {
    if (this.mode === 'pvp' && this.net) this.net.send('game_resign', {})
    this._clearGrace()
    this._setPhase(PHASE.GAME_OVER)
    this._emit('gameover', 'lose')
  }

  dispose() {
    this._disposed = true
    this._clearGrace()
    this._listeners = {}
    this._pendingOppByRound.clear()
  }
}
