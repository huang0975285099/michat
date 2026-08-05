import { LEVELS } from './levels.js'

export const SAVE_KEY = 'sugar-pop:save'

const MAX_LEVEL = LEVELS.length
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const BOOSTER_NAMES = ['hammer', 'shuffle', 'extraMoves']

function clampInteger(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeResults(results) {
  if (!isPlainObject(results)) return {}
  return Object.entries(results).reduce((normalized, [levelId, result]) => {
    const canonicalLevelId = Number(levelId)
    if (!Number.isInteger(canonicalLevelId) || canonicalLevelId < 1 || canonicalLevelId > MAX_LEVEL || !isPlainObject(result)) return normalized
    const previous = normalized[canonicalLevelId] || { stars: 0, highScore: 0 }
    normalized[canonicalLevelId] = {
      stars: Math.max(previous.stars, clampInteger(result.stars, 0, 3)),
      highScore: Math.max(previous.highScore, clampInteger(result.highScore, 0, MAX_SAFE_INTEGER)),
    }
    return normalized
  }, {})
}

function normalizeSave(value) {
  if (!isPlainObject(value)) return createDefaultSave()
  const results = normalizeResults(value.results)
  const completedLevel = Math.max(0, ...Object.keys(results).map(Number))
  const boosters = isPlainObject(value.boosters) ? value.boosters : {}
  return {
    version: 1,
    unlockedLevel: Math.max(clampInteger(value.unlockedLevel, 1, MAX_LEVEL), Math.min(MAX_LEVEL, completedLevel + 1)),
    results,
    boosters: Object.fromEntries(BOOSTER_NAMES.map((name) => [name, clampInteger(boosters[name], 0, MAX_SAFE_INTEGER)])),
  }
}

export function createDefaultSave() {
  return {
    version: 1,
    unlockedLevel: 1,
    results: {},
    boosters: { hammer: 0, shuffle: 0, extraMoves: 0 },
  }
}

export function loadSave(storage) {
  try {
    const serialized = storage?.getItem?.(SAVE_KEY)
    if (serialized == null) return createDefaultSave()
    return normalizeSave(JSON.parse(serialized))
  } catch {
    return createDefaultSave()
  }
}

export function saveProgress(storage, save) {
  const normalized = normalizeSave(save)
  storage?.setItem?.(SAVE_KEY, JSON.stringify(normalized))
  return normalized
}

export function recordLevelResult(save, { levelId, score, stars }) {
  const normalized = normalizeSave(save)
  const safeLevelId = clampInteger(levelId, 1, MAX_LEVEL)
  const previous = normalized.results[safeLevelId] || { stars: 0, highScore: 0 }
  const nextStars = Math.max(previous.stars, clampInteger(stars, 0, 3))
  const nextScore = Math.max(previous.highScore, clampInteger(score, 0, MAX_SAFE_INTEGER))
  const boosters = { ...normalized.boosters }
  for (let star = previous.stars + 1; star <= nextStars; star += 1) {
    const booster = BOOSTER_NAMES[star - 1]
    boosters[booster] = clampInteger(boosters[booster] + 1, 0, MAX_SAFE_INTEGER)
  }
  return {
    ...normalized,
    unlockedLevel: Math.max(normalized.unlockedLevel, Math.min(MAX_LEVEL, safeLevelId + 1)),
    results: { ...normalized.results, [safeLevelId]: { stars: nextStars, highScore: nextScore } },
    boosters,
  }
}
