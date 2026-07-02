// 九州征途（SLG）- 常量定义
// MVP 阶段为纯本地单机沙盘，数值以「演示节奏」为准（时间加速），详见 docs/slg.md。

// ── 地图 ────────────────────────────────────────────────────────────────────
export const MAP_W = 48          // 地图宽（格）
export const MAP_H = 48          // 地图高（格）
export const TILE_SIZE = 48      // 单格像素

// 时间加速：1 真实秒 = 60 游戏秒（游戏内 1 小时 ≈ 真实 1 分钟）
export const TIME_SCALE = 60

// 离线收益上限（游戏内秒）：8 游戏小时
export const OFFLINE_CAP_SECONDS = 8 * 3600

// ── 地块类型 ────────────────────────────────────────────────────────────────
// res: 该地块产出的资源 key（null = 不产出/不可通行）
export const TILE_TYPES = {
  plain:    { name: '平原', res: 'grain', color: 0x9fb96e, passable: true },
  farm:     { name: '农田', res: 'grain', color: 0xc9b458, passable: true },
  forest:   { name: '森林', res: 'wood',  color: 0x4e7a3b, passable: true },
  hill:     { name: '丘陵', res: 'stone', color: 0xa89a7e, passable: true },
  mountain: { name: '山地', res: 'iron',  color: 0x8a8078, passable: true },
  lake:     { name: '湖泊', res: null,    color: 0x5a9bc9, passable: false },
  npcCity:  { name: '城池', res: 'all',   color: 0xb05a44, passable: true },
}

// 图标仅用 Emoji 12.0 之前的字符：🪙🪵🪨 等 13.0 新字符在 Win10 上无字体支持
export const RESOURCES = {
  coin:  { name: '铜币', icon: '💰' },
  grain: { name: '粮食', icon: '🌾' },
  wood:  { name: '木材', icon: '🌲' },
  iron:  { name: '铁矿', icon: '⛏️' },
  stone: { name: '石料', icon: '🧱' },
}

// 地块每小时产量 = level * BASE_YIELD_PER_LEVEL（npcCity 为每种资源各产一半）
export const BASE_YIELD_PER_LEVEL = 100
// 铜币：所有领地统一按 level * 20 / 小时 产出
export const COIN_YIELD_PER_LEVEL = 20

// 地块守军兵力：lv → l*(l+1)/2 * 100（lv1=100 … lv5=1500）；NPC 城池固定 3000
export function garrisonOf(level, type) {
  if (type === 'npcCity') return 3000
  return (level * (level + 1) / 2) * 100
}
// 守军属性随等级微升
export function garrisonStats(level) {
  return { atk: 50 + level * 5, def: 50 + level * 5 }
}

// ── 主城 ────────────────────────────────────────────────────────────────────
export const CITY_MAX_LEVEL = 5
// 领地上限 = 8 + 主城等级 * 4
export function territoryCap(cityLv) { return 8 + cityLv * 4 }
// 升级到 lv 的花费（lv2 起）
export function cityUpgradeCost(toLv) {
  const k = Math.pow(2, toLv - 2)   // lv2:1x lv3:2x lv4:4x lv5:8x
  return { coin: 500 * k, wood: 500 * k, stone: 500 * k }
}

// ── 建筑体系（阶段二）─────────────────────────────────────────────────────────
// 主城内四条独立强化线，效果覆盖全局。等级 1~5 且不得超过主城等级。
export const BUILDING_MAX_LEVEL = 5
export const BUILDINGS = {
  granary:  { name: '粮仓',   icon: '🌾', costKeys: ['grain', 'wood'] },
  barracks: { name: '兵营',   icon: '⚔️', costKeys: ['wood', 'iron'] },
  training: { name: '校场',   icon: '🎯', costKeys: ['stone', 'coin'] },
  forge:    { name: '铁匠坊', icon: '🔨', costKeys: ['iron', 'stone'] },
}
// 升级到 lv 的花费（lv2 起）：两种主资源各 300 × 2^(lv-2)
export function buildingUpgradeCost(type, toLv) {
  const k = Math.pow(2, toLv - 2)   // lv2:1x lv3:2x lv4:4x lv5:8x
  const [a, b] = BUILDINGS[type].costKeys
  return { [a]: 300 * k, [b]: 300 * k }
}
export const GRANARY_YIELD_PER_LEVEL = 0.05   // 每级 +5% 全资源产出（叠乘）
export const BARRACKS_CAP_PER_LEVEL = 100      // 每级 +100 带兵上限
export const TRAINING_EXP_PER_LEVEL = 20       // 每级 20 经验/游戏小时（在城武将挂机）
export const FORGE_STAT_PER_LEVEL = 1          // 每级 +1 武/防（战斗结算时叠加）

// ── 体力（阶段二）─────────────────────────────────────────────────────────────
export const STAMINA_MAX = 100
export const MARCH_STAMINA_COST = 20           // 每次出征固定消耗（够连打 5 次）
export const STAMINA_REGEN_PER_HOUR = 5        // 回满约 20 游戏小时 ≈ 20 真实分钟

// ── 兵种 ────────────────────────────────────────────────────────────────────
// 骑兵行军有效速度加成（在此定义，供 TROOP_TYPES 与行军计时共用）
export const CAVALRY_MARCH_SPEED = 30
// 克制三角：盾克弓、弓克枪、枪克盾（beats = 我方克制的兵种）。
// 骑兵不参与克制（beats:null 且无人克它），只享行军速度加成。
export const TROOP_TYPES = {
  spear:   { name: '枪', icon: '🔱', color: '#e57373', beats: 'shield' },
  shield:  { name: '盾', icon: '🛡️', color: '#64b5f6', beats: 'bow' },
  bow:     { name: '弓', icon: '🏹', color: '#81c784', beats: 'spear' },
  cavalry: { name: '骑', icon: '🐎', color: '#ffb74d', beats: null, marchSpeed: CAVALRY_MARCH_SPEED },
}
export const COUNTER_MULT_STRONG = 1.25   // 克制方战力倍率
export const COUNTER_MULT_WEAK = 0.85     // 被克方战力倍率
/** 攻方兵种对守方兵种的战力倍率（1 = 无克制关系） */
export function counterMult(atkType, defType) {
  if (!atkType || !defType) return 1
  if (TROOP_TYPES[atkType]?.beats === defType) return COUNTER_MULT_STRONG
  if (TROOP_TYPES[defType]?.beats === atkType) return COUNTER_MULT_WEAK
  return 1
}
// 地块守军的兵种池（骑兵不作守军，避免守方永远中立）
export const GARRISON_TYPE_POOL = ['spear', 'shield', 'bow']

// ── 武将 ────────────────────────────────────────────────────────────────────
// 品质分档（招募抽卡的概率与展示色）
export const GENERAL_QUALITY = {
  common: { name: '普通', color: '#bdbdbd', rate: 50 },
  rare:   { name: '精良', color: '#4fc3f7', rate: 30 },
  elite:  { name: '精锐', color: '#ba68c8', rate: 15 },
  legend: { name: '王牌', color: '#ffb300', rate: 5 },
}
// 旧版开局固定三武将模板（新开局已不再自动持有，仅保留供旧存档 findGeneralTemplate 查找）。
// troopType 固定（率土式，武将自带兵种）。
export const STARTER_GENERALS = [
  // 魏：许褚（高攻枪兵）
  { id: 'xuchu',    name: '许褚',   quality: 'common', faction: 'wei',  troopType: 'spear',   atk: 69, def: 65, spd: 62 },
  // 蜀：魏延（均衡枪兵）
  { id: 'weiyi',    name: '魏延',   quality: 'common', faction: 'shu',  troopType: 'spear',   atk: 67, def: 66, spd: 65 },
  // 吴：周泰（高防盾兵）
  { id: 'zhoutai',  name: '周泰',   quality: 'common', faction: 'wu',   troopType: 'shield',  atk: 63, def: 69, spd: 64 },
];
// 可招募武将池（按品质分档，抽卡先 roll 品质再从该档随机取一名）
export const RECRUITABLE_GENERALS = [
  // === Legend (传说) - 4个 (魏蜀吴群各1个, 数值 90~100) ===
  { id: 'liubei',     name: '刘备',     quality: 'legend', faction: 'shu',    troopType: 'spear',   atk: 92, def: 98, spd: 90 },
  { id: 'caocao',     name: '曹操',     quality: 'legend', faction: 'wei',    troopType: 'cavalry', atk: 98, def: 95, spd: 96 },
  { id: 'sunquan',    name: '孙权',     quality: 'legend', faction: 'wu',     troopType: 'shield',  atk: 94, def: 96, spd: 92 },
  { id: 'lvbu',       name: '吕布',     quality: 'legend', faction: 'qun',    troopType: 'cavalry', atk: 100,def: 90, spd: 98 },

  // === Elite (精英) - 8个 (魏蜀吴群各2个, 数值 80~90) ===
  // 蜀
  { id: 'zhugeliang', name: '诸葛亮',   quality: 'elite',  faction: 'shu',    troopType: 'bow',     atk: 90, def: 82, spd: 88 },
  { id: 'zhaoyun',    name: '赵云',     quality: 'elite',  faction: 'shu',    troopType: 'cavalry', atk: 89, def: 88, spd: 90 },
  // 魏
  { id: 'simayi',     name: '司马懿',   quality: 'elite',  faction: 'wei',    troopType: 'cavalry', atk: 84, def: 86, spd: 82 },
  { id: 'xuchu',      name: '许褚',     quality: 'elite',  faction: 'wei',    troopType: 'spear',   atk: 88, def: 85, spd: 80 },
  // 吴
  { id: 'zhouyu',     name: '周瑜',     quality: 'elite',  faction: 'wu',     troopType: 'bow',     atk: 88, def: 80, spd: 86 },
  { id: 'ganning',    name: '甘宁',     quality: 'elite',  faction: 'wu',     troopType: 'bow',     atk: 86, def: 82, spd: 84 },
  // 群
  { id: 'zhangjiao',  name: '张角',     quality: 'elite',  faction: 'qun',    troopType: 'bow',     atk: 87, def: 80, spd: 85 },
  { id: 'huatuo',     name: '华佗',     quality: 'elite',  faction: 'qun',    troopType: 'shield',  atk: 80, def: 88, spd: 82 },

  // === Rare (稀有) - 12个 (魏蜀吴群各3个, 数值 70~80) ===
  // 蜀
  { id: 'guanyu',     name: '关羽',     quality: 'rare',   faction: 'shu',    troopType: 'cavalry', atk: 79, def: 75, spd: 76 },
  { id: 'zhangfei',   name: '张飞',     quality: 'rare',   faction: 'shu',    troopType: 'spear',   atk: 78, def: 78, spd: 72 },
  { id: 'huangzhong', name: '黄忠',     quality: 'rare',   faction: 'shu',    troopType: 'bow',     atk: 78, def: 70, spd: 72 },
  // 魏
  { id: 'dianwei',    name: '典韦',     quality: 'rare',   faction: 'wei',    troopType: 'spear',   atk: 78, def: 75, spd: 71 },
  { id: 'machao',     name: '马超',     quality: 'rare',   faction: 'wei',    troopType: 'cavalry', atk: 77, def: 72, spd: 79 },
  { id: 'zhangliao',  name: '张辽',     quality: 'rare',   faction: 'wei',    troopType: 'cavalry', atk: 75, def: 74, spd: 76 },
  // 吴
  { id: 'caoren',     name: '曹仁',     quality: 'rare',   faction: 'wu',     troopType: 'shield',  atk: 70, def: 80, spd: 72 },
  { id: 'lusu',       name: '鲁肃',     quality: 'rare',   faction: 'wu',     troopType: 'shield',  atk: 72, def: 78, spd: 74 },
  { id: 'taishici',   name: '太史慈',   quality: 'rare',   faction: 'wu',     troopType: 'bow',     atk: 76, def: 72, spd: 78 },
  // 群
  { id: 'diaochan',   name: '貂蝉',     quality: 'rare',   faction: 'qun',    troopType: 'bow',     atk: 74, def: 70, spd: 80 },
  { id: 'huaxiong',   name: '华雄',     quality: 'rare',   faction: 'qun',    troopType: 'cavalry', atk: 77, def: 73, spd: 74 },
  { id: 'yanliang',   name: '颜良',     quality: 'rare',   faction: 'qun',    troopType: 'spear',   atk: 76, def: 75, spd: 72 },

  // === Common (普通) - 16个 (魏蜀吴群各4个, 数值 60~70) ===
  // 蜀
  { id: 'weiyi',      name: '魏延',     quality: 'common', faction: 'shu',    troopType: 'spear',   atk: 69, def: 66, spd: 65 },
  { id: 'jiangwei',   name: '姜维',     quality: 'common', faction: 'shu',    troopType: 'bow',     atk: 69, def: 64, spd: 68 },
  { id: 'madai',      name: '马岱',     quality: 'common', faction: 'shu',    troopType: 'cavalry', atk: 65, def: 63, spd: 68 },
  { id: 'guanxing',   name: '关兴',     quality: 'common', faction: 'shu',    troopType: 'cavalry', atk: 67, def: 65, spd: 66 },
  // 魏
  { id: 'xuhuang',    name: '徐晃',     quality: 'common', faction: 'wei',    troopType: 'spear',   atk: 67, def: 68, spd: 62 },
  { id: 'yuwen',      name: '于禁',     quality: 'common', faction: 'wei',    troopType: 'spear',   atk: 65, def: 70, spd: 60 },
  { id: 'pangde',     name: '庞德',     quality: 'common', faction: 'wei',    troopType: 'spear',   atk: 68, def: 67, spd: 63 },
  { id: 'caoxiu',     name: '曹休',     quality: 'common', faction: 'wei',    troopType: 'shield',  atk: 64, def: 68, spd: 62 },
  // 吴
  { id: 'dingfeng',   name: '丁奉',     quality: 'common', faction: 'wu',     troopType: 'bow',     atk: 64, def: 62, spd: 66 },
  { id: 'zhoucang',   name: '周泰',     quality: 'common', faction: 'wu',     troopType: 'shield',  atk: 63, def: 69, spd: 64 },
  { id: 'zhuran',     name: '朱然',     quality: 'common', faction: 'wu',     troopType: 'shield',  atk: 62, def: 67, spd: 65 },
  { id: 'xusheng',    name: '徐盛',     quality: 'common', faction: 'wu',     troopType: 'bow',     atk: 66, def: 64, spd: 67 },
  // 群
  { id: 'zhanghe',    name: '张郃',     quality: 'common', faction: 'qun',    troopType: 'cavalry', atk: 66, def: 66, spd: 67 },
  { id: 'wenchou',    name: '文丑',     quality: 'common', faction: 'qun',    troopType: 'cavalry', atk: 68, def: 64, spd: 65 },
  { id: 'jiling',     name: '纪灵',     quality: 'common', faction: 'qun',    troopType: 'spear',   atk: 65, def: 65, spd: 62 },
  { id: 'wutugu',     name: '兀突骨',   quality: 'common', faction: 'qun',    troopType: 'shield',  atk: 62, def: 70, spd: 60 },
];
// 招募花费（铜币的主要消耗口）与阵容上限
export const RECRUIT_COST_COIN = 800
export const MAX_GENERALS = 8
// 开局赠送的免费招募次数（不再固定 3 武将起手，改为送一次抽卡机会）
export const FREE_RECRUIT_COUNT = 1
// 重复武将转觉醒：每次 +武/+防
export const AWAKEN_ATK = 3
export const AWAKEN_DEF = 3

/** 按 id 查武将模板（初始或可招募），存档恢复时用 */
export function findGeneralTemplate(id) {
  return STARTER_GENERALS.find(g => g.id === id) ||
    RECRUITABLE_GENERALS.find(g => g.id === id) || null
}
export const GENERAL_BASE_TROOP_CAP = 1000   // 带兵上限 = 1000 + (lv-1)*200
export function troopCapOf(lv) { return GENERAL_BASE_TROOP_CAP + (lv - 1) * 200 }
// 升级经验：升到 lv 需要 lv*1000 累计经验
export function expToLevel(lv) { return lv * 1000 }
export const GENERAL_MAX_LEVEL = 20
// 征兵花费：1 兵 = 2 粮
export const RECRUIT_GRAIN_PER_TROOP = 2

// ── 行军 ────────────────────────────────────────────────────────────────────
// 沿网格逐格行军，每格耗时随「有效速度」变化，合击按全队最慢者计。
// 参照速度 100 时每格 = 真实 1 秒；速度越高越快（反比）。
// 有效速度 = 武将速度 + 兵种加成（骑兵，见 TROOP_TYPES），下限 MARCH_MIN_SPEED。
export const MARCH_REF_SPEED = 100
export const MARCH_TILE_SECONDS_AT_REF = TIME_SCALE   // 速度 100 时每格游戏秒（=真实 1 秒）
export const MARCH_MIN_SPEED = 30
export function tileMarchSeconds(effSpeed) {
  return MARCH_TILE_SECONDS_AT_REF * (MARCH_REF_SPEED / Math.max(effSpeed, MARCH_MIN_SPEED))
}

// ── 城池攻坚 ────────────────────────────────────────────────────────────────
// 攻克 NPC 城池的一次性掠夺奖励
export const NPC_CITY_LOOT = { coin: 2000, grain: 5000, wood: 3000, iron: 3000, stone: 3000 }
// 未占领地块的守军回复速度：每游戏小时回复「上限的 10%」
export const GARRISON_REGEN_PER_HOUR = 0.1

// ── 初始资源 ────────────────────────────────────────────────────────────────
export const INITIAL_RESOURCES = { coin: 1000, grain: 2000, wood: 500, iron: 200, stone: 500 }
export const INITIAL_TROOPS = 500   // 每名初始武将的起始兵力

// 存档 key
export const SAVE_KEY = 'slg:save:v1'
