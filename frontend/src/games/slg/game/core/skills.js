// 九州征途 - 战法数据（数据驱动：普通攻击与所有战法统一抽象为 Skill）
// 战斗引擎（battle.js）只认 Skill 的「触发时机 + 属性 + 倍率 + 概率 + 目标 + 效果」，
// 新增战法只需在此加一条数据、无需改战斗逻辑（除非引入全新的 timing/effect）。
//
// 字段：
//   id           唯一 ID（= 仓库/绑定/存档的 key）
//   name         显示名
//   timing       触发时机：'beforeAction'(行动前主动战法) | 'onAttack'(普通攻击本体) | 'afterAttack'(普攻后追击)
//   rate         发动概率（%）；普通攻击本体恒为 100
//   attribute    伤害取哪项属性算攻击值：'atk'(武力) | 'int'(智力) | 'spd'(速度)
//   mult         伤害倍率
//   target       目标类型：'random_enemy'（当前仅此一种，预留全体/最高兵力等）
//   targetCount  目标数量（超过存活敌军数时只打存活者，不选尸体、不重复）
//   effect       'damage'(伤害) | 'control'(施加状态) | 'extra_attack'(追加一次普攻)
//   status       control 用：施加的状态 ID
//   duration     status 持续回合
//   useCounter   伤害是否叠加兵种克制（枪克盾等 ×1.25/×0.85）。
//                普通攻击 true（吃克制）；主动战法一律 false（无视克制，符合率土惯例）。
//                注：连击追加的是「普通攻击」，故那一下同样吃克制。此字段与描述末尾的括注一一对应。
//   cost         玉石兑换消耗（第三期经济用）
//   desc         玩家可见描述

export const NORMAL_ATTACK_ID = 'normal_attack'

// 平衡口径：伤害战法的「期望收益 EV = 发动率 × 倍率 × 目标数」拉齐到 ≈0.40，
// 使各战法强度相当，仅在「单体爆发 / 群体铺伤 / 追击 / 控制」的定位上区分（不再是火攻一家独大）。
//   挥砍 .40×1.0×1=0.40  践踏 .40×0.5×2=0.40  火攻 .35×1.2×1=0.42  落雷 .35×0.6×2=0.42
//   连击 追加一次普攻（含兵种克制，约等值）  谎报 控制（价值单独计，控 1 次行动）
export const SKILLS = {
  normal_attack: {
    id: 'normal_attack', name: '普通攻击', timing: 'onAttack', rate: 100,
    attribute: 'atk', mult: 1.0, target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: true, desc: '对随机 1 名敌军造成 100% 武力伤害（受兵种克制影响）',
  },
  huikan: {
    id: 'huikan', name: '挥砍', timing: 'beforeAction', rate: 40,
    attribute: 'atk', mult: 1.0, target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, cost: 20, desc: '40% 概率对随机 1 名敌军造成 100% 武力伤害（无视兵种克制）',
  },
  jianta: {
    id: 'jianta', name: '践踏', timing: 'beforeAction', rate: 40,
    attribute: 'spd', mult: 0.45, target: 'random_enemy', targetCount: 2,
    effect: 'damage', useCounter: false, cost: 20, desc: '40% 概率对随机 2 名敌军各造成 45% 速度伤害（无视兵种克制）',
  },
  huogong: {
    id: 'huogong', name: '火攻', timing: 'beforeAction', rate: 35,
    attribute: 'int', mult: 1.2, target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, cost: 30, desc: '35% 概率对随机 1 名敌军造成 120% 智力伤害（无视兵种克制）',
  },
  luolei: {
    id: 'luolei', name: '落雷', timing: 'beforeAction', rate: 35,
    attribute: 'int', mult: 0.55, target: 'random_enemy', targetCount: 2,
    effect: 'damage', useCounter: false, cost: 30, desc: '35% 概率对随机 2 名敌军各造成 55% 智力伤害（无视兵种克制）',
  },
  lianji: {
    id: 'lianji', name: '连击', timing: 'afterAttack', rate: 35,
    effect: 'extra_attack', cost: 20, desc: '普通攻击后 35% 概率再追加一次普通攻击（追加的普攻同样受兵种克制影响）',
  },
  huangbao: {
    id: 'huangbao', name: '谎报', timing: 'beforeAction', rate: 30,
    target: 'random_enemy', targetCount: 1,
    effect: 'control', status: 'huangbao', duration: 1, cost: 20,
    desc: '30% 概率使随机 1 名敌军进入谎报状态，跳过其下一次行动',
  },
}

// 状态定义：control 效果施加的状态。skip=true 表示无法行动。
export const STATUSES = {
  huangbao: { id: 'huangbao', name: '谎报', skip: true, desc: '无法行动' },
}

/** 玩家可绑定的战法（普通攻击不进仓库、人人自带，故排除） */
export const BINDABLE_SKILLS = Object.values(SKILLS).filter(s => s.id !== NORMAL_ATTACK_ID)

export function getSkill(id) { return SKILLS[id] || null }
export const NORMAL_ATTACK = SKILLS.normal_attack
