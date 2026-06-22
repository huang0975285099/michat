import { TILE, COLS, ROWS, TILE_EMPTY, TILE_HARD, TILE_SOFT } from './GameConstants.js'

function mulberry32(seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Cells that must stay empty so players can move at spawn
const SAFE = new Set([
  '1,1', '2,1', '1,2',
  '13,11', '12,11', '13,10',
])

function isHard(col, row) {
  if (col === 0 || row === 0 || col === COLS - 1 || row === ROWS - 1) return true
  if (col % 2 === 0 && row % 2 === 0) return true
  return false
}

export function generateMap(seed) {
  const rand = mulberry32(seed)
  const map = []
  for (let row = 0; row < ROWS; row++) {
    map[row] = []
    for (let col = 0; col < COLS; col++) {
      if (isHard(col, row)) {
        map[row][col] = TILE_HARD
      } else if (SAFE.has(`${col},${row}`)) {
        map[row][col] = TILE_EMPTY
      } else {
        map[row][col] = rand() < 0.65 ? TILE_SOFT : TILE_EMPTY
      }
    }
  }
  return map
}

export function tileCenter(col, row) {
  return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 }
}
