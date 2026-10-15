import test from 'node:test'
import assert from 'node:assert/strict'
import { createCallSignaling } from './call-signaling.mjs'
import { bufToB64 } from './crypto.js'

async function fixture() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicKey = bufToB64(await crypto.subtle.exportKey('spki', keys.publicKey))
  let clock = 100000
  const sender = { chatId: 'alice', isLocked: false, getFriendPubKey: () => publicKey }
  const receiver = { chatId: 'bob', isLocked: false, getFriendPubKey: () => publicKey }
  const outgoing = createCallSignaling({ identity: sender, loadKeyPair: async () => keys, now: () => clock })
  let activeCall = '11111111-1111-4111-8111-111111111111'
  const incoming = createCallSignaling({ identity: receiver, loadKeyPair: async () => keys, now: () => clock, isCurrentCall: (callId, peer) => callId === activeCall && peer === 'alice' })
  const payload = {
    to: 'bob', call_id: '11111111-1111-4111-8111-111111111111', media: 'video', video_enabled: false,
    sdp: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\na=ice-ufrag:original' },
  }
  const wire = async (type = 'call_offer', value = payload) => ({ ...await outgoing.seal(type, value), from: 'alice' })
  return { incoming, outgoing, receiver, payload, wire, advance: () => { clock += 60001 }, endCall: () => { activeCall = null } }
}

test('authenticates complete SDP fingerprints and metadata for offers and answers, including restarts', async () => {
  const env = await fixture()
  for (const type of ['call_offer', 'call_answer', 'call_restart_offer', 'call_restart_answer']) {
    const payload = { ...env.payload, sdp: { ...env.payload.sdp, type: type.endsWith('offer') ? 'offer' : 'answer' }, negotiation: 'restart-token' }
    const opened = await env.incoming.open(type, await env.wire(type, payload))
    assert.deepEqual(opened.sdp, payload.sdp)
    assert.equal(opened.negotiation, 'restart-token')
    assert.equal(opened.video_enabled, false)
  }
})

test('rejects sender, receiver, call ID, type, sequence and fingerprint substitution', async () => {
  const env = await fixture()
  const wire = await env.wire()
  for (const changed of [
    { ...wire, from: 'mallory' },
    { ...wire, call_id: 'different-call' },
    { ...wire, sdp: { ...wire.sdp, sequence: 2 } },
  ]) await assert.rejects(env.incoming.open('call_offer', changed))
  await assert.rejects(env.incoming.open('call_restart_offer', wire))
  env.receiver.chatId = 'charlie'
  await assert.rejects(env.incoming.open('call_offer', wire))
  env.receiver.chatId = 'bob'
  const parsed = JSON.parse(wire.sdp.signature)
  const content = JSON.parse(parsed.content)
  content.sdp.sdp = content.sdp.sdp.replace('AA:BB', 'CC:DD')
  parsed.content = JSON.stringify(content)
  await assert.rejects(env.incoming.open('call_offer', { ...wire, sdp: { ...wire.sdp, signature: JSON.stringify(parsed) } }), /signature/)
  const opened = await env.incoming.open('call_offer', { ...wire, media: 'audio', video_enabled: true })
  assert.equal(opened.media, 'video')
  assert.equal(opened.video_enabled, false)
})

test('rejects unsigned downgrade, replay, reordered sequences and expired invitations', async () => {
  const env = await fixture()
  await assert.rejects(env.incoming.open('call_offer', { ...env.payload, from: 'alice' }), /Unsigned/)
  const first = await env.wire()
  const second = await env.wire()
  await env.incoming.open('call_offer', second)
  await assert.rejects(env.incoming.open('call_offer', second), /Replayed/)
  await assert.rejects(env.incoming.open('call_offer', first), /Replayed/)
  const next = await env.wire('call_restart_offer', { ...env.payload, negotiation: 'restart' })
  env.advance()
  await assert.rejects(env.incoming.open('call_restart_offer', next), /context/)
})

test('authenticates ICE and rejects concurrent replay atomically after verification', async () => {
  const env = await fixture()
  const wire = await env.wire('call_ice', { to: 'bob', call_id: env.payload.call_id, ice: { candidate: 'candidate:original', sdpMid: '0' } })
  const results = await Promise.allSettled([env.incoming.open('call_ice', wire), env.incoming.open('call_ice', wire)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal(results.find(result => result.status === 'fulfilled').value.ice.candidate, 'candidate:original')
})

test('rejects unpinned attacker keys and unavailable or locked identities', async () => {
  const env = await fixture()
  const wire = await env.wire()
  const attacker = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  env.receiver.getFriendPubKey = () => bufToB64(new Uint8Array([1, 2, 3]))
  await assert.rejects(env.incoming.open('call_offer', wire))
  env.receiver.getFriendPubKey = () => null
  await assert.rejects(env.incoming.open('call_offer', wire))
  env.receiver.getFriendPubKey = () => env.payload.to
  env.receiver.isLocked = true
  await assert.rejects(env.incoming.open('call_offer', wire))
  const forged = createCallSignaling({ identity: { chatId: 'alice', getFriendPubKey: () => 'pinned' }, loadKeyPair: async () => attacker })
  const forgedWire = { ...await forged.seal('call_offer', env.payload), from: 'alice' }
  const fresh = await fixture()
  await assert.rejects(fresh.incoming.open('call_offer', forgedWire), /signature|context/)
})

test('authenticates all control messages using the relay-preserved SDP field', async () => {
  const env = await fixture()
  for (const type of ['call_hangup', 'call_reject', 'call_restart_request', 'call_media_state']) {
    const wire = await env.wire(type, { to: 'bob', call_id: env.payload.call_id, reason: 'busy', video_enabled: false })
    assert.equal(typeof wire.sdp.signature, 'string')
    await assert.rejects(env.incoming.open(type, { ...wire, sdp: undefined }), /Unsigned/)
    const opened = await env.incoming.open(type, { ...wire, reason: 'rejected', video_enabled: true })
    assert.equal(opened.reason, 'busy')
    assert.equal(opened.video_enabled, false)
    await assert.rejects(env.incoming.open(type, wire), /Replayed/)
  }
})

test('identity replacement during asynchronous verification invalidates signaling', async () => {
  const env = await fixture()
  const wire = await env.wire()
  const original = env.receiver.getFriendPubKey
  let reads = 0
  env.receiver.getFriendPubKey = () => ++reads === 1 ? original() : 'changed-key'
  await assert.rejects(env.incoming.open('call_offer', wire), /context/)
})

test('call cleanup releases only outgoing sequences and retains incoming replay protection', async () => {
  const env = await fixture()
  const first = await env.wire()
  await env.incoming.open('call_offer', first)
  assert.equal(env.incoming.release(env.payload.call_id), 0)
  await assert.rejects(env.incoming.open('call_offer', first), /Replayed/)
  const other = await env.wire('call_offer', { ...env.payload, call_id: 'other-call' })
  assert.equal(other.sdp.sequence, 1)
  await env.wire('call_ice', { to: 'bob', call_id: env.payload.call_id, ice: { candidate: 'candidate' } })
  assert.equal(env.outgoing.release(env.payload.call_id), 2)
  assert.equal(env.outgoing.release(env.payload.call_id), 0)
  const next = await env.wire('call_offer', { ...env.payload, call_id: 'other-call' })
  assert.equal(next.sdp.sequence, 2)
  assert.equal(env.outgoing.release('other-call'), 1)
})

test('repeated completed calls do not retain outgoing sequence entries', async () => {
  const env = await fixture()
  for (let index = 0; index < 200; index++) {
    const callId = `finished-call-${index}`
    await env.wire('call_hangup', { to: 'bob', call_id: callId })
    assert.equal(env.outgoing.release(callId), 1)
    assert.equal(env.outgoing.release(callId), 0)
  }
})

test('prepared hangup remains valid for the active call after ordinary signaling expires', async () => {
  const env = await fixture()
  const wire = await env.wire('call_hangup', { to: 'bob', call_id: env.payload.call_id, prepared: true })
  env.advance()
  const opened = await env.incoming.open('call_hangup', wire)
  assert.equal(opened.call_id, env.payload.call_id)
  await assert.rejects(env.incoming.open('call_hangup', wire), /Replayed/)
  await assert.rejects(env.incoming.open('call_reject', wire))
  await assert.rejects(env.incoming.open('call_hangup', { ...wire, call_id: 'different-call' }))
})

test('prepared hangup never authorizes a stale call or another signal type', async () => {
  const env = await fixture()
  const wire = await env.wire('call_hangup', { to: 'bob', call_id: env.payload.call_id, prepared: true })
  env.endCall()
  await assert.rejects(env.incoming.open('call_hangup', wire), /context/)
  const invalid = await env.wire('call_media_state', { to: 'bob', call_id: env.payload.call_id, prepared: true })
  await assert.rejects(env.incoming.open('call_media_state', invalid), /context/)
})
