import test from 'node:test'
import assert from 'node:assert/strict'
import { createBoard, findLegalMoves, findMatches } from './board.js'
import { useBooster } from './boosters.js'

function fixture(overrides = {}) {
  return {
    board: createBoard({ seed: 17 }),
    movesLeft: 0,
    target: { candies: { berry: 2 } },
    score: 100,
    status: 'playing',
    boosters: { hammer: 2, shuffle: 2, extraMoves: 2 },
    extraMovesUsed: false,
    ...overrides,
  }
}

test('hammer is consumed only when it clears a valid occupied cell', () => {
  const occupied = fixture()
  const emptyBoard = occupied.board.map((row) => row.map((cell) => cell && { ...cell }))
  emptyBoard[0][0] = null

  const cleared = useBooster(occupied, 'hammer', { row: 0, col: 0 }, () => 0.25)
  const rejected = useBooster(fixture({ board: emptyBoard }), 'hammer', { row: 0, col: 0 }, () => 0.25)

  assert.equal(cleared.success, true)
  assert.equal(cleared.boosters.hammer, 1)
  assert.equal(cleared.wave.removed.length, 1)
  assert.equal(rejected.success, false)
  assert.equal(rejected.boosters.hammer, 2)
  assert.equal(occupied.boosters.hammer, 2)
  assert.notStrictEqual(cleared.board, occupied.board)
})

test('a failed shuffle does not consume inventory or mutate the board', () => {
  const cell = { id: 'berry', special: null, jelly: false, frosting: 0 }
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ ...cell })))
  const state = fixture({ board })

  const result = useBooster(state, 'shuffle', null, () => 0)

  assert.equal(result.success, false)
  assert.equal(result.boosters.shuffle, 2)
  assert.deepEqual(result.board, board)
})

test('extra moves revives a lost run once and only consumes the successful use', () => {
  const first = useBooster(fixture({ status: 'lost' }), 'extraMoves')
  const repeated = useBooster(first, 'extraMoves')

  assert.equal(first.success, true)
  assert.equal(first.movesLeft, 5)
  assert.equal(first.status, 'playing')
  assert.equal(first.boosters.extraMoves, 1)
  assert.equal(first.extraMovesUsed, true)
  assert.equal(repeated.success, false)
  assert.equal(repeated.movesLeft, 5)
  assert.equal(repeated.boosters.extraMoves, 1)
})

test('hammer clears its cell targets and can complete a level without spending a move', () => {
  const state = fixture({
    target: { candies: { berry: 1 }, jelly: 1, frosting: 1 },
  })
  state.board[0][0] = { id: 'berry', special: null, jelly: true, frosting: 2 }

  const result = useBooster(state, 'hammer', { row: 0, col: 0 }, () => 0.4)

  assert.deepEqual(result.target, { candies: { berry: 0 }, jelly: 0, frosting: 0 })
  assert.equal(result.movesLeft, 0)
  assert.equal(result.status, 'won')
})

test('hammer leaves a stable playable board even when its first refill makes a match', () => {
  const result = useBooster(fixture({ board: createBoard({ seed: 1 }) }), 'hammer', { row: 1, col: 1 }, () => 0)

  assert.equal(result.success, true)
  assert.equal(findMatches(result.board).length, 0)
  assert.ok(findLegalMoves(result.board).length > 0)
})
