// 门派 PK · 梦幻西游风 - 常量定义
// 详见 docs/menpai-pk-xyq.md 第三节。首期为单机 PVE 1v1 demo。

// ── 战斗参数 ─────────────────────────────────────────────────────────────────
export const MAX_ROUNDS = 30          // 回合上限，到点按剩余 HP% 判胜
export const MAX_ANGER = 150          // 愤怒上限，满 150 可放必杀
export const MP_REGEN_RATIO = 0.05    // 每回合自然回 MP 占上限比例
export const DEFEND_DAMAGE_REDUCE = 0.5  // 防御态受伤减免
export const TURN_TIME_SECONDS = 30   // 每回合行动倒计时（秒），超时自动普攻

// ── 愤怒 ─────────────────────────────────────────────────────────────────────
// 端游规则：战斗中不用道具时，愤怒的唯一来源是**挨打**，按单次伤害占自身最大气血的
// 百分比分档。攻击方出手不获得愤怒 —— 愤怒是挨打的补偿、劣势方的翻盘资源。
//
// 阶梯（而非线性）是有意的：10% 这道坎上从 3 跳到 10，奖励被打出大伤害的一方。
// 「临界值取右侧」：伤害恰好等于 3%/10%/20%/30%/50%/80% 时算进更高一档，
//   故此表按 min 降序排列，取第一个 ratio >= min 的档位（下界闭区间）。
// 多段攻击（横扫千军/连环击）每一刀的伤害各自结算一次，不合并。
// 来源：端游玩家实测（手游是 1/10/20/30/40/50/60 七档，数值完全不同，勿混用）。
export const ANGER_ON_DAMAGE = [
  { min: 0.80, anger: 55 },
  { min: 0.50, anger: 40 },
  { min: 0.30, anger: 25 },
  { min: 0.20, anger: 15 },
  { min: 0.10, anger: 10 },
  { min: 0.03, anger: 3 },
  { min: 0.00, anger: 1 },   // 低于 3% 的伤害端游界面不显示，但实际每次仍 +1
]

// ── 暴击 ─────────────────────────────────────────────────────────────────────
export const CRIT_RATE_BASE = 0.05    // 基础暴击率 5%
export const CRIT_MULT = 1.5          // 暴击伤害倍率

// ── 伤害波动 ─────────────────────────────────────────────────────────────────
export const DAMAGE_VARIANCE_MIN = 0.9
export const DAMAGE_VARIANCE_MAX = 1.1

// ── 技能类型 ─────────────────────────────────────────────────────────────────
export const SkillType = {
  PHYSICAL: 'physical',   // 物理技能（受 DEF 减伤）
  MAGICAL: 'magical',     // 法术技能（受 MDEF 减伤）
  FIXED: 'fixed',         // 固定伤害（无视防御）
  HEAL: 'heal',           // 治疗
  BUFF: 'buff',           // 增益
  DEBUFF: 'debuff',       // 减益
  SEAL: 'seal',           // 封印
  REVIVE: 'revive',       // 复活
}

// 技能分类（用于 UI 分组与 AI 决策）
export const SkillCategory = {
  NORMAL: 'normal',       // 普攻
  ACTIVE: 'active',       // 主动技能
  PASSIVE: 'passive',     // 被动
  ULTIMATE: 'ultimate',   // 必杀技（150 愤怒）
}

// ── 异常状态 ─────────────────────────────────────────────────────────────────
export const StatusType = {
  STUN: 'stun',           // 眩晕：跳过行动
  SLEEP: 'sleep',         // 睡眠：无法行动，受伤害立即苏醒
  SEAL_MAGIC: 'seal_magic',   // 封法：无法用法术技能
  SEAL_PHYS: 'seal_phys',     // 封物理：无法用物理技能
  POISON: 'poison',       // 中毒：每回合扣 5% 最大 HP
  BURN: 'burn',           // 灼烧：每回合扣 5% 最大 HP
  DEFENDING: 'defending', // 防御态：本回合受伤 -50%
}

// 持续伤害状态每回合扣血比例（占最大 HP）
export const DOT_DAMAGE_RATIO = {
  [StatusType.POISON]: 0.05,
  [StatusType.BURN]: 0.05,
}

// ── 增益/减益状态（独立于异常状态，可叠加） ─────────────────────────────────
export const BuffType = {
  ATK_UP: 'atk_up',
  MATK_UP: 'matk_up',
  DEF_UP: 'def_up',
  MDEF_UP: 'mdef_up',
  SPD_UP: 'spd_up',
  ATK_DOWN: 'atk_down',
  DEF_DOWN: 'def_down',
  MDEF_DOWN: 'mdef_down',
  SPD_DOWN: 'spd_down',
  MDEF_DOWN_ULT: 'mdef_down_ult',  // 必杀附加的强力减益
}

// ── 阵营 ─────────────────────────────────────────────────────────────────────
export const Side = {
  PLAYER: 'player',
  ENEMY: 'enemy',
}

// ── 战斗阶段 ─────────────────────────────────────────────────────────────────
export const Phase = {
  SELECT: 'select',       // 双方选择行动
  RESOLVE: 'resolve',     // 依次结算行动
  ROUND_END: 'round_end', // 回合结束（DoT/状态衰减/MP回复）
  GAME_OVER: 'game_over', // 游戏结束
}

// ── 行动类型 ─────────────────────────────────────────────────────────────────
export const ActionType = {
  SKILL: 'skill',         // 使用技能
  DEFEND: 'defend',       // 防御
  ULTIMATE: 'ultimate',   // 必杀技
}

// ── 胜负结果 ─────────────────────────────────────────────────────────────────
export const Result = {
  PLAYER_WIN: 'player_win',
  ENEMY_WIN: 'enemy_win',
  DRAW: 'draw',
}

// ── 种族（仅用于门派选择前的过滤 + 展示，不参与战斗数值计算） ──────────────────
// 数值取自 docs/梦幻西游-人物属性参考.md 第一节「0 级未加点」初始属性。
// id 与 factions.js 里 faction.race 字段的取值一致（人/仙/魔），用于按种族筛选可选门派。
export const RACES = [
  {
    id: '人', name: '人族', emoji: '🧑', color: 0x3498db,
    tagline: '全属性均衡，无专长无短板',
    stats: { 体质: 10, 魔力: 10, 力量: 10, 耐力: 10, 敏捷: 10 },
  },
  {
    id: '仙', name: '仙族', emoji: '🧚', color: 0x1abc9c,
    tagline: '耐力体质高，魔力低；物理面板偏弱，法系耐久强',
    stats: { 体质: 12, 魔力: 5, 力量: 11, 耐力: 12, 敏捷: 10 },
  },
  {
    id: '魔', name: '魔族', emoji: '👹', color: 0xc0392b,
    tagline: '体质力量高，耐力敏捷低；爆发力强，防御偏软',
    stats: { 体质: 12, 魔力: 11, 力量: 11, 耐力: 8, 敏捷: 8 },
  },
]

// ── 响应式布局 ───────────────────────────────────────────────────────────────
// portrait：高 > 宽，选择类场景改用上下堆叠布局（手机竖屏、窄浏览器窗口）。
// 战斗场景的坐标另见 layout.js（BattleScene 与 UIScene 共用）。
export function getMetrics(width, height) {
  return { width, height, portrait: height > width }
}

// ── 视觉常量（场景用） ───────────────────────────────────────────────────────
export const COLORS = {
  BG: 0x1a1428,           // 深紫黑背景
  PANEL: 0x2a2438,         // 面板
  PLAYER: 0x4a90e2,        // 玩家方蓝
  ENEMY: 0xe24a4a,         // 敌方红
  HP: 0xe24a4a,            // 血条红
  MP: 0x4a90e2,            // 魔法蓝
  ANGER: 0xe2a04a,         // 愤怒橙
  TEXT: 0xf5f5f5,          // 主文字
  TEXT_DIM: 0x999999,      // 次要文字
  GOLD: 0xffd700,          // 金色（必杀高亮）
}
