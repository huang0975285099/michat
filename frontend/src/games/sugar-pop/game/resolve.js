import {
  applyGravityWithPlan,
  createBoard,
  findLegalMoves,
  findMatches,
  isAdjacent,
  reshuffle,
  trySwap,
} from './board.js'

const BASE_REMOVAL_SCORE = 10
const SPECIAL_ACTIVATION_BONUS = 25
const MAX_CASCADE_WAVES = 100
const STABLE_FALLBACK_SEED = 0x5A17E

function cloneBoard(board) {
  return board.map((row) => row.map((cell) => (cell == null ? null : { ...cell })))
}

function cloneTarget(target) {
  return {
    ...target,
    ...(target?.candies ? { candies: { ...target.candies } } : {}),
  }
}

function key({ row, col }) {
  return `${row},${col}`
}

function boardState(board) {
  return JSON.stringify(board)
}

function isColorBombSpecialSwap(board, swap) {
  const fromCell = board[swap?.from?.row]?.[swap?.from?.col]
  const toCell = board[swap?.to?.row]?.[swap?.to?.col]
  if (!isAdjacent(swap?.from, swap?.to) || !fromCell || !toCell) return false
  const fromIsBomb = fromCell.special === 'color-bomb'
  const toIsBomb = toCell.special === 'color-bomb'
  return (fromIsBomb && toCell.special != null) || (toIsBomb && fromCell.special != null)
}

function tryColorBombSwap(board, swap) {
  const fromCell = board[swap?.from?.row]?.[swap?.from?.col]
  const toCell = board[swap?.to?.row]?.[swap?.to?.col]
  if (!isAdjacent(swap?.from, swap?.to) || !fromCell || !toCell) return null
  const fromIsBomb = fromCell.special === 'color-bomb'
  const toIsBomb = toCell.special === 'color-bomb'
  if (fromIsBomb === toIsBomb) return null
  const counterpart = fromIsBomb ? toCell : fromCell
  if (counterpart.special != null || counterpart.frosting > 0 || counterpart.id == null) return null

  const swapped = cloneBoard(board)
  Object.assign(swapped[swap.from.row][swap.from.col], { id: toCell.id, special: toCell.special })
  Object.assign(swapped[swap.to.row][swap.to.col], { id: fromCell.id, special: fromCell.special })
  return {
    board: swapped,
    triggered: [fromIsBomb ? swap.to : swap.from],
  }
}

function hasPlayableMove(board) {
  if (findLegalMoves(board).length > 0) return true
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      const from = { row, col }
      for (const to of [{ row, col: col + 1 }, { row: row + 1, col }]) {
        if (tryColorBombSwap(board, { from, to })) return true
      }
    }
  }
  return false
}

function stableFallback(board) {
  const generated = createBoard({ seed: STABLE_FALLBACK_SEED })
  return board.map((row, rowIndex) => row.map((cell, colIndex) => (
    cell == null || cell.frosting > 0
      ? (cell == null ? null : { ...cell })
      : { ...cell, id: generated[rowIndex][colIndex].id, special: null }
  )))
}

function positionFromKey(value) {
  const [row, col] = value.split(',').map(Number)
  return { row, col }
}

function isOnBoard(board, { row, col }) {
  return row >= 0 && row < board.length && col >= 0 && col < board[row].length
}

function runLengths(group) {
  const byRow = new Map()
  const byCol = new Map()
  for (const position of group) {
    byRow.set(position.row, (byRow.get(position.row) || 0) + 1)
    byCol.set(position.col, (byCol.get(position.col) || 0) + 1)
  }
  return {
    horizontal: Math.max(0, ...byRow.values()),
    vertical: Math.max(0, ...byCol.values()),
  }
}

function specialForGroup(group, swap) {
  const lengths = runLengths(group)
  if (lengths.horizontal >= 3 && lengths.vertical >= 3) return 'wrapped'
  if (Math.max(lengths.horizontal, lengths.vertical) >= 5) return 'color-bomb'
  if (Math.max(lengths.horizontal, lengths.vertical) === 4) {
    return swap.from.row === swap.to.row ? 'striped-h' : 'striped-v'
  }
  return null
}

function contains(group, position) {
  return group.some(({ row, col }) => row === position.row && col === position.col)
}

function specialPosition(group, swap, special) {
  if (contains(group, swap.to)) return swap.to
  if (contains(group, swap.from)) return swap.from
  if (special === 'wrapped') {
    const lengths = runLengths(group)
    return group.find((position) => group.filter((other) => other.row === position.row).length === lengths.horizontal
      && group.filter((other) => other.col === position.col).length === lengths.vertical) || group[0]
  }
  return group[0]
}

function targetComplete(target) {
  return Object.values(target?.candies || {}).every((count) => count <= 0)
    && ['jelly', 'frosting'].every((name) => (target?.[name] || 0) <= 0)
}

function decrementTarget(target, name, amount = 1) {
  if (typeof target[name] === 'number') target[name] = Math.max(0, target[name] - amount)
}

function colorChoice(originalBoard, swap, position, cell) {
  if (cell.special !== 'color-bomb') return cell.id
  if (position.row === swap.to.row && position.col === swap.to.col) return originalBoard[swap.to.row][swap.to.col]?.id
  if (position.row === swap.from.row && position.col === swap.from.col) return originalBoard[swap.from.row][swap.from.col]?.id
  return cell.id
}

function expandedSpecialCells(board, special, position, colorId) {
  const affected = []
  if (special === 'striped-h') {
    for (let col = 0; col < board[position.row].length; col += 1) affected.push({ row: position.row, col })
  } else if (special === 'striped-v') {
    for (let row = 0; row < board.length; row += 1) affected.push({ row, col: position.col })
  } else if (special === 'wrapped') {
    for (let row = position.row - 1; row <= position.row + 1; row += 1) {
      for (let col = position.col - 1; col <= position.col + 1; col += 1) {
        if (isOnBoard(board, { row, col })) affected.push({ row, col })
      }
    }
  } else if (special === 'color-bomb') {
    for (let row = 0; row < board.length; row += 1) {
      for (let col = 0; col < board[row].length; col += 1) {
        if (board[row][col]?.id === colorId) affected.push({ row, col })
      }
    }
  }
  return affected
}

function resolveWave({ board, groups, triggered, swap, originalBoard, target, multiplier }) {
  const created = []
  const spared = new Set()
  for (const group of groups) {
    const special = specialForGroup(group, swap)
    if (!special) continue
    const position = specialPosition(group, swap, special)
    const cell = board[position.row][position.col]
    if (!cell || cell.frosting > 0) continue
    cell.special = special
    spared.add(key(position))
    created.push({ ...position, special })
  }

  const affected = new Set()
  for (const position of triggered) affected.add(key(position))
  for (const group of groups) {
    for (const position of group) {
      if (!spared.has(key(position))) affected.add(key(position))
    }
  }

  const queued = []
  const queuedKeys = new Set()
  const activatedKeys = new Set()
  const activatedSpecials = []
  const enqueueSpecial = (position) => {
    const cell = board[position.row]?.[position.col]
    const positionKey = key(position)
    if (!cell?.special || queuedKeys.has(positionKey) || activatedKeys.has(positionKey)) return
    queuedKeys.add(positionKey)
    queued.push({ ...position, special: cell.special, colorId: colorChoice(originalBoard, swap, position, cell) })
  }

  for (const affectedKey of affected) enqueueSpecial(positionFromKey(affectedKey))
  while (queued.length > 0) {
    const next = queued.shift()
    const nextKey = key(next)
    if (activatedKeys.has(nextKey)) continue
    activatedKeys.add(nextKey)
    activatedSpecials.push({ row: next.row, col: next.col, special: next.special })
    for (const position of expandedSpecialCells(board, next.special, next, next.colorId)) {
      const positionKey = key(position)
      if (!affected.has(positionKey)) affected.add(positionKey)
      enqueueSpecial(position)
    }
  }

  const removed = []
  for (const affectedKey of affected) {
    const position = positionFromKey(affectedKey)
    const cell = board[position.row][position.col]
    if (!cell || cell.frosting > 0) continue
    removed.push({ ...position })
    if (cell.jelly) {
      cell.jelly = false
      decrementTarget(target, 'jelly')
    }
    decrementTarget(target.candies || {}, cell.id)
  }

  let frostingLayersReduced = 0
  for (const position of removed) {
    for (const neighbor of [
      { row: position.row - 1, col: position.col },
      { row: position.row + 1, col: position.col },
      { row: position.row, col: position.col - 1 },
      { row: position.row, col: position.col + 1 },
    ]) {
      if (!isOnBoard(board, neighbor)) continue
      const frostingCell = board[neighbor.row][neighbor.col]
      if (frostingCell?.frosting > 0) {
        frostingCell.frosting -= 1
        frostingLayersReduced += 1
        if (frostingCell.frosting === 0) {
          frostingCell.id = null
          frostingCell.special = null
          decrementTarget(target, 'frosting')
        }
      }
    }
  }

  for (const position of removed) {
    const tile = board[position.row][position.col]
    board[position.row][position.col] = { ...tile, id: null, special: null }
  }
  const scoreDelta = multiplier * ((removed.length * BASE_REMOVAL_SCORE)
    + (activatedSpecials.length * SPECIAL_ACTIVATION_BONUS))
  const gravity = applyGravityWithPlan(board, swap.rng)
  return {
    board: gravity.board,
    created,
    frostingLayersReduced,
    wave: {
      removed,
      activatedSpecials,
      scoreDelta,
      movements: gravity.movements,
      refills: gravity.refills,
      board: cloneBoard(gravity.board),
    },
  }
}

export function resolveTurn({ board, swap, movesLeft, target, score, rng }) {
  const originalBoard = cloneBoard(board)
  const resultTarget = cloneTarget(target)
  const forbiddenSpecialSwap = isColorBombSpecialSwap(board, swap)
  const colorBombSwap = forbiddenSpecialSwap ? null : tryColorBombSwap(board, swap)
  const matchedSwap = colorBombSwap || forbiddenSpecialSwap ? null : trySwap(board, swap?.from, swap?.to)
  if (forbiddenSpecialSwap || (!colorBombSwap && !matchedSwap.accepted)) {
    return {
      board: originalBoard,
      waves: [],
      score,
      movesLeft,
      target: resultTarget,
      status: 'playing',
      createdSpecials: [],
    }
  }

  let currentBoard = colorBombSwap?.board || matchedSwap.board
  let currentScore = score
  const waves = []
  const createdSpecials = []
  let groups = matchedSwap?.matches || []
  let triggered = colorBombSwap?.triggered || []
  let multiplier = 1
  let needsStableFallback = false
  const seenStates = new Set([boardState(currentBoard)])

  while (groups.length > 0 || triggered.length > 0) {
    const resolved = resolveWave({
      board: currentBoard,
      groups,
      triggered,
      swap: { ...swap, rng },
      originalBoard,
      target: resultTarget,
      multiplier,
    })
    currentBoard = resolved.board
    currentScore += resolved.wave.scoreDelta
    waves.push(resolved.wave)
    createdSpecials.push(...resolved.created)
    triggered = []
    if (resolved.wave.removed.length === 0 && resolved.frostingLayersReduced === 0) {
      needsStableFallback = true
      break
    }
    const state = boardState(currentBoard)
    if (seenStates.has(state) || waves.length >= MAX_CASCADE_WAVES) {
      needsStableFallback = true
      break
    }
    seenStates.add(state)
    groups = findMatches(currentBoard)
    multiplier += 1
  }

  if (needsStableFallback) currentBoard = stableFallback(currentBoard)
  if (!hasPlayableMove(currentBoard)) currentBoard = reshuffle(currentBoard, rng)
  const complete = targetComplete(resultTarget)
  return {
    board: currentBoard,
    waves,
    score: currentScore,
    movesLeft: movesLeft - 1,
    target: resultTarget,
    status: complete ? 'won' : (movesLeft - 1 <= 0 ? 'lost' : 'playing'),
    createdSpecials,
  }
}

export function resolveBonusMoves({ board, movesLeft, score, rng }) {
  const bonusMoves = Math.max(0, Math.trunc(movesLeft || 0))
  const startingScore = Math.max(0, Math.trunc(score || 0))
  let currentBoard = cloneBoard(board)
  let currentScore = startingScore
  const waves = []

  for (let moveIndex = 0; moveIndex < bonusMoves; moveIndex += 1) {
    const candidates = []
    for (let row = 0; row < currentBoard.length; row += 1) {
      for (let col = 0; col < currentBoard[row].length; col += 1) {
        const candidate = currentBoard[row][col]
        if (candidate?.id != null && candidate.frosting <= 0) candidates.push({ row, col })
      }
    }
    if (candidates.length === 0) break

    const selected = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]
    currentBoard[selected.row][selected.col].special = moveIndex % 2 === 0 ? 'striped-h' : 'striped-v'
    let groups = []
    let triggered = [selected]
    let multiplier = 1
    const swap = { from: selected, to: selected, rng }
    const originalBoard = cloneBoard(currentBoard)
    const target = { candies: {} }

    while (groups.length > 0 || triggered.length > 0) {
      const resolved = resolveWave({
        board: currentBoard,
        groups,
        triggered,
        swap,
        originalBoard,
        target,
        multiplier,
      })
      currentBoard = resolved.board
      currentScore += resolved.wave.scoreDelta
      waves.push(resolved.wave)
      triggered = []
      groups = findMatches(currentBoard)
      multiplier += 1
      if (resolved.wave.removed.length === 0 || multiplier > MAX_CASCADE_WAVES) {
        currentBoard = stableFallback(currentBoard)
        break
      }
    }
  }

  if (!hasPlayableMove(currentBoard)) currentBoard = reshuffle(currentBoard, rng)
  return {
    board: currentBoard,
    waves,
    score: currentScore,
    movesLeft: 0,
    bonusMoves,
    bonusScore: currentScore - startingScore,
  }
}
