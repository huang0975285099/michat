const BOARD_ROWS = 8
const BOARD_COLUMNS = 8

function positions(...coordinates) {
  return coordinates.map(([row, col, layers = 1]) => ({ row, col, layers }))
}

function level({ id, seed, moves, candies, jelly = [], frosting = [], starScores }) {
  return {
    id,
    seed,
    moves,
    targets: {
      candies,
      ...(jelly.length > 0 ? { jelly: jelly.length } : {}),
      ...(frosting.length > 0 ? { frosting: frosting.length } : {}),
    },
    boardShape: { rows: BOARD_ROWS, columns: BOARD_COLUMNS, blocked: [] },
    obstacles: { jelly, frosting },
    starScores,
  }
}

export const LEVELS = [
  level({ id: 1, seed: 104729, moves: 24, candies: { berry: 12 }, starScores: [180, 300, 450] }),
  level({ id: 2, seed: 209759, moves: 23, candies: { lemon: 14 }, starScores: [220, 360, 520] }),
  level({ id: 3, seed: 314159, moves: 22, candies: { mint: 10, grape: 10 }, starScores: [260, 420, 600] }),
  level({ id: 4, seed: 271828, moves: 23, candies: { orange: 10 }, jelly: positions([2, 2], [2, 3], [3, 2], [3, 3]), starScores: [280, 460, 680] }),
  level({ id: 5, seed: 161803, moves: 22, candies: { berry: 10, lemon: 10 }, jelly: positions([1, 2], [1, 5], [2, 2], [2, 5], [5, 2], [5, 5]), starScores: [340, 560, 800] }),
  level({ id: 6, seed: 141421, moves: 22, candies: { grape: 12 }, frosting: positions([2, 3], [2, 4], [3, 3], [3, 4]), starScores: [380, 620, 900] }),
  level({ id: 7, seed: 173205, moves: 21, candies: { mint: 10, orange: 10 }, frosting: positions([1, 3, 2], [1, 4, 2], [2, 3], [2, 4], [5, 3], [5, 4]), starScores: [440, 720, 1040] }),
  level({ id: 8, seed: 223607, moves: 20, candies: { berry: 10, lemon: 8 }, jelly: positions([2, 1], [2, 6], [3, 2], [3, 5]), frosting: positions([4, 3], [4, 4]), starScores: [500, 820, 1180] }),
  level({ id: 9, seed: 244949, moves: 19, candies: { grape: 10, orange: 10 }, jelly: positions([1, 1], [1, 6], [6, 1], [6, 6]), frosting: positions([3, 3, 2], [3, 4, 2], [4, 3], [4, 4]), starScores: [560, 920, 1320] }),
  level({ id: 10, seed: 316227, moves: 18, candies: { berry: 8, mint: 8, lemon: 8 }, jelly: positions([1, 2], [1, 5], [2, 1], [2, 6], [5, 1], [5, 6], [6, 2], [6, 5]), frosting: positions([3, 3, 2], [3, 4, 2], [4, 3, 2], [4, 4, 2]), starScores: [650, 1060, 1500] }),
]

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validPosition(position) {
  return Number.isInteger(position?.row) && Number.isInteger(position?.col)
    && position.row >= 0 && position.row < BOARD_ROWS
    && position.col >= 0 && position.col < BOARD_COLUMNS
}

export function validateLevels(levels) {
  if (!Array.isArray(levels)) return ['Level catalog must be an array']
  const errors = []
  const occupied = new Set()
  for (const [index, entry] of levels.entries()) {
    const prefix = `Level ${index + 1}`
    if (!entry || typeof entry !== 'object') {
      errors.push(`${prefix} must be an object`)
      continue
    }
    if (entry.id !== index + 1) errors.push(`${prefix} must have sequential id ${index + 1}`)
    if (!isSafePositiveInteger(entry.seed)) errors.push(`${prefix} must have a positive safe integer seed`)
    if (!isSafePositiveInteger(entry.moves)) errors.push(`${prefix} must have positive moves`)
    if (entry.boardShape?.rows !== BOARD_ROWS || entry.boardShape?.columns !== BOARD_COLUMNS || !Array.isArray(entry.boardShape?.blocked)) errors.push(`${prefix} must use an 8 by 8 board shape`)
    if (!entry.targets || typeof entry.targets !== 'object' || !Object.values(entry.targets.candies || {}).every(isSafePositiveInteger) || Object.keys(entry.targets.candies || {}).length === 0) errors.push(`${prefix} must have positive candy targets`)
    if (!Array.isArray(entry.obstacles?.jelly) || !Array.isArray(entry.obstacles?.frosting)) errors.push(`${prefix} must declare obstacle arrays`)
    for (const obstacle of [...(entry.obstacles?.jelly || []), ...(entry.obstacles?.frosting || [])]) {
      if (!validPosition(obstacle)) errors.push(`${prefix} has an out-of-board obstacle`)
      const coordinate = `${obstacle?.row},${obstacle?.col}`
      if (occupied.has(`${entry.id}:${coordinate}`)) errors.push(`${prefix} has overlapping obstacles`)
      occupied.add(`${entry.id}:${coordinate}`)
    }
    if ((entry.targets.jelly || 0) !== (entry.obstacles?.jelly?.length || 0)) errors.push(`${prefix} jelly target must match jelly obstacles`)
    if ((entry.targets.frosting || 0) !== (entry.obstacles?.frosting?.length || 0)) errors.push(`${prefix} frosting target must match frosting obstacles`)
    if (!Array.isArray(entry.starScores) || entry.starScores.length !== 3 || !entry.starScores.every(isSafePositiveInteger) || entry.starScores.some((score, scoreIndex) => scoreIndex > 0 && score <= entry.starScores[scoreIndex - 1])) errors.push(`${prefix} must have three ascending star scores`)
  }
  return errors
}

export function getLevel(id) {
  return LEVELS.find((levelDefinition) => levelDefinition.id === id) || null
}
