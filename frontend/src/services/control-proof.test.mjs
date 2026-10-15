import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufToB64 } from './crypto.js'
import { signControlProof, verifyControlProof } from './control-proof.mjs'

async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return { privateKey: keys.privateKey, publicKey: bufToB64(await crypto.subtle.exportKey('spki', keys.publicKey)) }
}

const original = { from: '1111-AAAA', to: '2222-BBBB', msgId: 'abc-def-ghi', kind: 'read', at: 1234567890 }

test('group read proofs bind the reader, group, message and purpose', async () => {
  const reader = await identity()
  const read = { ...original, to: 'G-123456ABCDEF', kind: 'group-read' }
  const proof = await signControlProof(read, reader.privateKey)
  assert.equal(await verifyControlProof({ ...read, proof }, reader.publicKey), read.at)
  for (const changed of [
    { from: '3333-CCCC' }, { to: 'G-ABCDEF123456' }, { msgId: 'other-message-id' }, { kind: 'read' },
  ]) {
    await assert.rejects(verifyControlProof({ ...read, ...changed, proof }, reader.publicKey))
  }
  const impostor = await identity()
  await assert.rejects(verifyControlProof({ ...read, proof }, impostor.publicKey))
})

test('uses the authenticated read timestamp and binds every control field', async () => {
  const sender = await identity()
  const proof = await signControlProof(original, sender.privateKey)
  assert.equal(await verifyControlProof({ ...original, proof, read_at: 1 }, sender.publicKey), original.at)
  for (const field of ['from', 'to', 'msgId', 'kind']) {
    const changed = { ...original, proof, [field]: field === 'kind' ? 'recall' : 'changed' }
    await assert.rejects(verifyControlProof(changed, sender.publicKey))
  }
})

test('rejects unsigned and attacker-signed recalls before deletion', async () => {
  const sender = await identity()
  const attacker = await identity()
  const recall = { ...original, kind: 'recall' }
  await assert.rejects(verifyControlProof(recall, sender.publicKey), /Unsigned/)
  const proof = await signControlProof(recall, attacker.privateKey)
  await assert.rejects(verifyControlProof({ ...recall, proof }, sender.publicKey), /signature/)
})

test('group recall proofs cannot be reused in another group or as a direct recall', async () => {
  const sender = await identity()
  const recall = { ...original, kind: 'group-recall', to: 'G-123456ABCDEF' }
  const proof = await signControlProof(recall, sender.privateKey)
  assert.equal(await verifyControlProof({ ...recall, proof }, sender.publicKey), recall.at)
  await assert.rejects(verifyControlProof({ ...recall, proof, to: 'G-ABCDEF123456' }, sender.publicKey))
  await assert.rejects(verifyControlProof({ ...recall, proof, kind: 'recall' }, sender.publicKey))
})
