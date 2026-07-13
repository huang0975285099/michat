// 门派 PK · 梦幻西游风 - 7 门派数据
// 详见 docs/menpai-pk-xyq.md 第四节。技能命名沿用梦幻西游原味。
// 数值为 v0.1 草案，供平衡迭代。

import { SkillType, SkillCategory } from './GameConstants.js'

/**
 * 门派普攻（不耗 MP、无 CD、不受封印限制的保底行动）
 * 文档第六节：物理系 ATK×1.0，法系 MATK×0.8
 */
export function getNormalAttack(faction) {
  const phys = faction.base.atk >= faction.base.matk
  return {
    id: 'normal_attack', name: '普攻', category: SkillCategory.NORMAL,
    type: phys ? SkillType.PHYSICAL : SkillType.MAGICAL,
    mpCost: 0, power: phys ? 1.0 : 0.8,
    desc: phys ? '普通攻击（ATK×1.0）' : '普通攻击（MATK×0.8）',
  }
}

/**
 * @typedef {Object} Skill
 * @property {string} id               技能唯一 id
 * @property {string} name             显示名
 * @property {string} category         SkillCategory
 * @property {string} type             SkillType
 * @property {number} mpCost           MP 消耗（普攻/被动为 0）
 * @property {number} [angerCost]      愤怒消耗（仅必杀 150）
 * @property {number} [cooldown]       CD 回合数（无 CD 不填）
 * @property {number} power            威力倍率/基础值
 * @property {string} [desc]           描述（UI 显示）
 * @property {Object} [effect]         附加效果
 * @property {string} [effect.status]  附加异常状态
 * @property {number} [effect.statusTurns] 状态持续回合
 * @property {Object} [effect.buff]    附加增益/减益 { type, value, turns }
 * @property {boolean} [effect.hitStun] 命中即眩晕 1 回合（必杀用）
 * @property {boolean} [requiresTransform] 需要变身状态（狮驼）
 * @property {boolean} [cancelsTransform] 使用后取消变身（连环击）
 * @property {number} [hits]           多段攻击次数（横扫 3 / 连环 4）
 * @property {boolean} [alwaysHit]     必中
 * @property {boolean} [ignoreDef]     无视防御
 * @property {number} [ignoreDefRatio] 无视防御比例
 * @property {number} [critBonus]      暴击率加成
 * @property {boolean} [forceCrit]     必定暴击
 * @property {boolean} [selfHeal]      治疗自身
 * @property {boolean} [revive]        复活
 * @property {number} [delayedAction]  延迟行动回合（后发制人 1）
 */

/**
 * 门派列表。首期 7 门派齐全（Phase 2 内容），但 Phase 1 可只启用前 3 个。
 */
export const FACTIONS = [
  // ── 1. 大唐官府 ──────────────────────────────────────────────────────────
  {
    id: 'datang',
    name: '大唐官府',
    race: '人',
    role: '物理点杀',
    color: 0xc0392b,
    emoji: '⚔️',
    base: { hp: 1200, mp: 200, atk: 130, matk: 30, def: 60, mdef: 40, spd: 95 },
    skills: [
      {
        id: 'dt_hengsao', name: '横扫千军', category: SkillCategory.ACTIVE, type: SkillType.PHYSICAL,
        mpCost: 50, power: 0.8, hits: 3,
        desc: '连续攻击 3 次，休息 1 回合。HP>50% 才能用',
        restAfter: 1, hpGate: 0.5,
      },
      {
        id: 'dt_houfa', name: '后发制人', category: SkillCategory.ACTIVE, type: SkillType.PHYSICAL,
        mpCost: 30, power: 2.5,
        desc: '本回合防御，下回合自动攻击 ×2.5 且必中',
        delayedAction: 1, alwaysHit: true,
      },
      {
        id: 'dt_shaqi', name: '杀气诀', category: SkillCategory.ACTIVE, type: SkillType.BUFF,
        mpCost: 25,
        desc: '提升自身 ATK 20%，持续 3 回合',
        effect: { buff: { type: 'atk_up', value: 0.2, turns: 3 } },
      },
      {
        id: 'dt_shixue', name: '嗜血', category: SkillCategory.ACTIVE, type: SkillType.HEAL,
        mpCost: 20, power: 0.15,
        desc: '恢复自身 15% 最大 HP',
        selfHeal: true,
      },
      {
        id: 'dt_passive', name: '剑心通明', category: SkillCategory.PASSIVE, type: SkillType.BUFF,
        mpCost: 0,
        desc: '暴击率 +15%，暴击伤害 +20%',
        passive: { critRateBonus: 0.15, critMultBonus: 0.2 },
      },
      {
        id: 'dt_zhanlong', name: '斩龙诀', category: SkillCategory.ULTIMATE, type: SkillType.PHYSICAL,
        angerCost: 150, power: 3.0, ignoreDefRatio: 0.3,
        desc: '单体物理 ×3.0，无视 30% DEF',
      },
    ],
  },

  // ── 2. 化生寺 ──────────────────────────────────────────────────────────
  {
    id: 'huasheng', name: '化生寺', race: '人', role: '治疗辅助', color: 0xf39c12, emoji: '☸️',
    base: { hp: 1100, mp: 400, atk: 40, matk: 80, def: 55, mdef: 75, spd: 85 },
    skills: [
      {
        id: 'hs_jjww', name: '唧唧歪歪', category: SkillCategory.ACTIVE, type: SkillType.MAGICAL,
        mpCost: 30, power: 1.0, desc: '单体法术伤害 ×1.0',
      },
      {
        id: 'hs_huoxue', name: '活血', category: SkillCategory.ACTIVE, type: SkillType.HEAL,
        mpCost: 25, power: 1.5, desc: '恢复自身 HP = MATK × 1.5（歧黄之术·活血）', selfHeal: true,
      },
      {
        id: 'hs_tuqi', name: '推气过宫', category: SkillCategory.ACTIVE, type: SkillType.HEAL,
        mpCost: 50, power: 2.5, cooldown: 3,
        desc: '大幅恢复自身 HP = MATK × 2.5，CD 3 回合', selfHeal: true,
      },
      {
        id: 'hs_jingang', name: '金刚护体', category: SkillCategory.ACTIVE, type: SkillType.BUFF,
        mpCost: 35,
        desc: '提升自身 DEF 30%，持续 3 回合',
        effect: { buff: { type: 'def_up', value: 0.3, turns: 3 } },
      },
      {
        id: 'hs_passive', name: '佛光普照', category: SkillCategory.PASSIVE, type: SkillType.BUFF,
        mpCost: 0, desc: '每回合结束恢复 3% 最大 HP',
        passive: { regenRatio: 0.03 },
      },
      {
        id: 'hs_fohci', name: '我佛慈悲', category: SkillCategory.ULTIMATE, type: SkillType.HEAL,
        angerCost: 150, power: 0.4,
        desc: '立即恢复 40% 最大 HP，并解除所有异常状态', selfHeal: true, cleanse: true,
      },
    ],
  },

  // ── 3. 龙宫 ──────────────────────────────────────────────────────────
  {
    id: 'longgong', name: '龙宫', race: '仙', role: '法系群攻', color: 0x2980b9, emoji: '🐉',
    base: { hp: 950, mp: 350, atk: 30, matk: 130, def: 45, mdef: 65, spd: 90 },
    skills: [
      {
        id: 'lg_longteng', name: '龙腾', category: SkillCategory.ACTIVE, type: SkillType.MAGICAL,
        mpCost: 25, power: 1.2, alwaysHit: true, desc: '单体法术 ×1.2，必中',
      },
      {
        id: 'lg_longjuan', name: '龙卷雨击', category: SkillCategory.ACTIVE, type: SkillType.MAGICAL,
        mpCost: 40, power: 1.5, cooldown: 2, alwaysHit: true,
        desc: '群体法术（1v1 即单体）×1.5，CD 2 回合，必中',
      },
      {
        id: 'lg_longfu', name: '龙附', category: SkillCategory.ACTIVE, type: SkillType.BUFF,
        mpCost: 20,
        desc: '提升自身 MATK 20%，持续 3 回合',
        effect: { buff: { type: 'matk_up', value: 0.2, turns: 3 } },
      },
      {
        id: 'lg_nixie', name: '逆鳞', category: SkillCategory.ACTIVE, type: SkillType.BUFF,
        mpCost: 30,
        desc: '提升自身 MATK 25% + ATK 15%，持续 3 回合（端游：增加伤害力）',
        effect: { buff: { type: 'matk_up', value: 0.25, turns: 3 }, buff2: { type: 'atk_up', value: 0.15, turns: 3 } },
      },
      {
        id: 'lg_passive', name: '法术命中 100%', category: SkillCategory.PASSIVE, type: SkillType.BUFF,
        mpCost: 0, desc: '法术攻击不可被闪避',
        passive: { magicAlwaysHit: true },
      },
      {
        id: 'lg_longxiao', name: '龙啸九天', category: SkillCategory.ULTIMATE, type: SkillType.MAGICAL,
        angerCost: 150, power: 3.0, alwaysHit: true,
        desc: '克制盘丝洞必杀技·单体法术 ×3.0，附加降低目标 MDEF 30% 2 回合',
        effect: { buff: { type: 'mdef_down_ult', value: 0.3, turns: 2 } },
      },
    ],
  },

  // ── 4. 方寸山 ──────────────────────────────────────────────────────────
  {
    id: 'fangcun', name: '方寸山', race: '人', role: '封系控制', color: 0x8e44ad, emoji: '🔮',
    base: { hp: 1000, mp: 350, atk: 50, matk: 95, def: 55, mdef: 70, spd: 105 },
    skills: [
      {
        id: 'fc_wulei', name: '五雷咒', category: SkillCategory.ACTIVE, type: SkillType.MAGICAL,
        mpCost: 20, power: 0.9, desc: '单体法术 ×0.9',
      },
      {
        id: 'fc_cuimian', name: '催眠符', category: SkillCategory.ACTIVE, type: SkillType.SEAL,
        mpCost: 35, cooldown: 3,
        desc: '令目标睡眠（受伤害苏醒前无法行动），CD 3 回合',
        effect: { status: 'sleep', statusTurns: 2 },
      },
      {
        id: 'fc_shixin', name: '失心符', category: SkillCategory.ACTIVE, type: SkillType.SEAL,
        mpCost: 35, cooldown: 2,
        desc: '封法 2 回合 + 降灵力 25%，CD 2 回合',
        effect: { status: 'seal_magic', statusTurns: 2, buff: { type: 'mdef_down', value: 0.25, turns: 2 } },
      },
      {
        id: 'fc_dingshen', name: '定身符', category: SkillCategory.ACTIVE, type: SkillType.SEAL,
        mpCost: 40, cooldown: 3,
        desc: '封物理 + 降物防法防各 20%，2 回合，CD 3 回合',
        effect: {
          status: 'seal_phys', statusTurns: 2,
          buff: { type: 'def_down', value: 0.2, turns: 2 },
          buff2: { type: 'mdef_down', value: 0.2, turns: 2 },
        },
      },
      {
        id: 'fc_passive', name: '凝神术', category: SkillCategory.PASSIVE, type: SkillType.BUFF,
        mpCost: 0, desc: '封印命中率 +15%',
        passive: { sealHitBonus: 0.15 },
      },
      {
        id: 'fc_sanxing', name: '三星灭魔', category: SkillCategory.ULTIMATE, type: SkillType.MAGICAL,
        angerCost: 150, power: 2.5,
        desc: '单体法术 ×2.5 + 必定封印 1 回合',
        effect: { status: 'stun', statusTurns: 1, forceSeal: true },
      },
    ],
  },

  // ── 5. 普陀山 ──────────────────────────────────────────────────────────
  {
    // 🪷 需要 Unicode 13 字体（Win10 无），用 🌸 保证兼容
    id: 'putuo', name: '普陀山', race: '仙', role: '治疗+固伤', color: 0x16a085, emoji: '🌸',
    base: { hp: 1050, mp: 380, atk: 35, matk: 90, def: 50, mdef: 75, spd: 88 },
    skills: [
      {
        id: 'pt_wuxing', name: '五行咒法', category: SkillCategory.ACTIVE, type: SkillType.FIXED,
        mpCost: 25, power: 524, ignoreDef: true,
        desc: '固定伤害 524（无视防御）',
      },
      {
        id: 'pt_pudu', name: '普度众生', category: SkillCategory.ACTIVE, type: SkillType.HEAL,
        mpCost: 30, power: 1.3,
        desc: '恢复自身 HP = MATK × 1.3，并持续 3 回合每回合回血',
        selfHeal: true,
        effect: { buff: { type: 'regen', value: 0.05, turns: 3 } },
      },
      {
        id: 'pt_jingu', name: '紧箍咒', category: SkillCategory.ACTIVE, type: SkillType.MAGICAL,
        mpCost: 30, power: 0.3, cooldown: 2,
        desc: '对目标造成少量法术伤害并附加持续扣血（每回合 5% maxHP），持续 3 回合，CD 2',
        effect: { status: 'poison', statusTurns: 3 },
      },
      {
        id: 'pt_yangliu', name: '杨柳甘露', category: SkillCategory.ACTIVE, type: SkillType.REVIVE,
        mpCost: 50, cooldown: 5, power: 0.3,
        desc: '1v1 中若被击倒可自我复活（HP 30%），CD 5 回合',
        revive: true,
      },
      {
        id: 'pt_passive', name: '莲花护体', category: SkillCategory.PASSIVE, type: SkillType.BUFF,
        mpCost: 0, desc: '受到的法术伤害 -15%',
        passive: { magicDamageReduce: 0.15 },
      },
      {
        id: 'pt_wuxingcuowei', name: '五行错位', category: SkillCategory.ULTIMATE, type: SkillType.FIXED,
        angerCost: 150, power: 1572, ignoreDef: true,
        desc: '克制女儿村必杀技·固定伤害 1572（3 倍基础值），无视防御',
      },
    ],
  },

  // ── 6. 魔王寨 ──────────────────────────────────────────────────────────
  {
    id: 'mowang', name: '魔王寨', race: '魔', role: '法系爆发', color: 0xc0392b, emoji: '🔥',
    base: { hp: 1000, mp: 350, atk: 30, matk: 125, def: 50, mdef: 70, spd: 82 },
    skills: [
      {
        id: 'mw_sandmei', name: '三昧真火', category: SkillCategory.ACTIVE, type: SkillType.MAGICAL,
        mpCost: 25, power: 1.3, critBonus: 0.2,
        desc: '单体法术 ×1.3，20% 暴击几率（独立）',
      },
      {
        id: 'mw_feisha', name: '飞砂走石', category: SkillCategory.ACTIVE, type: SkillType.MAGICAL,
        mpCost: 40, power: 1.4, cooldown: 2,
        desc: '群体法术（1v1 即单体）×1.4，CD 2 回合',
      },
      {
        id: 'mw_niujin', name: '牛劲', category: SkillCategory.ACTIVE, type: SkillType.BUFF,
        mpCost: 20,
        desc: '提升自身 MATK 25%，持续 3 回合（端游：法术伤害力提升）',
        effect: { buff: { type: 'matk_up', value: 0.25, turns: 3 } },
      },
      {
        id: 'mw_huchi', name: '魔王护持', category: SkillCategory.ACTIVE, type: SkillType.BUFF,
        mpCost: 30,
        desc: '提升自身 MDEF 30%，持续 3 回合',
        effect: { buff: { type: 'mdef_up', value: 0.3, turns: 3 } },
      },
      {
        id: 'mw_passive', name: '神焰', category: SkillCategory.PASSIVE, type: SkillType.BUFF,
        mpCost: 0, desc: '2% 概率法术伤害 +40%',
        passive: { shenyanChance: 0.02, shenyanBonus: 0.4 },
      },
      {
        id: 'mw_tashan', name: '踏山裂石', category: SkillCategory.ULTIMATE, type: SkillType.MAGICAL,
        angerCost: 150, power: 3.0,
        desc: '克制化生寺必杀技·单体法术 ×3.0，附加灼烧 3 回合',
        effect: { status: 'burn', statusTurns: 3 },
      },
    ],
  },

  // ── 7. 狮驼岭 ──────────────────────────────────────────────────────────
  {
    id: 'shituoling', name: '狮驼岭', race: '魔', role: '物理群攻', color: 0x7f8c8d, emoji: '🦁',
    base: { hp: 1150, mp: 250, atk: 120, matk: 25, def: 65, mdef: 45, spd: 80 },
    skills: [
      {
        id: 'st_bianshen', name: '变身', category: SkillCategory.ACTIVE, type: SkillType.BUFF,
        mpCost: 20,
        desc: '进入变身状态，ATK +20%，是鹰击/狮搏/连环击的前提',
        effect: { buff: { type: 'atk_up', value: 0.2, turns: 99 } },
        setTransform: true,
      },
      {
        id: 'st_shibo', name: '狮搏', category: SkillCategory.ACTIVE, type: SkillType.PHYSICAL,
        mpCost: 25, power: 1.5, requiresTransform: true,
        desc: '单体物理 ×1.5，需变身',
      },
      {
        id: 'st_yingji', name: '鹰击', category: SkillCategory.ACTIVE, type: SkillType.PHYSICAL,
        mpCost: 40, power: 1.8, requiresTransform: true, restAfter: 1,
        desc: '群体物理（1v1 即单体）×1.8，休息 1 回合，需变身',
      },
      {
        id: 'st_lianhuan', name: '连环击', category: SkillCategory.ACTIVE, type: SkillType.PHYSICAL,
        mpCost: 60, power: 0.6, hits: 5, requiresTransform: true, restAfter: 1, cancelsTransform: true,
        desc: '连续攻击 5 次 ×0.6，休息 1 回合并取消变身（109 级 5 次）',
      },
      {
        id: 'st_passive', name: '兽血沸腾', category: SkillCategory.PASSIVE, type: SkillType.BUFF,
        mpCost: 0, desc: '变身状态下 ATK 额外 +10%，暴击率 +10%',
        passive: { transformAtkBonus: 0.1, transformCritBonus: 0.1 },
      },
      {
        id: 'st_moshou', name: '魔兽啸天', category: SkillCategory.ULTIMATE, type: SkillType.PHYSICAL,
        angerCost: 150, power: 3.0, ignoreDef: true, forceCrit: true,
        desc: '单体物理 ×3.0，无视 DEF，必定暴击',
      },
    ],
  },
]

/** 按 id 查门派 */
export function getFaction(id) {
  return FACTIONS.find((f) => f.id === id)
}

/** 取门派的主动技能（含必杀，不含被动/普攻） */
export function getUsableSkills(faction) {
  return faction.skills.filter(
    (s) => s.category === SkillCategory.ACTIVE || s.category === SkillCategory.ULTIMATE
  )
}

/** 取门派被动技能 */
export function getPassive(faction) {
  return faction.skills.find((s) => s.category === SkillCategory.PASSIVE)
}
