// 九州征途（SLG）- 常量定义
// MVP 阶段为纯本地单机沙盘，数值以「演示节奏」为准（时间加速），详见 docs/slg.md。

// ── 地图 ────────────────────────────────────────────────────────────────────
export const MAP_W = 48          // 地图宽（格）
export const MAP_H = 48          // 地图高（格）
export const TILE_SIZE = 48      // 单格像素
// 铜矿地占比：地貌平滑后按此概率把陆地随机改为铜矿（散点式矿脉，见 MapGenerator 步骤 2.5）
export const COPPER_TILE_RATE = 0.04

// 时间加速：1 真实秒 = 60 游戏秒（游戏内 1 小时 ≈ 真实 1 分钟）
export const TIME_SCALE = 60

// 离线收益上限（游戏内秒）：8 游戏小时
export const OFFLINE_CAP_SECONDS = 8 * 3600

// ── 纪元 ────────────────────────────────────────────────────────────────────
// 游戏内历法：从公元 1 年 1 月起算，按 365 天/年、12 月/年 换算。
// now（游戏秒）→ 年月，仅用于展示，不影响玩法节奏。
export const GAME_START_YEAR = 1
export const GAME_SECONDS_PER_YEAR = 365 * 24 * 3600
export const GAME_SECONDS_PER_MONTH = GAME_SECONDS_PER_YEAR / 12
export const GAME_SECONDS_PER_DAY = 24 * 3600

// ── 地块类型 ────────────────────────────────────────────────────────────────
// res: 该地块产出的资源 key（null = 不产出/不可通行）
export const TILE_TYPES = {
  plain:    { name: '平原', res: 'grain', color: 0x9fb96e, passable: true },
  farm:     { name: '农田', res: 'grain', color: 0xc9b458, passable: true },
  forest:   { name: '森林', res: 'wood',  color: 0x4e7a3b, passable: true },
  hill:     { name: '丘陵', res: 'stone', color: 0xb59872, passable: true },
  mountain: { name: '山地', res: 'iron',  color: 0x8d8f96, passable: true },
  // 铜矿地：产铜币（res:'coin'）。铜币基础人人有份（level*COIN_YIELD_PER_LEVEL=20），铜矿地再叠加
  // level*BASE_YIELD_PER_LEVEL=100，合计每级 120 铜币 —— 约普通地 6 倍的铜矿产出速度。
  copper:   { name: '铜矿', res: 'coin',  color: 0xd07b3a, passable: true },
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
  jade:  { name: '玉石', icon: '💎' },
}

// 地块每小时产量 = level * BASE_YIELD_PER_LEVEL（npcCity 为每种资源各产一半）
export const BASE_YIELD_PER_LEVEL = 100
// 铜币：所有领地统一按 level * 20 / 小时 产出
export const COIN_YIELD_PER_LEVEL = 20

// 编队（formation）：最多 3 名武将组成的战斗小队，攻守同一口径。
//   玩家出征：MAX_MARCH_PARTY=3（一个出征编队，见下文）
//   守军：TILE_GUARDS[level].teams / NPC_CITY_LEVELS[level].teams 为「编队数」，
//         每个编队 = FORMATION_SIZE 名武将，每名武将兵力在配置表中写死，方便单独调整。
// 普通地块守军总兵力 = teams × FORMATION_SIZE × TILE_GUARDS[level].troops。
// NPC 城池沿用显式 garrison 总额，per-将 = garrison / (teams × FORMATION_SIZE)。
export const FORMATION_SIZE = 3                   // 每个编队的武将数
export function garrisonOf(level, type) {
  if (type === 'npcCity') return NPC_CITY_LEVELS[level]?.garrison ?? NPC_CITY_LEVELS[NPC_CITY_MAX_LEVEL].garrison
  const spec = TILE_GUARDS[level]
  if (!spec) return 0
  return spec.teams * FORMATION_SIZE * spec.troops
}
// 每名守将武将兵力（普通地块）= TILE_GUARDS[level].troops
export function troopsPerGuard(level) {
  return TILE_GUARDS[level]?.troops ?? 0
}

// ── 主城 ────────────────────────────────────────────────────────────────────
export const CITY_MAX_LEVEL = 10
// 领地上限 = 8 + 主城等级 * 10
export function territoryCap(cityLv) { return 8 + cityLv * 10 }
// 升级到 lv 的花费（lv2 起）：指数增长，lv10 为 512x 基础
export function cityUpgradeCost(toLv) {
  const k = Math.pow(2, toLv - 2)   // lv2:1x lv3:2x lv4:4x ... lv10:256x
  return { coin: 500 * k, wood: 500 * k, stone: 500 * k }
}

// ── 建筑体系（阶段二）─────────────────────────────────────────────────────────
// 主城内四条独立强化线，效果覆盖全局。等级 1~10 且不得超过主城等级。
export const BUILDING_MAX_LEVEL = 10
export const BUILDINGS = {
  granary:  { name: '粮仓',   icon: '🌾', costKeys: ['grain', 'wood'] },
  barracks: { name: '兵营',   icon: '⚔️', costKeys: ['wood', 'iron'] },
  training: { name: '校场',   icon: '🎯', costKeys: ['stone', 'coin'] },
  forge:    { name: '铁匠坊', icon: '🔨', costKeys: ['iron', 'stone'] },
}
// 升级到 lv 的花费（lv2 起）：两种主资源各 300 × 2^(lv-2)，lv10 为 512x 基础
export function buildingUpgradeCost(type, toLv) {
  const k = Math.pow(2, toLv - 2)   // lv2:1x lv3:2x ... lv10:256x
  const [a, b] = BUILDINGS[type].costKeys
  return { [a]: 300 * k, [b]: 300 * k }
}
export const GRANARY_YIELD_PER_LEVEL = 0.05   // 每级 +5% 全资源产出（叠乘）
export const BARRACKS_CAP_PER_LEVEL = 100      // 每级 +100 带兵上限
export const TRAINING_EXP_PER_LEVEL = 20       // 每级 20 经验/游戏小时（在城武将挂机）
export const FORGE_STAT_PER_LEVEL = 1          // 每级 +1 全属性（武/防/智/速，战斗结算时叠加）

// ── 体力（阶段二）─────────────────────────────────────────────────────────────
export const STAMINA_MAX = 100
export const MARCH_STAMINA_COST = 10           // 每次出征固定消耗（够连打 10 次）
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
// ── 战斗结算（多对多回合制：全场按速度排序逐将行动，见 core/battle.js）───────
export const BATTLE_MAX_ROUNDS = 10        // 最多打 10 回合，仍未分胜负则判平
export const BATTLE_ROUND_ATTRITION = 0.2  // 单次攻击按攻防战力比造成的兵力损耗系数
export const MAX_MARCH_PARTY = 3           // 单次出征最多同行武将（= 一个出征编队的上限）
export const MAX_FORMATIONS = 4            // 玩家可保存的编队预设槽位数
export const FORMATION_NAME_MAX_LEN = 6    // 编队名称最大字数

// ── 武将 ────────────────────────────────────────────────────────────────────
// 品质分档（招募抽卡的概率与展示色）。basic 仅守将用，rate=0 不进抽卡池。
export const GENERAL_QUALITY = {
  basic:  { name: '平庸', color: '#9e9e9e', rate: 0 },
  common: { name: '普通', color: '#bdbdbd', rate: 50 },
  rare:   { name: '精良', color: '#4fc3f7', rate: 30 },
  elite:  { name: '精锐', color: '#ba68c8', rate: 15 },
  legend: { name: '王牌', color: '#ffb300', rate: 5 },
}
// 品质成长值：升级/觉醒的属性提升按此系数缩放（品质越高成长越快）
export const GENERAL_GROWTH = {
  basic: 1, common: 1.3, rare: 1.7, elite: 2.2, legend: 3,
}
export function growthOf(quality) { return GENERAL_GROWTH[quality] ?? 1 }
// 升级基础属性提升（实际 = 基础 × 品质成长值）
export const LEVELUP_ATK = 2
export const LEVELUP_DEF = 2
export const LEVELUP_INT = 2
export const LEVELUP_POL = 2
export const LEVELUP_CHA = 2
// 觉醒基础属性提升（实际 = 基础 × 品质成长值）
export const AWAKEN_ATK = 3
export const AWAKEN_DEF = 3
export const AWAKEN_INT = 3
export const AWAKEN_POL = 3
export const AWAKEN_CHA = 3

/** 速度 = 五维平均值（武力/统率/智力/政治/魅力） */
export function calcSpd({ atk, def, int, pol, cha }) {
  return (atk + def + int + pol + cha) / 5
}

// ── 武将数值来源 ──────────────────────────────────────────────────────────────
// 参照《三国志》系列（Koei 历代综合评价）的五维：武力/统率/智力/政治/魅力（0~100），
// 换算为本游戏字段：atk=武力  def=统率  int=智力  pol=政治  cha=魅力。
// 速度 spd 由五维平均值计算得出，不单独填写。
// 品质与兵种参考史实定位与游戏平衡微调。

// 可招募武将池（按品质分档，抽卡先 roll 品质再从该档随机取一名）
export const RECRUITABLE_GENERALS = [
  // === Legend (传说) - 6名 ===
  { id: 'zhugeliang', name: '诸葛亮', quality: 'legend', faction: 'shu', troopType: 'bow',     atk: 62,  def: 98, int: 100, pol: 100, cha: 100 },
  { id: 'caocao',     name: '曹操',   quality: 'legend', faction: 'wei', troopType: 'spear',   atk: 78,  def: 98, int: 92,  pol: 90,  cha: 90 },
  { id: 'lvbu',       name: '吕布',   quality: 'legend', faction: 'qun', troopType: 'cavalry', atk: 100, def: 72, int: 26,  pol: 30,  cha: 60 },
  { id: 'sunquan',    name: '孙权',   quality: 'legend', faction: 'wu',  troopType: 'shield',  atk: 72,  def: 86, int: 82,  pol: 80,  cha: 85 },
  { id: 'simayi',     name: '司马懿', quality: 'legend', faction: 'wei', troopType: 'spear',   atk: 60,  def: 96, int: 98,  pol: 85,  cha: 70 },
  { id: 'guanyu',     name: '关羽',   quality: 'legend', faction: 'shu', troopType: 'cavalry', atk: 98,  def: 94, int: 78,  pol: 65,  cha: 95 },

  // === Elite (精英) - 16名 ===
  { id: 'zhouyu',        name: '周瑜',     quality: 'elite', faction: 'wu',  troopType: 'bow',     atk: 70, def: 92, int: 96, pol: 80, cha: 95 },
  { id: 'zhangfei',      name: '张飞',     quality: 'elite', faction: 'shu', troopType: 'spear',   atk: 98, def: 78, int: 32, pol: 40, cha: 70 },
  { id: 'zhaoyun',       name: '赵云',     quality: 'elite', faction: 'shu', troopType: 'cavalry', atk: 96, def: 92, int: 78, pol: 70, cha: 95 },
  { id: 'machao',        name: '马超',     quality: 'elite', faction: 'qun', troopType: 'cavalry', atk: 97, def: 78, int: 34, pol: 35, cha: 75 },
  { id: 'huangzhong',    name: '黄忠',     quality: 'elite', faction: 'shu', troopType: 'bow',     atk: 94, def: 82, int: 60, pol: 55, cha: 80 },
  { id: 'liubei',        name: '刘备',     quality: 'elite', faction: 'shu', troopType: 'spear',   atk: 76, def: 82, int: 82, pol: 90, cha: 100 },
  { id: 'sunce',         name: '孙策',     quality: 'elite', faction: 'wu',  troopType: 'cavalry', atk: 92, def: 86, int: 66, pol: 60, cha: 90 },
  { id: 'sunjian',       name: '孙坚',     quality: 'elite', faction: 'wu',  troopType: 'shield',  atk: 90, def: 90, int: 70, pol: 70, cha: 85 },
  { id: 'taishici',      name: '太史慈',   quality: 'elite', faction: 'wu',  troopType: 'bow',     atk: 90, def: 84, int: 60, pol: 55, cha: 85 },
  { id: 'zhangliao',     name: '张辽',     quality: 'elite', faction: 'wei', troopType: 'cavalry', atk: 90, def: 92, int: 78, pol: 70, cha: 80 },
  { id: 'lvmeng',        name: '吕蒙',     quality: 'elite', faction: 'wu',  troopType: 'bow',     atk: 69, def: 96, int: 95, pol: 88, cha: 91 },
  { id: 'luxun',         name: '陆逊',     quality: 'elite', faction: 'wu',  troopType: 'bow',     atk: 69, def: 96, int: 95, pol: 88, cha: 91 },
  { id: 'dengai',        name: '邓艾',     quality: 'elite', faction: 'wei', troopType: 'spear',   atk: 87, def: 94, int: 89, pol: 81, cha: 70 },
  { id: 'guojia',        name: '郭嘉',     quality: 'elite', faction: 'wei', troopType: 'bow',     atk: 15, def: 62, int: 98, pol: 84, cha: 80 },
  { id: 'huangyueying',  name: '黄月英',   quality: 'elite', faction: 'shu', troopType: 'shield',  atk: 40, def: 60, int: 92, pol: 80, cha: 75 },
  { id: 'sunshangxiang', name: '孙尚香',   quality: 'elite', faction: 'wu',  troopType: 'cavalry', atk: 86, def: 78, int: 64, pol: 55, cha: 82 },

  // === Rare (稀有) - 26名 ===
  { id: 'dianwei',    name: '典韦',   quality: 'rare', faction: 'wei', troopType: 'shield',  atk: 95, def: 56, int: 36, pol: 30, cha: 60 },
  { id: 'zhanghe',    name: '张郃',   quality: 'rare', faction: 'qun', troopType: 'bow',     atk: 90, def: 86, int: 76, pol: 70, cha: 75 },
  { id: 'zhoutai',    name: '周泰',   quality: 'rare', faction: 'wu',  troopType: 'shield',  atk: 88, def: 76, int: 46, pol: 40, cha: 70 },
  { id: 'jiangwei',   name: '姜维',   quality: 'rare', faction: 'shu', troopType: 'spear',   atk: 89, def: 90, int: 92, pol: 75, cha: 80 },
  { id: 'weiyi',      name: '魏延',   quality: 'rare', faction: 'shu', troopType: 'spear',   atk: 92, def: 82, int: 64, pol: 55, cha: 55 },
  { id: 'ganning',    name: '甘宁',   quality: 'rare', faction: 'wu',  troopType: 'bow',     atk: 92, def: 80, int: 74, pol: 50, cha: 85 },
  { id: 'xuchu',      name: '许褚',   quality: 'rare', faction: 'wei', troopType: 'spear',   atk: 96, def: 58, int: 34, pol: 30, cha: 60 },
  { id: 'chengpu',    name: '程普',   quality: 'rare', faction: 'wu',  troopType: 'shield',  atk: 84, def: 86, int: 68, pol: 70, cha: 75 },
  { id: 'wenchou',    name: '文丑',   quality: 'rare', faction: 'qun', troopType: 'cavalry', atk: 92, def: 68, int: 34, pol: 35, cha: 55 },
  { id: 'xiahoudun',  name: '夏侯惇', quality: 'rare', faction: 'wei', troopType: 'shield',  atk: 90, def: 80, int: 50, pol: 55, cha: 75 },
  { id: 'dongzhuo',   name: '董卓',   quality: 'rare', faction: 'qun', troopType: 'shield',  atk: 84, def: 80, int: 40, pol: 50, cha: 55 },
  { id: 'zhangjiao',  name: '张角',   quality: 'rare', faction: 'qun', troopType: 'bow',     atk: 42, def: 72, int: 92, pol: 80, cha: 90 },
  { id: 'xiahouyuan', name: '夏侯渊', quality: 'rare', faction: 'wei', troopType: 'cavalry', atk: 90, def: 80, int: 54, pol: 55, cha: 70 },
  { id: 'huanggai',   name: '黄盖',   quality: 'rare', faction: 'wu',  troopType: 'bow',     atk: 84, def: 82, int: 64, pol: 70, cha: 80 },
  { id: 'pangtong',   name: '庞统',   quality: 'rare', faction: 'shu', troopType: 'bow',     atk: 34, def: 62, int: 96, pol: 90, cha: 70 },
  { id: 'xushu',      name: '徐庶',   quality: 'rare', faction: 'shu', troopType: 'spear',   atk: 64, def: 74, int: 90, pol: 85, cha: 80 },
  { id: 'jiaxu',      name: '贾诩',   quality: 'rare', faction: 'wei', troopType: 'bow',     atk: 45, def: 78, int: 97, pol: 78, cha: 52 },
  { id: 'xunyu',      name: '荀彧',   quality: 'rare', faction: 'wei', troopType: 'shield',  atk: 14, def: 54, int: 95, pol: 99, cha: 94 },
  { id: 'xunyou',     name: '荀攸',   quality: 'rare', faction: 'wei', troopType: 'bow',     atk: 25, def: 58, int: 94, pol: 80, cha: 70 },
  { id: 'zhangzhao',  name: '张昭',   quality: 'rare', faction: 'wu',  troopType: 'shield',  atk: 20, def: 48, int: 82, pol: 95, cha: 70 },
  { id: 'yuanshao',   name: '袁绍',   quality: 'rare', faction: 'qun', troopType: 'cavalry', atk: 68, def: 82, int: 60, pol: 70, cha: 90 },
  { id: 'liubiao',    name: '刘表',   quality: 'rare', faction: 'qun', troopType: 'shield',  atk: 48, def: 62, int: 75, pol: 86, cha: 80 },
  { id: 'gaoshun',    name: '高顺',   quality: 'rare', faction: 'qun', troopType: 'spear',   atk: 86, def: 88, int: 60, pol: 46, cha: 69 },
  { id: 'chenggong',  name: '陈宫',   quality: 'rare', faction: 'qun', troopType: 'bow',     atk: 55, def: 79, int: 89, pol: 83, cha: 69 },
  { id: 'yanliang',   name: '颜良',   quality: 'rare', faction: 'qun', troopType: 'cavalry', atk: 94, def: 76, int: 30, pol: 30, cha: 60 },
  { id: 'wenyang',    name: '文鸯',   quality: 'rare', faction: 'wei', troopType: 'cavalry', atk: 94, def: 80, int: 50, pol: 30, cha: 65 },

  // === Common (普通) - 27名 ===
  { id: 'caoren',     name: '曹仁',   quality: 'common', faction: 'wei', troopType: 'cavalry', atk: 80, def: 88, int: 60, pol: 65, cha: 75 },
  { id: 'xusheng',    name: '徐盛',   quality: 'common', faction: 'wu',  troopType: 'bow',     atk: 82, def: 84, int: 68, pol: 65, cha: 75 },
  { id: 'dingfeng',   name: '丁奉',   quality: 'common', faction: 'wu',  troopType: 'bow',     atk: 86, def: 78, int: 64, pol: 60, cha: 70 },
  { id: 'xuhuang',    name: '徐晃',   quality: 'common', faction: 'wei', troopType: 'spear',   atk: 90, def: 86, int: 70, pol: 70, cha: 75 },
  { id: 'zhuran',     name: '朱然',   quality: 'common', faction: 'wu',  troopType: 'shield',  atk: 76, def: 82, int: 70, pol: 65, cha: 70 },
  { id: 'yuwen',      name: '于禁',   quality: 'common', faction: 'wei', troopType: 'spear',   atk: 82, def: 86, int: 64, pol: 65, cha: 70 },
  { id: 'madai',      name: '马岱',   quality: 'common', faction: 'shu', troopType: 'cavalry', atk: 84, def: 76, int: 54, pol: 50, cha: 65 },
  { id: 'guanxing',   name: '关兴',   quality: 'common', faction: 'shu', troopType: 'cavalry', atk: 82, def: 72, int: 50, pol: 45, cha: 70 },
  { id: 'huaxiong',   name: '华雄',   quality: 'common', faction: 'qun', troopType: 'cavalry', atk: 90, def: 72, int: 40, pol: 40, cha: 60 },
  { id: 'pangde',     name: '庞德',   quality: 'common', faction: 'wei', troopType: 'shield',  atk: 92, def: 80, int: 56, pol: 55, cha: 75 },
  { id: 'lusu',       name: '鲁肃',   quality: 'common', faction: 'wu',  troopType: 'shield',  atk: 46, def: 76, int: 90, pol: 95, cha: 85 },
  { id: 'jiling',     name: '纪灵',   quality: 'common', faction: 'qun', troopType: 'spear',   atk: 82, def: 72, int: 44, pol: 45, cha: 60 },
  { id: 'diaochan',   name: '貂蝉',   quality: 'common', faction: 'qun', troopType: 'bow',     atk: 28, def: 34, int: 76, pol: 60, cha: 100 },
  { id: 'huatuo',     name: '华佗',   quality: 'common', faction: 'qun', troopType: 'shield',  atk: 16, def: 24, int: 96, pol: 50, cha: 85 },
  { id: 'lidian',     name: '李典',   quality: 'common', faction: 'wei', troopType: 'shield',  atk: 72, def: 82, int: 80, pol: 75, cha: 75 },
  { id: 'yuejin',     name: '乐进',   quality: 'common', faction: 'wei', troopType: 'spear',   atk: 86, def: 80, int: 58, pol: 60, cha: 70 },
  { id: 'maliang',    name: '马良',   quality: 'common', faction: 'shu', troopType: 'bow',     atk: 30, def: 50, int: 88, pol: 85, cha: 82 },
  { id: 'guanping',   name: '关平',   quality: 'common', faction: 'shu', troopType: 'spear',   atk: 82, def: 76, int: 60, pol: 55, cha: 72 },
  { id: 'zhoucang',   name: '周仓',   quality: 'common', faction: 'shu', troopType: 'spear',   atk: 84, def: 62, int: 38, pol: 30, cha: 65 },
  { id: 'menghuo',    name: '孟获',   quality: 'common', faction: 'qun', troopType: 'cavalry', atk: 88, def: 70, int: 32, pol: 30, cha: 75 },
  { id: 'zhangxiu',   name: '张绣',   quality: 'common', faction: 'qun', troopType: 'cavalry', atk: 78, def: 72, int: 62, pol: 55, cha: 70 },
  { id: 'mateng',     name: '马腾',   quality: 'common', faction: 'qun', troopType: 'cavalry', atk: 82, def: 78, int: 40, pol: 45, cha: 70 },
  { id: 'daqiao',     name: '大乔',   quality: 'common', faction: 'wu',  troopType: 'bow',     atk: 20, def: 25, int: 70, pol: 65, cha: 95 },
  { id: 'xiaoqiao',   name: '小乔',   quality: 'common', faction: 'wu',  troopType: 'bow',     atk: 20, def: 25, int: 68, pol: 60, cha: 94 },
  { id: 'lingtong',   name: '凌统',   quality: 'common', faction: 'wu',  troopType: 'cavalry', atk: 86, def: 82, int: 68, pol: 55, cha: 76 },
  { id: 'caopi',      name: '曹丕',   quality: 'common', faction: 'wei', troopType: 'spear',   atk: 65, def: 70, int: 75, pol: 80, cha: 75 },
  { id: 'wangyi',     name: '王异',   quality: 'common', faction: 'wei', troopType: 'cavalry', atk: 72, def: 70, int: 78, pol: 55, cha: 70 },
];

// ── 守将池（仅守地用，不进抽卡池）───────────────────────────────────────────
// 守将按 quality 分档，与可招募武将池共用同一套品质体系：
//   basic  = 低级守将（1~3 级地、1 级 NPC 城池）
//   common = 中级守将（4~7 级地、2 级 NPC 城池），不进抽卡池，仅作守军
// 高级地（8~10 级）与高级 NPC 城池（3~5 级）从 RECRUITABLE_GENERALS 对应品质取。
export const GARRISON_GENERALS = [
  // === basic（低级守将，12名）===
  { id: 'yanbaihu',   name: '严白虎', quality: 'basic', faction: 'wu',  troopType: 'spear',   atk: 58, def: 44, int: 32, pol: 30, cha: 45 },
  { id: 'wanglang',   name: '王朗',   quality: 'basic', faction: 'wei', troopType: 'bow',     atk: 22, def: 32, int: 78, pol: 75, cha: 60 },
  { id: 'kongrong',   name: '孔融',   quality: 'basic', faction: 'qun', troopType: 'shield',  atk: 16, def: 28, int: 82, pol: 85, cha: 80 },
  { id: 'liuzhang',   name: '刘璋',   quality: 'basic', faction: 'qun', troopType: 'shield',  atk: 22, def: 38, int: 44, pol: 50, cha: 55 },
  { id: 'liuyan',     name: '刘焉',   quality: 'basic', faction: 'qun', troopType: 'shield',  atk: 28, def: 42, int: 60, pol: 75, cha: 60 },
  { id: 'baoshixin',  name: '鲍信',   quality: 'basic', faction: 'wei', troopType: 'spear',   atk: 66, def: 72, int: 66, pol: 65, cha: 70 },
  { id: 'quancong',   name: '全琮',   quality: 'basic', faction: 'wu',  troopType: 'shield',  atk: 58, def: 62, int: 58, pol: 70, cha: 70 },
  { id: 'zhangyang',  name: '张杨',   quality: 'basic', faction: 'qun', troopType: 'cavalry', atk: 66, def: 62, int: 48, pol: 55, cha: 60 },
  { id: 'liaohua',    name: '廖化',   quality: 'basic', faction: 'shu', troopType: 'spear',   atk: 78, def: 72, int: 54, pol: 50, cha: 65 },
  { id: 'wangshuang', name: '王双',   quality: 'basic', faction: 'wei', troopType: 'cavalry', atk: 85, def: 56, int: 30, pol: 30, cha: 50 },
  { id: 'hansui',     name: '韩遂',   quality: 'basic', faction: 'qun', troopType: 'cavalry', atk: 62, def: 68, int: 50, pol: 60, cha: 65 },
  { id: 'panzhang',   name: '潘璋',   quality: 'basic', faction: 'wu',  troopType: 'spear',   atk: 80, def: 70, int: 40, pol: 40, cha: 55 },

  // === common（中级守将，16名）===
  { id: 'haozhao',    name: '郝昭',   quality: 'common', faction: 'wei', troopType: 'shield',  atk: 78, def: 88, int: 78, pol: 60, cha: 70 },
  { id: 'guohuai',    name: '郭淮',   quality: 'common', faction: 'wei', troopType: 'spear',   atk: 78, def: 86, int: 80, pol: 75, cha: 75 },
  { id: 'caozhen',    name: '曹真',   quality: 'common', faction: 'wei', troopType: 'cavalry', atk: 78, def: 82, int: 65, pol: 70, cha: 70 },
  { id: 'wangping',   name: '王平',   quality: 'common', faction: 'shu', troopType: 'shield',  atk: 76, def: 84, int: 70, pol: 60, cha: 65 },
  { id: 'hanzong',    name: '韩当',   quality: 'common', faction: 'wu',  troopType: 'shield',  atk: 82, def: 78, int: 50, pol: 50, cha: 70 },
  { id: 'zhangren',   name: '张任',   quality: 'common', faction: 'qun', troopType: 'cavalry', atk: 82, def: 78, int: 76, pol: 70, cha: 75 },
  { id: 'fazheng',    name: '法正',   quality: 'common', faction: 'shu', troopType: 'bow',     atk: 42, def: 58, int: 93, pol: 85, cha: 75 },
  { id: 'caohong',    name: '曹洪',   quality: 'common', faction: 'wei', troopType: 'shield',  atk: 78, def: 76, int: 42, pol: 52, cha: 60 },
  { id: 'zhuhuan',    name: '朱桓',   quality: 'common', faction: 'wu',  troopType: 'bow',     atk: 76, def: 80, int: 66, pol: 65, cha: 70 },
  { id: 'gongsunzan', name: '公孙瓒', quality: 'common', faction: 'qun', troopType: 'cavalry', atk: 82, def: 80, int: 56, pol: 60, cha: 75 },
  { id: 'zhangyi',    name: '张翼',   quality: 'common', faction: 'shu', troopType: 'spear',   atk: 76, def: 74, int: 60, pol: 55, cha: 65 },
  { id: 'zhurong',    name: '祝融',   quality: 'common', faction: 'qun', troopType: 'cavalry', atk: 82, def: 65, int: 30, pol: 25, cha: 72 },
  { id: 'zhugejin',   name: '诸葛瑾', quality: 'common', faction: 'wu',  troopType: 'shield',  atk: 38, def: 68, int: 86, pol: 80, cha: 80 },
  { id: 'liuye',      name: '刘晔',   quality: 'common', faction: 'wei', troopType: 'bow',     atk: 28, def: 44, int: 90, pol: 85, cha: 65 },
  { id: 'tianfeng',   name: '田丰',   quality: 'common', faction: 'qun', troopType: 'bow',     atk: 32, def: 48, int: 93, pol: 90, cha: 75 },
  { id: 'juanshu',    name: '沮授',   quality: 'common', faction: 'qun', troopType: 'bow',     atk: 36, def: 74, int: 92, pol: 90, cha: 80 },
];

// ── 地块守卫规格 ─────────────────────────────────────────────────────────────
// 每块可通行地块由 1~3 个编队驻守（teams=编队数；teams>1 须一次远征连灭全部编队才能占领，
// 否则守军全部回满）。每个编队 = FORMATION_SIZE(3) 名武将，每名武将兵力 = troops（写死）。
// 抽将规则：编队内 3 名武将互不相同；跨编队允许重复（最小池仅需 ≥3）。
// pool 统一为 quality 名称：'basic'/'common' 取自 GARRISON_GENERALS，'rare'/'elite'/'legend' 取自 RECRUITABLE_GENERALS。
export const TILE_MAX_LEVEL = 10
export const TILE_GUARDS = {
  1:  { teams: 1, pool: 'basic',  guardLv: 1,  troops: 100  },    // 1队×3将×100  = 300
  2:  { teams: 1, pool: 'basic',  guardLv: 3,  troops: 200  },    // 1×3×200      = 600
  3:  { teams: 1, pool: 'basic',  guardLv: 5,  troops: 400  },    // 1×3×400      = 1200
  4:  { teams: 1, pool: 'common', guardLv: 10,  troops: 800  },    // 1×3×800      = 2400
  5:  { teams: 2, pool: 'common', guardLv: 14, troops: 1000 },    // 2×3×1000     = 6000
  6:  { teams: 2, pool: 'rare', guardLv: 15, troops: 2000 },    // 2×3×2000     = 12000
  7:  { teams: 2, pool: 'rare', guardLv: 16, troops: 3000 },    // 2×3×3000     = 18000
  8:  { teams: 2, pool: 'elite',   guardLv: 17, troops: 4000 },    // 2×3×4000     = 24000
  9:  { teams: 3, pool: 'elite',  guardLv: 18, troops: 4000 },    // 3×3×4000     = 36000
  10: { teams: 3, pool: 'legend', guardLv: 20, troops: 5000 },    // 3×3×5000     = 45000
}
// NPC 城池分 5 级（等级如何分配到地图上的具体城池由地图生成逻辑决定，这里只定义每级的规格）：
// pool 按等级递进 basic→common→rare→elite→legend（与 TILE_GUARDS 高级地同档同 guardLv，数值口径一致）。
// 各等级编队数与总兵力均写死，per-将 = garrison / (teams × FORMATION_SIZE)。
export const NPC_CITY_MAX_LEVEL = 5
export const NPC_CITY_LEVELS = {
  1: { garrison: 30000,  teams: 5,  pool: 'basic',  guardLv: 12, loot: { coin: 2000, grain: 5000,  wood: 3000,  iron: 3000,  stone: 3000 } },  // 5×3×2000  = 30000
  2: { garrison: 54000,  teams: 6,  pool: 'common', guardLv: 14, loot: { coin: 2500, grain: 6250,  wood: 3750,  iron: 3750,  stone: 3750 } },  // 6×3×3000  = 54000
  3: { garrison: 84000,  teams: 7,  pool: 'rare',   guardLv: 16, loot: { coin: 5000, grain: 12500, wood: 7500,  iron: 7500,  stone: 7500 } },  // 7×3×4000  = 84000
  4: { garrison: 120000, teams: 8,  pool: 'elite',  guardLv: 18, loot: { coin: 6000, grain: 15000, wood: 9000,  iron: 9000,  stone: 9000 } },  // 8×3×5000  = 120000
  5: { garrison: 150000, teams: 10, pool: 'legend', guardLv: 20, loot: { coin: 8000, grain: 20000, wood: 12000, iron: 12000, stone: 12000 } },  // 10×3×5000 = 150000
}
// NPC 城池在地图上的等级分布：1 级（最弱）5 座、2 级 4 座、3 级 3 座、4 级 2 座、5 级（最强）1 座，
// 共 15 座，弱到强梯度分布，由地图生成逻辑按此计数随机放置各等级城池。
export const NPC_CITY_LEVEL_COUNTS = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 }

/** 取守将候选池：'basic'/'common' 从 GARRISON_GENERALS 按 quality 筛选；其余品质名从 RECRUITABLE_GENERALS 筛选 */
export function guardPoolOf(pool) {
  const fromGarrison = GARRISON_GENERALS.filter(g => g.quality === pool)
  if (fromGarrison.length) return fromGarrison
  return RECRUITABLE_GENERALS.filter(g => g.quality === pool)
}

// 守将等级加成与玩家成长口径对齐：玩家每级永久 +2×成长值（_gainExp 落进属性），
// 战斗结算时再临时 +(lv-1)×2×成长值 —— 合计每级 +4×成长值。守将模板存基础值，此处一次性折算。
export function guardStat(base, guardLv, quality) {
  return base + (guardLv - 1) * 4 * growthOf(quality)
}

/** 地块守卫规格（npcCity 按城池等级查 NPC_CITY_LEVELS，与普通地块的 TILE_GUARDS 是两套独立编号） */
export function tileGuardSpec(level, type) {
  return type === 'npcCity' ? NPC_CITY_LEVELS[level] : TILE_GUARDS[level]
}
// 招募花费（铜币的主要消耗口）与阵容上限
export const RECRUIT_COST_COIN = 1000
export const MAX_GENERALS = 8
// 开局赠送的免费招募次数（不再固定 3 武将起手，改为送三次抽卡机会）
export const FREE_RECRUIT_COUNT = 3

/** 按 id 查武将模板（可招募/守将），存档恢复与守将重建时用 */
export function findGeneralTemplate(id) {
  return RECRUITABLE_GENERALS.find(g => g.id === id) ||
    GARRISON_GENERALS.find(g => g.id === id) || null
}
export const GENERAL_BASE_TROOP_CAP = 100    // 带兵上限 = 100 + (lv-1)*200
export function troopCapOf(lv) { return GENERAL_BASE_TROOP_CAP + (lv - 1) * 200 }
// 升级经验：升到下一级需要 lv*200 经验
export function expToLevel(lv) { return lv * 200 }
export const GENERAL_MAX_LEVEL = 20
// 战法携带槽位：默认 1 个主动战法；武将等级达到 SKILL_SLOT2_LEVEL（=满级）解锁第 2 个槽位
export const SKILL_SLOT2_LEVEL = GENERAL_MAX_LEVEL
export const MAX_SKILL_SLOTS = 2
export function maxSkillSlots(lv) { return lv >= SKILL_SLOT2_LEVEL ? MAX_SKILL_SLOTS : 1 }
// 征兵花费：主城 <5 级时 1 兵 = 2 粮；>=5 级时 1 兵 = 2 粮 + 1 铁矿 + 1 木材
export function getRecruitCostPerTroop(cityLv) {
  if (cityLv >= 5) return { grain: 3, iron: 1, wood: 1 }
  return { grain: 2, iron: 0, wood: 0 }
}

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
// 攻克 NPC 城池的一次性掠夺奖励，按城池等级查 NPC_CITY_LEVELS[level].loot
export function npcCityLootOf(level) {
  return NPC_CITY_LEVELS[level]?.loot ?? NPC_CITY_LEVELS[NPC_CITY_MAX_LEVEL].loot
}
// 未占领地块的守军回复速度：每游戏小时回复「上限的 10%】
export const GARRISON_REGEN_PER_HOUR = 0.1

// ── 初始资源 ────────────────────────────────────────────────────────────────
export const INITIAL_RESOURCES = { coin: 1000, grain: 2000, wood: 500, iron: 200, stone: 500, jade: 0 }
export const INITIAL_TROOPS = 100   // 每名初始武将的起始兵力（=1级基础带兵上限，开局不超编）

// ── 玉石经济（战法系统，见 docs/slg-战法升级与扩展设计.md 6.6）─────────────────
// 玉石：销毁武将产出，用于战法兑换与升级。非地块产出资源，仅由遣散武将获得。
export const DISMISS_JADE = {
  basic: 1, common: 2, rare: 5, elite: 10, legend: 20,
}
export const SKILL_MAX_LEVEL = 10

// ── 装备系统（见 docs/slg-装备系统设计.md）─────────────────────────────────
// 6 种装备槽位，每名武将每种类型最多装 1 件。
export const EQUIP_TYPES = [
  { id: 'weapon',   name: '武器', icon: '⚔️' },
  { id: 'helmet',   name: '头盔', icon: '⛑️' },
  { id: 'necklace', name: '项链', icon: '📿' },
  { id: 'armor',    name: '铠甲', icon: '🛡️' },
  { id: 'belt',     name: '腰带', icon: '🟫' },
  { id: 'boots',    name: '靴子', icon: '🥾' },
]
// 装备属性：与武将战斗属性对齐
export const EQUIP_ATTRS = {
  atk: { name: '武力', icon: '⚔' },
  def: { name: '统率', icon: '🛡' },
  int: { name: '智力', icon: '🧠' },
  spd: { name: '速度', icon: '💨' },
}
// 装备品质：与武将品质共用概率（rate），但 basic 不进装备池。
// value=Lv.1 主属性，step=每级增量，costBase=升级铜币基础（消耗 = costBase × 当前等级）
export const EQUIP_QUALITY = {
  common: { name: '普通', color: '#bdbdbd', rate: 50, value: 5,  step: 1, costBase: 200  },
  rare:   { name: '精良', color: '#4fc3f7', rate: 30, value: 10, step: 2, costBase: 500  },
  elite:  { name: '精锐', color: '#ba68c8', rate: 15, value: 18, step: 3, costBase: 1200 },
  legend: { name: '王牌', color: '#ffb300', rate: 5,  value: 30, step: 5, costBase: 3000 },
}
export const EQUIP_MAX_LEVEL = 10
export const EQUIP_DRAW_COST = 2000   // 抽装备单次消耗铜币
// 销毁装备返还玉石：按品质阶梯（与武将遣散同口径，装备档更高）
export const EQUIP_DISMISS_JADE = {
  common: 5, rare: 10, elite: 30, legend: 50,
}

// ── AI 对手势力（见 docs/slg-AI势力设计.md）───────────────────────────────────
// 2 个会自动发育、抢地盘的 AI 势力：老巢在地图生成时按种子确定性放置（MapGenerator 步骤 7），
// 扩张判定见 GameState._aiExpandStep；地块攻防完全复用现有守军规格表，AI 不设武将系统。
export const AI_FACTIONS = [
  { id: 'ai1', name: '黄巾余部', color: 0x9c5fd1 },
  { id: 'ai2', name: '黑山贼',   color: 0x1fae8e },
]
// 每 1 游戏小时为每个存活势力跑一次扩张判定
export const AI_TICK_SECONDS = 3600
// 老巢地块等级（决定老巢自身守军强度，比照中等地块/NPC 城池强度）
export const AI_LAIR_LEVEL = 6
// 玩家主城达到此等级后，AI 才会把玩家的普通领地纳入进攻候选（主城本身永远不会被攻击）
export const AI_AGGRESSION_CITY_LV = 4
// 玩家领地相对同级中立地的额外防御倍率（代表边境比荒地更难啃）
export const PLAYER_TILE_DEFENSE_MULT = 1.6
// AI 扩张胜率夹在 [下限, 上限] 之间，避免出现必胜或必败
export const AI_SUCCESS_MIN = 0.15
export const AI_SUCCESS_MAX = 0.85
// 老巢放置的最小间距（格）：与出生点、与 NPC 城池、与彼此
export const AI_LAIR_MIN_DIST_FROM_SPAWN = 10
export const AI_LAIR_MIN_DIST_FROM_CITY = 4
export const AI_LAIR_MIN_DIST_BETWEEN = 8

// 存档 key
export const SAVE_KEY = 'slg:save:v1'
