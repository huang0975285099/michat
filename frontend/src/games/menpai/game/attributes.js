// 门派 PK · 梦幻西游风 - 五维属性 → 面板属性推导（端游公式）
//
// 人物固定 109 级、师门技能固定 119 级（人物等级 + 10）。因此「满修炼 + 标准配装」
// 这一层退化为常数，不需要随等级插值 —— 这是固定等级方案最大的好处。
//
// 系数来源：docs/梦幻西游-人物属性参考.md 第四、五节（已用 0 级面板表反推校验）。
// 其中伤害系数采用「A 套」(0.7/0.8/0.6)；命中截距三族统一 30；魔族防御 1.4。

import { RACES } from './GameConstants.js'

export const CHAR_LEVEL = 109        // 人物等级（固定）
export const SKILL_LEVEL = 119       // 师门技能等级 = 人物等级 + 10

/** 五维属性名（顺序即 UI 展示顺序） */
export const ATTR_KEYS = ['体质', '魔力', '力量', '耐力', '敏捷']

/** 每升 1 级：五项各自动 +1，另给 5 点自由分配 */
const LEVELS_GAINED = CHAR_LEVEL - 1          // 108
export const AUTO_PER_ATTR = LEVELS_GAINED    // 108，洗点下限
export const FREE_POINTS = 5 * LEVELS_GAINED  // 540，玩家自由分配

/**
 * 三族面板换算系数。
 * 命中截距三族统一 30（原文档写魔族 27，与 0 级面板表矛盾，已修正）。
 * 防御魔族 1.4（原文档面板公式节写 1.3，与成长表节矛盾，已修正）。
 */
export const RACE_COEF = {
  人: { hp: 5, mp: 3, dmg: 0.7, dmgC: 34, hit: 2.0, def: 1.5 },
  魔: { hp: 6, mp: 2.5, dmg: 0.8, dmgC: 34, hit: 2.3, def: 1.4 },
  仙: { hp: 4.5, mp: 3.5, dmg: 0.6, dmgC: 40, hit: 1.7, def: 1.6 },
}
const HIT_CONST = 30

/**
 * 109 级「满修炼 + 标准配装」基准。所有角色一致，本作不做装备系统。
 *
 * 没有这一层，纯五维推导会崩：全力量大唐面板伤害 494，而对手气血只有 690（体质仅靠
 * 每级自动 +1），两刀就打死。端游正是靠强身术/强壮/武器/灵饰把气血与伤害同时抬起来的。
 * 数值取自参考文档第五节：强身术满级气血 ×2.4、强壮满级 +1440、冥想抬魔法上限。
 */
export const CULTIVATION = {
  hpMult: 2.4,      // 强身术满级 140 → 气血 ×(1 + 140%)
  hpFlat: 1440,     // 强壮满级 40 → 15 × 40 × 2.4
  mpMult: 2.0,      // 冥想
  atkFlat: 600,     // 武器伤害 + 太阳石
  defFlat: 300,     // 装备防御 + 月亮石
  spiritFlat: 150,  // 灵饰法伤/法防
  spdFlat: 60,      // 神速满级
}

const raceOf = (raceId) => RACES.find((r) => r.id === raceId)

/** 洗点下限：种族初始 + 每级自动 +1 累积。这部分不可分配 */
export function baseAttrs(raceId) {
  const race = raceOf(raceId)
  const out = {}
  for (const k of ATTR_KEYS) out[k] = race.stats[k] + AUTO_PER_ATTR
  return out
}

/** 空的自由加点方案 */
export function emptyAlloc() {
  const out = {}
  for (const k of ATTR_KEYS) out[k] = 0
  return out
}

export function spentPoints(alloc) {
  return ATTR_KEYS.reduce((sum, k) => sum + (alloc[k] || 0), 0)
}

export function unspentPoints(alloc) {
  return FREE_POINTS - spentPoints(alloc)
}

/** 最终五维 = 洗点下限 + 自由加点 */
export function finalAttrs(raceId, alloc) {
  const base = baseAttrs(raceId)
  const out = {}
  for (const k of ATTR_KEYS) out[k] = base[k] + (alloc[k] || 0)
  return out
}

/** 加点方案是否合法（非负、不超总点数） */
export function isValidAlloc(alloc) {
  if (!alloc || typeof alloc !== 'object') return false
  for (const k of ATTR_KEYS) {
    const v = alloc[k]
    if (!Number.isInteger(v) || v < 0) return false
  }
  return spentPoints(alloc) <= FREE_POINTS
}

/**
 * 五维 → 面板属性（端游公式，全部向下取整，与游戏内面板显示一致）
 * @returns {{hp,mp,atk,hit,def,spd,spirit,dodge}}
 */
export function derivePanel(raceId, attrs) {
  const c = RACE_COEF[raceId]
  const { 体质: con, 魔力: mag, 力量: str, 耐力: end, 敏捷: agi } = attrs

  const hpRaw = con * c.hp + 100
  const mpRaw = mag * c.mp + 80
  return {
    // 强身术是百分比加成、强壮是固定值，二者叠加即端游的气血构成
    hp: Math.floor(hpRaw * CULTIVATION.hpMult + CULTIVATION.hpFlat),
    mp: Math.floor(mpRaw * CULTIVATION.mpMult),
    atk: Math.floor(str * c.dmg + c.dmgC) + CULTIVATION.atkFlat,
    hit: Math.floor(str * c.hit + HIT_CONST),
    def: Math.floor(end * c.def) + CULTIVATION.defFlat,
    spd: Math.floor(con * 0.1 + str * 0.1 + end * 0.1 + agi * 0.7) + CULTIVATION.spdFlat,
    // 灵力是综合属性，同时决定法术伤害与法术防御（端游原版没有独立法伤/法防面板）
    spirit: Math.floor(con * 0.3 + mag * 0.7 + str * 0.4 + end * 0.2) + CULTIVATION.spiritFlat,
    dodge: agi,
  }
}

/** 面板 → BattleEngine 需要的字段（matk/mdef 都取灵力，因为端游灵力身兼二职） */
export function toEngineStats(panel) {
  return {
    hp: panel.hp, mp: panel.mp,
    atk: panel.atk, def: panel.def, spd: panel.spd,
    matk: panel.spirit, mdef: panel.spirit,
    hit: panel.hit, dodge: panel.dodge,
  }
}

/** 一步到位：种族 + 加点 → 引擎属性 */
export function computeStats(raceId, alloc) {
  return toEngineStats(derivePanel(raceId, finalAttrs(raceId, alloc)))
}
