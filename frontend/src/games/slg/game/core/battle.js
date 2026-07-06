// 九州征途 - 战斗结算（多对多回合制 + 数据驱动战法）
// 双方各若干名武将同场作战：每回合按速度从高到低依次行动（每回合重排存活者）。
// 每个单位一次行动：控制检查 → 前置主动战法 → 普通攻击 → 普攻后追击战法(连击) → 结束。
// 普通攻击与所有战法统一抽象为 Skill（见 skills.js），引擎只认「触发时机+属性+倍率+概率+目标+效果」。
// 任一方全灭立即结束；打满 BATTLE_MAX_ROUNDS 仍双方有兵则判平。
//
// 战报：整场战斗产出 rounds[].events（BattleEvent 事件流），是战斗动画/回放/战报/统计的唯一数据源。
//
// 确定性：所有随机（选目标、发动判定、伤害浮动）都来自入参 seed 播种的 mulberry32，
// 同输入必同结果 —— 战报回放、离线结算、未来 PVP 校验都依赖这一点。
//
// 伤害公式（率土口径：绝对伤害，目标兵力只当血条、不参与自身减伤）：
//   攻击战力 = 攻击者当前兵力 × (1 + 攻击属性/150) × 战法倍率 × 兵种克制(仅普攻) × 浮动(95~105%)
//   绝对伤害 = 0.3 × 攻击战力 / (1 + 目标防御属性/150)     ← 减伤只看防御「属性」，与目标剩余兵力无关
//   夹取上下限：下限 = 当前兵力 × 5%（保证推进），上限 = 「入场兵力」× 80%（防满血一击秒杀，最少两击）
//   损失 = min(当前兵力, 绝对伤害)     ← 用入场兵力做上限 → 削到残血后能被一击收掉，不再挤牙膏长尾

import { BATTLE_MAX_ROUNDS, BATTLE_ROUND_ATTRITION, counterMult } from '../GameConstants.js'
import { getSkill, NORMAL_ATTACK, STATUSES, skillLevelAt } from './skills.js'

export const BATTLE_DMG_ATTR_DIVISOR = 150   // 属性对攻/防值的增幅分母（越小=属性差距越明显；100属性→×1.67）
export const BATTLE_DMG_RATE_MIN = 0.05      // 伤害下限 = 当前兵力 5%（保证战斗推进，不出 0 伤）
export const BATTLE_DMG_RATE_MAX = 0.80      // 伤害上限 = 「入场兵力」80%（防满血一击秒杀；残血仍可被收掉）
export const BATTLE_HEAL_RATE_MAX = 0.30     // 单次治疗上限 = 目标入场兵力 30%（避免一口满血）

/** mulberry32：确定性伪随机（同 seed 必同序列） */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * @typedef {{key?:string, name:string, atk:number, def:number, spd:number, int?:number,
 *            troops:number, troopType?:string, skillId?:string}} BattleUnit
 *
 * @param {BattleUnit[]} attackers 进攻方武将（1~N 名）
 * @param {BattleUnit[]} defenders 防守方武将（1~N 名）
 * @param {number} seed 战斗种子（同 seed 同输入必同结果）
 * @returns {{outcome:'win'|'lose'|'draw', exp:number,
 *            atkStart:number, defStart:number, atkLoss:number, defLoss:number,
 *            rounds:Array<{round:number, atkTroops:number, defTroops:number,
 *                          atkLoss:number, defLoss:number, events:BattleEvent[]}>,
 *            units:{atk:UnitResult[], def:UnitResult[]}}}
 * @typedef {Object} BattleEvent  {type, side?, actor?, actorKey?, target?, targetKey?, skill?,
 *   skillName?, value?, status?, statusName?, atkPow?, defPow?, counter?, ratio?, targetLeft?}
 * @typedef {Object} UnitResult  {key,name,start,troops,dealt,taken,skillFire,extra,control}
 */
export function resolveBattle(attackers, defenders, seed = 1) {
  const rand = mulberry32(seed || 1)
  const rate = (pct) => rand() * 100 < pct
  // 兵力一律取整入场：守军经回复后带小数，逐次取整损耗后小数残余抹不掉 → 假判平局、战报难看
  const mkUnits = (list, side) => list.map((u, i) => ({
    side, idx: i, key: u.key ?? `${side}${i}`, name: u.name,
    atk: u.atk || 0, def: u.def || 0, spd: u.spd || 0, int: u.int || 0,
    troopType: u.troopType || null, skillId: u.skillId || null, skillLv: u.skillLv || 1,
    start: Math.round(u.troops), troops: Math.round(u.troops),
    statuses: {},                       // statusId → 剩余可跳过次数（控制类）
    dots: [],                           // 持续伤害/易伤：[{name, dmg, duration, vuln}]（沙暴等）
    buffs:   { atk: [], def: [], int: [], spd: [] },   // 增益列表：[{value, duration}]
    debuffs: { atk: [], def: [], int: [], spd: [] },   // 减益列表：[{value, duration}]
    healed: 0,                          // 累计接受治疗量（doHeal 给目标累加）
    lifesteal: 0,                       // 累计吸血回复量（lifesteal 给自身累加）
    buffCast: 0, debuffCast: 0,         // 施加增益/减益次数
    conditionMet: 0,                    // 残血爆发等条件触发次数
    dealt: 0, taken: 0, skillFire: 0, extra: 0, control: 0,
  })).filter(u => u.start > 0)

  // 有效属性：基础属性 × (1 + 增益% + 减益%)，下限 0
  // 增益/减益百分比累加（如 +25% 与 +25% → +50%；+25% 与 -25% → 0%）
  const effAttr = (u, attr) => {
    const base = u[attr] || 0
    const mods = [...(u.buffs[attr] || []), ...(u.debuffs[attr] || [])]
    const modSum = mods.reduce((s, m) => s + m.value, 0)
    return Math.max(0, base * (1 + modSum / 100))
  }
  const atkUnits = mkUnits(attackers, 'atk')
  const defUnits = mkUnits(defenders, 'def')

  const sum = (units) => units.reduce((s, u) => s + u.troops, 0)
  const alive = (units) => units.filter(u => u.troops > 0)
  const atkStart = sum(atkUnits)
  const defStart = sum(defUnits)
  const rounds = []

  // 守军空虚：不经交战直接判胜（exp 只给基础 50）
  if (defStart <= 0) {
    return {
      outcome: 'win', exp: 50, atkStart, defStart, atkLoss: 0, defLoss: 0, rounds,
      units: { atk: unitResults(atkUnits), def: unitResults(defUnits) },
    }
  }

  // 目标当前「兵刃易伤」加成（沙暴等 dot 记在 dots[].vuln 上；取最强，不叠加）
  const bianrenVuln = (target) => target.dots.reduce((m, d) => Math.max(m, d.vuln || 0), 0)

  // 单次命中结算（率土绝对伤害）。attribute 决定伤害类型：int=谋略，其余(武/速)=兵刃。
  // 兵刃伤害额外吃目标的「兵刃易伤」；谋略伤害不吃。lifesteal 按本次伤害回血。
  const resolveHit = (skill, u, target, attribute, mult, useCounter, events) => {
    if (target.troops <= 0) return
    const attrVal = effAttr(u, attribute)                  // buff/debuff 折算后的攻击属性
    const defVal  = effAttr(target, 'def')                 // 减益后目标的有效统率
    const counter = useCounter ? counterMult(u.troopType, target.troopType) : 1
    const roll = 0.95 + rand() * 0.10
    const troopsBefore = target.troops
    const isStrategy = attribute === 'int'                 // int=谋略，武/速=兵刃
    const vuln = (!isStrategy) ? (1 + bianrenVuln(target)) : 1
    // 攻击战力：攻击方兵力 × 属性折算 × 战法倍率 × 兵种克制 × 浮动（率土口径：输出由攻击方决定）
    const atkPow = u.troops * (1 + attrVal / BATTLE_DMG_ATTR_DIVISOR) * mult * counter * roll
    // 绝对伤害：战力经目标「统率」减免（目标兵力不参与减免 → 残血可被一击收掉）× 兵刃易伤
    let dmg = BATTLE_ROUND_ATTRITION * atkPow / (1 + defVal / BATTLE_DMG_ATTR_DIVISOR) * vuln
    // 上限 = 入场兵力 80%（防满血秒杀，最少两击；按入场兵力算 → 残血可收掉）；下限 = 当前兵力 5%
    dmg = Math.min(BATTLE_DMG_RATE_MAX * target.start, Math.max(BATTLE_DMG_RATE_MIN * troopsBefore, dmg))
    const loss = Math.min(troopsBefore, Math.max(1, Math.round(dmg)))
    target.troops -= loss
    u.dealt += loss
    target.taken += loss
    const ratio = loss / (troopsBefore || 1)               // 展示用：削掉当前兵力比例（1.00=击杀）
    events.push({
      type: 'damage', side: u.side, actor: u.name, actorKey: u.key,
      target: target.name, targetKey: target.key, skill: skill.id, skillName: skill.name,
      dmgType: isStrategy ? '谋略' : '兵刃',
      value: loss, atkPow, defStat: Math.round(defVal), counter, ratio, targetLeft: target.troops,
    })
    if (skill.lifesteal && loss > 0) {                     // 吸血：按伤害回血（不超过入场兵力）
      const before = u.troops
      u.troops = Math.min(u.start, u.troops + Math.round(loss * skill.lifesteal))
      const real = u.troops - before
      if (real > 0) {
        u.lifesteal += real
        events.push({ type: 'lifesteal', side: u.side, actor: u.name, actorKey: u.key,
          skill: skill.id, skillName: skill.name, value: real, targetLeft: u.troops })
      }
    }
    if (target.troops <= 0) {
      events.push({ type: 'death', side: target.side, actor: target.name, actorKey: target.key })
    }
  }

  // 一次攻击：随机取 min(count, 存活数) 个不重复目标，逐一结算。
  // hits：多属性命中（破甲=兵刃+谋略）；缺省单次命中，属性取 skill.attribute。
  const doAttack = (skill, u, events) => {
    const enemies = alive(u.side === 'atk' ? defUnits : atkUnits)
    if (!enemies.length) return
    const count = Math.min(skill.targetCount || 1, enemies.length)
    const pool = enemies.slice()
    // condition：残血爆发（自身兵力 < 入场 50% 时倍率 ×conditionMult）
    let mult = skill.mult || 1
    if (skill.condition === 'low_hp' && u.troops < u.start * 0.5) {
      mult *= (skill.conditionMult || 1.5)
      u.conditionMet++
      events.push({ type: 'condition_met', side: u.side, actor: u.name, actorKey: u.key,
        condition: skill.condition, conditionMult: skill.conditionMult || 1.5 })
    }
    const hits = skill.hits || [{ attribute: skill.attribute, useCounter: skill.useCounter }]
    for (let n = 0; n < count; n++) {
      const target = pool.splice(Math.floor(rand() * pool.length), 1)[0]
      for (const h of hits) resolveHit(skill, u, target, h.attribute, mult, h.useCounter ?? skill.useCounter, events)
    }
  }

  // 持续伤害/易伤施加（沙暴）：给随机 count 名敌人挂 dot（每回合造成快照伤害 + 兵刃易伤），刷新取 max。
  const doDot = (skill, u, events) => {
    const enemies = alive(u.side === 'atk' ? defUnits : atkUnits)
    if (!enemies.length) return
    const count = Math.min(skill.targetCount || 1, enemies.length)
    const pool = enemies.slice()
    const attrVal = effAttr(u, skill.attribute)            // int（受智力影响）
    for (let n = 0; n < count; n++) {
      const target = pool.splice(Math.floor(rand() * pool.length), 1)[0]
      const defVal = effAttr(target, 'def')
      // 每回合伤害快照（率土绝对伤害口径，施加时定值），不随后续兵力/属性变化
      const tickDmg = BATTLE_ROUND_ATTRITION * u.troops * (1 + attrVal / BATTLE_DMG_ATTR_DIVISOR) * (skill.mult || 1) / (1 + defVal / BATTLE_DMG_ATTR_DIVISOR)
      const dur = skill.duration || 2
      const existing = target.dots.find(d => d.name === skill.status)
      if (existing) {
        existing.dmg = Math.max(existing.dmg, tickDmg)
        existing.duration = Math.max(existing.duration, dur)
        existing.vuln = skill.vulnPhysical || 0
      } else {
        target.dots.push({ name: skill.status, dmg: tickDmg, duration: dur, vuln: skill.vulnPhysical || 0 })
      }
      u.debuffCast++
      const actualDur = existing ? existing.duration : dur
      events.push({ type: 'status_add', side: target.side, actor: target.name, actorKey: target.key,
        status: skill.status, statusName: STATUSES[skill.status]?.name || skill.status, value: actualDur })
    }
  }

  // 回合末：所有 dot 造成一次持续伤害并倒计时；<=0 时移除（易伤随之消失）
  const tickDots = (events) => {
    for (const u of [...atkUnits, ...defUnits]) {
      if (u.troops <= 0) continue
      for (let i = u.dots.length - 1; i >= 0; i--) {
        const d = u.dots[i]
        if (u.troops > 0) {
          // dot 伤害与直接伤害保持一致：下限为当前兵力 5%，上限为入场兵力 80%
          const raw = Math.min(BATTLE_DMG_RATE_MAX * u.start, Math.max(BATTLE_DMG_RATE_MIN * u.troops, d.dmg))
          const loss = Math.min(u.troops, Math.max(1, Math.round(raw)))
          u.troops -= loss
          u.taken += loss
          events.push({ type: 'dot_damage', side: u.side, actor: u.name, actorKey: u.key,
            status: d.name, statusName: STATUSES[d.name]?.name || d.name, value: loss, targetLeft: u.troops })
          if (u.troops <= 0) events.push({ type: 'death', side: u.side, actor: u.name, actorKey: u.key })
        }
        if (--d.duration <= 0) {
          events.push({ type: 'status_remove', side: u.side, actor: u.name, actorKey: u.key,
            status: d.name, statusName: STATUSES[d.name]?.name || d.name })
          u.dots.splice(i, 1)
        }
      }
    }
  }

  // 治疗：从己方存活者中筛未满血者，随机选 count 个回复兵力。
  // 治疗量公式与伤害对称：troops × (1 + attr/150) × mult × 0.3，确保不会过强。
  const doHeal = (skill, u, events) => {
    const allies = alive(u.side === 'atk' ? atkUnits : defUnits)
      .filter(a => a.troops < a.start)              // 仅未满血者
    if (!allies.length) return
    const count = Math.min(skill.targetCount || 1, allies.length)
    const pool = allies.slice()
    const attrVal = effAttr(u, skill.attribute)
    for (let n = 0; n < count; n++) {
      const target = pool.splice(Math.floor(rand() * pool.length), 1)[0]
      let heal = u.troops * (1 + attrVal / BATTLE_DMG_ATTR_DIVISOR) * (skill.mult || 1) * BATTLE_ROUND_ATTRITION
      // 单次治疗不能超过目标入场兵力的 30%，避免高智力/高兵力时一口回满
      heal = Math.min(heal, BATTLE_HEAL_RATE_MAX * target.start)
      const before = target.troops
      target.troops = Math.min(target.start, target.troops + Math.round(heal))
      const real = target.troops - before
      if (real > 0) {
        target.healed += real
        events.push({ type: 'heal', side: target.side, actor: target.name, actorKey: target.key,
          skill: skill.id, skillName: skill.name, value: real, targetLeft: target.troops })
      }
    }
  }

  // 增益：随机选 count 名我军，给 buffAttr 加 buffValue%，持续 duration 回合
  // 用剩余回合数模型：duration=2 表示当回合 + 下一回合；回合末统一 -1，<=0 时移除
  const doBuff = (skill, u, events, side = 'ally') => {
    const targets = side === 'ally'
      ? alive(u.side === 'atk' ? atkUnits : defUnits)
      : alive(u.side === 'atk' ? defUnits : atkUnits)
    if (!targets.length) return
    // 战报统计：发动者记一次「增益/减益施放」（按施放次数计，不按目标数）
    if (side === 'ally') u.buffCast++
    else u.debuffCast++
    const count = Math.min(skill.targetCount || 1, targets.length)
    const pool = targets.slice()
    for (let n = 0; n < count; n++) {
      const target = pool.splice(Math.floor(rand() * pool.length), 1)[0]
      const list = side === 'ally' ? target.buffs[skill.buffAttr] : target.debuffs[skill.buffAttr]
      // 同属性增益/减益：取「|value| 最强」覆盖策略（不累加），避免不同 value 叠加成变态数值。
      // 新 |value| ≥ 已有 |value| → 用新值覆盖并刷新 duration；
      // 新 |value| < 已有 |value| → 仅刷新 duration（不削弱已有更强效果）。
      const newAbs = Math.abs(skill.buffValue)
      const strongest = list[0]
      if (!strongest) {
        list.push({ value: skill.buffValue, duration: skill.duration })
      } else if (newAbs >= Math.abs(strongest.value)) {
        strongest.value = skill.buffValue
        strongest.duration = Math.max(strongest.duration, skill.duration)
      } else {
        strongest.duration = Math.max(strongest.duration, skill.duration)
      }
      events.push({
        type: side === 'ally' ? 'buff_add' : 'debuff_add',
        side: target.side, actor: target.name, actorKey: target.key,
        skill: skill.id, skillName: skill.name,
        attr: skill.buffAttr, value: skill.buffValue, duration: skill.duration,
      })
    }
  }
  // 减益：目标改为敌军
  const doDebuff = (skill, u, events) => doBuff(skill, u, events, 'enemy')

  // 回合末结算：所有 buff/debuff duration -= 1，<=0 时移除
  const tickBuffs = (events) => {
    for (const u of [...atkUnits, ...defUnits]) {
      if (u.troops <= 0) continue
      for (const store of [u.buffs, u.debuffs]) {
        for (const attr of Object.keys(store)) {
          const list = store[attr]
          for (let i = list.length - 1; i >= 0; i--) {
            list[i].duration -= 1
            if (list[i].duration <= 0) {
              events.push({ type: 'mod_expire', side: u.side, actor: u.name, actorKey: u.key,
                attr, value: list[i].value })
              list.splice(i, 1)
            }
          }
        }
      }
    }
  }

  // 施加控制状态：给随机 count 个存活敌人挂状态。
  // 同状态刷新取 max（不累加），防止连续命中导致超长控制（见 docs/slg-战法升级与扩展设计.md 第二章）。
  const doControl = (skill, u, events) => {
    const enemies = alive(u.side === 'atk' ? defUnits : atkUnits)
    if (!enemies.length) return
    const count = Math.min(skill.targetCount || 1, enemies.length)
    const pool = enemies.slice()
    for (let n = 0; n < count; n++) {
      const target = pool.splice(Math.floor(rand() * pool.length), 1)[0]
      const dur = skill.duration || 1
      target.statuses[skill.status] = Math.max(target.statuses[skill.status] || 0, dur)
      u.control++
      events.push({
        type: 'status_add', side: target.side, actor: target.name, actorKey: target.key,
        status: skill.status, statusName: STATUSES[skill.status]?.name || skill.status,
        value: dur,
      })
    }
  }

  const bothAlive = () => alive(atkUnits).length && alive(defUnits).length

  for (let round = 1; round <= BATTLE_MAX_ROUNDS && bothAlive(); round++) {
    // 每回合重排存活者：有效速度高者先动（含 spd 增益/减益，未来支持 spd 类战法影响行动顺序）；
    // 平速攻方优先，同方按入场顺序
    const order = [...alive(atkUnits), ...alive(defUnits)].sort((a, b) =>
      (effAttr(b, 'spd') - effAttr(a, 'spd')) ||
      (a.side !== b.side ? (a.side === 'atk' ? -1 : 1) : a.idx - b.idx))
    const events = []
    const atkBefore = sum(atkUnits), defBefore = sum(defUnits)

    for (const u of order) {
      if (u.troops <= 0) continue                          // 本回合先手已把它打死
      // ① 控制检查：有跳过类状态则消耗一层、跳过整个行动
      const skipStatus = Object.keys(u.statuses).find(s => STATUSES[s]?.skip && u.statuses[s] > 0)
      if (skipStatus) {
        events.push({ type: 'status_skip', side: u.side, actor: u.name, actorKey: u.key,
          status: skipStatus, statusName: STATUSES[skipStatus]?.name || skipStatus })
        if (--u.statuses[skipStatus] <= 0) {
          delete u.statuses[skipStatus]
          events.push({ type: 'status_remove', side: u.side, actor: u.name, actorKey: u.key,
            status: skipStatus, statusName: STATUSES[skipStatus]?.name || skipStatus })
        }
        continue
      }
      if (!alive(u.side === 'atk' ? defUnits : atkUnits).length) break

      events.push({ type: 'action_start', side: u.side, actor: u.name, actorKey: u.key })
      // 按武将携带等级解析战法实际数值（rate/mult/duration 随等级成长）
      const rawSkill = u.skillId ? getSkill(u.skillId) : null
      const skill = rawSkill ? skillLevelAt(rawSkill, u.skillLv || 1) : null

      // ② 前置主动战法
      if (skill && skill.timing === 'beforeAction') {
        if (rate(skill.rate)) {
          u.skillFire++
          events.push({ type: 'skill_trigger', side: u.side, actor: u.name, actorKey: u.key,
            skill: skill.id, skillName: skill.name })
          if (skill.effect === 'damage')        doAttack(skill, u, events)
          else if (skill.effect === 'control')  doControl(skill, u, events)
          else if (skill.effect === 'heal')     doHeal(skill, u, events)
          else if (skill.effect === 'buff')     doBuff(skill, u, events)
          else if (skill.effect === 'debuff')   doDebuff(skill, u, events)
          else if (skill.effect === 'dot')      doDot(skill, u, events)
        } else {
          events.push({ type: 'skill_failed', side: u.side, actor: u.name, actorKey: u.key,
            skill: skill.id, skillName: skill.name })
        }
      }

      // ③ 普通攻击（恒定发生，敌方尚存活时）
      if (alive(u.side === 'atk' ? defUnits : atkUnits).length) {
        events.push({ type: 'normal_attack', side: u.side, actor: u.name, actorKey: u.key })
        doAttack(NORMAL_ATTACK, u, events)

        // ④ 普攻后追击战法（连击/追击/横扫）：追加一次带倍率的普攻（受兵种克制）
        if (skill && skill.timing === 'afterAttack' && skill.effect === 'extra_attack' && rate(skill.rate)) {
          u.extra++
          events.push({ type: 'extra_attack', side: u.side, actor: u.name, actorKey: u.key,
            skill: skill.id, skillName: skill.name })
          if (alive(u.side === 'atk' ? defUnits : atkUnits).length) {
            doAttack({ ...NORMAL_ATTACK, mult: skill.mult || 1 }, u, events)
          }
        }
      }

      events.push({ type: 'action_end', side: u.side, actor: u.name, actorKey: u.key })
      if (!bothAlive()) break
    }

    // 回合末：先结算持续伤害(dot)，再给 buff/debuff 倒计时（events 流追加 dot_damage / mod_expire）
    if (bothAlive()) { tickDots(events); tickBuffs(events) }

    rounds.push({
      round,
      atkTroops: sum(atkUnits), defTroops: sum(defUnits),
      atkLoss: atkBefore - sum(atkUnits), defLoss: defBefore - sum(defUnits),
      events,
    })
  }

  const atkLeft = sum(atkUnits), defLeft = sum(defUnits)
  const outcome = defLeft <= 0 ? 'win' : (atkLeft <= 0 ? 'lose' : 'draw')
  const atkLoss = atkStart - atkLeft
  const defLoss = defStart - defLeft
  const expBase = outcome === 'win' ? 100 : (outcome === 'draw' ? 50 : 20)
  const exp = Math.round(defLoss * 0.5) + expBase

  return {
    outcome, exp, atkStart, defStart, atkLoss, defLoss, rounds,
    units: { atk: unitResults(atkUnits), def: unitResults(defUnits) },
  }
}

function unitResults(units) {
  return units.map(u => ({
    key: u.key, name: u.name, start: u.start, troops: u.troops,
    dealt: u.dealt, taken: u.taken, healed: u.healed, lifesteal: u.lifesteal,
    skillFire: u.skillFire, extra: u.extra, control: u.control,
    buffCast: u.buffCast, debuffCast: u.debuffCast, conditionMet: u.conditionMet,
  }))
}
