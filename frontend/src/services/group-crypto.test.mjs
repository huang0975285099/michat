import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptGroupMessageContent, decryptGroupMessageContent, wrapContentKey, unwrapContentKey, generateContentKey } from './group-crypto.mjs'

function bufToB64(buf) {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

async function generateMemberKeyPair() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  )
  const pubBuf = await crypto.subtle.exportKey('spki', kp.publicKey)
  const pubB64 = bufToB64(pubBuf)
  return { privateKey: kp.privateKey, public_key: pubB64, chat_id: '' }
}

test('encrypt and decrypt group message for all members', async () => {
  const members = []
  for (let i = 0; i < 3; i++) {
    const m = await generateMemberKeyPair()
    m.chat_id = `100${i + 1}-AAA${String.fromCharCode(65 + i)}`
    members.push(m)
  }

  const msgId = 'abc123-test-def456'
  const plaintext = '群聊秘密 — end-to-end encrypted'
  const envelope = await encryptGroupMessageContent(plaintext, members, msgId)

  assert.equal(envelope.key_envelopes.length, 3)
  assert.ok(!JSON.stringify(envelope).includes('群聊秘密'))
  assert.ok(!JSON.stringify(envelope).includes(plaintext))

  for (const member of members) {
    const memberEnvelope = envelope.key_envelopes.find((e) => e.to === member.chat_id)
    assert.ok(memberEnvelope, `envelope for ${member.chat_id} not found`)
    assert.equal(memberEnvelope.to, member.chat_id)

    const text = await decryptGroupMessageContent(
      { iv: envelope.iv, ciphertext: envelope.ciphertext, key_envelope: memberEnvelope },
      member.privateKey,
      msgId,
    )
    assert.equal(text, plaintext)
  }
})

test('fourth member cannot decrypt any envelope', async () => {
  const members = []
  for (let i = 0; i < 3; i++) {
    const m = await generateMemberKeyPair()
    m.chat_id = `200${i + 1}-BBB${String.fromCharCode(65 + i)}`
    members.push(m)
  }
  const outsider = await generateMemberKeyPair()
  outsider.chat_id = '2999-ZZZZ'

  const msgId = 'xyz789-test-abc123'
  const envelope = await encryptGroupMessageContent('secret', members, msgId)

  // outsider tries every envelope
  for (const env of envelope.key_envelopes) {
    await assert.rejects(
      decryptGroupMessageContent(
        { iv: envelope.iv, ciphertext: envelope.ciphertext, key_envelope: env },
        outsider.privateKey,
        msgId,
      ),
    )
  }
})

test('tampering ciphertext byte rejects authentication', async () => {
  const members = [await generateMemberKeyPair()]
  members[0].chat_id = '3001-CCCC'

  const msgId = 'tamper1-test-abc123'
  const envelope = await encryptGroupMessageContent('original', members, msgId)

  // flip a byte in ciphertext
  const ctBytes = atob(envelope.ciphertext)
  const tampered = String.fromCharCode(ctBytes.charCodeAt(0) ^ 1) + ctBytes.slice(1)

  await assert.rejects(
    decryptGroupMessageContent(
      { iv: envelope.iv, ciphertext: btoa(tampered), key_envelope: envelope.key_envelopes[0] },
      members[0].privateKey,
      msgId,
    ),
  )
})

test('swapped envelope from another message fails validation', async () => {
  const members = [await generateMemberKeyPair()]
  members[0].chat_id = '4001-DDDD'

  const msgId1 = 'msg001-test-abc123'
  const msgId2 = 'msg002-test-def456'

  const env1 = await encryptGroupMessageContent('message one', members, msgId1)
  const env2 = await encryptGroupMessageContent('message two', members, msgId2)

  // try to use envelope from msg2 to decrypt msg1
  await assert.rejects(
    decryptGroupMessageContent(
      { iv: env1.iv, ciphertext: env1.ciphertext, key_envelope: env2.key_envelopes[0] },
      members[0].privateKey,
      msgId1, // expectedMsgId is msgId1, but envelope is from msgId2
    ),
  )
})

test('missing members throws', async () => {
  await assert.rejects(encryptGroupMessageContent('text', [], 'msg-id'), /at least one member/)
})

test('missing msgId throws', async () => {
  const m = await generateMemberKeyPair()
  m.chat_id = '5001-EEEE'
  await assert.rejects(encryptGroupMessageContent('text', [m], ''), /msg_id is required/)
})

test('generateContentKey produces 32-byte keys', () => {
  const key = generateContentKey()
  const raw = atob(key)
  assert.equal(raw.length, 32)
  const key2 = generateContentKey()
  assert.notEqual(key, key2)
})

test('wrapContentKey and unwrapContentKey round-trip', async () => {
  const member = await generateMemberKeyPair()
  const contentKey = generateContentKey()
  const msgId = 'wrap001-test-abc123'

  const env = await wrapContentKey(contentKey, member.public_key, msgId)
  const unwrapped = await unwrapContentKey(env, member.privateKey, msgId)
  assert.equal(unwrapped, contentKey)
})

test('unwrapContentKey with wrong msgId fails', async () => {
  const member = await generateMemberKeyPair()
  const contentKey = generateContentKey()
  const env = await wrapContentKey(contentKey, member.public_key, 'msg-a')
  await assert.rejects(unwrapContentKey(env, member.privateKey, 'msg-b'))
})
