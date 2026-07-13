// 门派 PK · 梦幻西游风 - 等级与经验系统
//
// 经验公式来源：17173《梦幻西游每级升级与每级师门经验列表》(端游)
//   https://xyq.17173.com/player/newer34.shtml
// 对该表 20/25/30/40/45/50 级的数据做三次多项式拟合，得到精确闭式解：
//
//   expToNext(L) = ceil(4.8·L³ + 14.4·L² + 50.4·L + 40)
//
// 逐点验算（左为公式值，右为原表值）：
//   L=20 → 45208   / 45208     L=21 → 51901.6 →51902 / 51902
//   L=25 → 85300   / 85300     L=26 → 95449.6 →95450 / 95450
//   L=27 → 106376.8→106377     L=29 → 130679.2→130680 / 130680
//   L=30 → 144112  / 144112    L=31 → 158437.6→158438 / 158438
//   L=40 → 332296  / 332296    L=45 → 468868  / 468868
//   L=50 → 638560  / 638560
// 全部命中，原表就是本式向上取整。

import { RACES } from './GameConstants.js'

export const LEVEL_MIN = 1
export const LEVEL_MAX = 109        // 端游 109 级为本作上限（与技能参考文档一致）

/** 每升 1 级五维各自动 +2（对应端游"每级 10 点潜力"均分到五项） */
export const ATTR_PER_LEVEL = 2

/**
 * 从 level 升到 level+1 所需经验。满级返回 Infinity。
 * @param {number} level
 * @returns {number}
 */
export function expToNext(level) {
  if (level >= LEVEL_MAX) return Infinity
  const L = level
  return Math.ceil(4.8 * L * L * L + 14.4 * L * L + 50.4 * L + 40)
}

/**
 * 种族成长率：每升 1 级，各面板属性在门派 base 之上按此比例线性累加。
 *
 *   stat(L) = round(base × (1 + rate × (L - 1)))
 *
 * 之所以用"占 base 的百分比"而不是参考文档里的绝对成长值（如魔族 1 体质 = 6 血），
 * 是因为门派 base 是为 1v1 平衡手调的（大唐 ATK 130 / 龙宫 MATK 130）。
 * 若改用绝对值，攻击成长（约 1.3/级）会被气血成长（约 10/级）远远甩开，
 * 高等级战斗会退化成互相磨血的拉锯。按比例成长可保证 TTK 跨等级基本恒定。
 *
 * 各族 rate 的相对高低严格对应参考文档的种族画像：
 *   魔族：体质/力量成长高，耐力/敏捷成长低  → hp/atk/matk 高，def/mdef/spd 低
 *   仙族：魔力/耐力成长高，体质/力量成长低  → mp/def/mdef 高，hp/atk 低
 *   人族：全属性均衡，无专长无短板          → 全部取中位 0.040
 * 三族 rate 总和接近，保证整体强度不失衡，只改变属性侧写。
 */
export const RACE_GROWTH = {
  人: { hp: 0.040, mp: 0.040, atk: 0.040, matk: 0.040, def: 0.040, mdef: 0.040, spd: 0.040 },
  魔: { hp: 0.048, mp: 0.034, atk: 0.046, matk: 0.046, def: 0.032, mdef: 0.032, spd: 0.034 },
  仙: { hp: 0.034, mp: 0.048, atk: 0.032, matk: 0.044, def: 0.048, mdef: 0.046, spd: 0.040 },
}

const STAT_KEYS = ['hp', 'mp', 'atk', 'matk', 'def', 'mdef', 'spd']

/**
 * 按门派 base + 种族成长率 + 等级，算出该角色的面板属性。
 * @param {object} faction 门派数据（需含 base）
 * @param {string} raceId  '人' | '仙' | '魔'
 * @param {number} level
 * @returns {{hp:number,mp:number,atk:number,matk:number,def:number,mdef:number,spd:number}}
 */
export function computeStats(faction, raceId, level) {
  const growth = RACE_GROWTH[raceId] || RACE_GROWTH['人']
  const levelsGained = Math.max(0, level - 1)
  const stats = {}
  for (const key of STAT_KEYS) {
    stats[key] = Math.round(faction.base[key] * (1 + growth[key] * levelsGained))
  }
  return stats
}

/**
 * 该等级下的五维属性（体质/魔力/力量/耐力/敏捷），仅用于面板展示。
 * @param {string} raceId
 * @param {number} level
 */
export function computeAttributes(raceId, level) {
  const race = RACES.find((r) => r.id === raceId)
  if (!race) return {}
  const gained = Math.max(0, level - 1) * ATTR_PER_LEVEL
  const out = {}
  for (const [k, v] of Object.entries(race.stats)) out[k] = v + gained
  return out
}

// ── 经验结算 ────────────────────────────────────────────────────────────────

/** 胜负对应的经验系数：约 3 场胜利升 1 级 */
const RESULT_EXP_RATIO = { win: 0.34, draw: 0.12, lose: 0.06 }

/**
 * 单场战斗的经验奖励。以"当前等级升级所需经验"为基数，等级差做修正。
 * @param {'win'|'draw'|'lose'} outcome
 * @param {number} playerLevel
 * @param {number} enemyLevel
 * @returns {number}
 */
export function expReward(outcome, playerLevel, enemyLevel) {
  const ratio = RESULT_EXP_RATIO[outcome] ?? 0
  if (ratio === 0) return 0
  // 满级后经验无处可加（applyExp 会丢弃），直接返回 0，免得结算面板显示一个假数字
  if (playerLevel >= LEVEL_MAX) return 0
  const base = expToNext(playerLevel)
  // 打高等级敌人多给，打低等级敌人少给
  const diffMult = Math.min(2, Math.max(0.4, 1 + (enemyLevel - playerLevel) * 0.15))
  return Math.max(1, Math.round(base * ratio * diffMult))
}

/**
 * 把经验加到角色上，处理连续升级。不修改入参。
 * @param {{level:number, exp:number}} character
 * @param {number} gained
 * @returns {{level:number, exp:number, levelsGained:number}}
 */
export function applyExp(character, gained) {
  let level = character.level
  let exp = character.exp + Math.max(0, gained)
  let levelsGained = 0
  while (level < LEVEL_MAX && exp >= expToNext(level)) {
    exp -= expToNext(level)
    level += 1
    levelsGained += 1
  }
  if (level >= LEVEL_MAX) exp = 0   // 满级不再累计
  return { level, exp, levelsGained }
}

/**
 * 敌方等级：跟随玩家等级 ±1，保证战斗强度不脱节。
 * @param {number} playerLevel
 * @param {() => number} [rand] 注入随机源便于测试
 */
export function rollEnemyLevel(playerLevel, rand = Math.random) {
  const deltas = [-1, 0, 0, 1]
  const delta = deltas[Math.floor(rand() * deltas.length)] ?? 0
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, playerLevel + delta))
}
