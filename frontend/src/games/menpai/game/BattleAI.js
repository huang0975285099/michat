// 门派 PK · 梦幻西游风 - PVE AI 决策（简单决策树）
// 详见 docs/menpai-pk-xyq.md 第六节。首期为门派策略 + 通用规则 + 随机扰动。

import { ActionType, SkillType, SkillCategory, Side, StatusType } from './GameConstants.js'

/**
 * @param {BattleEngine} engine
 * @param {string} side  AI 所在方（通常为 enemy）
 * @returns {{type: string, skill?: object}}
 */
export function decideAI(engine, side) {
  const unit = engine[side]
  const opp = engine[side === Side.PLAYER ? Side.ENEMY : Side.PLAYER]
  if (!unit.alive) return { type: ActionType.DEFEND }

  const skills = engine.getAvailableSkills(side)
  // 休息中/无可用技能：交给引擎的休息判定处理，这里给个安全占位动作
  if (skills.length === 0) return { type: ActionType.DEFEND }

  // 10% 随机扰动（从可用技能里随机选）
  if (Math.random() < 0.1 && skills.length > 0) {
    const s = skills[Math.floor(Math.random() * skills.length)]
    if (s.category === SkillCategory.ULTIMATE) return { type: ActionType.ULTIMATE, skill: s }
    return { type: ActionType.SKILL, skill: s }
  }

  // 1. HP < 30% 且有恢复技能 → 治疗
  if (unit.hp / unit.maxHp < 0.3) {
    const heal = skills.find((s) => s.selfHeal)
    if (heal) return { type: ActionType.SKILL, skill: heal }
    // 没治疗就防御
    return { type: ActionType.DEFEND }
  }

  // 2. 愤怒满 → 必杀
  const ult = skills.find((s) => s.category === SkillCategory.ULTIMATE)
  if (ult) return { type: ActionType.ULTIMATE, skill: ult }

  // 3. 门派策略
  const pick = pickByFaction(unit.faction.id, skills, unit, opp)
  if (pick) {
    if (pick.category === SkillCategory.ULTIMATE) return { type: ActionType.ULTIMATE, skill: pick }
    return { type: ActionType.SKILL, skill: pick }
  }

  // 4. 兜底：第一个可用技能
  const s = skills[0]
  if (!s || s.category === SkillCategory.NORMAL) return { type: ActionType.SKILL, skill: s }
  if (s.category === SkillCategory.ULTIMATE) return { type: ActionType.ULTIMATE, skill: s }
  return { type: ActionType.SKILL, skill: s }
}

/** 门派专属策略 */
function pickByFaction(factionId, skills, unit, opp) {
  const find = (id) => skills.find((s) => s.id === id)

  switch (factionId) {
    case 'datang':
      // HP>50% 优先横扫，否则后发制人/杀气诀
      if (unit.hp / unit.maxHp > 0.5) {
        return find('dt_hengsao') || find('dt_shaqi') || find('dt_shixue')
      }
      return find('dt_houfa') || find('dt_shaqi') || find('dt_shixue')

    case 'huasheng':
      // HP<70% 活血，<40% 推气过宫
      if (unit.hp / unit.maxHp < 0.4) return find('hs_tuqi') || find('hs_huoxue')
      if (unit.hp / unit.maxHp < 0.7) return find('hs_huoxue')
      return find('hs_jingang') || find('hs_jjww')

    case 'longgong':
      // 龙附 → 龙腾 → 龙卷雨击
      if (!hasBuff(unit, 'matk_up') && find('lg_longfu')) return find('lg_longfu')
      return find('lg_longjuan') || find('lg_longteng')

    case 'fangcun':
      // 先手失心符封法，再五雷咒
      if (!hasStatus(opp, 'seal_magic') && find('fc_shixin')) return find('fc_shixin')
      if (!hasStatus(opp, 'sleep') && find('fc_cuimian')) return find('fc_cuimian')
      return find('fc_wulei')

    case 'putuo':
      // 紧箍咒 → 五行咒法，HP<50% 普度众生
      if (unit.hp / unit.maxHp < 0.5 && find('pt_pudu')) return find('pt_pudu')
      if (!hasStatus(opp, 'poison') && find('pt_jingu')) return find('pt_jingu')
      return find('pt_wuxing')

    case 'mowang':
      // 飞砂走石优先，三昧真火补刀
      return find('mw_feisha') || find('mw_sandmei')

    case 'shituoling':
      // 先变身，再鹰击/连环击
      if (!unit.transform && find('st_bianshen')) return find('st_bianshen')
      return find('st_yingji') || find('st_shibo')

    default:
      return null
  }
}

function hasBuff(unit, type) { return unit.buffs.some((b) => b.type === type) }
function hasStatus(unit, type) { return unit.statuses.some((s) => s.type === type) }
