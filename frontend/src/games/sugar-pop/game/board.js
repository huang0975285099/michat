import { BOARD_SIZE, CANDY_IDS } from './constants.js'

const MAX_GENERATION_ATTEMPTS = 200
const MAX_RESHUFFLE_ATTEMPTS = 500

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function cell(id) {
  return { id, special: null, jelly: false, frosting: 0 }
}

function cloneCell(value) {
  return value == null ? null : { ...value }
}

function cloneBoard(board) {
  return board.map((row) => row.map(cloneCell))
}

function hasCandy(value) {
  return value != null && value.frosting <= 0 && value.id != null
}

function candyState(value) {
  return { id: value.id, special: value.special || null }
}

function placeCandy(tile, candy) {
  return { ...tile, id: candy?.id ?? null, special: candy?.special || null }
}

function isPosition(value) {
  return Number.isInteger(value?.row) && Number.isInteger(value?.col)
    && value.row >= 0 && value.row < BOARD_SIZE && value.col >= 0 && value.col < BOARD_SIZE
}

function hasCoordinate(group, position) {
  return group.some(({ row, col }) => row === position.row && col === position.col)
}

function randomCandy(rng) {
  return CANDY_IDS[Math.floor(rng() * CANDY_IDS.length)]
}

function blockedCoordinates(blocked) {
  return new Set(blocked.map((entry) => {
    if (typeof entry === 'string') return entry
    return `${entry.row},${entry.col}`
  }))
}

function groupKey({ row, col }) {
  return `${row},${col}`
}

export function createBoard({ seed, blocked = [] }) {
  const rng = mulberry32(seed)
  const blockedCells = blockedCoordinates(blocked)

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null))
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        if (blockedCells.has(`${row},${col}`)) continue
        const candidates = CANDY_IDS.filter((id) => !(
          col >= 2 && board[row][col - 1]?.id === id && board[row][col - 2]?.id === id
        ) && !(
          row >= 2 && board[row - 1][col]?.id === id && board[row - 2][col]?.id === id
        ))
        board[row][col] = cell(candidates[Math.floor(rng() * candidates.length)])
      }
    }
    if (findLegalMoves(board).length > 0) return board
  }
  throw new Error('Unable to create board with a legal move')
}

export function findMatches(board) {
  const runs = []
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    let col = 0
    while (col < BOARD_SIZE) {
      const id = hasCandy(board[row]?.[col]) ? board[row][col].id : null
      let end = col + 1
      while (id != null && end < BOARD_SIZE && hasCandy(board[row]?.[end]) && board[row][end].id === id) end += 1
      if (id != null && end - col >= 3) {
        runs.push(Array.from({ length: end - col }, (_, index) => ({ row, col: col + index })))
      }
      col = end
    }
  }
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    let row = 0
    while (row < BOARD_SIZE) {
      const id = hasCandy(board[row]?.[col]) ? board[row][col].id : null
      let end = row + 1
      while (id != null && end < BOARD_SIZE && hasCandy(board[end]?.[col]) && board[end][col].id === id) end += 1
      if (id != null && end - row >= 3) {
        runs.push(Array.from({ length: end - row }, (_, index) => ({ row: row + index, col })))
      }
      row = end
    }
  }

  const groups = []
  for (const run of runs) {
    const connected = groups.filter((group) => run.some((position) => hasCoordinate(group, position)))
    const merged = [...new Map([...run, ...connected.flat()].map((position) => [groupKey(position), position])).values()]
    groups.splice(0, groups.length, ...groups.filter((group) => !connected.includes(group)), merged)
  }
  return groups.map((group) => group.sort((a, b) => a.row - b.row || a.col - b.col))
    .sort((a, b) => a[0].row - b[0].row || a[0].col - b[0].col)
}

export function isAdjacent(a, b) {
  return isPosition(a) && isPosition(b) && Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1
}

export function trySwap(board, a, b) {
  const swapped = cloneBoard(board)
  if (!isAdjacent(a, b) || !hasCandy(swapped[a.row]?.[a.col]) || !hasCandy(swapped[b.row]?.[b.col])) {
    return { accepted: false, board: swapped, matches: [] }
  }
  const firstCandy = candyState(swapped[a.row][a.col])
  const secondCandy = candyState(swapped[b.row][b.col])
  swapped[a.row][a.col] = placeCandy(swapped[a.row][a.col], secondCandy)
  swapped[b.row][b.col] = placeCandy(swapped[b.row][b.col], firstCandy)
  const matches = findMatches(swapped)
  if (!matches.some((group) => hasCoordinate(group, a) || hasCoordinate(group, b))) {
    return { accepted: false, board: cloneBoard(board), matches: [] }
  }
  return { accepted: true, board: swapped, matches }
}

export function findLegalMoves(board) {
  const moves = []
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      for (const to of [{ row, col: col + 1 }, { row: row + 1, col }]) {
        const from = { row, col }
        if (isPosition(to) && trySwap(board, from, to).accepted) moves.push({ from, to })
      }
    }
  }
  return moves
}

export function applyGravityWithPlan(board, rng) {
  const result = cloneBoard(board).map((row) => row.map((tile) => (
    tile == null || tile.frosting > 0 ? tile : placeCandy(tile, null)
  )))
  const movements = []
  const refills = []
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    let segmentBottom = BOARD_SIZE - 1
    while (segmentBottom >= 0) {
      while (segmentBottom >= 0 && (board[segmentBottom]?.[col] == null || board[segmentBottom][col].frosting > 0)) {
        segmentBottom -= 1
      }
      if (segmentBottom < 0) break
      let segmentTop = segmentBottom
      while (segmentTop > 0 && board[segmentTop - 1]?.[col] != null && board[segmentTop - 1][col].frosting <= 0) {
        segmentTop -= 1
      }
      const sources = []
      for (let row = segmentBottom; row >= segmentTop; row -= 1) {
        if (hasCandy(board[row][col])) sources.push(row)
      }
      let destinationRow = segmentBottom
      for (const sourceRow of sources) {
        result[destinationRow][col] = placeCandy(result[destinationRow][col], candyState(board[sourceRow][col]))
        movements.push({ from: { row: sourceRow, col }, to: { row: destinationRow, col } })
        destinationRow -= 1
      }
      let refillIndex = 1
      for (let row = destinationRow; row >= segmentTop; row -= 1) {
        result[row][col] = placeCandy(result[row][col], { id: randomCandy(rng), special: null })
        refills.push({ from: { row: segmentTop - refillIndex, col }, to: { row, col } })
        refillIndex += 1
      }
      segmentBottom = segmentTop - 1
    }
  }
  return { board: result, movements, refills }
}

export function applyGravity(board, rng) {
  return applyGravityWithPlan(board, rng).board
}

export function reshuffle(board, rng) {
  const positions = []
  const values = []
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (!hasCandy(board[row]?.[col])) continue
      positions.push({ row, col })
      values.push(candyState(board[row][col]))
    }
  }
  for (let attempt = 0; attempt < MAX_RESHUFFLE_ATTEMPTS; attempt += 1) {
    const shuffled = [...values]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = Math.floor(rng() * (index + 1))
      ;[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]
    }
    const candidate = cloneBoard(board)
    positions.forEach((position, index) => {
      candidate[position.row][position.col] = placeCandy(candidate[position.row][position.col], shuffled[index])
    })
    if (findMatches(candidate).length === 0 && findLegalMoves(candidate).length > 0) return candidate
  }
  throw new Error('Unable to reshuffle board with a legal move')
}
