// 铁拳 - 游戏核心引擎（状态机 + 结算编排，渲染无关）
// 渲染层/UI 通过 on(event, cb) 订阅事件驱动动画，不直接读内部状态。
// 见 docs/ironfist.md 第十三/十五节（逻辑与渲染解耦）

import { PHASE, ACTION, OPPONENT_GRACE_MS, RECONNECT_WINDOW_MS, LS_PENDING_KEY } from './GameConstants.js'
import { resolveRound, initialState } from './resolve.js'
import { aiDecide, trackAiHistory } from './GameAI.js'
import { replayGame } from './replay.js'

export class IronFistGame {
  /**
   * @param {object} opts
   * @param {'pve'|'pvp'} opts.mode
   * @param {object} [opts.net]  PvP 网络层（GameNet 实例），需有 on/send
   * @param {string} [opts.roomId]  PvP 房间 ID（用于 localStorage 持久化本回合动作）
   * @param {string} [opts.myChatId]  PvP 自己的 chat_id（用于重放时区分双方动作）
   */
  constructor({ mode = 'pve', net = null, roomId = null, myChatId = null } = {}) {
    this.mode = mode
    this.net = net
    this.roomId = roomId
    this.myChatId = myChatId
    this.state = initialState()
    this.phase = PHASE.ROUND_START
    this.round = 0
    this.lastResult = null

    this._myAction = null
    this._oppAction = null
    this._aiHistory = { consecutiveChargeInterrupted: 0 }
    this._counterSuccesses = 0 // 本场反击成功次数（用于「反击大师」成就）
    this._pendingOppByRound = new Map() // PvP: 提前到达的对方动作按 round 暂存
    this._listeners = {}
    this._disposed = false
    this._graceTimer = null             // PvP: 已出招后等待对方动作的宽限计时器
    this._reconnectTimer = null         // PvP: 对方掉线后等待重连的计时器（60s）

    if (this.mode === 'pve') this._opponentName = 'AI'

    if (this.net) {
      this.net.on('ironfist_action', (p) => this._onNetAction(p))
      this.net.on('ironfist_replay', (p) => this._onReplay(p))
      this.net.on('game_resign', () => {
        if (this.phase === PHASE.GAME_OVER) return
        this._clearGrace()
        this._clearReconnectTimer()
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
      // 持久化本回合动作（用于刷新重连后续传，详见 docs 第十四节方案 B）
      if (this.roomId) {
        try {
          localStorage.setItem(LS_PENDING_KEY(this.roomId), JSON.stringify({
            round: this.round,
            action,
            ts: Date.now(),
          }))
        } catch { /* localStorage 不可用时降级：仅依赖服务端 action 流 */ }
      }
      this.net.send('ironfist_action', { round: this.round, action, ts: Date.now() })
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

  // PvP：本地已出招后，若对方在宽限期内仍未送达动作，视为掉线，
  // 进入 WAITING_RECONNECT 等待重连（60s），而非直接中断对局。
  // PVP 一旦开始就必须有结果，60s 内未重连 → 判对方负（己方 win）。
  _startGrace() {
    this._clearGrace()
    this._graceTimer = setTimeout(() => {
      if (this._disposed || this.phase !== PHASE.LOCKED) return
      this._setPhase(PHASE.WAITING_RECONNECT)
      this._emit('opponent-disconnected', { timeoutMs: RECONNECT_WINDOW_MS })
      this._startReconnectWait()
    }, OPPONENT_GRACE_MS)
  }

  _clearGrace() {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null }
  }

  // 60s 重连窗口：对方未重连 → 判对方负（己方 win）。
  // 期间不允许"放弃等待认输"，必须等满窗口或对方重连（PVP 一定要有结果）。
  _startReconnectWait() {
    this._clearReconnectTimer()
    this._reconnectTimer = setTimeout(() => {
      if (this._disposed || this.phase !== PHASE.WAITING_RECONNECT) return
      this._setPhase(PHASE.GAME_OVER)
      this._emit('gameover', 'win') // 对方判负
    }, RECONNECT_WINDOW_MS)
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
  }

  _onNetAction(payload) {
    if (this._disposed) return
    // 对局已结束：丢弃任何后续动作，避免重结算翻转已定结果
    // （60s 重连窗口超时判负后，对方延迟重连补发动作会在此被拦截）
    if (this.phase === PHASE.GAME_OVER) return
    const { round, action } = payload

    // 收到对方任何消息 = 对方已重连（如果在 WAITING_RECONNECT）
    if (this.phase === PHASE.WAITING_RECONNECT) {
      this._clearReconnectTimer()
      this._clearGrace()
    }

    // 丢弃过期/异常未来动作，避免 _pendingOppByRound 无界增长（内存泄漏修复）
    if (round < this.round) return
    if (round > this.round + 1) return

    if (round !== this.round) {
      // 提前到达的下一回合动作，暂存
      this._pendingOppByRound.set(round, action)
      return
    }
    this._oppAction = action
    if (this._myAction) {
      this._resolve()
    } else {
      // 对方已选，我还没选 → 回到 DECIDING 让本端继续选
      this._setPhase(PHASE.DECIDING)
      this._emit('round-resume', { round: this.round })
    }
  }

  /**
   * 收到服务端返回的 ironfist_replay（自己发起 ironfist_reconnect 后）。
   * 用 replayGame 重放出当前状态，恢复到中断回合。
   */
  _onReplay(payload) {
    if (this._disposed) return
    const { actions } = payload
    if (!this.myChatId) {
      console.warn('[IronFistGame] loadReplay 需要 myChatId 才能区分双方动作')
      return
    }
    this.loadReplay(actions, this.myChatId)
  }

  /**
   * 从 action 历史重放并恢复状态。供 _onReplay 内部调用，也可由外部主动调用。
   * 详见 docs/ironfist.md 第十四节方案 B。
   */
  loadReplay(actionLog, myChatId) {
    this._clearGrace()
    this._clearReconnectTimer()

    const {
      state, lastResult, completedRounds,
      pendingRound, pendingPlayerAction, pendingOpponentAction,
      counterSuccesses, history,
    } = replayGame(actionLog, myChatId)

    this.state = state
    // 恢复回合级派生数据：重放已完成回合时重算反击成功数与逐回合历史，
    // 否则重连后 _counterSuccesses 归零（漏判「反击大师」成就）、UI moveHistory 缺失。
    this._counterSuccesses = counterSuccesses
    if (history.length) this._emit('replay-history', history)

    if (lastResult?.gameResult) {
      // 重放过程中游戏已结束（最后一回合结算出胜负）
      this.lastResult = lastResult
      this.round = completedRounds
      this._setPhase(PHASE.GAME_OVER)
      this._emit('resolved', lastResult)
      this._emit('gameover', lastResult.gameResult)
      return
    }

    if (pendingRound != null) {
      // 本回合进行中（双方动作未齐）
      this.round = pendingRound
      this._myAction = pendingPlayerAction
      this._oppAction = pendingOpponentAction

      // localStorage 兜底：若服务端没收到我本回合动作（掉线前没发出去），
      // 从本地恢复（重发统一由下面的通知逻辑处理，避免重复发送）
      if (!this._myAction && this.roomId) {
        try {
          const saved = JSON.parse(localStorage.getItem(LS_PENDING_KEY(this.roomId)) || 'null')
          if (saved && saved.round === this.round) {
            this._myAction = saved.action
          }
        } catch { /* ignore */ }
      }

      // 重连恢复后通知对方：重发本回合已选动作，让对方从 WAITING_RECONNECT 恢复。
      // 否则对方仍在 WAITING_RECONNECT，收到后续 round 动作只暂存不恢复，形成死锁。
      if (this._myAction && this.mode === 'pvp' && this.net) {
        this.net.send('ironfist_action', { round: this.round, action: this._myAction, ts: Date.now() })
      }

      if (this._myAction && this._oppAction) {
        // 双方都已选（极端：双方都掉线但服务端有两边动作），直接结算
        this._resolve()
      } else if (this._myAction) {
        // 我已选，等对方
        this._setPhase(PHASE.LOCKED)
        this._emit('locked', { side: 'player', action: this._myAction })
        // 对方可能也掉线了，启动 grace
        if (this.mode === 'pvp') this._startGrace()
      } else {
        // 对方已选等我 / 都未选 → 进入决策
        this._setPhase(PHASE.DECIDING)
        this._emit('round-start', { round: this.round, state: { ...this.state } })
      }
    } else {
      // 没有进行中的 round，所有已选动作都已结算，开始下一 round
      // 先对齐 round 计数器（completedRounds 是最后结算的 round 号）
      this.round = completedRounds
      this._myAction = null
      this._oppAction = null
      this._startRound()
    }
  }

  /**
   * 主动请求重连（页面挂载时检测到未完成对局调用）。
   * 服务端返回 ironfist_replay 后由 _onReplay 处理。
   */
  requestReconnect() {
    if (this.mode !== 'pvp' || !this.net) return
    this.net.send('ironfist_reconnect', { last_round: this.round })
  }

  _resolve() {
    if (this.phase === PHASE.RESOLVING || this.phase === PHASE.WAITING_CONFIRM || this.phase === PHASE.GAME_OVER) return
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

    // 追踪本方反击成功（counter vs attack = 反击命中），用于「反击大师」成就
    if (myAction === ACTION.COUNTER && oppAction === ACTION.ATTACK) {
      this._counterSuccesses += 1
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
      this._clearPendingAction()
      this._emit('gameover', this.lastResult.gameResult)
    } else {
      this._startRound()
    }
  }

  /**
   * 返回本场对局摘要（供上报战绩与成就判定用）。
   * 不含 result：result 由 gameover 事件回调参数提供（认输/超时判负等场景下
   * lastResult.gameResult 不可靠）。
   */
  getMatchSummary() {
    return {
      playerHP: this.state.playerHP,
      counterSuccesses: this._counterSuccesses,
      rounds: this.state.totalRounds,
    }
  }

  resign() {
    if (this.mode === 'pvp' && this.net) this.net.send('game_resign', { room_id: this.roomId })
    this._clearGrace()
    this._clearReconnectTimer()
    this._clearPendingAction()
    this._setPhase(PHASE.GAME_OVER)
    this._emit('gameover', 'lose')
  }

  /** 清理 localStorage 中本房间的 pending action（对局结束/认输时调用）。 */
  _clearPendingAction() {
    if (!this.roomId) return
    try { localStorage.removeItem(LS_PENDING_KEY(this.roomId)) } catch { /* ignore */ }
  }

  dispose() {
    this._disposed = true
    this._clearGrace()
    this._clearReconnectTimer()
    this._listeners = {}
    this._pendingOppByRound.clear()
  }
}
