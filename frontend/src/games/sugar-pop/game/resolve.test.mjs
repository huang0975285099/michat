import test from 'node:test'
import assert from 'node:assert/strict'
import { createBoard, findLegalMoves, findMatches } from './board.js'
import { CANDY_IDS } from './constants.js'
import { resolveTurn } from './resolve.js'

function clone(value) {
  return structuredClone(value)
}

function boardFromSeed({ withLegalMove = true } = {}) {
  const board = Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, col) => ({
    id: `unique-${row}-${col}`,
    special: null,
    jelly: false,
    frosting: 0,
  })))
  if (withLegalMove) {
    Object.assign(board[6][5], { id: 'mint' })
    Object.assign(board[6][6], { id: 'mint' })
    Object.assign(board[6][7], { id: 'lemon' })
    Object.assign(board[5][7], { id: 'mint' })
  }
  return board
}

function sequence(values = []) {
  const fallback = [0.01, 0.18, 0.34, 0.51, 0.68, 0.85]
  let index = 0
  return () => values[index++] ?? fallback[(index - values.length - 1) % fallback.length]
}

function fourMatchFixture({ withLegalMove = true } = {}) {
  const board = boardFromSeed({ withLegalMove })
  Object.assign(board[2][0], { id: 'berry' })
  Object.assign(board[2][1], { id: 'berry' })
  Object.assign(board[2][2], { id: 'berry' })
  Object.assign(board[2][3], { id: 'lemon' })
  Object.assign(board[2][4], { id: 'berry' })
  return {
    board,
    swap: { from: { row: 2, col: 4 }, to: { row: 2, col: 3 } },
    movesLeft: 5,
    target: { candies: { berry: 20 } },
    score: 0,
    rng: sequence([0.1, 0.2, 0.3]),
  }
}

function wrappedFixture() {
  const board = boardFromSeed()
  Object.assign(board[2][0], { id: 'berry' })
  Object.assign(board[2][1], { id: 'berry' })
  Object.assign(board[2][2], { id: 'lemon', jelly: true })
  Object.assign(board[2][3], { id: 'berry', special: 'wrapped' })
  Object.assign(board[3][3], { frosting: 1 })
  return {
    board,
    swap: { from: { row: 2, col: 3 }, to: { row: 2, col: 2 } },
    movesLeft: 5,
    target: { jelly: 1, frosting: 1 },
    score: 0,
    rng: sequence(),
  }
}

function lastMoveFixture(target) {
  const fixture = fourMatchFixture()
  return { ...fixture, movesLeft: 1, target }
}

function deadBoardFixture({ withColorBomb = false } = {}) {
  const board = Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, col) => ({
    id: CANDY_IDS[(row + col) % CANDY_IDS.length],
    special: null,
    jelly: false,
    frosting: 0,
  })))
  board[0][0].id = 'mint'
  if (withColorBomb) board[7][7].special = 'color-bomb'
  let calls = 0
  let state = 17
  return {
    input: {
      board,
      swap: { from: { row: 1, col: 0 }, to: { row: 1, col: 1 } },
      movesLeft: 5,
      target: { candies: { berry: 20 } },
      score: 0,
      rng: () => {
        calls += 1
        state = (state * 48271) % 2147483647
        return state / 2147483647
      },
    },
    calls: () => calls,
  }
}

test('a four-match creates a striped candy at the swap destination', () => {
  const result = resolveTurn(fourMatchFixture())
  assert.deepEqual(result.createdSpecials[0], {
    row: 2,
    col: 3,
    special: 'striped-h',
  })
})

test('a wrapped blast damages adjacent frosting and clears jelly', () => {
  const result = resolveTurn(wrappedFixture())
  assert.equal(result.board[3][3].frosting, 0)
  assert.equal(result.board[2][2].jelly, false)
})

test('a turn with no remaining moves loses unless its target is complete', () => {
  assert.equal(resolveTurn(lastMoveFixture({ candies: { grape: 1 } })).status, 'lost')
  assert.equal(resolveTurn(lastMoveFixture({ candies: { berry: 3 } })).status, 'won')
})

test('later cascades receive a higher score multiplier', () => {
  const board = boardFromSeed()
  Object.assign(board[0][0], { id: 'berry' })
  Object.assign(board[0][1], { id: 'berry' })
  Object.assign(board[0][2], { id: 'lemon' })
  Object.assign(board[0][3], { id: 'berry' })
  const result = resolveTurn({
    board,
    swap: { from: { row: 0, col: 3 }, to: { row: 0, col: 2 } },
    movesLeft: 3,
    target: { candies: { orange: 99 } },
    score: 0,
    rng: sequence([0.34, 0.34, 0.34, 0.1, 0.2, 0.4]),
  })

  assert.ok(result.waves.length >= 2)
  assert.ok(result.waves[1].scoreDelta > result.waves[0].scoreDelta)
})

test('each cascade wave exposes survivor moves and only its actual refills', () => {
  const result = resolveTurn({
    board: createBoard({ seed: 1 }),
    swap: { from: { row: 1, col: 0 }, to: { row: 1, col: 1 } },
    movesLeft: 10,
    target: { candies: { berry: 99 } },
    score: 0,
    rng: sequence([0.34, 0.34, 0.34, 0.1, 0.2, 0.4]),
  })

  assert.ok(result.waves.length >= 2)
  assert.deepEqual(result.waves[0].movements.filter(({ from, to }) => (
    from.row === 0 && to.row === 1 && [1, 2, 3].includes(from.col)
  )), [
    { from: { row: 0, col: 1 }, to: { row: 1, col: 1 } },
    { from: { row: 0, col: 2 }, to: { row: 1, col: 2 } },
    { from: { row: 0, col: 3 }, to: { row: 1, col: 3 } },
  ])
  assert.deepEqual(result.waves[0].refills.filter(({ to }) => to.row === 0 && [1, 2, 3].includes(to.col)), [
    { from: { row: -1, col: 1 }, to: { row: 0, col: 1 } },
    { from: { row: -1, col: 2 }, to: { row: 0, col: 2 } },
    { from: { row: -1, col: 3 }, to: { row: 0, col: 3 } },
  ])
  assert.deepEqual(result.waves[1].removed, [
    { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 },
  ])
  assert.equal(result.waves[0].board[0][1].id, result.waves[0].board[0][2].id)
  assert.equal(result.waves[0].board[0][2].id, result.waves[0].board[0][3].id)
})

test('an activated special only appears once in a wave activation queue', () => {
  const board = boardFromSeed()
  Object.assign(board[4][0], { id: 'berry', special: 'striped-h' })
  Object.assign(board[4][1], { id: 'berry', special: 'striped-v' })
  Object.assign(board[4][2], { id: 'lemon' })
  Object.assign(board[4][3], { id: 'berry' })
  const result = resolveTurn({
    board,
    swap: { from: { row: 4, col: 3 }, to: { row: 4, col: 2 } },
    movesLeft: 3,
    target: { candies: { orange: 99 } },
    score: 0,
    rng: sequence(),
  })
  const activated = result.waves[0].activatedSpecials.map(({ row, col }) => `${row},${col}`)

  assert.equal(new Set(activated).size, activated.length)
})

test('a swapped color bomb clears every candy matching its normal counterpart', () => {
  const board = boardFromSeed()
  Object.assign(board[0][0], { id: 'lemon', special: 'color-bomb' })
  Object.assign(board[0][1], { id: 'berry' })
  Object.assign(board[1][0], { id: 'berry' })
  Object.assign(board[2][0], { id: 'berry' })
  Object.assign(board[2][2], { id: 'berry' })
  Object.assign(board[4][4], { id: 'berry' })
  const result = resolveTurn({
    board,
    swap: { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } },
    movesLeft: 3,
    target: { candies: { berry: 5 } },
    score: 0,
    rng: sequence(),
  })

  assert.equal(result.movesLeft, 2)
  assert.equal(result.waves[0].activatedSpecials[0].special, 'color-bomb')
  assert.equal(result.waves[0].removed.length, 6)
  assert.equal(result.target.candies.berry, 0)
})

test('a color bomb accepts a non-bomb special counterpart and activates it by ID', () => {
  const board = boardFromSeed()
  Object.assign(board[0][0], { id: 'lemon', special: 'color-bomb' })
  Object.assign(board[0][1], { id: 'berry', special: 'striped-h' })
  Object.assign(board[2][2], { id: 'berry' })
  const result = resolveTurn({
    board,
    swap: { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } },
    movesLeft: 3,
    target: { candies: { berry: 2 } },
    score: 0,
    rng: sequence(),
  })

  assert.equal(result.movesLeft, 2)
  assert.deepEqual(result.waves[0].activatedSpecials.map(({ special }) => special), [
    'color-bomb',
    'striped-h',
  ])
  assert.equal(result.target.candies.berry, 0)
})

test('removing candy and obstacles decrements their targets without mutating inputs', () => {
  const fixture = wrappedFixture()
  const originalBoard = clone(fixture.board)
  const originalTarget = clone(fixture.target)
  const result = resolveTurn(fixture)

  assert.equal(result.target.jelly, 0)
  assert.equal(result.target.frosting, 0)
  assert.deepEqual(fixture.board, originalBoard)
  assert.deepEqual(fixture.target, originalTarget)
})

test('a frosting target counts cleared obstacles rather than damaged layers', () => {
  const fixture = wrappedFixture()
  fixture.board[3][3].frosting = 3
  const result = resolveTurn(fixture)

  assert.equal(result.board[3][3].frosting, 1)
  assert.equal(result.target.frosting, 1)
})

test('invalid swaps leave all input progress unchanged', () => {
  const board = boardFromSeed()
  const target = { candies: { berry: 3 }, jelly: 1 }
  const originalBoard = clone(board)
  const originalTarget = clone(target)
  const result = resolveTurn({
    board,
    swap: { from: { row: 0, col: 0 }, to: { row: 7, col: 7 } },
    movesLeft: 2,
    target,
    score: 40,
    rng: sequence(),
  })

  assert.equal(result.movesLeft, 2)
  assert.equal(result.score, 40)
  assert.deepEqual(result.target, originalTarget)
  assert.deepEqual(result.board, originalBoard)
  assert.deepEqual(result.waves, [])
  assert.equal(result.status, 'playing')
})

test('a dead stable board is reshuffled into one with a legal move', () => {
  const fixture = deadBoardFixture()
  const result = resolveTurn(fixture.input)

  assert.ok(fixture.calls() > 3)
  assert.ok(findLegalMoves(result.board).length > 0)
})

test('a stable board whose only move is a color-bomb swap is not reshuffled', () => {
  const fixture = deadBoardFixture({ withColorBomb: true })
  const result = resolveTurn(fixture.input)

  assert.equal(fixture.calls(), 3)
  assert.equal(result.board[7][7].special, 'color-bomb')
  assert.equal(findLegalMoves(result.board).length, 0)
})

test('a wave that cannot remove candy or damage frosting terminates resolution', () => {
  const board = boardFromSeed()
  Object.assign(board[0][0], { id: 'berry', frosting: 1 })
  Object.assign(board[0][1], { id: 'berry', frosting: 1 })
  Object.assign(board[0][2], { id: 'lemon', frosting: 1 })
  Object.assign(board[0][3], { id: 'berry', frosting: 1 })
  const result = resolveTurn({
    board,
    swap: { from: { row: 0, col: 3 }, to: { row: 0, col: 2 } },
    movesLeft: 3,
    target: { frosting: 3 },
    score: 0,
    rng: sequence(),
  })

  assert.equal(result.movesLeft, 2)
  assert.equal(result.waves.length, 1)
  assert.deepEqual(result.waves[0].removed, [])
  assert.equal(result.target.frosting, 3)
  assert.equal(result.board[0][0].frosting, 1)
  assert.deepEqual(findMatches(result.board), [])
})

test('a repeated cascade state from degenerate refill randomness is bounded', () => {
  const fixture = fourMatchFixture()
  fixture.rng = () => 0
  const result = resolveTurn(fixture)

  assert.equal(result.movesLeft, 4)
  assert.ok(result.waves.length <= 100)
  assert.deepEqual(findMatches(result.board), [])
  assert.ok(findLegalMoves(result.board).length > 0)
})
