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
//   timing       触发时机：'beforeAction'(行动前主动战法) | 'onAttack'(普通攻击本体) | 'afterAttack'(普攻后追击) | 'onHit'(受击反应)
//   rate         发动概率（%）；普通攻击本体恒为 100
//   rateStep     每升 1 级概率增加量（%），通常 +2
//   attribute    伤害/治疗取哪项属性算攻击值：'atk'(武力) | 'int'(智力) | 'spd'(速度) | 'def'(统率)
//   mult         伤害/治疗倍率
//   multStep     每升 1 级倍率增加量，按档位：单体伤害 0.05 / 群体伤害 0.03 / 追击 0.025
//   target       目标类型：'random_enemy' | 'random_ally'（治疗/增益用） | 'self'
//   targetCount  目标数量（超过存活数时只打存活者，不选尸体、不重复）
//   effect       'damage'(伤害) | 'control'(施加状态) | 'extra_attack'(追加一次普攻)
//                | 'heal'(治疗) | 'buff'(增益我军属性) | 'debuff'(减益敌军属性)
//                | 'shield'(护盾) | 'cleanse'(驱散+治疗) | 'dot'(持续伤害+易伤) | 'counter'(受击反击，仅 timing:'onHit')
//   status       control/dot 用：施加的状态 ID
//   duration     status 持续回合（也用作 buff/debuff/shield 持续回合）
//   durationScaleLevels  控制/增益/护盾持续成长的等级节点数组（如 [5,10] 表示 Lv.5/Lv.10 各 +1 回合）
//   useCounter   伤害是否叠加兵种克制（枪克盾等 ×1.25/×0.85）。
//                普通攻击 true（吃克制）；主动战法一律 false（无视克制，符合率土惯例）。
//                注：连击/鬼神追加的是「普通攻击」，故那一下同样吃克制。此字段与描述末尾的括注一一对应。
//   lifesteal    吸血比例（0~1），伤害的一定比例回复自身兵力
//   condition    自身条件触发 ID，如 'low_hp'（自身兵力 < 50% 时倍率 ×conditionMult）
//   conditionMult 自身条件满足时的倍率系数（如 1.5）
//   targetCondition  目标条件触发 ID，如 'low_hp'（目标兵力低于 targetConditionThreshold 时倍率 ×targetConditionMult）
//   targetConditionThreshold / targetConditionMult  目标条件的阈值与倍率（斩杀等处决类战法用）
//   pityStep     憋气递增步长（%）：每次未发动，下次发动率 += pityStep（触发后清零），封顶 100%
//   buffAttr     增益/减益属性 ID：'atk'/'def'/'int'/'spd'
//   buffValue    增益/减益数值（百分比，如 25 表示 +25%/-25%）
//   tier         强度分档：'S'/'A'/'B'（战法仓库排序/展示用，由平衡审计结果人工定档）
//   cost         玉石兑换消耗 —— 与 tier 一起写在同一个战法定义里，不放去单独的映射表，
//                避免「表里 id 打错/漏加」导致某战法静默变成 cost:undefined 却不报错的问题。
//                升级消耗 = cost × 当前等级（见 GameState.upgradeSkill），越强的战法升级也越贵。
//   maxLevel     最大升级等级（10）
//   desc         玩家可见描述
//
// multStep 分档（控制群体成长速度，避免低倍率群体战法满级过强）：
//   单体伤害（targetCount=1, damage）   = 0.05   → Lv.10 倍率 = Lv.1 + 0.45
//   群体伤害（targetCount≥2, damage）   = 0.03   → Lv.10 倍率 = Lv.1 + 0.27
//   追击类（extra_attack）              = 0.025  → Lv.10 倍率 = Lv.1 + 0.225

export const NORMAL_ATTACK_ID = 'normal_attack'

// 各档位玉石消耗基准（唯一定价来源）：战法定义里的 cost 字段应写成 SKILL_TIER_COST[tier]，
// 而不是硬编码数字 —— 这样以后要整体调价（如 S 档 30→35）只需改这一行，所有 S 档战法联动生效。
export const SKILL_TIER_COST = { S: 30, A: 20, B: 10 }

export const SKILLS = {
  // ── 普通攻击（人人自带，不可升级、不进仓库）─────────────────────────────────
  normal_attack: {
    id: 'normal_attack', name: '普通攻击', timing: 'onAttack', rate: 100,
    attribute: 'atk', mult: 1.0, target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: true, desc: '对随机 1 名敌军造成 100% 武力的兵刃伤害（受兵种克制影响）',
  },

  // ── 保留战法（7 个）─────────────────────────────────────────────────────────

  // 1. 力劈（替代挥砍/猛击/突刺，作为武力单体代表）
  lipi: {
    id: 'lipi', name: '力劈', timing: 'beforeAction', rate: 40, rateStep: 2,
    attribute: 'atk', mult: 1.2, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '40% 概率对随机 1 名敌军造成 120% 武力的兵刃伤害（无视兵种克制）',
  },

  // 2. 疾风（速度单体代表，替代践踏/突袭）
  // 平衡：rate 35→40 + mult 1.1→1.5 后 Lv.1 EV 0.385→0.60，已超过多数 S 档基准 → 升为 S
  jifeng: {
    id: 'jifeng', name: '疾风', timing: 'beforeAction', rate: 40, rateStep: 2,
    attribute: 'spd', mult: 1.5, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '40% 概率对随机 1 名敌军造成 150% 速度的兵刃伤害（无视兵种克制）',
  },

  // 3. 火攻（智力群体，替代水攻/天雷；原单体已改为 2 目标）
  // 平衡：单体 120%→双目标各 100% 后 Lv.1 EV 0.42→0.70，全表第二高 → 升为 S
  huogong: {
    id: 'huogong', name: '火攻', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'int', mult: 1.0, multStep: 0.03,
    target: 'random_enemy', targetCount: 2,
    effect: 'damage', useCounter: false, maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '35% 概率对随机 2 名敌军各造成 100% 智力的谋略伤害（无视兵种克制）',
  },

  // 4. 箭雨（武力群体 3 目标）
  // 平衡：rate 25→35 后 Lv.1 EV 0.375→0.525，超过落雷等既有 S 档基准 → 升为 S
  jianyu: {
    id: 'jianyu', name: '箭雨', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'atk', mult: 0.5, multStep: 0.03,
    target: 'random_enemy', targetCount: 3,
    effect: 'damage', useCounter: false, maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '35% 概率对随机 3 名敌军各造成 50% 武力的兵刃伤害（无视兵种克制）',
  },

  // 5. 落雷（智力群体 3 目标）
  luolei: {
    id: 'luolei', name: '落雷', timing: 'beforeAction', rate: 30, rateStep: 2,
    attribute: 'int', mult: 0.50, multStep: 0.03,
    target: 'random_enemy', targetCount: 3,
    effect: 'damage', useCounter: false, maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '30% 概率对随机 3 名敌军各造成 50% 智力的谋略伤害（无视兵种克制）',
  },

  // 6. 连击（追击代表，替代追击/横扫）
  lianji: {
    id: 'lianji', name: '连击', timing: 'afterAttack', rate: 40, rateStep: 2,
    mult: 1.0, multStep: 0.025, useCounter: true,
    effect: 'extra_attack', maxLevel: 10,
    tier: 'A', cost: SKILL_TIER_COST.A,
    desc: '普通攻击后 40% 概率再追加一次普通攻击（造成兵刃伤害，受兵种克制影响）',
  },

  // 7. 谎报（唯一控制战法，替代威慑/迷阵/缴械）
  // 平衡：目标 1→2 后控场覆盖面翻倍，B 档定价已偏低 → 升为 A
  huangbao: {
    id: 'huangbao', name: '谎报', timing: 'beforeAction', rate: 30, rateStep: 2,
    attribute: 'int', target: 'random_enemy', targetCount: 2,
    effect: 'control', status: 'huangbao', duration: 1, durationScaleLevels: [10],
    maxLevel: 10,
    tier: 'A', cost: SKILL_TIER_COST.A,
    desc: '30% 概率使随机 2 名敌军进入谎报状态，跳过其下一次行动（持续 1 回合，Lv.10 额外 +1 回合）',
  },

  // ── 新增战法（8 个）─────────────────────────────────────────────────────────

  // 8. 青囊（智力治疗我军，新机制 heal）—— 目标 1→2 后改按群体档成长，避免重蹈火攻的 multStep 疏漏。
  // 平衡：原 mult 1.5 使单次回复≈施法者 70% 兵力，全战法第一（审计 S 档最高）→ 降到 1.0
  // 回复量公式（casterPower，见 battle.js）：施法者当前兵力 ×(1+施法者智力/150)× 倍率 × BATTLE_ROUND_ATTRITION，
  // 只吃「施法者」智力，与目标属性无关；智力越高/兵力越多回复越多；倍率 1.00x 起，每级 +0.03（Lv.10 = 1.27x）；
  // 结果封顶目标入场兵力 30%（BATTLE_HEAL_RATE_MAX），超出部分溢出浪费。
  qingnang: {
    id: 'qingnang', name: '青囊', timing: 'beforeAction', rate: 30, rateStep: 2,
    attribute: 'int', mult: 1.0, multStep: 0.03,
    target: 'random_ally', targetCount: 2,
    effect: 'heal', useCounter: false, maxLevel: 10,
    tier: 'A', cost: SKILL_TIER_COST.A,
    desc: '30% 概率治疗随机 2 名我军，回复量随施法者智力与当前兵力提升（智力越高回复越多），单次回复不超过目标入场兵力的 30%',
  },

  // 9. 激励（增益我军武力，新机制 buff）
  // 平衡：原单目标 buff 收益极低（审计 B 档垫底）→ 改为全队(最多3)增益，让 buff 类站得住脚；
  // 增益数值 25%→50% 后是翻倍强度的团队增伤，B 档定价已明显偏低 → 升为 A
  jili: {
    id: 'jili', name: '激励', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'atk',
    target: 'random_ally', targetCount: 3,
    effect: 'buff', buffAttr: 'atk', buffValue: 50,
    duration: 2, durationScaleLevels: [5, 10],
    maxLevel: 10,
    tier: 'A', cost: SKILL_TIER_COST.A,
    desc: '35% 概率使我军最多 3 名武将武力 +50%，持续 2 回合（Lv.5/Lv.10 各 +1 回合）',
  },

  // 10. 铁壁（增益我军统率，新机制 buff；用 def 属性发动）
  // 平衡：与激励同理，增益数值 25%→50% 后升为 A
  tiebi: {
    id: 'tiebi', name: '铁壁', timing: 'beforeAction', rate: 35, rateStep: 2,
    attribute: 'def',
    target: 'random_ally', targetCount: 3,
    effect: 'buff', buffAttr: 'def', buffValue: 50,
    duration: 2, durationScaleLevels: [5, 10],
    maxLevel: 10,
    tier: 'A', cost: SKILL_TIER_COST.A,
    desc: '35% 概率使我军最多 3 名武将统率 +50%，持续 2 回合（Lv.5/Lv.10 各 +1 回合）',
  },

  // 11. 破甲（兵刃+谋略双伤，damage 多属性命中）—— 一次发动同时打出一记兵刃(武力)与一记谋略(智力)。
  //     hits 里两次命中共用 mult（0.75→1.5 随等级），对同一目标结算，互不吃对方属性。
  pojia: {
    id: 'pojia', name: '破甲', timing: 'beforeAction', rate: 30, rateStep: 2,
    attribute: 'atk', mult: 0.75, multStep: 0.0833,
    hits: [{ attribute: 'atk' }, { attribute: 'int' }],   // 兵刃(武力) + 谋略(智力)
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '30% 概率对随机 1 名敌军同时造成一次武力的兵刃伤害与一次智力的谋略伤害，各 75%（Lv.10 各 150%）',
  },

  // 12. 天雷（高爆发智力单体，damage）—— 原「乱谋(减敌智力)」对无战法守军毫无作用、审计垫底；
  //     智力增益(神机)实测在纯智力队也仅 +96(远逊直接带火攻的 +636)，故改为「智力武将的爆发核弹」：
  //     低概率、高倍率，直接把智力换成大额输出。universal、不依赖队友。id 保留 luanmou 兼容旧档。
  luanmou: {
    id: 'luanmou', name: '天雷', timing: 'beforeAction', rate: 25, rateStep: 2,
    attribute: 'int', mult: 1.6, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, maxLevel: 10,
    tier: 'A', cost: SKILL_TIER_COST.A,
    desc: '25% 概率对随机 1 名敌军造成 160% 智力的谋略伤害（无视兵种克制，智力越高越爆炸）',
  },

  // 13. 嗜血（兵刃伤害 + 吸血，damage 变种）
  shixue: {
    id: 'shixue', name: '嗜血', timing: 'beforeAction', rate: 40, rateStep: 2,
    attribute: 'atk', mult: 1.0, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, lifesteal: 0.3, maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '40% 概率对随机 1 名敌军造成 100% 武力的兵刃伤害，并将 30% 伤害转化为自身兵力回复',
  },

  // 14. 背水（速度残血爆发，damage 变种 + condition）
  beishui: {
    id: 'beishui', name: '背水', timing: 'beforeAction', rate: 40, rateStep: 2,
    attribute: 'spd', mult: 1.0, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false,
    condition: 'low_hp', conditionMult: 1.5,
    maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '40% 概率对随机 1 名敌军造成 100% 速度的兵刃伤害；自身当前兵力低于入场兵力 50% 时倍率 ×1.5',
  },

  // 15. 鬼神（高倍率突击，extra_attack 变种）
  // 平衡：rate 25→40 后 Lv.1 EV 0.375→0.60，与疾风并列全表前段 → 升为 S
  guishen: {
    id: 'guishen', name: '鬼神', timing: 'afterAttack', rate: 40, rateStep: 2,
    mult: 1.5, multStep: 0.025, useCounter: true,
    effect: 'extra_attack', maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '普通攻击后 40% 概率再追加一次普通攻击，伤害提升至 150%（造成兵刃伤害，受兵种克制影响）',
  },

  // 16. 沙暴（智力持续伤害 + 兵刃易伤，新机制 dot）—— 施加时按当回合战力快照每回合伤害，逐回合结算；
  //     期间目标受到的兵刃(武/速)伤害 +25%（谋略不受影响）。mult 0.63→1.26 即「伤害率 63%~126%」。
  shabao: {
    id: 'shabao', name: '沙暴', timing: 'beforeAction', rate: 30, rateStep: 2,
    attribute: 'int', mult: 0.63, multStep: 0.07,
    target: 'random_enemy', targetCount: 2,
    effect: 'dot', status: 'shabao', vulnPhysical: 0.25,
    duration: 2, maxLevel: 10,
    tier: 'A', cost: SKILL_TIER_COST.A,
    desc: '30% 概率对随机 2 名敌军施加【沙暴】（持续 2 回合）：每回合按施放时自身智力与兵力造成谋略持续伤害（63%→126%，无视兵种克制），并使其在持续期间受到的兵刃伤害 +25%',
  },

  // ── V2.1 新增（5 个）——引入 4 个新机制：护盾/处决判定/驱散/受击反击/憋气 ──────────

  // 17. 护佑（护盾支援，新机制 shield）—— 为我军罩上一层护盾，优先吸收兵力损失（含普攻/战法/持续伤害）。
  huyou: {
    id: 'huyou', name: '护佑', timing: 'beforeAction', rate: 30, rateStep: 2,
    attribute: 'int', mult: 1.0, multStep: 0.05,
    target: 'random_ally', targetCount: 1,
    effect: 'shield', duration: 2, durationScaleLevels: [5, 10],
    maxLevel: 10,
    tier: 'A', cost: SKILL_TIER_COST.A,
    desc: '30% 概率为随机 1 名我军罩上护盾，优先吸收其受到的兵力损失，持续 2 回合（Lv.5/Lv.10 各 +1 回合）',
  },

  // 18. 斩杀（兵刃处决，damage + 新机制 targetCondition）—— 目标残血时倍率暴增，专收割残兵。
  // 平衡：rate/基础伤害/处决倍率均有提升，但价值高度依赖「目标残血」这个前提，仍保留在 B 档。
  zhansha: {
    id: 'zhansha', name: '斩杀', timing: 'beforeAction', rate: 40, rateStep: 2,
    attribute: 'atk', mult: 1.0, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    targetCondition: 'low_hp', targetConditionThreshold: 0.3, targetConditionMult: 3,
    effect: 'damage', useCounter: false, maxLevel: 10,
    tier: 'B', cost: SKILL_TIER_COST.B,
    desc: '40% 概率对随机 1 名敌军造成 100% 武力的兵刃伤害；若其当前兵力低于入场兵力 30%，伤害倍率 ×3',
  },

  // 19. 凯歌（团队驱散+治疗，新机制 cleanse）—— 清除我军减益/持续伤害效果并附带治疗，克制减益/DOT 体系。
  // 平衡：初版 targetCount:3 时纯治疗部分就把均值审计拉到 2167（全战法第一），驱散只是附加价值还没算；
  // 3 目标团体治疗相当于青囊(1目标)的 ~2.4 倍，收窄到 2 目标、mult 0.8→0.65 后落回 S 档正常区间。
  // 治疗部分与青囊同一套 casterPower 公式（同吃「施法者」智力，与目标属性无关），只是倍率更低（0.65x 起，
  // 每级 +0.03，Lv.10 = 0.92x）、目标数更多（2 人而非 1 人），同样封顶各自目标入场兵力 30%。
  kaige: {
    id: 'kaige', name: '凯歌', timing: 'beforeAction', rate: 30, rateStep: 2,
    attribute: 'int', mult: 0.65, multStep: 0.03,
    target: 'random_ally', targetCount: 2,
    effect: 'cleanse', maxLevel: 10,
    tier: 'S', cost: SKILL_TIER_COST.S,
    desc: '30% 概率为我军最多 2 名清除全部减益/持续伤害效果，并按施法者智力治疗少量兵力（智力越高回复越多）',
  },

  // 20. 复仇（受击反击，新机制 timing:'onHit' + effect:'counter'）—— 全战法中唯一「被动反应」类，
  //     不占用自己回合，受到攻击时判定反击；反击命中不会再被对方复仇触发（防连锁死循环）。
  // 平衡：rate 30→50 提升明显，但纯被动、完全依赖「被攻击」这个前提（后排不受击则等于没有），仍保留 B 档。
  fuchou: {
    id: 'fuchou', name: '复仇', timing: 'onHit', rate: 50, rateStep: 2,
    attribute: 'atk', mult: 0.7, multStep: 0.04,
    effect: 'counter', useCounter: false, maxLevel: 10,
    tier: 'B', cost: SKILL_TIER_COST.B,
    desc: '受到攻击时 50% 概率反击攻击者，造成 70% 武力的兵刃伤害（无视兵种克制）',
  },

  // 21. 破釜沉舟（背水一战，damage + 新机制 pityStep 憋气）—— 基础概率不高，但每次未发动都攒憋气值，
  //     下次发动率随之提升，触发后清零；10 回合内必然触发至少一次，杜绝战法脸黑。
  pofu: {
    id: 'pofu', name: '破釜沉舟', timing: 'beforeAction', rate: 20, rateStep: 2,
    attribute: 'atk', mult: 1.3, multStep: 0.05,
    target: 'random_enemy', targetCount: 1,
    effect: 'damage', useCounter: false, pityStep: 8,
    maxLevel: 10,
    tier: 'A', cost: SKILL_TIER_COST.A,
    desc: '20% 概率对随机 1 名敌军造成 130% 武力的兵刃伤害；每次未发动下次概率 +8%（触发后重置）',
  },
}

// 状态定义：control 类 skip=true 表示无法行动；dot 类只作为持续伤害/易伤的标签（记在 unit.dots 上）。
export const STATUSES = {
  huangbao: { id: 'huangbao', name: '谎报', skip: true, desc: '无法行动' },
  shabao:   { id: 'shabao',   name: '沙暴', dot: true,  desc: '谋略持续伤害 + 兵刃易伤 25%' },
}

/** 玩家可绑定的战法（普通攻击不进仓库、人人自带，故排除） */
export const BINDABLE_SKILLS = Object.values(SKILLS).filter(s => s.id !== NORMAL_ATTACK_ID)

// 启动期健全性检查：每个可绑定战法都必须有 tier/cost，漏配直接崩溃提示，而不是留一个
// cost:undefined 静默流入仓库/升级页面（NaN 定价却不报错）。
for (const s of BINDABLE_SKILLS) {
  if (!s.tier || !s.cost) {
    throw new Error(`战法【${s.name}】(${s.id}) 缺少 tier/cost 定义，请检查 skills.js`)
  }
}

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
  } else if (s.effect === 'dot') {
    parts.push(`${(s.mult || 1).toFixed(2)}x`)
    if (s.targetCount > 1) parts.push(`${s.targetCount}目标`)
    parts.push(`${s.duration}回合`)
  } else if (s.effect === 'buff' || s.effect === 'debuff') {
    const attr = ATTR_CN[s.buffAttr] || s.buffAttr
    const sign = s.buffValue > 0 ? '+' : ''
    parts.push(`${sign}${s.buffValue}%${attr}`)
    parts.push(`${s.duration}回合`)
  } else if (s.effect === 'shield') {
    parts.push(`${(s.mult || 1).toFixed(2)}x护盾`)
    if (s.targetCount > 1) parts.push(`${s.targetCount}我军`)
    parts.push(`${s.duration}回合`)
  } else if (s.effect === 'cleanse') {
    parts.push('驱散')
    if (s.targetCount > 1) parts.push(`${s.targetCount}我军`)
  } else if (s.effect === 'counter') {
    parts.push(`${(s.mult || 1).toFixed(2)}x反击`)
  }
  if (s.lifesteal) parts.push(`${Math.round(s.lifesteal * 100)}%吸血`)
  if (s.condition === 'low_hp') parts.push(`残血×${s.conditionMult}`)
  if (s.targetCondition === 'low_hp') parts.push(`处决×${s.targetConditionMult}`)
  if (s.pityStep) parts.push(`憋气+${s.pityStep}%`)
  return parts.join('/')
}
