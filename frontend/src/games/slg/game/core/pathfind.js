// 九州征途 - 网格寻路（BFS，四方向，绕开不可通行地块）
// 只走上下左右、不走对角线，路径清晰地"沿格子"折行（而非对角直线）。
// 纯函数、确定性（固定的邻居遍历顺序 → 同输入同路径），为联网校验留余地。

import { MAP_W, MAP_H, TILE_TYPES } from '../GameConstants.js'

// 四方向（上下左右）。顺序固定以保证路径确定性。
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/**
 * 在可通行格上求 from→to 的最短步数路径（四方向，每步算一格）。
 * @returns {{x,y}[]} 含起点与终点的格子序列；无陆路可达时回退为 [from, to] 直连两点。
 */
export function findPath(tiles, from, to) {
  if (from.x === to.x && from.y === to.y) return [{ x: from.x, y: from.y }]

  const passable = (x, y) => {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false
    return TILE_TYPES[tiles[y][x].type].passable
  }
  const key = (x, y) => y * MAP_W + x

  const prev = new Map()
  const seen = new Set([key(from.x, from.y)])
  const q = [{ x: from.x, y: from.y }]
  let head = 0

  while (head < q.length) {
    const cur = q[head++]
    if (cur.x === to.x && cur.y === to.y) {
      const path = []
      let c = cur
      while (c) { path.push({ x: c.x, y: c.y }); c = prev.get(key(c.x, c.y)) }
      return path.reverse()
    }
    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx, ny = cur.y + dy
      if (!passable(nx, ny)) continue
      const k = key(nx, ny)
      if (seen.has(k)) continue
      seen.add(k)
      prev.set(k, cur)
      q.push({ x: nx, y: ny })
    }
  }
  // 目标被水域隔离等：回退为两点直连（仍可行军，只是视觉为直线）
  return [{ x: from.x, y: from.y }, { x: to.x, y: to.y }]
}
