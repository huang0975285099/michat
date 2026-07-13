// 门派 PK · 梦幻西游风 - 角色本地存档（localStorage）
// 单机 demo 阶段用本地存档保存 种族/门派/等级/经验/战绩。
// 隐私模式下 localStorage 可能抛异常，所有读写都吞掉错误退化为"无存档"。

import { getFaction } from './factions.js'
import { RACES } from './GameConstants.js'
import { LEVEL_MIN, LEVEL_MAX } from './leveling.js'

const STORAGE_KEY = 'menpai:character:v1'

/**
 * @typedef {Object} Character
 * @property {string} raceId     '人' | '仙' | '魔'
 * @property {string} factionId  门派 id
 * @property {number} level
 * @property {number} exp        当前等级内已累计经验
 * @property {number} wins
 * @property {number} losses
 * @property {number} draws
 * @property {number} updatedAt
 */

/** 新建一个 1 级角色 */
export function createCharacter(raceId, factionId) {
  return {
    raceId, factionId,
    level: LEVEL_MIN, exp: 0,
    wins: 0, losses: 0, draws: 0,
    updatedAt: Date.now(),
  }
}

/** 校验存档结构；任何一项不合法都视为无存档（避免旧版本数据把游戏搞崩） */
function isValid(c) {
  if (!c || typeof c !== 'object') return false
  if (!RACES.some((r) => r.id === c.raceId)) return false
  const faction = getFaction(c.factionId)
  if (!faction || faction.race !== c.raceId) return false
  if (!Number.isInteger(c.level) || c.level < LEVEL_MIN || c.level > LEVEL_MAX) return false
  if (!Number.isFinite(c.exp) || c.exp < 0) return false
  return true
}

/** 读存档，无/损坏则返回 null */
export function loadCharacter() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw)
    if (!isValid(c)) return null
    return {
      wins: 0, losses: 0, draws: 0,   // 旧存档缺战绩字段时兜底
      ...c,
    }
  } catch {
    return null
  }
}

/** 写存档。失败静默（隐私模式/配额满），不影响本局游戏 */
export function saveCharacter(character) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...character, updatedAt: Date.now() }))
  } catch {
    /* 存不了就算了，本局仍可正常游玩 */
  }
}

/** 清除存档（换角色时用） */
export function clearCharacter() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
}

/**
 * 取该 种族+门派 组合对应的角色：存档匹配就沿用（保留等级经验），
 * 否则视为新角色从 1 级开始。
 */
export function characterFor(raceId, factionId) {
  const saved = loadCharacter()
  if (saved && saved.raceId === raceId && saved.factionId === factionId) return saved
  return createCharacter(raceId, factionId)
}
