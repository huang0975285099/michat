import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateBoardLayout, adjacentPositionFromSwipe } from '../ui/BoardView.js'
import { calculateHudLayout } from '../ui/HudView.js'
import { canSelectLevel } from '../scenes/MapScene.js'
import { isPlayableSwap } from '../scenes/LevelScene.js'

test('mobile layout keeps the complete board between the HUD and booster row', () => {
  const layout = calculateBoardLayout(390, 844)

  assert.ok(layout.x >= 12)
  assert.ok(layout.x + layout.size <= 378)
  assert.ok(layout.y >= 112)
  assert.ok(layout.y + layout.size <= 690)
  assert.equal(layout.cellSize * 8, layout.size)
})

test('desktop layout centers a bounded square board', () => {
  const layout = calculateBoardLayout(1600, 900)

  assert.equal(layout.x + layout.size / 2, 800)
  assert.ok(layout.size <= 680)
  assert.ok(layout.y + layout.size <= 780)
})

test('HUD layout keeps targets, moves, and all three boosters in view on mobile', () => {
  const layout = calculateHudLayout(390, 844)

  assert.ok(layout.targets.y >= 16)
  assert.ok(layout.moves.x < 390)
  assert.equal(layout.boosters.length, 3)
  assert.ok(layout.boosters.every(({ x, y }) => x >= 36 && x <= 354 && y <= 816))
})

test('swipe selects one orthogonally adjacent cell and rejects short drags', () => {
  const from = { row: 3, col: 3 }

  assert.deepEqual(adjacentPositionFromSwipe(from, 42, 8, 20), { row: 3, col: 4 })
  assert.deepEqual(adjacentPositionFromSwipe(from, -4, -35, 20), { row: 2, col: 3 })
  assert.equal(adjacentPositionFromSwipe(from, 8, 5, 20), null)
  assert.equal(adjacentPositionFromSwipe({ row: 0, col: 0 }, -30, 0, 20), null)
})

test('map selection permits unlocked levels and rejects locked levels', () => {
  const save = { unlockedLevel: 3 }

  assert.equal(canSelectLevel(3, save), true)
  assert.equal(canSelectLevel(4, save), false)
  assert.equal(canSelectLevel(0, save), false)
})

test('playable swap mirrors the engine color-bomb rule', () => {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null))
  board[2][2] = { id: 'berry', special: 'color-bomb', jelly: false, frosting: 0 }
  board[2][3] = { id: 'lemon', special: null, jelly: false, frosting: 0 }

  assert.equal(isPlayableSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 }), true)
  board[2][3].special = 'striped-h'
  assert.equal(isPlayableSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 }), true)
  board[2][3].special = 'color-bomb'
  assert.equal(isPlayableSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 }), false)
})
