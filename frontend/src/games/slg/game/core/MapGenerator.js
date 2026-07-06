// 九州征途 - 种子化地图生成
// 同一 seed 必然生成同一张地图，存档只需记录 seed + 领地增量，为后续联网版打基础。

import { MAP_W, MAP_H, TILE_TYPES, COPPER_TILE_RATE, NPC_CITY_LEVEL_COUNTS, garrisonOf, tileGuardSpec, guardPoolOf, FORMATION_SIZE } from '../GameConstants.js'

/** 按权重随机取一项。items = [[value, weight], ...] */
function weightedPick(rng, items) {
  const total = items.reduce((s, [, w]) => s + w, 0)
  let r = rng() * total
  for (const [v, w] of items) {
    r -= w
    if (r < 0) return v
  }
  return items[items.length - 1][0]
}

/** 根据距中心距离决定地块等级：外圈低级、中心高级，形成 SLG 扩张节奏。
 *  整体档位比初版上移约 2 级，让 5~7 级地成为中圈主力，出生点附近也能较快遇到中级地。 */
function pickLevelByDist(rng, ratio) {
  // ratio ∈ [0, 1]，0 为地图中心，1 为边角。整体档位上移，5~7 级在中圈大量出现。
  if (ratio > 0.75) return weightedPick(rng, [[1, 10], [2, 30], [3, 35], [4, 20], [5, 5]])
  if (ratio > 0.60) return weightedPick(rng, [[2, 10], [3, 30], [4, 35], [5, 20], [6, 5]])
  if (ratio > 0.45) return weightedPick(rng, [[3, 10], [4, 25], [5, 40], [6, 20], [7, 5]])
  if (ratio > 0.30) return weightedPick(rng, [[4, 10], [5, 30], [6, 40], [7, 15], [8, 5]])
  if (ratio > 0.15) return weightedPick(rng, [[5, 10], [6, 35], [7, 40], [8, 12], [9, 3]])
  return weightedPick(rng, [[6, 10], [7, 30], [8, 40], [9, 15], [10, 5]])
}

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
 * - 等级：按距中心距离分带随机分布，外圈低级、中心高级（出生点周边另行降级）
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

  // 2) 两轮多数平滑，让同类地貌成块；湖泊/山地作为天然屏障保留，不参与平滑
  const PRESERVE_TYPES = new Set(['lake', 'mountain'])
  for (let pass = 0; pass < 2; pass++) {
    const next = grid.map(r => r.slice())
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const cur = grid[y][x]
        if (PRESERVE_TYPES.has(cur)) { next[y][x] = cur; continue }
        const count = {}
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue
            const t = grid[ny][nx]
            count[t] = (count[t] || 0) + 1
          }
        }
        let best = cur, bestN = 0
        for (const [t, n] of Object.entries(count)) {
          if (n > bestN) { best = t; bestN = n }
        }
        next[y][x] = best
      }
    }
    grid = next
  }

  // 2.5) 铜矿地散点：平滑后再随机铺设，限制 2 格内不能出现第二个铜矿，避免聚集或连片。
  const copperPlaced = Array.from({ length: MAP_H }, () => Array(MAP_W).fill(false))
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (grid[y][x] === 'lake') continue
      let tooClose = false
      for (let dy = -2; dy <= 2 && !tooClose; dy++) {
        for (let dx = -2; dx <= 2 && !tooClose; dx++) {
          const ny = y + dy, nx = x + dx
          if (ny < 0 || nx < 0 || ny >= MAP_H || nx >= MAP_W) continue
          if (copperPlaced[ny][nx]) tooClose = true
        }
      }
      if (tooClose) continue
      if (rng() < COPPER_TILE_RATE) {
        grid[y][x] = 'copper'
        copperPlaced[y][x] = true
      }
    }
  }

  // 3) 等级：按到中心距离分带随机分布，外圈低级、中心高级，形成 SLG 扩张节奏。
  //    出生点周边会在步骤 5 进一步降级，保证开局必有可攻打的弱地。
  const tiles = []
  for (let y = 0; y < MAP_H; y++) {
    const row = []
    for (let x = 0; x < MAP_W; x++) {
      const type = grid[y][x]
      const dist = Math.hypot(x - cx, y - cy)
      const level = pickLevelByDist(rng, dist / maxDist)
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
  //    等级按 NPC_CITY_LEVEL_COUNTS 生成升序队列（1 级最多 → 5 级最少），
  //    放置后按距中心距离从远到近分配等级：越远越弱、越近越强，形成向中心推进的节奏。
  const cityLevels = []
  for (const [lv, count] of Object.entries(NPC_CITY_LEVEL_COUNTS)) {
    for (let i = 0; i < count; i++) cityLevels.push(Number(lv))
  }
  cityLevels.sort((a, b) => a - b)

  const cityCandidates = []
  let guard = 0
  while (cityCandidates.length < cityLevels.length && guard++ < 3000) {
    const ang = rng() * Math.PI * 2
    const r = (0.2 + rng() * 0.35) * maxDist
    const x = Math.round(cx + Math.cos(ang) * r)
    const y = Math.round(cy + Math.sin(ang) * r)
    if (x < 1 || y < 1 || x >= MAP_W - 1 || y >= MAP_H - 1) continue
    if (cityCandidates.some(c => Math.hypot(c.x - x, c.y - y) < 6)) continue
    const t = tiles[y][x]
    // 城池不能压在山地、湖泊、铜矿上，避免视觉异常与战略位置不合理
    if (!TILE_TYPES[t.type].passable || t.type === 'mountain' || t.type === 'lake' || t.type === 'copper') continue
    cityCandidates.push({ x, y, dist: Math.hypot(x - cx, y - cy) })
  }
  // 按距中心距离从远到近排序，远的分配低等级，近的分配高等级
  cityCandidates.sort((a, b) => b.dist - a.dist)

  const cities = []
  for (let i = 0; i < cityCandidates.length; i++) {
    const { x, y } = cityCandidates[i]
    const level = cityLevels[i]
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

  // 5.4) 出生点自身及八邻强制改为平原/农田，避免开局被铜矿/森林/丘陵等地貌包围。
  const spawnTile = tiles[spawn.y][spawn.x]
  spawnTile.type = 'plain'
  spawnTile.garrison = garrisonOf(spawnTile.level, spawnTile.type)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const t = tiles[spawn.y + dy]?.[spawn.x + dx]
      if (!t || t.type === 'npcCity' || !TILE_TYPES[t.type].passable) continue
      t.type = rng() < 0.5 ? 'plain' : 'farm'
      t.garrison = garrisonOf(t.level, t.type)
    }
  }

  // 5.5) 出生点第一圈（八邻）强制降到 1~2 级，保证开局必有可攻打的弱地。
  //      第二圈（Chebyshev 距离 = 2 的 16 格）降到 3~4 级，形成清晰过渡。
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      const t = tiles[spawn.y + dy]?.[spawn.x + dx]
      if (!t || !TILE_TYPES[t.type].passable || t.type === 'npcCity') continue
      if (dist === 1) {
        // 第一圈：1~2 级
        t.level = 1 + Math.floor(rng() * 2)
      } else if (dist === 2) {
        // 第二圈：3~4 级（若原本就不高于 4 则保持不变）
        if (t.level <= 4) continue
        t.level = 3 + Math.floor(rng() * 2)
      } else {
        continue
      }
      t.garrison = garrisonOf(t.level, t.type)
    }
  }

  // 6) 守将指派：用独立 rng（不扰动上面地形/城池/出生点的随机流，保证既有地图不变）。
  //    同一 seed 守将阵容确定，存档无需记录守将模板。
  //    编队制：每块地 spec.teams 个编队，每编队 FORMATION_SIZE(3) 名武将（编队内不重复、跨编队可重复）。
  //    每名武将兵力 = garrisonOf / (teams × FORMATION_SIZE)；总兵 = garrisonOf。
  const rng2 = mulberry32((seed ^ 0x85ebca6b) >>> 0)
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = tiles[y][x]
      if (!TILE_TYPES[t.type].passable) continue
      const spec = tileGuardSpec(t.level, t.type)
      const pool = guardPoolOf(spec.pool)
      // 防御：池子过小时每编队武将数下调到 pool.length（所有池均 ≥3，正常不会触发）
      const genPerForm = Math.min(FORMATION_SIZE, pool.length)
      const totalGen = spec.teams * genPerForm
      if (totalGen <= 0) {
        t.guards = []
        t.garrisonType = null
        continue
      }
      const perGen = garrisonOf(t.level, t.type) / totalGen
      const guards = []
      let firstTpl = null
      for (let f = 0; f < spec.teams; f++) {
        const used = new Set()                       // 编队内 3 名武将互不相同
        while (used.size < genPerForm) {
          const tpl = pool[Math.floor(rng2() * pool.length)]
          if (used.has(tpl.id)) continue
          used.add(tpl.id)
          if (!firstTpl) firstTpl = tpl
          guards.push({ id: tpl.id, lv: spec.guardLv, troops: perGen })
        }
      }
      t.guards = guards
      t.garrisonType = firstTpl ? firstTpl.troopType : null
    }
  }

  return { tiles, spawn, cities }
}
