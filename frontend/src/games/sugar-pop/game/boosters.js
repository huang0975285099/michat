import { applyGravityWithPlan, findLegalMoves, findMatches, reshuffle } from './board.js'
import { CANDY_IDS } from './constants.js'

const BOOSTER_NAMES = ['hammer', 'shuffle', 'extraMoves']

function cloneTarget(target = {}) {
  return { ...target, candies: { ...(target.candies || {}) } }
}

function decrement(target, key) {
  if (typeof target[key] === 'number') target[key] = Math.max(0, target[key] - 1)
}

function targetsComplete(target) {
  return Object.values(target.candies || {}).every((count) => count <= 0)
    && (target.jelly || 0) <= 0
    && (target.frosting || 0) <= 0
}

function inventory(boosters = {}) {
  return Object.fromEntries(BOOSTER_NAMES.map((name) => [name, Math.max(0, Math.trunc(boosters[name] || 0))]))
}

function unchanged(state, boosters) {
  return { ...state, boosters, success: false, wave: null }
}

function playable(board) {
  return findMatches(board).length === 0 && findLegalMoves(board).length > 0
}

function stableHammerGravity(board, rng, cell) {
  const gravity = applyGravityWithPlan(board, rng)
  if (playable(gravity.board)) return { ...gravity, redraw: false }
  for (const candyId of CANDY_IDS) {
    const candidate = gravity.board.map((row) => row.map((entry) => entry && { ...entry }))
    for (const refill of gravity.refills) candidate[refill.to.row][refill.to.col].id = candyId
    if (playable(candidate)) return { ...gravity, board: candidate, redraw: false }
  }
  let value = ((cell.row + 1) * 2654435761 + cell.col) >>> 0
  const fallbackRng = () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 4294967296
  }
  try {
    return { board: reshuffle(gravity.board, fallbackRng), movements: [], refills: [], redraw: true }
  } catch {
    return null
  }
}

export function useBooster(state, kind, cell, rng = Math.random) {
  const boosters = inventory(state?.boosters)
  if (!BOOSTER_NAMES.includes(kind) || boosters[kind] <= 0) return unchanged(state, boosters)

  if (kind === 'extraMoves') {
    if (state.extraMovesUsed || !['playing', 'lost'].includes(state.status)) return unchanged(state, boosters)
    return {
      ...state,
      movesLeft: Math.max(0, Math.trunc(state.movesLeft || 0)) + 5,
      status: 'playing',
      boosters: { ...boosters, extraMoves: boosters.extraMoves - 1 },
      extraMovesUsed: true,
      success: true,
      wave: null,
    }
  }

  if (state.status !== 'playing') return unchanged(state, boosters)

  if (kind === 'shuffle') {
    try {
      return {
        ...state,
        board: reshuffle(state.board, rng),
        boosters: { ...boosters, shuffle: boosters.shuffle - 1 },
        success: true,
        wave: null,
      }
    } catch {
      return unchanged(state, boosters)
    }
  }

  const selected = state.board?.[cell?.row]?.[cell?.col]
  if (!selected) return unchanged(state, boosters)
  const board = state.board.map((row) => row.map((entry) => entry && { ...entry }))
  const target = cloneTarget(state.target)
  decrement(target.candies, selected.id)
  if (selected.jelly) decrement(target, 'jelly')
  if (selected.frosting > 0) decrement(target, 'frosting')
  board[cell.row][cell.col] = null
  const gravity = stableHammerGravity(board, rng, cell)
  if (!gravity) return unchanged(state, boosters)
  return {
    ...state,
    board: gravity.board,
    target,
    status: targetsComplete(target) ? 'won' : state.status,
    boosters: { ...boosters, hammer: boosters.hammer - 1 },
    success: true,
    wave: {
      removed: [{ row: cell.row, col: cell.col }],
      activatedSpecials: [],
      scoreDelta: 0,
      movements: gravity.movements,
      refills: gravity.refills,
      redraw: gravity.redraw,
      board: gravity.board.map((row) => row.map((entry) => entry && { ...entry })),
    },
  }
}
