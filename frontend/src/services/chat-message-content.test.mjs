import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_REPLY_PREVIEW_LENGTH,
  normalizeReplyReference,
  parseChatMessageContent,
  parseReplyReference,
  serializeChatMessageContent,
  serializeReplyReference,
} from './chat-message-content.mjs'

const reply = {
  messageId: 'abc-def-123',
  senderId: '1234-ABCD',
  kind: 'text',
  preview: ' original\nmessage ',
}

test('legacy plaintext remains unchanged and readable', () => {
  assert.equal(serializeChatMessageContent('hello'), 'hello')
  assert.deepEqual(parseChatMessageContent('hello'), { text: 'hello', reply: null })
})

test('reply metadata round-trips inside the versioned encrypted content', () => {
  const encoded = serializeChatMessageContent('answer', reply)
  assert.deepEqual(parseChatMessageContent(encoded), {
    text: 'answer',
    reply: { ...reply, preview: 'original message' },
  })
})

test('user-authored JSON is not mistaken for a reply envelope', () => {
  const text = JSON.stringify({ text: 'hello', reply })
  assert.deepEqual(parseChatMessageContent(text), { text, reply: null })
})

test('invalid references are removed and previews are bounded', () => {
  assert.equal(normalizeReplyReference({ ...reply, senderId: 'bad' }), null)
  const normalized = normalizeReplyReference({ ...reply, preview: 'x'.repeat(500) })
  assert.equal(normalized.preview.length, MAX_REPLY_PREVIEW_LENGTH)
})

test('burn-after-read references never retain the original plaintext preview', () => {
  assert.deepEqual(normalizeReplyReference({ ...reply, kind: 'burn' }), {
    messageId: reply.messageId,
    senderId: reply.senderId,
    kind: 'burn',
    preview: '',
  })
})

test('independent reply metadata can be encrypted without changing legacy message text', () => {
  const encoded = serializeReplyReference(reply)
  assert.deepEqual(parseReplyReference(encoded), {
    ...reply,
    preview: 'original message',
  })
  assert.equal(parseReplyReference('{"senderId":"bad"}'), null)
})
