import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { resolveAuthoritativeRound } from './resolve.js'

const fixtureURL = new URL(
  '../../../../../backend/internal/ironfistengine/testdata/rules-v1.json',
  import.meta.url,
)
const fixtures = JSON.parse(await readFile(fixtureURL, 'utf8'))

for (const fixture of fixtures) {
  test(`practice resolver matches rules v1: ${fixture.name}`, () => {
    const got = resolveAuthoritativeRound(
      fixture.action_a,
      fixture.action_b,
      fixture.before,
    )

    assert.deepEqual(got, {
      damageA: fixture.damage_a,
      damageB: fixture.damage_b,
      environmentDamage: fixture.environment_damage,
      state: fixture.after,
      outcome: fixture.outcome,
    })
  })
}
