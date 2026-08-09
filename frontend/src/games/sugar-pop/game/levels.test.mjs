import test from 'node:test'
import assert from 'node:assert/strict'
import { LEVELS, getLevel, validateLevels } from './levels.js'

test('level catalog has ten sequential valid levels', () => {
  assert.equal(LEVELS.length, 10)
  assert.deepEqual(LEVELS.map(({ id }) => id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(validateLevels(LEVELS), [])
})

test('level lookup returns the requested level only', () => {
  assert.equal(getLevel(4).id, 4)
  assert.equal(getLevel(0), null)
  assert.equal(getLevel(11), null)
})

test('obstacles progress from basic boards to jelly, frosting, and mixed goals', () => {
  for (const level of LEVELS.slice(0, 3)) {
    assert.deepEqual(level.obstacles, { jelly: [], frosting: [] })
  }
  for (const level of LEVELS.slice(3, 5)) {
    assert.ok(level.obstacles.jelly.length > 0)
    assert.equal(level.obstacles.frosting.length, 0)
  }
  for (const level of LEVELS.slice(5, 7)) {
    assert.ok(level.obstacles.frosting.length > 0)
  }
  for (const level of LEVELS.slice(7)) {
    assert.ok(level.obstacles.jelly.length > 0)
    assert.ok(level.obstacles.frosting.length > 0)
    assert.ok(Object.keys(level.targets.candies).length > 0)
  }
})
