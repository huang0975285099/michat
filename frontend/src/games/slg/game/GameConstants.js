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

// 地块守军总兵力：lv → l*(l+1)/2 * 100（lv1=100 … lv5=1500 … lv10=5500）；NPC 城池固定 3000。
// 多队地块（见 TILE_GUARDS.teams）由各队均分。
export function garrisonOf(level, type) {
  if (type === 'npcCity') return 3000
  return (level * (level + 1) / 2) * 100
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
// ── 战斗结算（逐回合，双方互击 + 速度先攻）───────────────────────────────────
export const BATTLE_MAX_ROUNDS = 10        // 最多打 10 回合，仍未分胜负则判平
export const BATTLE_ROUND_ATTRITION = 0.3  // 每回合按攻防战力比造成的兵力损耗系数

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
  basic: 1, common: 1.3, rare: 1.6, elite: 1.9, legend: 2.2,
}
export function growthOf(quality) { return GENERAL_GROWTH[quality] ?? 1 }
// 升级基础属性提升（实际 = 基础 × 品质成长值；int/spd 展示用，不参与战斗）
export const LEVELUP_ATK = 2
export const LEVELUP_DEF = 2
export const LEVELUP_INT = 2
export const LEVELUP_SPD = 2
// 觉醒基础属性提升（实际 = 基础 × 品质成长值；int/spd 展示用，不参与战斗）
export const AWAKEN_INT = 3
export const AWAKEN_SPD = 3
// ── 武将数值来源 ──────────────────────────────────────────────────────────────
// 参照《三国志》系列（Koei 历代综合评价，非某单一版本）的五维：统率/武力/智力/政治/魅力（0~100），
// 换算为本游戏字段：atk=武力  def=统率  int=智力（新增，供后续玩法/展示用，暂不参与战斗结算）
//   spd = round((政治+魅力)/2)  —— 谋主/主公类角色政治魅力高，出手快但攻防偏低，形成「快而脆」的差异化定位。
// 品质/tier 按综合战力评分 score=atk*0.5+def*0.35+spd*0.15（武力权重最高，速度权重最低）由高到低排序取段，
// 分段人数维持原结构不变（传说4/精英8/稀有12/普通16；守将 tier5~1 各8/8/4/4/4）以保持抽卡概率与守军强度曲线，
// 但不再保证魏蜀吴群人数均分——评分才是唯一入档依据，因此谋士型武将（如诸葛亮、司马懿）战力评分低于纯武将，
// 可能被排到比其历史知名度更低的档位，这是刻意保留的历史真实感，而非疏漏。

// 旧版开局固定三武将模板（新开局已不再自动持有，仅保留供旧存档 findGeneralTemplate 查找）。
// findGeneralTemplate 优先匹配本表，故此处数值需与 RECRUITABLE_GENERALS 同 id 条目保持一致。
// troopType 固定（率土式，武将自带兵种）。
export const STARTER_GENERALS = [
  // 魏：许褚（高攻枪兵）
  { id: 'xuchu',   name: '许褚', quality: 'common', faction: 'wei', troopType: 'spear',  atk: 96, def: 65, int: 25, spd: 26 },
  // 蜀：魏延（均衡枪兵）
  { id: 'weiyi',   name: '魏延', quality: 'rare',   faction: 'shu', troopType: 'spear',  atk: 90, def: 83, int: 58, spd: 48 },
  // 吴：周泰（高防盾兵）
  { id: 'zhoutai', name: '周泰', quality: 'rare',   faction: 'wu',  troopType: 'shield', atk: 91, def: 75, int: 32, spd: 43 },
];
// 可招募武将池（按品质分档，抽卡先 roll 品质再从该档随机取一名）
export const RECRUITABLE_GENERALS = [
  // === Legend (传说) - 4个，评分最高的纯武力/统率型猛将 ===
  { id: 'guanyu',     name: '关羽',   quality: 'legend', faction: 'shu', troopType: 'cavalry', atk: 97, def: 90, int: 75, spd: 79 },
  { id: 'zhaoyun',    name: '赵云',   quality: 'legend', faction: 'shu', troopType: 'cavalry', atk: 96, def: 91, int: 76, spd: 79 },
  { id: 'zhangliao',  name: '张辽',   quality: 'legend', faction: 'wei', troopType: 'cavalry', atk: 91, def: 92, int: 76, spd: 75 },
  { id: 'jiangwei',   name: '姜维',   quality: 'legend', faction: 'shu', troopType: 'bow',     atk: 89, def: 89, int: 92, spd: 73 },

  // === Elite (精英) - 8个 ===
  { id: 'zhanghe',    name: '张郃',   quality: 'elite', faction: 'qun', troopType: 'cavalry', atk: 89, def: 88, int: 77, spd: 64 },
  { id: 'machao',     name: '马超',   quality: 'elite', faction: 'wei', troopType: 'cavalry', atk: 97, def: 82, int: 33, spd: 48 },
  { id: 'xuhuang',    name: '徐晃',   quality: 'elite', faction: 'wei', troopType: 'spear',   atk: 90, def: 86, int: 65, spd: 62 },
  { id: 'taishici',   name: '太史慈', quality: 'elite', faction: 'wu',  troopType: 'bow',     atk: 91, def: 84, int: 56, spd: 61 },
  { id: 'caocao',     name: '曹操',   quality: 'elite', faction: 'wei', troopType: 'cavalry', atk: 72, def: 96, int: 91, spd: 96 },
  { id: 'huangzhong', name: '黄忠',   quality: 'elite', faction: 'shu', troopType: 'bow',     atk: 95, def: 78, int: 57, spd: 54 },
  { id: 'pangde',     name: '庞德',   quality: 'elite', faction: 'wei', troopType: 'spear',   atk: 94, def: 78, int: 56, spd: 53 },
  { id: 'zhouyu',     name: '周瑜',   quality: 'elite', faction: 'wu',  troopType: 'bow',     atk: 71, def: 96, int: 95, spd: 86 },

  // === Rare (稀有) - 12个 ===
  { id: 'zhangfei',   name: '张飞',   quality: 'rare', faction: 'shu', troopType: 'spear',   atk: 98,  def: 78, int: 30, spd: 38 },
  { id: 'lvbu',       name: '吕布',   quality: 'rare', faction: 'qun', troopType: 'cavalry', atk: 100, def: 78, int: 26, spd: 31 },
  { id: 'weiyi',      name: '魏延',   quality: 'rare', faction: 'shu', troopType: 'spear',   atk: 90,  def: 83, int: 58, spd: 48 },
  { id: 'ganning',    name: '甘宁',   quality: 'rare', faction: 'wu',  troopType: 'bow',     atk: 93,  def: 78, int: 55, spd: 47 },
  { id: 'caoren',     name: '曹仁',   quality: 'rare', faction: 'wu',  troopType: 'shield',  atk: 83,  def: 85, int: 58, spd: 63 },
  { id: 'zhoutai',    name: '周泰',   quality: 'rare', faction: 'wu',  troopType: 'shield',  atk: 91,  def: 75, int: 32, spd: 43 },
  { id: 'yuwen',      name: '于禁',   quality: 'rare', faction: 'wei', troopType: 'spear',   atk: 83,  def: 82, int: 62, spd: 50 },
  { id: 'liubei',     name: '刘备',   quality: 'rare', faction: 'shu', troopType: 'spear',   atk: 73,  def: 79, int: 76, spd: 90 },
  { id: 'xusheng',    name: '徐盛',   quality: 'rare', faction: 'wu',  troopType: 'bow',     atk: 84,  def: 79, int: 58, spd: 53 },
  { id: 'sunquan',    name: '孙权',   quality: 'rare', faction: 'wu',  troopType: 'shield',  atk: 70,  def: 83, int: 80, spd: 90 },
  { id: 'dingfeng',   name: '丁奉',   quality: 'rare', faction: 'wu',  troopType: 'bow',     atk: 85,  def: 76, int: 62, spd: 52 },
  { id: 'yanliang',   name: '颜良',   quality: 'rare', faction: 'qun', troopType: 'spear',   atk: 94,  def: 70, int: 32, spd: 34 },

  // === Common (普通) - 16个 ===
  { id: 'dianwei',    name: '典韦',   quality: 'common', faction: 'wei', troopType: 'spear',   atk: 96, def: 68, int: 30,  spd: 26 },
  { id: 'wenchou',    name: '文丑',   quality: 'common', faction: 'qun', troopType: 'cavalry', atk: 93, def: 69, int: 24,  spd: 28 },
  { id: 'zhuran',     name: '朱然',   quality: 'common', faction: 'wu',  troopType: 'shield',  atk: 78, def: 78, int: 65,  spd: 56 },
  { id: 'xuchu',      name: '许褚',   quality: 'common', faction: 'wei', troopType: 'spear',   atk: 96, def: 65, int: 25,  spd: 26 },
  { id: 'caoxiu',     name: '曹休',   quality: 'common', faction: 'wei', troopType: 'shield',  atk: 79, def: 76, int: 58,  spd: 57 },
  { id: 'madai',      name: '马岱',   quality: 'common', faction: 'shu', troopType: 'cavalry', atk: 83, def: 75, int: 52,  spd: 43 },
  { id: 'guanxing',   name: '关兴',   quality: 'common', faction: 'shu', troopType: 'cavalry', atk: 83, def: 71, int: 48,  spd: 48 },
  { id: 'huaxiong',   name: '华雄',   quality: 'common', faction: 'qun', troopType: 'cavalry', atk: 90, def: 67, int: 34,  spd: 30 },
  { id: 'simayi',     name: '司马懿', quality: 'common', faction: 'wei', troopType: 'cavalry', atk: 54, def: 91, int: 97,  spd: 83 },
  { id: 'wutugu',     name: '兀突骨', quality: 'common', faction: 'qun', troopType: 'shield',  atk: 88, def: 60, int: 15,  spd: 23 },
  { id: 'lusu',       name: '鲁肃',   quality: 'common', faction: 'wu',  troopType: 'shield',  atk: 55, def: 80, int: 88,  spd: 85 },
  { id: 'jiling',     name: '纪灵',   quality: 'common', faction: 'qun', troopType: 'spear',   atk: 80, def: 62, int: 40,  spd: 38 },
  { id: 'zhangjiao',  name: '张角',   quality: 'common', faction: 'qun', troopType: 'bow',     atk: 56, def: 77, int: 90,  spd: 77 },
  { id: 'zhugeliang', name: '诸葛亮', quality: 'common', faction: 'shu', troopType: 'bow',     atk: 38, def: 92, int: 100, spd: 94 },
  { id: 'diaochan',   name: '貂蝉',   quality: 'common', faction: 'qun', troopType: 'bow',     atk: 20, def: 10, int: 66,  spd: 69 },
  { id: 'huatuo',     name: '华佗',   quality: 'common', faction: 'qun', troopType: 'shield',  atk: 6,  def: 10, int: 94,  spd: 45 },
];

// ── 守将池（仅守地用，不进抽卡池）───────────────────────────────────────────
// tier = 守卫的地块等级（1~5）。6 级及以上地块直接从 RECRUITABLE_GENERALS 按品质取。
// 数值来源与分档方法同上（见「武将数值来源」注释），quality 统一为 basic。
export const GARRISON_GENERALS = [
  // === tier 5 (5级守将) - 8个 ===
  { id: 'huanggai',   name: '黄盖', tier: 5, quality: 'basic', faction: 'wu',  troopType: 'bow',     atk: 84, def: 79, int: 65, spd: 60 },
  { id: 'gaoshun',    name: '高顺', tier: 5, quality: 'basic', faction: 'qun', troopType: 'spear',   atk: 84, def: 82, int: 55, spd: 52 },
  { id: 'guohuai',    name: '郭淮', tier: 5, quality: 'basic', faction: 'wei', troopType: 'spear',   atk: 76, def: 85, int: 78, spd: 61 },
  { id: 'caozhen',    name: '曹真', tier: 5, quality: 'basic', faction: 'wei', troopType: 'cavalry', atk: 78, def: 82, int: 65, spd: 61 },
  { id: 'wangping',   name: '王平', tier: 5, quality: 'basic', faction: 'shu', troopType: 'spear',   atk: 75, def: 82, int: 68, spd: 53 },
  { id: 'hanzong',    name: '韩当', tier: 5, quality: 'basic', faction: 'wu',  troopType: 'shield',  atk: 80, def: 75, int: 48, spd: 45 },
  { id: 'liaohua',    name: '廖化', tier: 5, quality: 'basic', faction: 'shu', troopType: 'spear',   atk: 78, def: 70, int: 52, spd: 50 },
  { id: 'zhangyi',    name: '张翼', tier: 5, quality: 'basic', faction: 'shu', troopType: 'spear',   atk: 76, def: 72, int: 58, spd: 49 },

  // === tier 4 (4级守将) - 8个 ===
  { id: 'zhuhuan',    name: '朱桓',   tier: 4, quality: 'basic', faction: 'wu',  troopType: 'bow',     atk: 73, def: 75, int: 62, spd: 52 },
  { id: 'zhangren',   name: '张任',   tier: 4, quality: 'basic', faction: 'qun', troopType: 'bow',     atk: 77, def: 68, int: 55, spd: 46 },
  { id: 'panzhang',   name: '潘璋',   tier: 4, quality: 'basic', faction: 'wu',  troopType: 'spear',   atk: 79, def: 68, int: 38, spd: 35 },
  { id: 'gongsunzan', name: '公孙瓒', tier: 4, quality: 'basic', faction: 'qun', troopType: 'cavalry', atk: 72, def: 68, int: 42, spd: 47 },
  { id: 'menghuo',    name: '孟获',   tier: 4, quality: 'basic', faction: 'qun', troopType: 'cavalry', atk: 70, def: 60, int: 35, spd: 53 },
  { id: 'wangshuang', name: '王双',   tier: 4, quality: 'basic', faction: 'wei', troopType: 'cavalry', atk: 75, def: 55, int: 30, spd: 28 },
  { id: 'hansui',     name: '韩遂',   tier: 4, quality: 'basic', faction: 'qun', troopType: 'cavalry', atk: 60, def: 65, int: 58, spd: 50 },
  { id: 'baoshixin',  name: '鲍信',   tier: 4, quality: 'basic', faction: 'wei', troopType: 'spear',   atk: 62, def: 55, int: 45, spd: 45 },

  // === tier 3 (3级守将) - 4个 ===
  { id: 'quancong',   name: '全琮',   tier: 3, quality: 'basic', faction: 'wu',  troopType: 'shield', atk: 55, def: 58, int: 55, spd: 50 },
  { id: 'zhugejin',   name: '诸葛瑾', tier: 3, quality: 'basic', faction: 'wu',  troopType: 'shield', atk: 35, def: 65, int: 85, spd: 82 },
  { id: 'juanshu',    name: '沮授',   tier: 3, quality: 'basic', faction: 'qun', troopType: 'bow',    atk: 35, def: 70, int: 90, spd: 69 },
  { id: 'zhangyang',  name: '张杨',   tier: 3, quality: 'basic', faction: 'wei', troopType: 'cavalry',atk: 58, def: 48, int: 40, spd: 42 },

  // === tier 2 (2级守将) - 4个 ===
  { id: 'fazheng',    name: '法正',   tier: 2, quality: 'basic', faction: 'shu', troopType: 'bow',    atk: 40, def: 55, int: 92, spd: 68 },
  { id: 'yanbaihu',   name: '严白虎', tier: 2, quality: 'basic', faction: 'wu',  troopType: 'spear',  atk: 55, def: 40, int: 30, spd: 30 },
  { id: 'tianfeng',   name: '田丰',   tier: 2, quality: 'basic', faction: 'qun', troopType: 'bow',    atk: 30, def: 45, int: 91, spd: 65 },
  { id: 'liuye',      name: '刘晔',   tier: 2, quality: 'basic', faction: 'wei', troopType: 'bow',    atk: 25, def: 40, int: 88, spd: 71 },

  // === tier 1 (1级守将) - 4个 ===
  { id: 'liuyan',     name: '刘焉', tier: 1, quality: 'basic', faction: 'shu', troopType: 'shield', atk: 25, def: 40, int: 58, spd: 58 },
  { id: 'wanglang',   name: '王朗', tier: 1, quality: 'basic', faction: 'wei', troopType: 'bow',    atk: 20, def: 30, int: 78, spd: 68 },
  { id: 'liuzhang',   name: '刘璋', tier: 1, quality: 'basic', faction: 'shu', troopType: 'shield', atk: 20, def: 35, int: 40, spd: 53 },
  { id: 'kongrong',   name: '孔融', tier: 1, quality: 'basic', faction: 'shu', troopType: 'shield', atk: 15, def: 25, int: 70, spd: 68 },
];

// ── 地块守卫规格 ─────────────────────────────────────────────────────────────
// 每块可通行地块由 1~2 支守将队伍驻守（teams=2 须一次远征连灭两队才能占领，
// 否则守军全部回满）。pool：'tierN' 取守将池对应档，其余取抽卡池对应品质档。
// 每队兵力 = garrisonOf(level) / teams。
export const TILE_MAX_LEVEL = 10
export const TILE_GUARDS = {
  1:  { teams: 1, pool: 'tier1',  guardLv: 1 },    // 总兵 100
  2:  { teams: 1, pool: 'tier2',  guardLv: 3 },    // 300
  3:  { teams: 1, pool: 'tier3',  guardLv: 5 },    // 600
  4:  { teams: 1, pool: 'tier4',  guardLv: 7 },    // 1000
  5:  { teams: 1, pool: 'tier5',  guardLv: 9 },    // 1500
  6:  { teams: 1, pool: 'common', guardLv: 11 },   // 2100
  7:  { teams: 2, pool: 'common', guardLv: 12 },   // 1400×2
  8:  { teams: 2, pool: 'rare',   guardLv: 14 },   // 1800×2
  9:  { teams: 2, pool: 'elite',  guardLv: 16 },   // 2250×2
  10: { teams: 2, pool: 'legend', guardLv: 20 },   // 2750×2
}
// NPC 城池守将：等同 9 级地规格（Elite×2），总兵力仍 3000 → 1500×2
export const NPC_CITY_GUARD = { teams: 2, pool: 'elite', guardLv: 16 }

/** 取守将候选池（'tierN' → 守将池对应档；品质名 → 抽卡池对应品质档） */
export function guardPoolOf(pool) {
  if (pool.startsWith('tier')) {
    const tier = Number(pool.slice(4))
    return GARRISON_GENERALS.filter(g => g.tier === tier)
  }
  return RECRUITABLE_GENERALS.filter(g => g.quality === pool)
}

// 守将等级加成与玩家成长口径对齐：玩家每级永久 +2×成长值（_gainExp 落进属性），
// 战斗结算时再临时 +(lv-1)×2×成长值 —— 合计每级 +4×成长值。守将模板存基础值，此处一次性折算。
export function guardStat(base, guardLv, quality) {
  return base + (guardLv - 1) * 4 * growthOf(quality)
}

/** 地块守卫规格（npcCity 用城池守将规格） */
export function tileGuardSpec(level, type) {
  return type === 'npcCity' ? NPC_CITY_GUARD : TILE_GUARDS[level]
}
// 招募花费（铜币的主要消耗口）与阵容上限
export const RECRUIT_COST_COIN = 800
export const MAX_GENERALS = 8
// 开局赠送的免费招募次数（不再固定 3 武将起手，改为送一次抽卡机会）
export const FREE_RECRUIT_COUNT = 1
// 重复武将转觉醒：每次 +武/+防
export const AWAKEN_ATK = 3
export const AWAKEN_DEF = 3

/** 按 id 查武将模板（初始/可招募/守将），存档恢复与守将重建时用 */
export function findGeneralTemplate(id) {
  return STARTER_GENERALS.find(g => g.id === id) ||
    RECRUITABLE_GENERALS.find(g => g.id === id) ||
    GARRISON_GENERALS.find(g => g.id === id) || null
}
export const GENERAL_BASE_TROOP_CAP = 100    // 带兵上限 = 100 + (lv-1)*200
export function troopCapOf(lv) { return GENERAL_BASE_TROOP_CAP + (lv - 1) * 200 }
// 升级经验：升到 lv 需要 lv*1000 累计经验
export function expToLevel(lv) { return lv * 200 }
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
export const INITIAL_TROOPS = 100   // 每名初始武将的起始兵力（=1级基础带兵上限，开局不超编）

// 存档 key
export const SAVE_KEY = 'slg:save:v1'
