import assert from 'node:assert/strict'
import test from 'node:test'

import { deleteAccountThenClear } from './account-deletion.mjs'

test('server deletion failure preserves all local recovery material', async () => {
  const local = { key: true, token: true, messages: true }
  await assert.rejects(() => deleteAccountThenClear(
    async () => { throw new Error('500') },
    async () => { local.key = local.token = local.messages = false },
  ))
  assert.deepEqual(local, { key: true, token: true, messages: true })
})

test('local material is cleared only after remote deletion succeeds', async () => {
  const order = []
  await deleteAccountThenClear(async () => order.push('remote'), async () => order.push('local'))
  assert.deepEqual(order, ['remote', 'local'])
})
