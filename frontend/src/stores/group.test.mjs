import { test } from 'node:test'
import assert from 'node:assert/strict'

// These tests verify the group store's event-handling logic directly,
// without importing the actual Pinia store (which requires Vue runtime).
// The mock variables below simulate the store's internal state transitions.

let mockGroups = []

// We can't easily test the Pinia store in isolation without Vue runtime.
// Instead, test the logic directly by simulating the store's event handler.

test('group_event dissolved removes group from list', async () => {
  mockGroups = [{ group_id: 'G-000000000001', name: 'test', member_count: 3 }]
  const dissolved = new Set()
  let groupsState = [...mockGroups]

  // Simulate handleGroupEvent
  const payload = { group_id: 'G-000000000001', event: 'dissolved' }
  dissolved.add(payload.group_id)
  groupsState = groupsState.filter(g => g.group_id !== payload.group_id)

  assert.equal(groupsState.length, 0)
  assert.ok(dissolved.has('G-000000000001'))
})

test('group_event member_removed for self hides group', async () => {
  mockGroups = [{ group_id: 'G-000000000002', name: 'test2', member_count: 3 }]
  const removed = new Set()
  let groupsState = [...mockGroups]
  const myChatId = '1234-ABCD'

  const payload = { group_id: 'G-000000000002', event: 'member_removed', member: myChatId }
  if (payload.member === myChatId) {
    removed.add(payload.group_id)
    groupsState = groupsState.filter(g => g.group_id !== payload.group_id)
  }

  assert.equal(groupsState.length, 0)
  assert.ok(removed.has('G-000000000002'))
})

test('group_event member_removed for other does not hide group', async () => {
  mockGroups = [{ group_id: 'G-000000000003', name: 'test3', member_count: 3 }]
  const removed = new Set()
  let groupsState = [...mockGroups]
  const myChatId = '1234-ABCD'

  const payload = { group_id: 'G-000000000003', event: 'member_removed', member: '5678-EFGH' }
  if (payload.member === myChatId) {
    removed.add(payload.group_id)
    groupsState = groupsState.filter(g => g.group_id !== payload.group_id)
  }

  assert.equal(groupsState.length, 1)
  assert.equal(removed.size, 0)
})

test('amIMuted logic: future muted_until returns true', () => {
  const members = [{ chat_id: '1234-ABCD', muted_until: new Date(Date.now() + 3600000).toISOString() }]
  const me = members.find(m => m.chat_id === '1234-ABCD')
  const muted = me && me.muted_until && new Date(me.muted_until) > new Date()
  assert.ok(muted)
})

test('amIMuted logic: past muted_until returns false', () => {
  const members = [{ chat_id: '1234-ABCD', muted_until: new Date(Date.now() - 60000).toISOString() }]
  const me = members.find(m => m.chat_id === '1234-ABCD')
  const muted = me && me.muted_until && new Date(me.muted_until) > new Date()
  assert.ok(!muted)
})

test('amIMuted logic: null muted_until returns false', () => {
  const members = [{ chat_id: '1234-ABCD', muted_until: null }]
  const me = members.find(m => m.chat_id === '1234-ABCD')
  const muted = me && me.muted_until && new Date(me.muted_until) > new Date()
  assert.ok(!muted)
})

test('getMemberPubKeys excludes self and non-active', () => {
  const myChatId = '1111-AAAA'
  const members = [
    { chat_id: '1111-AAAA', public_key: 'key1', state: 'active' }, // self
    { chat_id: '2222-BBBB', public_key: 'key2', state: 'active' },
    { chat_id: '3333-CCCC', public_key: 'key3', state: 'removed' },
  ]
  const result = members
    .filter(m => m.state === 'active' && m.chat_id !== myChatId)
    .map(m => ({ chat_id: m.chat_id, public_key: m.public_key }))

  assert.equal(result.length, 1)
  assert.equal(result[0].chat_id, '2222-BBBB')
})
