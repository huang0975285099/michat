import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyGravity,
  createBoard,
  findLegalMoves,
  findMatches,
  isAdjacent,
  reshuffle,
  trySwap,
} from './board.js'

function boardFromIds(rows) {
  return rows.map((row) => [...row].map((id) => ({
    id,
    special: null,
    jelly: false,
    frosting: 0,
  })))
}

function uniqueBoard() {
  return Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, col) => ({
    id: `${row}-${col}`,
    special: null,
    jelly: false,
    frosting: 0,
  })))
}

test('new board has no matches and has a legal move', () => {
  const board = createBoard({ seed: 7 })
  assert.deepEqual(findMatches(board), [])
  assert.ok(findLegalMoves(board).length > 0)
})

test('swap only succeeds when it makes a match', () => {
  const board = boardFromIds([
    'ABCDEFAB', 'BCDEFABC', 'CDEFABCD', 'DEFABCDE',
    'EFABCDEF', 'FABCDEFA', 'ABCDEFAB', 'BCDEFABC',
  ])
  assert.equal(trySwap(board, { row: 0, col: 0 }, { row: 0, col: 1 }).accepted, false)
})

test('findMatches merges intersecting horizontal and vertical runs', () => {
  const board = uniqueBoard()
  for (const { row, col } of [
    { row: 2, col: 2 }, { row: 3, col: 1 }, { row: 3, col: 2 },
    { row: 3, col: 3 }, { row: 4, col: 2 },
  ]) board[row][col].id = 'A'
  assert.deepEqual(findMatches(board), [[
    { row: 2, col: 2 }, { row: 3, col: 1 }, { row: 3, col: 2 },
    { row: 3, col: 3 }, { row: 4, col: 2 },
  ]])
})

test('trySwap accepts adjacent swaps that create a match without mutating the original board', () => {
  const board = uniqueBoard()
  board[0][0].id = 'B'
  board[1][0].id = 'A'
  board[0][1].id = 'A'
  board[0][2].id = 'A'
  const result = trySwap(board, { row: 0, col: 0 }, { row: 1, col: 0 })

  assert.equal(result.accepted, true)
  assert.equal(board[0][0].id, 'B')
  assert.equal(result.board[0][0].id, 'A')
  assert.deepEqual(result.matches, [[
    { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 },
  ]])
})

test('isAdjacent only accepts orthogonally neighboring positions', () => {
  assert.equal(isAdjacent({ row: 3, col: 3 }, { row: 3, col: 4 }), true)
  assert.equal(isAdjacent({ row: 3, col: 3 }, { row: 4, col: 4 }), false)
})

test('applyGravity drops cells while preserving their properties and refills empty spaces', () => {
  const board = boardFromIds([
    'ABCDEFAB', 'BCDEFABC', 'CDEFABCD', 'DEFABCDE',
    'EFABCDEF', 'FABCDEFA', 'ABCDEFAB', 'BCDEFABC',
  ])
  const preserved = { id: 'grape', special: 'wrapped', jelly: true, frosting: 2 }
  board[2][0] = preserved
  board[5][0] = null
  board[6][0] = null

  const result = applyGravity(board, () => 0)

  assert.deepEqual(result[4][0], preserved)
  assert.notEqual(result[4][0], preserved)
  assert.equal(result[0][0].id, 'berry')
  assert.equal(result[1][0].id, 'berry')
  assert.equal(board[5][0], null)
})

test('reshuffle preserves non-null cell properties and returns a playable board', () => {
  const board = createBoard({ seed: 12 })
  board[0][0] = { id: board[0][0].id, special: 'striped-h', jelly: true, frosting: 2 }
  board[1][1] = null
  const expectedCells = board.flat().filter(Boolean)
    .map(({ id, special, jelly, frosting }) => `${id}:${special}:${jelly}:${frosting}`)
    .sort()

  const result = reshuffle(board, (() => {
    let value = 0
    return () => (value = (value + 0.61803398875) % 1)
  })())

  assert.deepEqual(findMatches(result), [])
  assert.ok(findLegalMoves(result).length > 0)
  assert.deepEqual(result.flat().filter(Boolean)
    .map(({ id, special, jelly, frosting }) => `${id}:${special}:${jelly}:${frosting}`)
    .sort(), expectedCells)
})
