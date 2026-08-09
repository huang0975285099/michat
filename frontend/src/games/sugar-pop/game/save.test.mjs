import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SAVE_KEY,
  createDefaultSave,
  loadSave,
  loadSaveState,
  recordLevelResult,
  saveProgress,
  boosterRewardDelta,
} from './save.js'

test('invalid persisted JSON returns the default save', () => {
  const storage = { getItem: () => '{bad json' }
  assert.deepEqual(loadSave(storage), createDefaultSave())
})

test('invalid persisted JSON reports recovery while a missing save does not', () => {
  const corrupt = loadSaveState({ getItem: () => '{bad json' })
  const missing = loadSaveState({ getItem: () => null })

  assert.deepEqual(corrupt, { save: createDefaultSave(), recovered: true })
  assert.deepEqual(missing, { save: createDefaultSave(), recovered: false })
})

test('save progress round-trips the versioned normalized shape', () => {
  let stored
  const storage = {
    getItem: (key) => (key === SAVE_KEY ? stored : null),
    setItem: (key, value) => { if (key === SAVE_KEY) stored = value },
  }
  const save = recordLevelResult(createDefaultSave(), { levelId: 1, score: 250, stars: 2 })

  saveProgress(storage, save)

  assert.deepEqual(loadSave(storage), save)
})

test('load save clamps unsafe and out-of-range persisted values', () => {
  const storage = {
    getItem: () => JSON.stringify({
      version: 99,
      unlockedLevel: 999,
      results: { 1: { stars: 8, highScore: Number.MAX_SAFE_INTEGER + 10 }, 99: { stars: 3, highScore: 4 } },
      boosters: { hammer: -5, shuffle: 2.5, extraMoves: 12 },
    }),
  }

  assert.deepEqual(loadSave(storage), {
    version: 1,
    unlockedLevel: 10,
    results: { 1: { stars: 3, highScore: Number.MAX_SAFE_INTEGER } },
    boosters: { hammer: 0, shuffle: 2, extraMoves: 12 },
  })
})

test('save migration canonicalizes duplicate numeric result keys without re-awarding boosters', () => {
  const storage = {
    getItem: () => JSON.stringify({
      version: 1,
      unlockedLevel: 1,
      results: {
        '1.0': { stars: 3, highScore: 900 },
        '01': { stars: 2, highScore: 1200 },
      },
      boosters: { hammer: 1, shuffle: 1, extraMoves: 1 },
    }),
  }

  const migrated = loadSave(storage)
  const repeated = recordLevelResult(migrated, { levelId: 1, score: 1, stars: 1 })

  assert.deepEqual(migrated.results, { 1: { stars: 3, highScore: 1200 } })
  assert.deepEqual(repeated, migrated)
})

test('recording a lower repeat result preserves progress and does not duplicate boosters', () => {
  const initial = recordLevelResult(createDefaultSave(), { levelId: 1, score: 500, stars: 2 })
  const repeated = recordLevelResult(initial, { levelId: 1, score: 100, stars: 1 })

  assert.deepEqual(repeated, initial)
  assert.deepEqual(repeated.results[1], { stars: 2, highScore: 500 })
  assert.equal(repeated.unlockedLevel, 2)
})

test('increasing a recorded star total awards each newly earned booster once', () => {
  const once = recordLevelResult(createDefaultSave(), { levelId: 2, score: 50, stars: 1 })
  const improved = recordLevelResult(once, { levelId: 2, score: 50, stars: 3 })

  assert.deepEqual(once.boosters, { hammer: 1, shuffle: 0, extraMoves: 0 })
  assert.deepEqual(improved.boosters, { hammer: 1, shuffle: 1, extraMoves: 1 })
})

test('a higher star result unlocks the next level once and reports only new rewards', () => {
  const initial = createDefaultSave()
  const next = recordLevelResult(initial, { levelId: 1, score: 1500, stars: 3 })
  const repeated = recordLevelResult(next, { levelId: 1, score: 1500, stars: 3 })

  assert.equal(next.unlockedLevel, 2)
  assert.equal(next.boosters.hammer, 1)
  assert.deepEqual(boosterRewardDelta(initial, next), { hammer: 1, shuffle: 1, extraMoves: 1 })
  assert.deepEqual(boosterRewardDelta(next, repeated), { hammer: 0, shuffle: 0, extraMoves: 0 })
})
