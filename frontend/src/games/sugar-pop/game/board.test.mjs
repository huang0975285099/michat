import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyGravity,
  applyGravityWithPlan,
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

test('applyGravity drops candy while jelly and frosting remain anchored to their coordinates', () => {
  const board = boardFromIds([
    'ABCDEFAB', 'BCDEFABC', 'CDEFABCD', 'DEFABCDE',
    'EFABCDEF', 'FABCDEFA', 'ABCDEFAB', 'BCDEFABC',
  ])
  board[2][0] = { id: 'grape', special: 'wrapped', jelly: true, frosting: 0 }
  board[5][0] = { id: null, special: null, jelly: false, frosting: 0 }
  board[6][0] = { id: null, special: null, jelly: false, frosting: 2 }

  const result = applyGravity(board, () => 0)

  assert.equal(result[2][0].jelly, true)
  assert.equal(result[2][0].id, 'B')
  assert.equal(result[3][0].id, 'grape')
  assert.equal(result[3][0].special, 'wrapped')
  assert.equal(result[6][0].frosting, 2)
  assert.equal(result[6][0].id, null)
  assert.equal(result[0][0].id, 'berry')
  assert.deepEqual(board[5][0], { id: null, special: null, jelly: false, frosting: 0 })
})

test('gravity plan maps each survivor and refill to its real destination coordinate', () => {
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({
    id: null, special: null, jelly: false, frosting: 0,
  })))
  board[2][0] = { id: 'mint', special: 'wrapped', jelly: true, frosting: 0 }
  board[6][0] = { id: 'berry', special: null, jelly: false, frosting: 0 }

  const result = applyGravityWithPlan(board, () => 0)

  assert.deepEqual(result.movements.filter(({ from }) => from.col === 0), [
    { from: { row: 6, col: 0 }, to: { row: 7, col: 0 } },
    { from: { row: 2, col: 0 }, to: { row: 6, col: 0 } },
  ])
  assert.deepEqual(result.refills.filter(({ to }) => to.col === 0), [
    { from: { row: -1, col: 0 }, to: { row: 5, col: 0 } },
    { from: { row: -2, col: 0 }, to: { row: 4, col: 0 } },
    { from: { row: -3, col: 0 }, to: { row: 3, col: 0 } },
    { from: { row: -4, col: 0 }, to: { row: 2, col: 0 } },
    { from: { row: -5, col: 0 }, to: { row: 1, col: 0 } },
    { from: { row: -6, col: 0 }, to: { row: 0, col: 0 } },
  ])
  assert.equal(result.board[6][0].special, 'wrapped')
  assert.equal(result.board[5][0].id, 'berry')
})

test('reshuffle moves candy properties but keeps obstacle layers at their coordinates', () => {
  const board = createBoard({ seed: 12 })
  board[0][0] = { id: board[0][0].id, special: 'striped-h', jelly: true, frosting: 2 }
  board[1][1] = null
  const expectedCandies = board.flat().filter((entry) => entry?.id != null && entry.frosting === 0)
    .map(({ id, special }) => `${id}:${special}`)
    .sort()

  const result = reshuffle(board, (() => {
    let value = 0
    return () => (value = (value + 0.61803398875) % 1)
  })())

  assert.deepEqual(findMatches(result), [])
  assert.ok(findLegalMoves(result).length > 0)
  assert.equal(result[0][0].jelly, true)
  assert.equal(result[0][0].frosting, 2)
  assert.equal(result[1][1], null)
  assert.deepEqual(result.flat().filter((entry) => entry?.id != null && entry.frosting === 0)
    .map(({ id, special }) => `${id}:${special}`)
    .sort(), expectedCandies)
})

test('accepted swaps move only candy state and leave tile obstacles anchored', () => {
  const board = uniqueBoard()
  board[0][0] = { id: 'B', special: 'wrapped', jelly: true, frosting: 0 }
  board[1][0].id = 'A'
  board[0][1].id = 'A'
  board[0][2].id = 'A'
  board[1][0].frosting = 0

  const result = trySwap(board, { row: 0, col: 0 }, { row: 1, col: 0 })

  assert.equal(result.accepted, true)
  assert.deepEqual(result.board[0][0], { id: 'A', special: null, jelly: true, frosting: 0 })
  assert.deepEqual(result.board[1][0], { id: 'B', special: 'wrapped', jelly: false, frosting: 0 })
})
