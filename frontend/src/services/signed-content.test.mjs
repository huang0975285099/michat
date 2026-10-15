import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bufToB64 } from './crypto.js'
import { openSignedContent, sealSignedContent, safetyNumber } from './signed-content.mjs'

async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return { privateKey: keys.privateKey, publicKey: bufToB64(await crypto.subtle.exportKey('spki', keys.publicKey)) }
}

const context = ['yunmi.message.v2', '1001-AAAA', '1002-BBBB', 'abc-def-ghi', 'message', false]

test('authenticates the sender and preserves signed text and reply content', async () => {
  const sender = await identity()
  const content = JSON.stringify({ text: '秘密', reply: { messageId: 'old-msg-id' } })
  const signed = await sealSignedContent(content, context, sender.privateKey)
  assert.equal(await openSignedContent(signed, context, sender.publicKey), content)
})

test('rejects an attacker signature even when the attacker can encrypt to the recipient', async () => {
  const sender = await identity()
  const attacker = await identity()
  const forged = await sealSignedContent('forged', context, attacker.privateKey)
  await assert.rejects(openSignedContent(forged, context, sender.publicKey), /signature/)
})

test('rejects content, sender, recipient, message ID, kind and burn flag substitutions', async () => {
  const sender = await identity()
  const signed = await sealSignedContent('original', context, sender.privateKey)
  const changed = JSON.parse(signed)
  changed.content = 'tampered'
  await assert.rejects(openSignedContent(JSON.stringify(changed), context, sender.publicKey), /signature/)
  for (const index of [1, 2, 3, 4, 5]) {
    const swapped = [...context]
    swapped[index] = index === 5 ? true : 'different'
    await assert.rejects(openSignedContent(signed, swapped, sender.publicKey), /context/)
  }
})

test('rejects unsigned legacy content instead of silently downgrading authentication', async () => {
  const sender = await identity()
  await assert.rejects(openSignedContent(JSON.stringify({ text: 'unsigned' }), context, sender.publicKey), /unsigned/)
})

test('both participants see the same safety number and a substituted key changes it', async () => {
  const first = await identity()
  const second = await identity()
  const attacker = await identity()
  const expected = await safetyNumber('first', first.publicKey, 'second', second.publicKey)
  assert.equal(await safetyNumber('second', second.publicKey, 'first', first.publicKey), expected)
  assert.notEqual(await safetyNumber('first', first.publicKey, 'second', attacker.publicKey), expected)
})
