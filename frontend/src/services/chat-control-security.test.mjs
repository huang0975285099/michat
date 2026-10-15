import test from 'node:test'
import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { signControlProof, verifyControlProof } from './control-proof.mjs'

const source = await readFile(new URL('../stores/chat.js', import.meta.url), 'utf8')
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const publicKey = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64')
const from = '1234-ABCD'
const to = '5678-EFGH'
const msgId = 'abc-def-123'

test('outgoing controls report unavailable private keys without attempting to sign', async () => {
  const start = source.indexOf('  async function outgoingControl(')
  const end = source.indexOf('\n  async function incomingControl(', start)
  for (const record of [null, {}, { privateKey: null }]) {
    let signed = false
    const dependencies = {
      useIdentityStore: () => ({ chatId: from, isLocked: false }),
      localKeyGeneration: 0,
      loadKeyPair: async () => record,
      assertTransferActive() {},
      signControlProof: async () => { signed = true },
    }
    const outgoing = new Function(...Object.keys(dependencies), `${source.slice(start, end)}; return outgoingControl`)(...Object.values(dependencies))
    await assert.rejects(outgoing(to, msgId, 'read', 123), /Private key is unavailable/)
    assert.equal(signed, false)
  }
})

test('read verification accepts pinned historical keys and refreshed current keys but rejects forged receipts', async () => {
  const freshKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const freshPublicKey = Buffer.from(await crypto.subtle.exportKey('spki', freshKeys.publicKey)).toString('base64')
  const attacker = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const context = { from, to, msgId, kind: 'read', at: 123 }
  const oldProof = await signControlProof(context, keys.privateKey)
  const freshProof = await signControlProof(context, freshKeys.privateKey)
  const forgedProof = await signControlProof(context, attacker.privateKey)
  const compile = (cachedKey, pinnedKey) => {
    let currentKey = cachedKey
    const identity = {
      chatId: to, isLocked: false,
      getFriendPubKey: () => currentKey,
      cacheFriendPubKey: async (_, key) => key,
      loadFriendPubKeys: async () => { currentKey = freshPublicKey },
    }
    const dependencies = {
      useIdentityStore: () => identity,
      localKeyGeneration: 0,
      getPinnedPeerPublicKey: async () => pinnedKey,
      verifyControlProof,
      assertTransferActive() {},
    }
    const start = source.indexOf('  async function incomingControl(')
    const end = source.indexOf('\n  function ensureThread(', start)
    return new Function(...Object.keys(dependencies), `${source.slice(start, end)}; return incomingControl`)(...Object.values(dependencies))
  }
  assert.equal(await compile(freshPublicKey, publicKey)(from, to, msgId, 'read', oldProof), 123)
  assert.equal(await compile(publicKey, publicKey)(from, to, msgId, 'read', freshProof), 123)
  await assert.rejects(compile(freshPublicKey, publicKey)(from, to, msgId, 'read', forgedProof), /signature/)
  await assert.rejects(compile(freshPublicKey, publicKey)(from, to, 'another-message-id', 'read', oldProof))
})

function recallHandler(group, stored) {
  const deleted = []
  const remembered = []
  const chatId = group ? 'group-one' : from
  const messages = { value: { [chatId]: stored ? [{ ...stored }] : [] } }
  const start = source.indexOf(`    async function ${group ? 'onGroupRecall' : 'onRecall'}(payload)`)
  const end = source.indexOf(`\n    async function ${group ? 'onGroupDelete' : 'onAck'}`, start)
  assert.ok(start >= 0 && end > start)
  const dependencies = {
    deferControl: () => false,
    validateChatId: value => /^\d{4}-[A-Z]{4}$/.test(value),
    validateMsgId: value => /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(value),
    useIdentityStore: () => ({ chatId: to }),
    incomingControl: (sender, recipient, id, kind, proof) => verifyControlProof({ from: sender, to: recipient, msgId: id, kind, proof }, publicKey),
    messages,
    findLocalMessage: () => stored,
    dbGetMessage: async () => stored,
    dbGetPending: async () => null,
    dbDeleteMessage: async id => deleted.push(id),
    dbDeletePending: async () => {},
    deleteFileArtifacts: async () => {},
    rememberRecall: value => remembered.push(value),
    confirmIncoming: () => {},
    send: () => {},
    console: { warn() {} },
  }
  const handler = new Function(...Object.keys(dependencies), `${source.slice(start, end)}; return ${group ? 'onGroupRecall' : 'onRecall'}`)(...Object.values(dependencies))
  return { handler, deleted, remembered, messages }
}

test('actual direct recall handler rejects unsigned and cross-thread deletions', async () => {
  const stored = { id: msgId, chatId: from, from, mine: false }
  const state = recallHandler(false, stored)
  await state.handler({ from, msg_id: msgId })
  assert.deepEqual(state.deleted, [])
  assert.equal(state.messages.value[from].length, 1)
  const proof = await signControlProof({ from, to, msgId, kind: 'recall', at: 123 }, keys.privateKey)
  const otherThread = recallHandler(false, { ...stored, chatId: '9999-IJKL' })
  await otherThread.handler({ from, msg_id: msgId, proof })
  assert.deepEqual(otherThread.deleted, [])
  await state.handler({ from, msg_id: msgId, proof })
  assert.deepEqual(state.deleted, [msgId])
  assert.deepEqual(state.remembered, [`${from}:${msgId}`])
})

test('actual group recall handler requires the author signature and matching stored author', async () => {
  const stored = { id: msgId, chatId: 'group-one', from, mine: false }
  const proof = await signControlProof({ from, to: 'group-one', msgId, kind: 'group-recall', at: 123 }, keys.privateKey)
  const state = recallHandler(true, stored)
  await state.handler({ from, group_id: 'group-two', msg_id: msgId, proof })
  assert.deepEqual(state.deleted, [])
  const otherAuthor = recallHandler(true, { ...stored, from: '9999-IJKL' })
  await otherAuthor.handler({ from, group_id: 'group-one', msg_id: msgId, proof })
  assert.deepEqual(otherAuthor.deleted, [])
  await state.handler({ from, group_id: 'group-one', msg_id: msgId, proof })
  assert.deepEqual(state.deleted, [msgId])
})

test('actual read acknowledgment handler ignores unsigned timestamps and uses its own signed proof', async () => {
  const corrections = []
  const confirmed = []
  const marked = []
  let failPersistence = false
  const message = { id: msgId, chatId: from, from, mine: false, burnAfterRead: true }
  const dependencies = {
    deferControl: () => false,
    validateChatId: value => /^\d{4}-[A-Z]{4}$/.test(value),
    validateMsgId: value => /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/.test(value),
    useIdentityStore: () => ({ chatId: to, isLocked: false }),
    messages: { value: { [from]: [message] } },
    confirmPendingReads: (...args) => confirmed.push(args),
    dbMarkReceiptSent: async id => {
      if (failPersistence) throw new Error('Storage unavailable')
      marked.push(id)
    },
    dbCorrectBurnCountdown: async (...args) => corrections.push(args),
    dbGetMessage: async () => message,
    loadKeyPair: async () => ({ pubKeyB64: publicKey }),
    verifyControlProof,
    localKeyGeneration: 0,
    assertTransferActive() {},
    BURN_AFTER_READ_DELAY: 1000,
    console: { warn() {} },
  }
  const start = source.indexOf('    async function onReadAck(payload)')
  const end = source.indexOf('\n    function failIncomingTransfer', start)
  assert.ok(start >= 0 && end > start)
  const handler = new Function(...Object.keys(dependencies), `${source.slice(start, end)}; return onReadAck`)(...Object.values(dependencies))
  const payload = { to: from, msg_id: [msgId], receipts: [{ msg_id: msgId, read_at: 999999 }] }
  await handler(payload)
  assert.deepEqual(corrections, [])
  assert.equal(message.readReceivedAt, undefined)
  assert.equal(message.receiptSent, undefined)
  assert.deepEqual(confirmed, [])
  assert.deepEqual(marked, [])
  await handler({ to: from, msg_id: [msgId] })
  assert.deepEqual(confirmed, [])
  payload.receipts[0].proof = await signControlProof({ from: to, to: '9999-IJKL', msgId, kind: 'read', at: 123 }, keys.privateKey)
  await handler(payload)
  assert.deepEqual(confirmed, [])
  assert.deepEqual(marked, [])
  payload.receipts[0].proof = await signControlProof({ from: to, to: from, msgId, kind: 'read', at: 123 }, keys.privateKey)
  payload.msg_id.push('another-message-id')
  payload.receipts.push({ msg_id: 'another-message-id', proof: 'invalid' })
  payload.receipts.push({ ...payload.receipts[0] })
  failPersistence = true
  await handler(payload)
  assert.deepEqual(confirmed, [])
  assert.deepEqual(marked, [])
  assert.equal(message.receiptSent, undefined)
  failPersistence = false
  await handler(payload)
  assert.deepEqual(corrections, [[msgId, 123, 1123]])
  assert.equal(message.readReceivedAt, 123)
  assert.equal(message.receiptSent, true)
  assert.deepEqual(confirmed, [[from, [msgId]]])
  assert.deepEqual(marked, [msgId])
})

test('actual automatic file cleanup refuses unauthenticated delivery notifications', async () => {
  const deleted = []
  const start = source.indexOf('  async function maybeAutoCleanReceivedAttachment(msg)')
  const end = source.indexOf('\n  function stopAttachmentStatusWatch', start)
  const handler = new Function('loadAttachmentAutoClean', 'useIdentityStore', 'deleteFileArtifacts', `${source.slice(start, end)}; return maybeAutoCleanReceivedAttachment`)(() => true, () => ({ chatId: to }), async message => deleted.push(message.id))
  assert.equal(await handler({ id: msgId, mine: true, attachmentStatus: 'received', read: true }), false)
  assert.deepEqual(deleted, [])
  assert.equal(await handler({ id: msgId, mine: true, authenticatedRead: true }), true)
  assert.deepEqual(deleted, [msgId])
})
