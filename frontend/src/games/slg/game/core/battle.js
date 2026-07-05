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
// 伤害公式（docs/slg-战斗和战报.md）：
//   攻击值 = 攻击者当前兵力 × (1 + 对应属性/300)          属性：普攻取武力、战法按 skill.attribute
//   最终攻击 = 攻击值 × 倍率 × 兵种克制(仅普攻) × 浮动(95%~105%)
//   防御值 = 目标当前兵力 × (1 + 防御/300)
//   伤害率 = Clamp(5%, 0.3 × 最终攻击/防御值, 80%)，损失 = 目标当前兵力 × 伤害率（存活时保底 -1）

import { BATTLE_MAX_ROUNDS, BATTLE_ROUND_ATTRITION, counterMult } from '../GameConstants.js'
import { getSkill, NORMAL_ATTACK, STATUSES } from './skills.js'

export const BATTLE_DMG_ATTR_DIVISOR = 300   // 属性对攻/防值的增幅分母
export const BATTLE_DMG_RATE_MIN = 0.05      // 单次攻击最低损失 5% 兵力
export const BATTLE_DMG_RATE_MAX = 0.80      // 单次攻击最高损失 80% 兵力（防一击秒杀）

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
    troopType: u.troopType || null, skillId: u.skillId || null,
    start: Math.round(u.troops), troops: Math.round(u.troops),
    statuses: {},                       // statusId → 剩余可跳过次数
    dealt: 0, taken: 0, skillFire: 0, extra: 0, control: 0,
  })).filter(u => u.start > 0)
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

  // 一次攻击：从对方存活者随机取 min(count, 存活数) 个不重复目标，逐一结算伤害
  const doAttack = (skill, u, events) => {
    const enemies = alive(u.side === 'atk' ? defUnits : atkUnits)
    if (!enemies.length) return
    const count = Math.min(skill.targetCount || 1, enemies.length)
    const pool = enemies.slice()
    for (let n = 0; n < count; n++) {
      const target = pool.splice(Math.floor(rand() * pool.length), 1)[0]
      const attrVal = u[skill.attribute] || 0
      const counter = skill.useCounter ? counterMult(u.troopType, target.troopType) : 1
      const roll = 0.95 + rand() * 0.10
      const atkPow = u.troops * (1 + attrVal / BATTLE_DMG_ATTR_DIVISOR) * (skill.mult || 1) * counter * roll
      const defPow = target.troops * (1 + target.def / BATTLE_DMG_ATTR_DIVISOR)
      const ratio = Math.min(BATTLE_DMG_RATE_MAX,
        Math.max(BATTLE_DMG_RATE_MIN, BATTLE_ROUND_ATTRITION * atkPow / defPow))
      const loss = Math.min(target.troops, Math.max(1, Math.round(target.troops * ratio)))
      target.troops -= loss
      u.dealt += loss
      target.taken += loss
      events.push({
        type: 'damage', side: u.side, actor: u.name, actorKey: u.key,
        target: target.name, targetKey: target.key, skill: skill.id, skillName: skill.name,
        value: loss, atkPow, defPow, counter, ratio, targetLeft: target.troops,
      })
      if (target.troops <= 0) {
        events.push({ type: 'death', side: target.side, actor: target.name, actorKey: target.key })
      }
    }
  }

  // 施加控制状态：给随机 count 个存活敌人挂状态
  const doControl = (skill, u, events) => {
    const enemies = alive(u.side === 'atk' ? defUnits : atkUnits)
    if (!enemies.length) return
    const count = Math.min(skill.targetCount || 1, enemies.length)
    const pool = enemies.slice()
    for (let n = 0; n < count; n++) {
      const target = pool.splice(Math.floor(rand() * pool.length), 1)[0]
      target.statuses[skill.status] = (target.statuses[skill.status] || 0) + (skill.duration || 1)
      u.control++
      events.push({
        type: 'status_add', side: target.side, actor: target.name, actorKey: target.key,
        status: skill.status, statusName: STATUSES[skill.status]?.name || skill.status,
        value: skill.duration || 1,
      })
    }
  }

  const bothAlive = () => alive(atkUnits).length && alive(defUnits).length

  for (let round = 1; round <= BATTLE_MAX_ROUNDS && bothAlive(); round++) {
    // 每回合重排存活者：速度高者先动；平速攻方优先，同方按入场顺序
    const order = [...alive(atkUnits), ...alive(defUnits)].sort((a, b) =>
      (b.spd - a.spd) ||
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
      const skill = u.skillId ? getSkill(u.skillId) : null

      // ② 前置主动战法
      if (skill && skill.timing === 'beforeAction') {
        if (rate(skill.rate)) {
          u.skillFire++
          events.push({ type: 'skill_trigger', side: u.side, actor: u.name, actorKey: u.key,
            skill: skill.id, skillName: skill.name })
          if (skill.effect === 'damage') doAttack(skill, u, events)
          else if (skill.effect === 'control') doControl(skill, u, events)
        } else {
          events.push({ type: 'skill_failed', side: u.side, actor: u.name, actorKey: u.key,
            skill: skill.id, skillName: skill.name })
        }
      }

      // ③ 普通攻击（恒定发生，敌方尚存活时）
      if (alive(u.side === 'atk' ? defUnits : atkUnits).length) {
        events.push({ type: 'normal_attack', side: u.side, actor: u.name, actorKey: u.key })
        doAttack(NORMAL_ATTACK, u, events)

        // ④ 普攻后追击战法（连击）
        if (skill && skill.timing === 'afterAttack' && skill.effect === 'extra_attack' && rate(skill.rate)) {
          u.extra++
          events.push({ type: 'extra_attack', side: u.side, actor: u.name, actorKey: u.key,
            skill: skill.id, skillName: skill.name })
          if (alive(u.side === 'atk' ? defUnits : atkUnits).length) doAttack(NORMAL_ATTACK, u, events)
        }
      }

      events.push({ type: 'action_end', side: u.side, actor: u.name, actorKey: u.key })
      if (!bothAlive()) break
    }

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
    dealt: u.dealt, taken: u.taken, skillFire: u.skillFire, extra: u.extra, control: u.control,
  }))
}
