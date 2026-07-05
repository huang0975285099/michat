// 九州征途 - 装备数据与工具函数（数据驱动，与 skills.js 同层）
//
// 装备实例结构：{ iid, type, quality, attr, level, boundTo }
//   iid     全局唯一实例 ID（递归序号，由 GameState._equipSeq 分配）
//   type    装备类型 ID（weapon/helmet/necklace/armor/belt/boots，见 EQUIP_TYPES）
//   quality 品质 ID（common/rare/elite/legend，见 EQUIP_QUALITY）
//   attr    主属性 ID（atk/def/int/spd）
//   level   当前等级 1~EQUIP_MAX_LEVEL
//   boundTo 绑定的武将 ID（null = 仓库未绑定）
//
// 装备经济走「铜币」（区别于战法的玉石经济），抽装备 2000 铜币/次，升级消耗 = costBase × 当前等级。

import {
  EQUIP_TYPES, EQUIP_ATTRS, EQUIP_QUALITY, EQUIP_MAX_LEVEL,
} from '../GameConstants.js'

/** 装备类型表（id → {name,icon}） */
const TYPE_MAP = Object.fromEntries(EQUIP_TYPES.map(t => [t.id, t]))

/** 装备当前主属性数值 = Lv.1 基础 + (等级-1) × 增量 */
export function equipValue(eq) {
  const q = EQUIP_QUALITY[eq?.quality]
  if (!q) return 0
  return q.value + (eq.level - 1) * q.step
}

/** 装备升级铜币消耗 = 品质基础 × 当前等级 */
export function equipUpgradeCost(eq) {
  const q = EQUIP_QUALITY[eq?.quality]
  if (!q) return 0
  return q.costBase * eq.level
}

/** 装备是否已满级 */
export function equipMaxed(eq) {
  return eq.level >= EQUIP_MAX_LEVEL
}

/** 属性单字缩写（用于装备名后缀） */
const ATTR_SHORT = { atk: '武', def: '统', int: '智', spd: '速' }

/** 装备显示名 = 品质前缀 + 类型名 + · + 属性缩写（单字） */
export function equipName(eq) {
  const q = EQUIP_QUALITY[eq?.quality]
  const t = TYPE_MAP[eq?.type]
  const a = ATTR_SHORT[eq?.attr]
  if (!q || !t || !a) return '未知装备'
  return `${q.name}${t.name}·${a}`
}

/** 装备简短描述（用于 toast/日志） */
export function equipDesc(eq) {
  const a = EQUIP_ATTRS[eq?.attr]
  if (!a) return ''
  return `+${equipValue(eq)} ${a.name}（Lv.${eq.level}/${EQUIP_MAX_LEVEL}）`
}

/**
 * 随机掷一件装备（不包含实例 iid，调用方负责分配）。
 * 品质按 EQUIP_QUALITY.rate 加权；类型与属性均等概率。
 * @param {function} rng 可选，随机数函数 [0,1)，默认 Math.random
 * @returns {{type:string, quality:string, attr:string, level:1}}
 */
export function rollEquipment(rng = Math.random) {
  // 掷品质：按 rate 加权（与武将招募同口径，但 basic 不进池）
  const total = Object.values(EQUIP_QUALITY).reduce((s, q) => s + q.rate, 0)
  let r = rng() * total
  let quality = 'common'
  for (const [key, q] of Object.entries(EQUIP_QUALITY)) {
    r -= q.rate
    if (r < 0) { quality = key; break }
  }
  // 掷类型：6 种等概率
  const type = EQUIP_TYPES[Math.floor(rng() * EQUIP_TYPES.length)].id
  // 掷属性：4 种等概率
  const attrs = Object.keys(EQUIP_ATTRS)
  const attr = attrs[Math.floor(rng() * attrs.length)]
  return { type, quality, attr, level: 1 }
}
