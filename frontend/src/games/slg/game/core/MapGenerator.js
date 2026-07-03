// 九州征途 - 种子化地图生成
// 同一 seed 必然生成同一张地图，存档只需记录 seed + 领地增量，为后续联网版打基础。

import { MAP_W, MAP_H, TILE_TYPES, TILE_MAX_LEVEL, COPPER_TILE_RATE, NPC_CITY_LEVEL_COUNTS, garrisonOf, tileGuardSpec, guardPoolOf } from '../GameConstants.js'

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
 * 生成地图。返回二维数组 tiles[y][x] = { x, y, type, level, garrison, guards, owner }
 * - 类型：随机播种 + 两轮多数平滑，形成地貌团块；铜矿地在平滑后散点铺设
 * - 等级：1~TILE_MAX_LEVEL 纯随机（出生点周边另行降级，避免开局被高级地包围）
 * - NPC 城池：中内圈随机放置 15 座，按 NPC_CITY_LEVEL_COUNTS 分配 1~5 级（弱到强梯度）
 * - 玩家出生点：外圈的平原，保证周边可通行
 * - 守将：每块可通行地块按 TILE_GUARDS 规格指派 1~2 支守将队伍（种子确定）
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

  // 2.5) 铜矿地散点：多数平滑会把零散地块并入周围地貌，故在平滑之后再随机铺设铜矿，
  //      让它以「矿脉散点」形式纯随机分布并保证一定数量。仅覆盖陆地（湖泊不动）；
  //      城池/出生点在后续步骤才落位，若正好压到铜矿会被覆盖，属正常。
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (grid[y][x] !== 'lake' && rng() < COPPER_TILE_RATE) grid[y][x] = 'copper'
    }
  }

  // 3) 等级：纯随机分布（1~TILE_MAX_LEVEL 均匀），不再按到中心的距离分带。
  //    出生点周边会在步骤 5 单独降级，避免开局被高级地包围。
  const tiles = []
  for (let y = 0; y < MAP_H; y++) {
    const row = []
    for (let x = 0; x < MAP_W; x++) {
      const type = grid[y][x]
      const level = 1 + Math.floor(rng() * TILE_MAX_LEVEL)
      row.push({
        x, y, type, level,
        garrison: TILE_TYPES[type].passable ? garrisonOf(level, type) : 0,
        guards: [],           // 见步骤 6，用独立 rng 指派守将
        garrisonType: null,   // 首支守将队伍的兵种（供 UI 克制提示）
        owner: null,
      })
    }
    tiles.push(row)
  }

  // 4) NPC 城池：距中心 20%~55% 半径、彼此至少 6 格（15 座城池比旧版 8 座更密，8 格间距实测
  //    ~40% 地图放不满，缩到 6 格 + 更高的尝试上限后 300 个种子样本 100% 放满 15 座）。
  //    等级按 NPC_CITY_LEVEL_COUNTS 分配（1 级最弱最多 → 5 级最强最少），先铺平打乱顺序的
  //    等级序列，再按放置顺序逐一消费。
  const cityLevels = []
  for (const [lv, count] of Object.entries(NPC_CITY_LEVEL_COUNTS)) {
    for (let i = 0; i < count; i++) cityLevels.push(Number(lv))
  }
  for (let i = cityLevels.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[cityLevels[i], cityLevels[j]] = [cityLevels[j], cityLevels[i]]
  }
  const cities = []
  let guard = 0
  while (cities.length < cityLevels.length && guard++ < 3000) {
    const ang = rng() * Math.PI * 2
    const r = (0.2 + rng() * 0.35) * maxDist
    const x = Math.round(cx + Math.cos(ang) * r)
    const y = Math.round(cy + Math.sin(ang) * r)
    if (x < 1 || y < 1 || x >= MAP_W - 1 || y >= MAP_H - 1) continue
    if (cities.some(c => Math.hypot(c.x - x, c.y - y) < 6)) continue
    const level = cityLevels[cities.length]
    const t = tiles[y][x]
    t.type = 'npcCity'
    t.level = level
    t.garrison = garrisonOf(level, 'npcCity')
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

  // 5.5) 出生点周边降级：纯随机等级下主城可能被高级地包围而无法扩张，
  //      把四周 8 格压到 1~2 级（并同步守军基数），保证开局必有可攻打的弱地。
  //      须在步骤 6 之前完成，守将才会按降级后的等级指派。
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const t = tiles[spawn.y + dy]?.[spawn.x + dx]
      if (!t || !TILE_TYPES[t.type].passable || t.level <= 2) continue
      t.level = 1 + Math.floor(rng() * 2)   // 1~2
      t.garrison = garrisonOf(t.level, t.type)
    }
  }

  // 6) 守将指派：用独立 rng（不扰动上面地形/城池/出生点的随机流，保证既有地图不变）。
  //    同一 seed 守将阵容确定，存档无需记录守将模板。
  const rng2 = mulberry32((seed ^ 0x85ebca6b) >>> 0)
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = tiles[y][x]
      if (!TILE_TYPES[t.type].passable) continue
      const spec = tileGuardSpec(t.level, t.type)
      const pool = guardPoolOf(spec.pool)
      const perTeam = garrisonOf(t.level, t.type) / spec.teams
      const picked = []
      while (picked.length < spec.teams) {
        const tpl = pool[Math.floor(rng2() * pool.length)]
        if (picked.some(p => p.id === tpl.id)) continue   // 两队守将互不相同
        picked.push(tpl)
      }
      t.guards = picked.map(tpl => ({ id: tpl.id, lv: spec.guardLv, troops: perTeam }))
      t.garrisonType = picked[0].troopType
    }
  }

  return { tiles, spawn, cities }
}
