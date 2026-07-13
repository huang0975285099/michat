// 门派 PK · 梦幻西游风 - 战斗事件回放队列
//
// 为什么需要它：BattleEngine.resolveRound() 是**同步**跑完整个回合的，
// 一次 selectAction 会在同一帧里把 skill_cast / damage×N / status / round_end /
// select_start 全部 emit 出去。场景若直接订阅 engine，所有动画会在同一帧叠在一起，
// 血条也会瞬间跳到回合结束后的值。
//
// BattleFeed 夹在中间：缓冲 engine 的事件，再按每种事件的表演时长逐条重放。
// BattleScene（演出）与 UIScene（数据条/按钮）都只订阅 feed，从而严格同步。
// 事件自带 snapshot（见 BattleEngine.emit），UI 直接渲染快照即可还原每一步的血量。

import { Emitter } from './Emitter.js'

/** 需要缓冲重放的 engine 事件 */
const QUEUED_EVENTS = [
  'round_start', 'skill_cast', 'skill_end', 'damage', 'heal', 'anger_change',
  'buff', 'status', 'cleanse', 'revive', 'defend', 'rest', 'controlled',
  'transform_off', 'miss', 'log', 'round_end', 'select_start', 'game_over',
]

/**
 * 不缓冲、立即透传的事件。
 * action_selected 只是"某方已提交行动"的记账，UI 靠它防重复提交，必须实时。
 */
const PASSTHROUGH_EVENTS = ['action_selected']

/** 每条事件播完后等待多久再播下一条（ms），即该事件的动画时长预算 */
const STEP_DELAY = {
  skill_cast: (p) => {
    if (p.skill?.category === 'ultimate') return 780   // 必杀：闪屏 + 蓄力
    const t = p.skill?.type
    if (t === 'physical') return 320                   // 突进到目标身前
    if (t === 'magical' || t === 'fixed') return 470   // 吟唱 + 弹道飞行
    return 340                                         // 治疗/增益/封印：起手光环
  },
  // 连击中的中间几刀节奏加快，只有最后一击留足读数字的时间（连环击 5 段否则要拖 3 秒）
  damage: (p) => (p.hits > 1 && p.hitIndex < p.hits ? 300 : 520),
  heal: 440,
  revive: 700,
  controlled: 420,
  miss: 360,
  status: 340,
  cleanse: 340,
  buff: 320,
  defend: 300,
  transform_off: 300,
  // 只有近战突进过的角色需要收势归位；其余技能原地施法，无需留时间
  skill_end: (p) => (p.skill?.type === 'physical' ? 240 : 0),
  rest: 260,
  game_over: 300,
  // 纯数据事件：不占演出时间，紧跟上一条一起呈现
  round_start: 0, round_end: 0, select_start: 0, log: 0, anger_change: 0,
}

export class BattleFeed extends Emitter {
  /**
   * @param {import('./BattleEngine.js').BattleEngine} engine
   * @param {Phaser.Scene} scene 提供 time.delayedCall；场景销毁时定时器自动清理
   */
  constructor(engine, scene) {
    super()
    this.engine = engine
    this.scene = scene
    this._queue = []
    this._draining = false
    this._subs = []

    for (const ev of PASSTHROUGH_EVENTS) {
      const fn = (payload) => this.emit(ev, payload)
      engine.on(ev, fn)
      this._subs.push([ev, fn])
    }
    for (const ev of QUEUED_EVENTS) {
      const fn = (payload) => {
        this._queue.push([ev, payload])
        this._drain()
      }
      engine.on(ev, fn)
      this._subs.push([ev, fn])
    }
  }

  /** 队列是否还在播（BattleScene 用它决定要不要等演出结束再弹结算面板） */
  get busy() { return this._draining }

  _drain() {
    if (this._draining) return
    this._draining = true
    this._step()
  }

  _step() {
    const item = this._queue.shift()
    if (!item) { this._draining = false; return }
    const [ev, payload] = item
    this.emit(ev, payload)

    const spec = STEP_DELAY[ev] ?? 0
    const delay = typeof spec === 'function' ? spec(payload) : spec
    if (delay <= 0) {
      // 零延迟事件直接接着播下一条，不浪费一帧
      if (this._queue.length) { this._step(); return }
      this._draining = false
      return
    }
    this._timer = this.scene.time.delayedCall(delay, () => this._step())
  }

  destroy() {
    if (this._timer) { this._timer.remove(); this._timer = null }
    this._subs.forEach(([ev, fn]) => { try { this.engine.off(ev, fn) } catch (e) { /* noop */ } })
    this._subs = []
    this._queue = []
    this._draining = false
    this._h.clear()
  }
}
