import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { computed, effectScope, reactive, ref, watch, nextTick } from 'vue'
import { signControlProof, verifyControlProof } from '../services/control-proof.mjs'
import { bufToB64 } from '../services/crypto.js'

const source = await readFile(new URL('./useGroupReadReceipts.js', import.meta.url), 'utf8')
const groupId = 'G-123456ABCDEF'

async function makeKeys() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return { ...keys, publicKeyB64: bufToB64(await crypto.subtle.exportKey('spki', keys.publicKey)) }
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for group read synchronization')
}

async function harness(api, peerKeys) {
  const ownKeys = await makeKeys()
  const identity = reactive({ chatId: '1001-AAAA', isLocked: false, restoringLocalData: false })
  const chat = reactive({ messages: { [groupId]: [{ id: 'incoming-msg-id', mine: false, read: true }, { id: 'outgoing-msg-id', mine: true, status: 'sent' }] } })
  const active = ref(true)
  const visible = computed(() => chat.messages[groupId])
  let mount
  let unmount
  let tick
  const scope = effectScope()
  const dependencies = {
    computed, ref, watch,
    onMounted: callback => { mount = callback },
    onUnmounted: callback => { unmount = callback },
    useIdentityStore: () => identity,
    useChatStore: () => chat,
    useGroupStore: () => ({ getMembers: () => [{ chat_id: '1002-BBBB', public_key: peerKeys.publicKeyB64 }] }),
    groupApi: api,
    loadKeyPair: async () => ownKeys,
    getPinnedPeerPublicKey: async () => null,
    signControlProof, verifyControlProof,
    getServerNow: () => 1700000000000,
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    setInterval: callback => { tick = callback; return 1 },
    clearInterval() {},
    console: { warn() {} },
  }
  const factory = new Function(...Object.keys(dependencies), source.slice(source.indexOf('export function')).replace('export function', 'function') + '\nreturn useGroupReadReceipts')(...Object.values(dependencies))
  const client = scope.run(() => factory(groupId, active, visible))
  mount()
  return { client, identity, tick: () => tick(), dispose: () => { unmount(); scope.stop() }, ownKeys }
}

test('retries offline reads with the same proof and only acknowledges confirmed message IDs', async () => {
  const peer = await makeKeys()
  const readProof = await signControlProof({ from: '1002-BBBB', to: groupId, msgId: 'outgoing-msg-id', kind: 'group-read', at: 1700000000123 }, peer.privateKey)
  const submissions = []
  const api = {
    async recordGroupReads(group, records) {
      assert.equal(group, groupId)
      submissions.push(records)
      if (submissions.length === 1) throw new Error('offline')
      return { data: { msg_ids: ['incoming-msg-id', 'unsubmitted-msg-id'] } }
    },
    async groupReads() { return { data: { receipts: [
      { msg_id: 'outgoing-msg-id', chat_id: '1002-BBBB', proof: readProof },
      { msg_id: 'outgoing-msg-id', chat_id: '1003-CCCC', proof: '' },
    ] } } },
  }
  const env = await harness(api, peer)
  try {
    await waitUntil(() => submissions.length === 1)
    await env.tick()
    assert.equal(submissions.length, 2)
    assert.equal(submissions[0][0].proof, submissions[1][0].proof)
    assert.equal(await verifyControlProof({ from: env.identity.chatId, to: groupId, msgId: 'incoming-msg-id', kind: 'group-read', proof: submissions[1][0].proof }, env.ownKeys.publicKeyB64), 1700000000000)
    assert.equal(env.client.readCount('outgoing-msg-id'), 1)
    assert.equal(env.client.rows('outgoing-msg-id').length, 2)
    await env.tick()
    assert.equal(submissions.length, 2)
    env.client.openReaders({ id: 'outgoing-msg-id', mine: false })
    assert.equal(env.client.showDialog.value, false)
  } finally { env.dispose() }
})

test('lock aborts a pending request and prevents its response from reopening read details', async () => {
  const peer = await makeKeys()
  let release
  let requestSignal
  const api = {
    async recordGroupReads(group, records) { return { data: { msg_ids: records.map(record => record.msg_id) } } },
    groupReads(group, ids, signal) {
      requestSignal = signal
      return new Promise(resolve => { release = resolve })
    },
  }
  const env = await harness(api, peer)
  try {
    await waitUntil(() => !!release)
    env.client.openReaders({ id: 'outgoing-msg-id', mine: true })
    env.identity.isLocked = true
    await nextTick()
    assert.equal(requestSignal.aborted, true)
    release({ data: { receipts: [{ msg_id: 'outgoing-msg-id', chat_id: '1002-BBBB', proof: '' }] } })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(env.client.showDialog.value, false)
    assert.deepEqual(env.client.rows('outgoing-msg-id'), [])
  } finally { env.dispose() }
})

test('does not count an attacker proof using an arbitrary key in the server response', async () => {
  const peer = await makeKeys()
  const attacker = await makeKeys()
  const proof = await signControlProof({ from: '1002-BBBB', to: groupId, msgId: 'outgoing-msg-id', kind: 'group-read', at: 1700000000123 }, attacker.privateKey)
  let loaded = false
  const api = {
    async recordGroupReads(group, records) { return { data: { msg_ids: records.map(record => record.msg_id) } } },
    async groupReads() { loaded = true; return { data: { receipts: [{ msg_id: 'outgoing-msg-id', chat_id: '1002-BBBB', proof, public_key: attacker.publicKeyB64 }] } } },
  }
  const env = await harness(api, peer)
  try {
    await waitUntil(() => loaded && env.client.rows('outgoing-msg-id').length > 0)
    assert.equal(env.client.readCount('outgoing-msg-id'), 0)
    assert.equal(env.client.rows('outgoing-msg-id')[0].verified, false)
  } finally { env.dispose() }
})
