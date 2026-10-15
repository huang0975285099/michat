import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as membership from './group-membership.mjs'

const source = (await readFile(new URL('../stores/group.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '')
const helperNames = ['canonicalPublicKey', 'rosterContent', 'approvalContent', 'fingerprint', 'signApproval', 'verifyApproval', 'approvalStorageKey', 'createMembershipGate']
const factory = new Function('defineStore', 'ref', 'groupApi', 'on', 'off', 'pinPeerPublicKey', 'loadKeyPair', 'hasSecurityCode', 'isUnlocked', 'localStorage', ...helperNames, source.replace('export const useGroupStore', 'const useGroupStore') + '\nreturn useGroupStore()')

async function harness() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const pubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))))
  const storage = new Map()
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  let detail = { group_id: 'g', members: [{ chat_id: 'alice', public_key: pubKeyB64, state: 'active' }] }
  let response = async () => ({ data: structuredClone(detail) })
  let keyRecord = { pubKeyB64, privateKey: keys.privateKey }
  let locked = false
  let listener
  const create = () => factory((name, setup) => setup, value => ({ value }), { detail: () => response(), list: async () => ({ data: [] }) }, (event, handler) => { listener = handler }, () => {}, async (account, member, key) => key, async () => { if (locked) throw new Error('locked'); return keyRecord }, async () => true, () => !locked, localStorage, ...helperNames.map(name => membership[name]))
  const store = create()
  store.setMyChatId('alice')
  return { store, create, storage, setResponse: value => { response = value }, setDetail: value => { detail = value }, setKeys: value => { keyRecord = value }, setLocked: value => { locked = value }, event: value => listener(value), pubKeyB64 }
}

test('store never auto approves; durable approval reload verifies signature and exact identity', async () => {
  const context = await harness()
  const { store } = context
  await store.loadGroupDetail('g')
  assert.equal(store.isMembershipTrusted('g'), false)
  const snapshot = store.membershipStatus.value.g.snapshot
  await store.approveMembership('g', snapshot)
  await store.assertMembershipTrusted('g')
  assert.equal(store.isMembershipTrusted('g'), true)
  const reloaded = context.create()
  reloaded.setMyChatId('alice')
  assert.equal(reloaded.isMembershipTrusted('g'), false)
  await reloaded.loadGroupDetail('g')
  assert.equal(reloaded.isMembershipTrusted('g'), true)
  for (const key of context.storage.keys()) context.storage.set(key, JSON.stringify({ content: 'forged', signature: 'forged' }))
  await reloaded.loadGroupDetail('g')
  assert.equal(reloaded.isMembershipTrusted('g'), false)
  reloaded.setMyChatId('bob')
  await reloaded.loadGroupDetail('g')
  assert.equal(reloaded.isMembershipTrusted('g'), false)
})

test('missing roster loads automatically once for concurrent authentication without requiring approval', async () => {
  const { store, pubKeyB64, setResponse } = await harness()
  let resolve
  let requests = 0
  setResponse(() => {
    requests += 1
    return new Promise(done => { resolve = done })
  })
  const first = store.assertRosterAvailable('g')
  const second = store.assertRosterAvailable('g')
  assert.equal(requests, 1)
  resolve({ data: { group_id: 'g', members: [{ chat_id: 'alice', public_key: pubKeyB64, state: 'active' }] } })
  await Promise.all([first, second])
  assert.equal(store.isRosterAvailable('g'), true)
  assert.equal(store.isMembershipTrusted('g'), false)
  await store.assertRosterAvailable('g')
  assert.equal(requests, 1)
})

test('missing roster retries after network failure and rejects an account switch during loading', async () => {
  const { store, pubKeyB64, setResponse } = await harness()
  setResponse(async () => { throw new Error('offline') })
  await assert.rejects(store.assertRosterAvailable('g'), /roster unavailable/)
  setResponse(async () => ({ data: { group_id: 'g', members: [{ chat_id: 'alice', public_key: pubKeyB64, state: 'active' }] } }))
  await store.assertRosterAvailable('g')
  store.clear()
  store.setMyChatId('alice')
  let resolve
  setResponse(() => new Promise(done => { resolve = done }))
  const pending = store.assertRosterAvailable('g')
  store.setMyChatId('bob')
  resolve({ data: { group_id: 'g', members: [{ chat_id: 'alice', public_key: pubKeyB64, state: 'active' }] } })
  await assert.rejects(pending, /account changed/)
  assert.equal(store.isRosterAvailable('g'), false)
})

test('failed refresh and invalid own key never leave stale trust enabled', async () => {
  const context = await harness()
  const { store } = context
  await store.loadGroupDetail('g')
  await store.approveMembership('g', store.membershipStatus.value.g.snapshot)
  context.setResponse(async () => { throw new Error('offline') })
  assert.equal(await store.loadGroupDetail('g'), null)
  assert.equal(store.isMembershipTrusted('g'), false)
  assert.throws(() => store.getMemberPubKeys('g'))
  assert.throws(() => store.getTrustedMemberPubKeys('g'))
  await assert.rejects(store.assertMembershipTrusted('g'))
  context.setResponse(async () => ({ data: { group_id: 'g', members: [{ chat_id: 'alice', public_key: context.pubKeyB64, state: 'active' }] } }))
  await store.loadGroupDetail('g')
  assert.equal(store.isMembershipTrusted('g'), true)
  const replacement = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const pubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', replacement.publicKey))))
  context.setKeys({ pubKeyB64, privateKey: replacement.privateKey })
  await assert.rejects(store.assertMembershipTrusted('g'), /Own identity key changed/)
  assert.equal(store.isMembershipTrusted('g'), false)
})

test('approval refresh detects injected member and pending refresh cannot restore trust after account switch', async () => {
  const context = await harness()
  const { store, pubKeyB64 } = context
  await store.loadGroupDetail('g')
  const snapshot = store.membershipStatus.value.g.snapshot
  context.setDetail({ group_id: 'g', members: [{ chat_id: 'alice', public_key: pubKeyB64, state: 'active' }, { chat_id: 'mallory', public_key: pubKeyB64, state: 'active' }] })
  await assert.rejects(store.approveMembership('g', snapshot))
  assert.equal(context.storage.size, 0)
  let resolve
  context.setResponse(() => new Promise(done => { resolve = done }))
  const pending = store.loadGroupDetail('g')
  store.setMyChatId('bob')
  resolve({ data: { group_id: 'g', members: [{ chat_id: 'alice', public_key: pubKeyB64, state: 'active' }] } })
  assert.equal(await pending, null)
  assert.equal(store.isMembershipTrusted('g'), false)
})

test('lock rejects approval and group events immediately invalidate existing approval', async () => {
  const context = await harness()
  const { store } = context
  await store.loadGroupDetail('g')
  const snapshot = store.membershipStatus.value.g.snapshot
  context.setLocked(true)
  await assert.rejects(store.approveMembership('g', snapshot))
  assert.equal(context.storage.size, 0)
  context.setLocked(false)
  await store.approveMembership('g', snapshot)
  store.startListening()
  context.setResponse(async () => { throw new Error('offline') })
  context.event({ group_id: 'g', event: 'member_added' })
  assert.equal(store.isMembershipTrusted('g'), false)
})

test('cancelled review cannot create a durable approval after awaited work', async () => {
  const context = await harness()
  await context.store.loadGroupDetail('g')
  let checks = 0
  await assert.rejects(context.store.approveMembership('g', context.store.membershipStatus.value.g.snapshot, () => ++checks === 1))
  assert.equal(context.storage.size, 0)
  assert.equal(context.store.isMembershipTrusted('g'), false)
})
