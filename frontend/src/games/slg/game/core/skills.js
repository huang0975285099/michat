// 九州征途 - 战法数据（数据驱动：普通攻击与所有战法统一抽象为 Skill）
// 战斗引擎（battle.js）只认 Skill 的「触发时机 + 属性 + 倍率 + 概率 + 目标 + 效果」，
// 新增战法只需在此加一条数据、无需改战斗逻辑（除非引入全新的 timing/effect）。
//
// V2.0：精简重复战法（17→7保留），新增 8 个新机制战法（治疗/增益/减益/吸血/残血爆发/高倍率突击），总数 15。
// 详见 docs/slg-战法升级与扩展设计.md
//
// 字段：
//   id           唯一 ID（= 仓库/绑定/存档的 key）
//   name         显示名
//   timing       触发时机：'beforeAction'(行动前主动战法) | 'onAttack'(普通攻击本体) | 'afterAttack'(普攻后追击)
//   rate         发动概率（%）；普通攻击本体恒为 100
//   rateStep     每升 1 级概率增加量（%），通常 +2
//   attribute    伤害/治疗取哪项属性算攻击值：'atk'(武力) | 'int'(智力) | 'spd'(速度) | 'def'(统率)
//   mult         伤害/治疗倍率
//   multStep     每升 1 级倍率增加量，按档位：单体伤害 0.05 / 群体伤害 0.03 / 追击 0.025
//   target       目标类型：'random_enemy' | 'random_ally'（治疗/增益用） | 'self'
//   targetCount  目标数量（超过存活数时只打存活者，不选尸体、不重复）
//   effect       'damage'(伤害) | 'control'(施加状态) | 'extra_attack'(追加一次普攻)
//                | 'heal'(治疗) | 'buff'(增益我军属性) | 'debuff'(减益敌军属性)
//   status       control 用：施加的状态 ID
//   duration     status 持续回合（也用作 buff/debuff 持续回合）
//   durationScaleLevels  控制/增益持续成长的等级节点数组（如 [5,10] 表示 Lv.5/Lv.10 各 +1 回合）
//   useCounter   伤害是否叠加兵种克制（枪克盾等 ×1.25/×0.85）。
//                普通攻击 true（吃克制）；主动战法一律 false（无视克制，符合率土惯例）。
//                注：连击/鬼神追加的是「普通攻击」，故那一下同样吃克制。此字段与描述末尾的括注一一对应。
//   lifesteal    吸血比例（0~1），伤害的一定比例回复自身兵力
//   condition    条件触发 ID，如 'low_hp'（自身兵力 < 50% 时倍率 ×conditionMult）
//   conditionMult 条件满足时的倍率系数（如 1.5）
//   buffAttr     增益/减益属性 ID：'atk'/'def'/'int'/'spd'
//   buffValue    增益/减益数值（百分比，如 25 表示 +25%/-25%）
//   cost         玉石兑换消耗
//   maxLevel     最大升级等级（10）
//   desc         玩家可见描述
//
// multStep 分档（控制群体成长速度，避免低倍率群体战法满级过强）：
//   单体伤害（targetCount=1, damage）   = 0.05   → Lv.10 倍率 = Lv.1 + 0.45
//   群体伤害（targetCount≥2, damage）   = 0.03   → Lv.10 倍率 = Lv.1 + 0.27
//   追击类（extra_attack）              = 0.025  → Lv.10 倍率 = Lv.1 + 0.225

export const NORMAL_ATTACK_ID = 'normal_attack'

export const SKILLS = {
  // ── 普通攻击（人人自带，不可升级、不进仓库）─────────────────────────────────
  normal_attack: {
    id: 'normal_attack', name: '普通攻击', timing: 'onAttack', rate: 100,
    attribute: 'atk', mult: 1.0, target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: true, desc: '对随机 1 名敌军造成 100% 武力伤害（受兵种克制影响）',
  },

  // ── 保留战法（7 个）─────────────────────────────────────────────────────────

  // 1. 力劈（替代挥砍/猛击/突刺，作为武力单体代表）
  lipi: {
    id: 'lipi', name: '力劈', timing: 'beforeAction', rate: 40, rateStep: 2,
    attribute: 'atk', mult: 1.0, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, cost: 20, maxLevel: 10,
    desc: '40% 概率对随机 1 名敌军造成 100% 武力伤害（无视兵种克制）',
  },

  // 2. 疾风（速度单体代表，替代践踏/突袭）
  jifeng: {
    id: 'jifeng', name: '疾风', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'spd', mult: 1.1, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, cost: 25, maxLevel: 10,
    desc: '35% 概率对随机 1 名敌军造成 110% 速度伤害（无视兵种克制）',
  },

  // 3. 火攻（智力单体代表，替代水攻/天雷）
  huogong: {
    id: 'huogong', name: '火攻', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'int', mult: 1.2, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, cost: 30, maxLevel: 10,
    desc: '35% 概率对随机 1 名敌军造成 120% 智力伤害（无视兵种克制）',
  },

  // 4. 箭雨（武力群体 3 目标）
  jianyu: {
    id: 'jianyu', name: '箭雨', timing: 'beforeAction', rate: 25, rateStep: 2,
    attribute: 'atk', mult: 0.5, multStep: 0.03,
    target: 'random_enemy', targetCount: 3,
    effect: 'damage', useCounter: false, cost: 30, maxLevel: 10,
    desc: '25% 概率对随机 3 名敌军各造成 50% 武力伤害（无视兵种克制）',
  },

  // 5. 落雷（智力群体 2 目标）
  luolei: {
    id: 'luolei', name: '落雷', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'int', mult: 0.55, multStep: 0.03,
    target: 'random_enemy', targetCount: 2,
    effect: 'damage', useCounter: false, cost: 30, maxLevel: 10,
    desc: '35% 概率对随机 2 名敌军各造成 55% 智力伤害（无视兵种克制）',
  },

  // 6. 连击（追击代表，替代追击/横扫）
  lianji: {
    id: 'lianji', name: '连击', timing: 'afterAttack', rate: 35, rateStep: 2,
    mult: 1.0, multStep: 0.025, useCounter: true,
    effect: 'extra_attack', cost: 20, maxLevel: 10,
    desc: '普通攻击后 35% 概率再追加一次普通攻击（追加的普攻同样受兵种克制影响）',
  },

  // 7. 谎报（唯一控制战法，替代威慑/迷阵/缴械）
  huangbao: {
    id: 'huangbao', name: '谎报', timing: 'beforeAction', rate: 30, rateStep: 2,
    attribute: 'int', target: 'random_enemy', targetCount: 1,
    effect: 'control', status: 'huangbao', duration: 1, durationScaleLevels: [10],
    cost: 20, maxLevel: 10,
    desc: '30% 概率使随机 1 名敌军进入谎报状态，跳过其下一次行动',
  },

  // ── 新增战法（8 个）─────────────────────────────────────────────────────────

  // 8. 青囊（智力治疗我军，新机制 heal）
  qingnang: {
    id: 'qingnang', name: '青囊', timing: 'beforeAction', rate: 30, rateStep: 2,
    attribute: 'int', mult: 1.5, multStep: 0.05,
    target: 'random_ally', targetCount: 1,
    effect: 'heal', useCounter: false, cost: 30, maxLevel: 10,
    desc: '30% 概率治疗随机 1 名我军，回复量 = 自身智力 × 1.5 倍兵力（无法超过入场兵力）',
  },

  // 9. 激励（武力增益我军武力，新机制 buff）
  jili: {
    id: 'jili', name: '激励', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'atk',
    target: 'random_ally', targetCount: 1,
    effect: 'buff', buffAttr: 'atk', buffValue: 25,
    duration: 2, durationScaleLevels: [5, 10],
    cost: 25, maxLevel: 10,
    desc: '35% 概率提升随机 1 名我军 25% 武力，持续 2 回合（Lv.5/Lv.10 各 +1 回合）',
  },

  // 10. 铁壁（统率增益我军统率，新机制 buff；用 def 属性发动）
  tiebi: {
    id: 'tiebi', name: '铁壁', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'def',
    target: 'random_ally', targetCount: 1,
    effect: 'buff', buffAttr: 'def', buffValue: 25,
    duration: 2, durationScaleLevels: [5, 10],
    cost: 25, maxLevel: 10,
    desc: '35% 概率提升随机 1 名我军 25% 统率，持续 2 回合（Lv.5/Lv.10 各 +1 回合）',
  },

  // 11. 破甲（智力减益敌军统率，新机制 debuff）
  pojia: {
    id: 'pojia', name: '破甲', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'int',
    target: 'random_enemy', targetCount: 1,
    effect: 'debuff', buffAttr: 'def', buffValue: -25,
    duration: 2, durationScaleLevels: [5, 10],
    cost: 25, maxLevel: 10,
    desc: '35% 概率降低随机 1 名敌军 25% 统率，持续 2 回合（Lv.5/Lv.10 各 +1 回合）',
  },

  // 12. 乱谋（智力减益敌军智力，新机制 debuff）
  luanmou: {
    id: 'luanmou', name: '乱谋', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'int',
    target: 'random_enemy', targetCount: 1,
    effect: 'debuff', buffAttr: 'int', buffValue: -25,
    duration: 2, durationScaleLevels: [5, 10],
    cost: 25, maxLevel: 10,
    desc: '35% 概率降低随机 1 名敌军 25% 智力，持续 2 回合（Lv.5/Lv.10 各 +1 回合）',
  },

  // 13. 嗜血（武力伤害 + 吸血，damage 变种）
  shixue: {
    id: 'shixue', name: '嗜血', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'atk', mult: 1.0, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, lifesteal: 0.3,
    cost: 30, maxLevel: 10,
    desc: '35% 概率对随机 1 名敌军造成 100% 武力伤害，并将 30% 伤害回复为自身兵力',
  },

  // 14. 背水（速度残血爆发，damage 变种 + condition）
  beishui: {
    id: 'beishui', name: '背水', timing: 'beforeAction', rate: 40, rateStep: 2,
    attribute: 'spd', mult: 1.0, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false,
    condition: 'low_hp', conditionMult: 1.5,
    cost: 25, maxLevel: 10,
    desc: '40% 概率对随机 1 名敌军造成 100% 速度伤害；自身兵力 < 50% 时倍率 ×1.5',
  },

  // 15. 鬼神（高倍率突击，extra_attack 变种）
  guishen: {
    id: 'guishen', name: '鬼神', timing: 'afterAttack', rate: 25, rateStep: 2,
    mult: 1.5, multStep: 0.025, useCounter: true,
    effect: 'extra_attack', cost: 30, maxLevel: 10,
    desc: '普通攻击后 25% 概率追加一次 150% 普攻伤害（受兵种克制影响）',
  },
}

// 状态定义：control 效果施加的状态。skip=true 表示无法行动。
// V2.0 收缩：仅保留 huangbao，删除 weishe/mizhen/jiaoxie。
export const STATUSES = {
  huangbao: { id: 'huangbao', name: '谎报', skip: true, desc: '无法行动' },
}

/** 玩家可绑定的战法（普通攻击不进仓库、人人自带，故排除） */
export const BINDABLE_SKILLS = Object.values(SKILLS).filter(s => s.id !== NORMAL_ATTACK_ID)

export function getSkill(id) { return SKILLS[id] || null }
export const NORMAL_ATTACK = SKILLS.normal_attack

/**
 * 按等级解析战法实际数值（rate/mult/duration 按 lv 成长）。
 * 返回 skill 的浅拷贝，原对象不变。普通攻击无升级字段，直接返回原对象。
 *
 * @param {object} skill SKILLS 中的战法定义
 * @param {number} lv 当前等级（1~maxLevel）
 * @returns {object} 带有等级修正后 rate/mult/duration 的战法副本
 */
export function skillLevelAt(skill, lv) {
  if (!skill) return skill
  // 普通攻击等无 maxLevel 的单位直接返回原对象
  if (!skill.maxLevel) return skill
  const r = { ...skill }
  if (skill.rateStep) r.rate = skill.rate + (lv - 1) * skill.rateStep
  if (skill.multStep) r.mult = (skill.mult || 1) + (lv - 1) * skill.multStep
  if (skill.durationScaleLevels && skill.duration) {
    r.duration = skill.duration + skill.durationScaleLevels.filter(l => lv >= l).length
  }
  return r
}

/** 属性中文名表（buff/debuff 显示用） */
const ATTR_CN = { atk: '武', def: '统', int: '智', spd: '速' }

/**
 * 战法在某等级的关键数值摘要（一行字符串，用于仓库/升级预览）。
 * 格式按 effect 分支：
 *   damage      → "40%/1.00x/1目标"
 *   heal        → "30%/1.50x/1我军"
 *   extra_attack→ "35%/1.00x追加"
 *   control     → "30%/1回合"
 *   buff        → "35%/+25%武/2回合"
 *   debuff      → "35%/-25%统/2回合"
 * 含 lifesteal 末尾追加 "/30%吸血"
 * 含 condition 末尾追加 "/残血×1.5"
 *
 * @param {object} skill SKILLS 中的战法定义
 * @param {number} lv 当前等级（1~maxLevel）
 * @returns {string} 摘要字符串
 */
export function skillStatLine(skill, lv) {
  if (!skill) return ''
  if (!skill.maxLevel) return ''                    // 普通攻击无摘要
  const s = skillLevelAt(skill, lv)
  const parts = [`${Math.round(s.rate)}%`]
  if (s.effect === 'damage' || s.effect === 'heal') {
    parts.push(`${(s.mult || 1).toFixed(2)}x`)
    if (s.targetCount > 1) parts.push(`${s.targetCount}${s.effect === 'heal' ? '我军' : '目标'}`)
  } else if (s.effect === 'extra_attack') {
    parts.push(`${(s.mult || 1).toFixed(2)}x追加`)
  } else if (s.effect === 'control') {
    parts.push(`${s.duration}回合`)
  } else if (s.effect === 'buff' || s.effect === 'debuff') {
    const attr = ATTR_CN[s.buffAttr] || s.buffAttr
    const sign = s.buffValue > 0 ? '+' : ''
    parts.push(`${sign}${s.buffValue}%${attr}`)
    parts.push(`${s.duration}回合`)
  }
  if (s.lifesteal) parts.push(`${Math.round(s.lifesteal * 100)}%吸血`)
  if (s.condition === 'low_hp') parts.push(`残血×${s.conditionMult}`)
  return parts.join('/')
}
