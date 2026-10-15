import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalPublicKey, rosterContent, approvalContent, fingerprint, signApproval, verifyApproval, approvalStorageKey, createMembershipGate } from './group-membership.mjs'

async function identity(chatId) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))))
  return { chat_id: chatId, public_key: await canonicalPublicKey(publicKey), state: 'active', privateKey: keys.privateKey }
}

test('signed local approval survives serialization but rejects tampering and other accounts/groups', async () => {
  const own = await identity('alice')
  const peer = await identity('bob')
  const roster = rosterContent('group', [own, peer])
  const content = approvalContent('alice', own.public_key, roster)
  const record = JSON.parse(JSON.stringify(await signApproval(content, own.privateKey)))
  assert.equal(await verifyApproval(record, content, own.public_key), true)
  assert.equal(await verifyApproval({ ...record, signature: btoa('tampered') }, content, own.public_key), false)
  const otherContent = approvalContent('bob', peer.public_key, roster)
  assert.equal(await verifyApproval(record, otherContent, peer.public_key), false)
  assert.notEqual(approvalStorageKey('alice', 'group', roster), approvalStorageKey('bob', 'group', roster))
  assert.equal(await verifyApproval(record, approvalContent('alice', own.public_key, rosterContent('other', [own, peer])), own.public_key), false)
})

test('exact complete active roster: reorder stable, injection/removal/key change rejected', async () => {
  const own = await identity('alice')
  const peer = await identity('bob')
  const injected = await identity('mallory')
  const replacement = await identity('bob')
  const roster = rosterContent('group', [own, peer])
  const content = approvalContent('alice', own.public_key, roster)
  const record = await signApproval(content, own.privateKey)
  assert.equal(rosterContent('group', [peer, own]), roster)
  assert.equal(await fingerprint(rosterContent('group', [peer, own])), await fingerprint(roster))
  for (const members of [[own, peer, injected], [own], [own, replacement]]) {
    assert.equal(await verifyApproval(record, approvalContent('alice', own.public_key, rosterContent('group', members)), own.public_key), false)
  }
  assert.throws(() => approvalContent('alice', replacement.public_key, roster))
  assert.throws(() => rosterContent('group', [own, own]))
  assert.throws(() => rosterContent('group', [{ ...own, public_key: '' }]))
})

test('refresh, failure, overlapping fetches and approval races fail closed', () => {
  const gate = createMembershipGate()
  const first = gate.invalidate()
  assert.equal(gate.publish(first, 'approved A', true), true)
  assert.equal(gate.trusted, true)
  const pending = gate.invalidate()
  assert.equal(gate.trusted, false)
  assert.equal(gate.content, null)
  const newest = gate.invalidate()
  assert.equal(gate.publish(pending, 'approved A', true), false)
  assert.equal(gate.publish(newest, 'unapproved B', false), true)
  assert.throws(() => gate.trust(first, 'approved A'))
  assert.throws(() => gate.trust(newest, 'approved A'))
  gate.trust(newest, 'unapproved B')
  assert.equal(gate.trusted, true)
  gate.invalidate()
  assert.equal(gate.trusted, false)
})

test('rollback to an unapproved snapshot never inherits approval; exact approved snapshot may be remembered', async () => {
  const own = await identity('alice')
  const peer = await identity('bob')
  const first = rosterContent('group', [own])
  const second = rosterContent('group', [own, peer])
  const record = await signApproval(approvalContent('alice', own.public_key, second), own.privateKey)
  const gate = createMembershipGate()
  let token = gate.invalidate()
  gate.publish(token, second, await verifyApproval(record, approvalContent('alice', own.public_key, second), own.public_key))
  assert.equal(gate.trusted, true)
  token = gate.invalidate()
  gate.publish(token, first, await verifyApproval(record, approvalContent('alice', own.public_key, first), own.public_key))
  assert.equal(gate.trusted, false)
  token = gate.invalidate()
  gate.publish(token, second, await verifyApproval(record, approvalContent('alice', own.public_key, second), own.public_key))
  assert.equal(gate.trusted, true)
})
