// 门派 PK · 梦幻西游风 - 法术「师门技能项」
//
// 端游法术伤害 =（师门技能项 + 法伤 − 法防）× … ，技能项由**技能等级**决定，占绝对主导，
// 与面板攻击基数无关。这正是为什么低等级法系也能打动人 —— 伤害不靠乘面板。
// 本作人物固定 109 级 → 师门技能固定 119 级，故技能项是常数。
//
// 有官方/玩测曲线的法术用其原式（docs/menpai-pk-xyq.md 第九节）；其余法术（含必杀）
// 无公开曲线，用通用式按其在 factions.js 里的 power 折算，保留门派间相对强弱。

import { SKILL_LEVEL } from './attributes.js'

const L = SKILL_LEVEL   // 119

/** 有据可查的技能项曲线（技能等级 → 技能项），键为 factions.js 的 skill.id */
const CURVES = {
  lg_longteng: (x) => x * x / 120 + x * 1.5 + 55,   // 龙腾
  lg_longjuan: (x) => x * x / 144 + x * 1.4 + 35,   // 龙卷雨击
  hs_jjww: (x) => x * 1,                             // 唧唧歪歪（秒杀系，基数低）
  mw_sandmei: (x) => x * x / 100 + x * 2.3 + 50,    // 三昧真火
  mw_feisha: (x) => x * x / 120 + x * 1.5 + 30,     // 飞砂走石
  fc_wulei: (x) => x * x / 144 + x * 1.4 + 30,      // 五雷咒（借谆谆教诲式，单体基数）
}

// 通用式：power 1.0 的法术 ≈ 250 项，与上面几条曲线在 119 级的量级相当（119~465）
const GENERIC_K = 250

/**
 * 取某法术在固定技能等级下的「师门技能项」。
 * @param {object} skill
 * @returns {number}
 */
export function skillTerm(skill) {
  const curve = CURVES[skill.id]
  if (curve) return Math.round(curve(L))
  // 无曲线：按 power 折算（必杀 power 3.0 → 750，五雷 0.9 → 225，紧箍 0.3 → 75）
  return Math.round((skill.power || 1) * GENERIC_K)
}
