// 九州征途 - 种子化地图生成
// 同一 seed 必然生成同一张地图，存档只需记录 seed + 领地增量，为后续联网版打基础。

import { MAP_W, MAP_H, TILE_TYPES, garrisonOf, GARRISON_TYPE_POOL } from '../GameConstants.js'

// mulberry32：轻量确定性 PRNG
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 生成地图。返回二维数组 tiles[y][x] = { x, y, type, level, garrison, owner }
 * - 类型：随机播种 + 两轮多数平滑，形成地貌团块
 * - 等级：按到地图中心的距离分带（外圈 1 → 中心 5），±1 抖动
 * - NPC 城池：中内圈随机放置 8 座
 * - 玩家出生点：外圈的平原，保证周边可通行
 */
export function generateMap(seed) {
  const rng = mulberry32(seed)
  const cx = MAP_W / 2, cy = MAP_H / 2
  const maxDist = Math.hypot(cx, cy)

  // 1) 随机初始类型（加权）
  const weighted = [
    ['plain', 30], ['farm', 14], ['forest', 20],
    ['hill', 14], ['mountain', 12], ['lake', 10],
  ]
  const total = weighted.reduce((s, [, w]) => s + w, 0)
  function pickType() {
    let r = rng() * total
    for (const [t, w] of weighted) { r -= w; if (r < 0) return t }
    return 'plain'
  }

  let grid = []
  for (let y = 0; y < MAP_H; y++) {
    const row = []
    for (let x = 0; x < MAP_W; x++) row.push(pickType())
    grid.push(row)
  }

  // 2) 两轮多数平滑，让同类地貌成块
  for (let pass = 0; pass < 2; pass++) {
    const next = grid.map(r => r.slice())
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const count = {}
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue
            const t = grid[ny][nx]
            count[t] = (count[t] || 0) + 1
          }
        }
        let best = grid[y][x], bestN = 0
        for (const [t, n] of Object.entries(count)) {
          if (n > bestN) { best = t; bestN = n }
        }
        next[y][x] = best
      }
    }
    grid = next
  }

  // 3) 等级分带 + 抖动
  const tiles = []
  for (let y = 0; y < MAP_H; y++) {
    const row = []
    for (let x = 0; x < MAP_W; x++) {
      const type = grid[y][x]
      const d = Math.hypot(x - cx, y - cy) / maxDist  // 0 中心 → 1 边缘
      let level = Math.min(5, Math.max(1, Math.ceil((1 - d) * 5)))
      const j = rng()
      if (j < 0.2 && level > 1) level--
      else if (j > 0.85 && level < 5) level++
      row.push({
        x, y, type, level,
        garrison: TILE_TYPES[type].passable ? garrisonOf(level, type) : 0,
        garrisonType: null,   // 见步骤 6，用独立 rng 赋值
        owner: null,
      })
    }
    tiles.push(row)
  }

  // 4) NPC 城池：距中心 20%~55% 半径、彼此至少 8 格
  const cities = []
  let guard = 0
  while (cities.length < 8 && guard++ < 500) {
    const ang = rng() * Math.PI * 2
    const r = (0.2 + rng() * 0.35) * maxDist
    const x = Math.round(cx + Math.cos(ang) * r)
    const y = Math.round(cy + Math.sin(ang) * r)
    if (x < 1 || y < 1 || x >= MAP_W - 1 || y >= MAP_H - 1) continue
    if (cities.some(c => Math.hypot(c.x - x, c.y - y) < 8)) continue
    const t = tiles[y][x]
    t.type = 'npcCity'
    t.level = 5
    t.garrison = garrisonOf(5, 'npcCity')
    cities.push({ x, y })
  }

  // 5) 玩家出生点：外圈（70%~90% 半径）的可通行地块，且四邻可通行
  let spawn = null
  guard = 0
  while (!spawn && guard++ < 1000) {
    const ang = rng() * Math.PI * 2
    const r = (0.7 + rng() * 0.2) * maxDist
    const x = Math.round(cx + Math.cos(ang) * r)
    const y = Math.round(cy + Math.sin(ang) * r)
    if (x < 2 || y < 2 || x >= MAP_W - 2 || y >= MAP_H - 2) continue
    const ok = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => {
      const t = tiles[y + dy][x + dx]
      return TILE_TYPES[t.type].passable && t.type !== 'npcCity'
    })
    if (ok) spawn = { x, y }
  }
  if (!spawn) spawn = { x: 4, y: 4 }   // 兜底（理论上不会触发）

  // 6) 守军兵种：用独立 rng（不扰动上面地形/城池/出生点的随机流，保证既有地图不变）
  const rng2 = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = tiles[y][x]
      t.garrisonType = TILE_TYPES[t.type].passable
        ? GARRISON_TYPE_POOL[Math.floor(rng2() * GARRISON_TYPE_POOL.length)]
        : null
    }
  }

  return { tiles, spawn, cities }
}
