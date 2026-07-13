// 门派 PK · 梦幻西游风 - 战斗逻辑核心（纯逻辑层，不依赖 Phaser）
// 详见 docs/menpai-pk-xyq.md 第五节。可单测，后续联机复用（event sourcing）。
//
// 设计要点：
// - BattleEngine 为权威状态机，UI 通过监听事件更新。
// - 所有随机数通过 this._rand(seed) 取，保证可复现（联机 action log 重放一致）。
// - 联机时双方 BattleEngine 实例同步 action（selectAction 入参），参考 ironfist 模式。

import {
  MAX_ROUNDS, MAX_ANGER, ANGER_ON_DAMAGE, MP_REGEN_RATIO,
  DEFEND_DAMAGE_REDUCE, CRIT_RATE_BASE, CRIT_MULT,
  DAMAGE_VARIANCE_MIN, DAMAGE_VARIANCE_MAX,
  SkillType, SkillCategory, StatusType, BuffType, Side, Phase, ActionType, Result,
  DOT_DAMAGE_RATIO,
} from './GameConstants.js'
import { getPassive, getNormalAttack } from './factions.js'
import { Emitter } from './Emitter.js'
import { skillTerm } from './skillTerm.js'

/**
 * 构造一个战斗角色实例
 * @param {string} side
 * @param {object} faction 门派数据
 * @param {object} [stats] 等级换算后的面板属性；缺省时退化为门派 base（1 级）
 * @param {number} [level]
 */
function createUnit(side, faction, stats, level = 1) {
  const passive = getPassive(faction)
  const s = stats || faction.base
  return {
    side,
    faction,
    level,
    name: faction.name,
    emoji: faction.emoji,
    color: faction.color,
    maxHp: s.hp,
    hp: s.hp,
    maxMp: s.mp,
    mp: s.mp,
    atk: s.atk,
    matk: s.matk,
    def: s.def,
    mdef: s.mdef,
    spd: s.spd,
    anger: 0,
    // 状态
    buffs: [],          // { type, value, turns } 增益/减益
    statuses: [],       // { type, turns } 异常状态
    cooldowns: {},      // { skillId: 剩余回合 }
    _cdFresh: new Set(),// 本回合内新上的 CD（跳过本回合末的衰减，避免"当回合就减1"）
    transform: false,   // 狮驼变身
    restTurns: 0,       // 休息回合数（横扫/鹰击后）
    _restFresh: false,  // 本回合内新设的休息（同上，跳过本回合末的衰减）
    delayedAction: null,// { skill, turns } 延迟行动（后发制人）
    alive: true,
    passive: passive ? passive.passive : {},
  }
}

export class BattleEngine extends Emitter {
  /**
   * @param {object} playerFaction  玩家门派数据
   * @param {object} enemyFaction   敌方门派数据
   * @param {number} [seed]         随机种子（同种子可复现）
   * @param {object} [opts]
   * @param {number} [opts.playerLevel]  玩家等级（缺省 1）
   * @param {number} [opts.enemyLevel]   敌方等级（缺省 1）
   * @param {object} [opts.playerStats]  玩家等级换算后的面板属性（见 leveling.computeStats）
   * @param {object} [opts.enemyStats]   敌方等级换算后的面板属性
   */
  constructor(playerFaction, enemyFaction, seed = Date.now(), opts = {}) {
    super()
    this.playerFaction = playerFaction
    this.enemyFaction = enemyFaction
    this.seed = seed
    this._rngState = seed

    this.player = createUnit(Side.PLAYER, playerFaction, opts.playerStats, opts.playerLevel ?? 1)
    this.enemy = createUnit(Side.ENEMY, enemyFaction, opts.enemyStats, opts.enemyLevel ?? 1)
    // 先手方：本局随机一次，同速时先手方优先
    this.firstSide = this._rand() < 0.5 ? Side.PLAYER : Side.ENEMY

    this.round = 1
    this.phase = Phase.SELECT
    this.result = null
    this.log = []

    // 双方已选行动：{ side: action }  action = { type, skill? }
    this._pendingActions = {}
  }

  /**
   * 每个事件都挂上当时的双方状态快照。
   *
   * resolveRound() 是同步跑完整个回合的，事件全部瞬间发出；而动画要按事件顺序逐条
   * 播放（见 BattleFeed）。若 UI 播到第 1 条伤害时才去读 engine 的当前状态，读到的
   * 已经是回合结束后的血量，血条会直接跳到最终值。带上快照，UI 就能还原每一步。
   */
  emit(event, payload = {}) {
    const withSnapshot = { ...payload, snapshot: this._snapshot() }
    return super.emit(event, withSnapshot)
  }

  _snapshot() {
    return {
      [Side.PLAYER]: this.getUnitState(Side.PLAYER),
      [Side.ENEMY]: this.getUnitState(Side.ENEMY),
    }
  }

  // ── 随机数（线性同余，可复现） ────────────────────────────────────────────
  _rand() {
    this._rngState = (this._rngState * 1664525 + 1013904223) % 0xffffffff
    return this._rngState / 0xffffffff
  }
  _randRange(min, max) { return min + this._rand() * (max - min) }

  // ── 公开 API ──────────────────────────────────────────────────────────────

  /**
   * 玩家选择行动。
   * @param {string} side
   * @param {{type: string, skill?: object}} action
   */
  selectAction(side, action) {
    if (this.phase !== Phase.SELECT) throw new Error(`phase ${this.phase} 不允许选行动`)
    this._pendingActions[side] = action
    this.emit('action_selected', { side, action })
    if (this._pendingActions[Side.PLAYER] && this._pendingActions[Side.ENEMY]) {
      this.resolveRound()
    }
  }

  /** 取当前角色的"有效"属性（含 buff 加成） */
  getEffective(unit, key) {
    let v = unit[key]
    for (const b of unit.buffs) {
      if (b.type === BuffType.ATK_UP && key === 'atk') v *= (1 + b.value)
      else if (b.type === BuffType.ATK_DOWN && key === 'atk') v *= (1 - b.value)
      else if (b.type === BuffType.MATK_UP && key === 'matk') v *= (1 + b.value)
      else if (b.type === BuffType.DEF_UP && key === 'def') v *= (1 + b.value)
      else if (b.type === BuffType.DEF_DOWN && key === 'def') v *= (1 - b.value)
      else if (b.type === BuffType.MDEF_UP && key === 'mdef') v *= (1 + b.value)
      else if (b.type === BuffType.MDEF_DOWN && key === 'mdef') v *= (1 - b.value)
      else if (b.type === BuffType.MDEF_DOWN_ULT && key === 'mdef') v *= (1 - b.value)
      else if (b.type === BuffType.SPD_UP && key === 'spd') v *= (1 + b.value)
      else if (b.type === BuffType.SPD_DOWN && key === 'spd') v *= (1 - b.value)
    }
    // 狮驼变身被动额外加成
    if (unit.transform && unit.passive.transformAtkBonus && key === 'atk') {
      v *= (1 + unit.passive.transformAtkBonus)
    }
    return Math.floor(v)
  }

  /** 取单位速度（含 buff，用于行动排序） */
  getSpeed(unit) { return this.getEffective(unit, 'spd') }

  // ── 回合结算 ──────────────────────────────────────────────────────────────

  resolveRound() {
    if (this.phase !== Phase.SELECT) return
    this.phase = Phase.RESOLVE
    this.emit('round_start', { round: this.round })

    // 1. 回合开始结算：DoT 扣血、状态衰减（在双方行动前）
    this._tickStartOfRound(this.player)
    this._tickStartOfRound(this.enemy)

    // 死亡检查（DoT 可能致死）
    if (this._checkGameOver()) return

    // 2. 行动队列：按 SPD 排序，同速先手方优先
    const order = [Side.PLAYER, Side.ENEMY].sort((a, b) => {
      const ua = this[a], ub = this[b]
      const sa = this.getSpeed(ua), sb = this.getSpeed(ub)
      if (sa !== sb) return sb - sa
      return a === this.firstSide ? -1 : 1
    })

    // 3. 依次结算
    for (const side of order) {
      if (this.result) break
      const unit = this[side]
      if (!unit.alive) continue
      this._executeAction(side)
      if (this._checkGameOver()) return
    }

    // 4. 回合结束
    this._endRound()
  }

  /** 回合开始：DoT 扣血 + 持续回血 + MP 回复 */
  _tickStartOfRound(unit) {
    if (!unit.alive) return
    // DoT
    for (const s of [...unit.statuses]) {
      const ratio = DOT_DAMAGE_RATIO[s.type]
      if (ratio) {
        const dmg = Math.floor(unit.maxHp * ratio)
        unit.hp = Math.max(0, unit.hp - dmg)
        this._log(`${unit.name} 受到${this._statusName(s.type)}伤害 ${dmg}`)
        this.emit('damage', { side: unit.side, amount: dmg, type: 'dot', status: s.type })
      }
    }
    // 持续回血 buff（普陀普度众生、化生被动）
    this._tickRegen(unit)
  }

  _tickRegen(unit) {
    let regen = 0
    // 化生被动
    if (unit.passive.regenRatio) regen += unit.maxHp * unit.passive.regenRatio
    // 普度众生 buff
    const regenBuffs = unit.buffs.filter((b) => b.type === 'regen')
    for (const b of regenBuffs) regen += unit.maxHp * b.value
    if (regen > 0 && unit.hp > 0) {
      const heal = Math.floor(regen)
      unit.hp = Math.min(unit.maxHp, unit.hp + heal)
      this._log(`${unit.name} 恢复 ${heal} HP`)
      this.emit('heal', { side: unit.side, amount: heal })
    }
  }

  /** 执行某方行动 */
  _executeAction(side) {
    const unit = this[side]
    const action = this._pendingActions[side]

    // 休息中
    if (unit.restTurns > 0) {
      this._log(`${unit.name} 休息中`)
      this.emit('rest', { side })
      return
    }
    // 延迟行动到期（后发制人）
    if (unit.delayedAction) {
      unit.delayedAction.turns -= 1
      if (unit.delayedAction.turns <= 0) {
        const skill = unit.delayedAction.skill
        unit.delayedAction = null
        this._log(`${unit.name} 后发制人发动！`)
        this._applySkill(side, skill)
        return
      }
    }
    // 被眩晕/睡眠
    if (this._hasStatus(unit, StatusType.STUN) || this._hasStatus(unit, StatusType.SLEEP)) {
      this._log(`${unit.name} 被控制，无法行动`)
      this.emit('controlled', { side, status: this._hasStatus(unit, StatusType.STUN) ? 'stun' : 'sleep' })
      return
    }

    // 防御
    if (action.type === ActionType.DEFEND) {
      unit.statuses.push({ type: StatusType.DEFENDING, turns: 1 })
      this._log(`${unit.name} 进入防御状态`)
      this.emit('defend', { side })
      return
    }

    // 必杀技
    if (action.type === ActionType.ULTIMATE) {
      const skill = action.skill
      unit.anger = 0
      this._log(`${unit.name} 释放必杀【${skill.name}】！`)
      this._applySkill(side, skill)
      return
    }

    // 普通技能
    if (action.type === ActionType.SKILL) {
      const skill = action.skill
      unit.mp -= skill.mpCost
      // CD
      if (skill.cooldown) { unit.cooldowns[skill.id] = skill.cooldown; unit._cdFresh.add(skill.id) }
      // 变身检查
      if (skill.setTransform) unit.transform = true
      this._log(`${unit.name} 使用【${skill.name}】`)
      if (skill.delayedAction) {
        // 延迟技能（后发制人）：本回合只进入防御蓄力，不立即出手，下回合才结算伤害
        unit.delayedAction = { skill, turns: skill.delayedAction }
        unit.statuses.push({ type: StatusType.DEFENDING, turns: 1 })
        this.emit('defend', { side })
      } else {
        this._applySkill(side, skill)
      }
      // 端游：攻击方出手不获得愤怒，愤怒只来自挨打（见 _gainAngerFromDamage）
    }
  }

  /** 应用技能效果 */
  _applySkill(side, skill) {
    const caster = this[side]
    const targetSide = side === Side.PLAYER ? Side.ENEMY : Side.PLAYER
    const target = this[targetSide]

    // 起手：渲染层据此播放蓄力/突进/吟唱动画，并记住本次技能类型，
    // 供后续每次 damage 决定用近战撞击还是法术弹道
    this.emit('skill_cast', { side, skill })

    // 治疗
    if (skill.selfHeal) {
      const heal = this._calcHeal(caster, skill)
      caster.hp = Math.min(caster.maxHp, caster.hp + heal)
      this._log(`${caster.name} 恢复 ${heal} HP`)
      this.emit('heal', { side, amount: heal })
      if (skill.cleanse) {
        caster.statuses = caster.statuses.filter((s) => !this._isNegativeStatus(s.type))
        this._log(`${caster.name} 解除所有异常状态`)
        this.emit('cleanse', { side })
      }
    }

    // 复活（普陀杨柳甘露：仅自己被击倒时可用；1v1 中通常用不上，留接口）
    if (skill.revive && !caster.alive) {
      caster.alive = true
      caster.hp = Math.floor(caster.maxHp * skill.power)
      this._log(`${caster.name} 复活！`)
      this.emit('revive', { side, hp: caster.hp })
    }

    // 增益（自身，无条件生效）
    if (skill.effect) {
      this._applySelfBuffs(side, skill.effect)
    }

    // 封印/异常状态附加（非伤害类技能：SEAL 等）+ 随附的目标减益
    // 两者是同一次"封印判定"的结果：没命中就都不生效，命中才一起附加
    // 伤害类技能的 status 在下方命中后附加；此处仅处理无伤害的封印技能
    const isSealLikeSkill = skill.type !== SkillType.PHYSICAL
        && skill.type !== SkillType.MAGICAL
        && skill.type !== SkillType.FIXED
    if (skill.effect && skill.effect.status && isSealLikeSkill) {
      if (this._rollSealHit(caster, skill)) {
        this._applyStatus(target, skill.effect.status, skill.effect.statusTurns)
        this._applyTargetDebuffs(side, skill.effect)
      } else {
        this._log(`${caster.name} 的【${skill.name}】未命中`)
        this.emit('miss', { side: targetSide, from: side })
      }
    } else if (skill.effect) {
      // 没有封印判定的技能（自身增益技能，或伤害技能自带的减益）：减益直接生效
      this._applyTargetDebuffs(side, skill.effect)
    }

    // 伤害。目标已死则整段跳过（含变身取消/休息），但仍要走到末尾发 skill_end
    const isDamageSkill = skill.type === SkillType.PHYSICAL
        || skill.type === SkillType.MAGICAL
        || skill.type === SkillType.FIXED
    if (isDamageSkill && target.alive) {
      const hits = skill.hits || 1
      for (let i = 0; i < hits; i++) {
        if (!target.alive) break
        const r = this._calcDamage(caster, target, skill)
        target.hp = Math.max(0, target.hp - r.damage)
        this._log(`${caster.name} 对 ${target.name} 造成 ${r.damage} 伤害${r.crit ? '（暴击！）' : ''}`)
        // hitIndex/hits 让渲染层区分"起手第一击"与"连击中的后续刀"，也让回放队列缩短连击间隔
        this.emit('damage', {
          side: targetSide, amount: r.damage, type: 'hit', crit: r.crit, from: side,
          hitIndex: i + 1, hits,
        })
        // 附加状态（命中后判定封印命中率，forceSeal 必中）
        if (skill.effect && skill.effect.status && this._rollSealHit(caster, skill)) {
          this._applyStatus(target, skill.effect.status, skill.effect.statusTurns)
        }
        // 受伤获取愤怒
        this._gainAngerFromDamage(target, r.damage)
        // 睡眠受伤害苏醒
        if (this._hasStatus(target, StatusType.SLEEP)) {
          this._removeStatus(target, StatusType.SLEEP)
          this._log(`${target.name} 受伤苏醒`)
        }
      }
      // 取消变身（连环击）
      if (skill.cancelsTransform) {
        caster.transform = false
        this._log(`${caster.name} 变身状态解除`)
        this.emit('transform_off', { side })
      }
      // 休息（横扫/鹰击/连环）
      if (skill.restAfter) {
        caster.restTurns = skill.restAfter
        caster._restFresh = true
      }
    }

    // 收势：与 skill_cast 严格配对。渲染层据此把近战角色拉回站位
    //（多段攻击期间一直贴在目标身前），并清掉"当前技能"上下文
    this.emit('skill_end', { side, skill })
  }

  /** 伤害计算 */
  _calcDamage(caster, target, skill) {
    let hit = true
    // 命中判定（封印技能另算）
    // 物理可闪避（简化：默认必中，留接口）
    if (skill.alwaysHit) hit = true

    // 暴击判定
    let critRate = CRIT_RATE_BASE
    if (skill.critBonus) critRate += skill.critBonus
    if (caster.passive.critRateBonus) critRate += caster.passive.critRateBonus
    if (caster.transform && caster.passive.transformCritBonus) critRate += caster.passive.transformCritBonus
    if (skill.forceCrit) critRate = 1
    const crit = this._rand() < critRate

    let critMult = CRIT_MULT
    if (caster.passive.critMultBonus) critMult += caster.passive.critMultBonus

    // 神焰（魔王被动）
    let shenyanMult = 1
    if (caster.passive.shenyanChance && skill.type === SkillType.MAGICAL) {
      if (this._rand() < caster.passive.shenyanChance) {
        shenyanMult = 1 + caster.passive.shenyanBonus
        this._log(`${caster.name} 触发神焰！法术伤害 +40%`)
      }
    }

    // ── 基础伤害（端游模型）─────────────────────────────────────────────
    // 物理：破防/不破防 —— 伤害力 = 面板伤害 − 面板防御，破防按差值、不破防走 10% 保底。
    // 法术：师门技能项 + 灵力(法伤) − 灵力(法防)，技能项由技能等级决定，占主导。
    // 固伤：无视防御，直接取技能基础值（普陀五行）。
    let base, floor
    if (skill.type === SkillType.PHYSICAL) {
      const atk = this.getEffective(caster, 'atk')
      let def = this.getEffective(target, 'def')
      if (skill.ignoreDef) def = 0
      else if (skill.ignoreDefRatio) def *= (1 - skill.ignoreDefRatio)
      const power = atk - def
      floor = atk * 0.1 * skill.power       // 不破防保底：面板伤害的 10%
      base = Math.max(power, atk * 0.1) * skill.power
    } else if (skill.type === SkillType.MAGICAL) {
      // matk/mdef 面板值都等于灵力；buff（龙附 +matk / 魔王护持 +mdef）在此各自生效
      const casterSpirit = this.getEffective(caster, 'matk')
      let targetSpirit = this.getEffective(target, 'mdef')
      if (skill.ignoreDef) targetSpirit = 0
      else if (skill.ignoreDefRatio) targetSpirit *= (1 - skill.ignoreDefRatio)
      const term = skillTerm(skill)
      floor = term * 0.1
      base = Math.max(term + casterSpirit - targetSpirit, floor)
    } else {
      // 固定伤害
      base = skill.power
      floor = skill.power
    }

    // 防御态减伤
    if (this._hasStatus(target, StatusType.DEFENDING)) base *= (1 - DEFEND_DAMAGE_REDUCE)
    // 普陀被动法术减伤
    if (skill.type === SkillType.MAGICAL && target.passive.magicDamageReduce) {
      base *= (1 - target.passive.magicDamageReduce)
    }

    let final = Math.max(base, floor)
    // 暴击
    if (crit) final *= critMult
    // 神焰
    final *= shenyanMult
    // 波动
    final *= this._randRange(DAMAGE_VARIANCE_MIN, DAMAGE_VARIANCE_MAX)

    return { damage: Math.max(1, Math.floor(final)), crit, hit }
  }

  /** 治疗计算 */
  _calcHeal(caster, skill) {
    if (skill.type === SkillType.FIXED) return Math.floor(caster.maxHp * skill.power)
    return Math.floor(this.getEffective(caster, 'matk') * skill.power)
  }

  /** 应用技能附加效果中作用于自身的增益（无条件生效） */
  _applySelfBuffs(side, effect) {
    const caster = this[side]
    if (effect.buff && !effect.buff.type.includes('down')) {
      this._applyBuff(caster, effect.buff)
      this.emit('buff', { side, buff: effect.buff })
    }
    if (effect.buff2 && !effect.buff2.type.includes('down')) {
      this._applyBuff(caster, effect.buff2)
      this.emit('buff', { side, buff: effect.buff2 })
    }
  }

  /** 应用技能附加效果中作用于目标的减益（调用方决定是否需要先过封印判定） */
  _applyTargetDebuffs(side, effect) {
    const targetSide = side === Side.PLAYER ? Side.ENEMY : Side.PLAYER
    const target = this[targetSide]
    if (effect.buff && effect.buff.type.includes('down')) {
      this._applyBuff(target, effect.buff)
      this.emit('buff', { side: targetSide, buff: effect.buff })
    }
    if (effect.buff2 && effect.buff2.type.includes('down')) {
      this._applyBuff(target, effect.buff2)
      this.emit('buff', { side: targetSide, buff: effect.buff2 })
    }
  }

  _applyBuff(unit, buff) {
    // 同类 buff 取 max（不叠加）
    // fresh=true：本回合刚上/刚刷新的，回合结束时先跳过一次衰减，
    // 否则"持续 N 回合"会在生效当回合就先减 1，实际只剩 N-1 回合生效
    const existing = unit.buffs.find((b) => b.type === buff.type)
    if (existing) {
      existing.value = Math.max(existing.value, buff.value)
      existing.turns = Math.max(existing.turns, buff.turns)
      existing.fresh = true
    } else {
      unit.buffs.push({ ...buff, fresh: true })
    }
  }

  _applyStatus(unit, status, turns) {
    // 封印命中率（方寸被动 +15%）
    // fresh 同 _applyBuff，避免状态在附加当回合就被立即衰减掉
    const existing = unit.statuses.find((s) => s.type === status)
    if (existing) {
      existing.turns = Math.max(existing.turns, turns)
      existing.fresh = true
    } else {
      unit.statuses.push({ type: status, turns, fresh: true })
    }
    this._log(`${unit.name} 陷入${this._statusName(status)}状态`)
    this.emit('status', { side: unit.side, status, turns })
  }

  /**
   * 封印/异常状态命中判定
   * 基础命中率 0.8；方寸被动 sealHitBonus +0.15；skill.effect.forceSeal 必中
   */
  _rollSealHit(caster, skill) {
    if (skill.effect && skill.effect.forceSeal) return true
    let hit = 0.8
    if (caster.passive.sealHitBonus) hit += caster.passive.sealHitBonus
    return this._rand() < hit
  }

  _hasStatus(unit, type) { return unit.statuses.some((s) => s.type === type) }
  _removeStatus(unit, type) {
    unit.statuses = unit.statuses.filter((s) => s.type !== type)
  }
  _isNegativeStatus(type) {
    return [StatusType.STUN, StatusType.SLEEP, StatusType.SEAL_MAGIC, StatusType.SEAL_PHYS,
            StatusType.POISON, StatusType.BURN].includes(type)
  }
  _statusName(type) {
    return { stun: '眩晕', sleep: '睡眠', seal_magic: '封法', seal_phys: '封物理',
             poison: '中毒', burn: '灼烧', defending: '防御' }[type] || type
  }

  _gainAnger(unit, amount) {
    unit.anger = Math.min(MAX_ANGER, unit.anger + amount)
    this.emit('anger_change', { side: unit.side, anger: unit.anger })
  }

  /**
   * 受伤获取愤怒（端游阶梯表，见 GameConstants.ANGER_ON_DAMAGE）。
   * 每次伤害单独结算 —— 多段攻击的每一刀各自查表，不把伤害合并。
   */
  _gainAngerFromDamage(unit, damage) {
    if (unit.maxHp <= 0) return
    const ratio = damage / unit.maxHp
    // 表按 min 降序；命中第一个 ratio >= min 的档位即「临界值取右侧」
    const tier = ANGER_ON_DAMAGE.find((t) => ratio >= t.min)
    this._gainAnger(unit, tier ? tier.anger : 1)
  }

  /** 回合结束 */
  _endRound() {
    this.phase = Phase.ROUND_END
    for (const unit of [this.player, this.enemy]) {
      if (!unit.alive) continue
      // 状态回合数 -1（本回合刚附加的 fresh 状态跳过这次衰减）
      for (const s of [...unit.statuses]) {
        if (s.fresh) { s.fresh = false; continue }
        s.turns -= 1
        if (s.turns <= 0 && s.type !== StatusType.DEFENDING) {
          this._removeStatus(unit, s.type)
        }
      }
      // DEFENDING 每回合自动清（即使没行动）
      this._removeStatus(unit, StatusType.DEFENDING)
      // buff 回合数 -1（同上，fresh 跳过一次）
      for (const b of [...unit.buffs]) {
        if (b.fresh) { b.fresh = false; continue }
        b.turns -= 1
        if (b.turns <= 0) {
          unit.buffs = unit.buffs.filter((x) => x !== b)
        }
      }
      // CD -1（本回合刚上的 CD 跳过这次衰减）
      for (const k of Object.keys(unit.cooldowns)) {
        if (unit._cdFresh.has(k)) { unit._cdFresh.delete(k); continue }
        unit.cooldowns[k] -= 1
        if (unit.cooldowns[k] <= 0) delete unit.cooldowns[k]
      }
      // 休息回合 -1（本回合刚进入休息的跳过这次衰减，否则休息 1 回合形同虚设）
      if (unit.restTurns > 0) {
        if (unit._restFresh) unit._restFresh = false
        else unit.restTurns -= 1
      }
      // MP 自然回复
      const mpRegen = Math.floor(unit.maxMp * MP_REGEN_RATIO)
      unit.mp = Math.min(unit.maxMp, unit.mp + mpRegen)
    }

    this.emit('round_end', { round: this.round })

    // 回合上限判定
    if (this.round >= MAX_ROUNDS) {
      this._endByTimeOut()
      return
    }

    this.round += 1
    this.phase = Phase.SELECT
    this._pendingActions = {}
    this.emit('select_start', { round: this.round })
  }

  /** 胜负判定 */
  _checkGameOver() {
    if (!this.player.alive || this.player.hp <= 0) {
      // 普陀杨柳甘露自我复活
      if (this._canRevive(this.player)) {
        this._doRevive(this.player)
        return false
      }
      this._endGame(Result.ENEMY_WIN)
      return true
    }
    if (!this.enemy.alive || this.enemy.hp <= 0) {
      if (this._canRevive(this.enemy)) {
        this._doRevive(this.enemy)
        return false
      }
      this._endGame(Result.PLAYER_WIN)
      return true
    }
    return false
  }

  _canRevive(unit) {
    const skill = unit.faction.skills.find((s) => s.revive)
    if (!skill) return false
    if (unit.cooldowns[skill.id]) return false
    if (unit.mp < skill.mpCost) return false
    return true
  }

  _doRevive(unit) {
    const skill = unit.faction.skills.find((s) => s.revive)
    unit.mp -= skill.mpCost
    unit.cooldowns[skill.id] = skill.cooldown || 5
    unit._cdFresh.add(skill.id)
    unit.alive = true
    unit.hp = Math.floor(unit.maxHp * skill.power)
    this._log(`${unit.name} 发动【${skill.name}】复活！`)
    this.emit('revive', { side: unit.side, hp: unit.hp })
  }

  _endByTimeOut() {
    const php = this.player.hp / this.player.maxHp
    const ehp = this.enemy.hp / this.enemy.maxHp
    if (php > ehp) this._endGame(Result.PLAYER_WIN)
    else if (ehp > php) this._endGame(Result.ENEMY_WIN)
    else this._endGame(Result.DRAW)
  }

  _endGame(result) {
    this.result = result
    this.phase = Phase.GAME_OVER
    this._log(result === Result.PLAYER_WIN ? '玩家胜利！'
              : result === Result.ENEMY_WIN ? 'AI 胜利！' : '平局！')
    this.emit('game_over', { result, round: this.round })
  }

  _log(msg) {
    this.log.push({ round: this.round, msg })
    this.emit('log', { round: this.round, msg })
  }

  // ── 查询 API（供 UI 用） ────────────────────────────────────────────────

  /** 取某方当前可用的技能列表（MP/CD/HP 门控/变身/封印 均通过） */
  getAvailableSkills(side) {
    const unit = this[side]
    if (!unit.alive) return []
    if (unit.restTurns > 0) return [] // 休息中：任何技能/普攻都不可选，与 _executeAction 的休息判定保持一致
    const result = []
    for (const skill of unit.faction.skills) {
      if (skill.category === SkillCategory.PASSIVE) continue
      // 复活技能只在死亡时自动触发（见 _canRevive/_doRevive），不可主动选择
      if (skill.revive) continue
      // 必杀技单独判定
      if (skill.category === SkillCategory.ULTIMATE) {
        if (unit.anger >= (skill.angerCost || 150)) result.push(skill)
        continue
      }
      // 主动技能
      if (unit.mp < skill.mpCost) continue
      if (unit.cooldowns[skill.id]) continue
      // HP 门控（大唐横扫）
      if (skill.hpGate && unit.hp / unit.maxHp < skill.hpGate) continue
      // 变身要求
      if (skill.requiresTransform && !unit.transform) continue
      // 封印限制：只封对应类型的攻击技能，不影响治疗/固伤/增益等其他类型
      if (this._hasStatus(unit, StatusType.SEAL_MAGIC) && skill.type === SkillType.MAGICAL) continue
      if (this._hasStatus(unit, StatusType.SEAL_PHYS) && skill.type === SkillType.PHYSICAL) continue
      result.push(skill)
    }
    // 普攻始终可选（不耗 MP、不受封印限制的保底行动，物理/法系按门派适配）
    result.push(getNormalAttack(unit.faction))
    return result
  }

  /** 是否可选必杀 */
  canUltimate(side) {
    return this[side].anger >= MAX_ANGER && this[side].alive
  }

  /** 取某方状态摘要（UI 用） */
  getUnitState(side) {
    const u = this[side]
    return {
      side, name: u.name, emoji: u.emoji, color: u.color, level: u.level,
      hp: u.hp, maxHp: u.maxHp, mp: u.mp, maxMp: u.maxMp, anger: u.anger,
      atk: this.getEffective(u, 'atk'), matk: this.getEffective(u, 'matk'),
      def: this.getEffective(u, 'def'), mdef: this.getEffective(u, 'mdef'),
      spd: this.getEffective(u, 'spd'),
      transform: u.transform, restTurns: u.restTurns,
      statuses: u.statuses.map((s) => ({ type: s.type, turns: s.turns })),
      buffs: u.buffs.map((b) => ({ type: b.type, value: b.value, turns: b.turns })),
      cooldowns: { ...u.cooldowns },
      alive: u.alive,
      delayedAction: !!u.delayedAction,
    }
  }
}
