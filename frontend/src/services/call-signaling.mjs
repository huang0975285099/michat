import { sealSignedContent, openSignedContent } from './signed-content.mjs'

const DOMAIN = 'yunmi.call.v2'
const MAX_AGE = 60000
const SDP_TYPES = new Set(['call_offer', 'call_answer', 'call_restart_offer', 'call_restart_answer'])

export function createCallSignaling({ identity, loadKeyPair, now = Date.now, isCurrentCall = () => false }) {
  const sent = new Map()
  const received = new Map()

  async function seal(type, payload) {
    const sender = identity.chatId
    if (!sender || identity.isLocked || !identity.getFriendPubKey(payload.to)) throw new Error('Call identity unavailable')
    const slot = JSON.stringify([sender, payload.to, payload.call_id, type])
    if (!sent.has(slot) && sent.size >= 10000) throw new Error('Call sending cache full')
    const sequence = (sent.get(slot) || 0) + 1
    sent.set(slot, sequence)
    const keys = await loadKeyPair()
    if (!keys?.privateKey || identity.chatId !== sender || identity.isLocked) throw new Error('Call identity unavailable')
    const context = [DOMAIN, sender, payload.to, payload.call_id, type, sequence]
    const content = JSON.stringify({ ...payload, issued: now() })
    const signature = await sealSignedContent(content, context, keys.privateKey)
    const field = type === 'call_ice' ? 'ice' : 'sdp'
    return { ...payload, [field]: { sequence, signature } }
  }

  async function open(type, payload) {
    const receiver = identity.chatId
    const publicKey = identity.getFriendPubKey(payload?.from)
    const field = type === 'call_ice' ? 'ice' : 'sdp'
    const envelope = payload?.[field]
    if (!receiver || identity.isLocked || !publicKey || !Number.isSafeInteger(envelope?.sequence) || envelope.sequence < 1) throw new Error('Unsigned call signaling')
    const context = [DOMAIN, payload.from, receiver, payload.call_id, type, envelope.sequence]
    const content = JSON.parse(await openSignedContent(envelope.signature, context, publicKey))
    const preparedHangup = type === 'call_hangup' && content.prepared === true && isCurrentCall(payload.call_id, payload.from)
    const age = now() - content.issued
    if (identity.chatId !== receiver || identity.isLocked || identity.getFriendPubKey(payload.from) !== publicKey ||
        content.to !== receiver || content.call_id !== payload.call_id ||
        !Number.isFinite(content.issued) || age < -MAX_AGE ||
        (content.prepared === true && !preparedHangup) || (!preparedHangup && age > MAX_AGE)) throw new Error('Invalid call signaling context')
    if (SDP_TYPES.has(type)) {
      const expected = type.endsWith('offer') ? 'offer' : 'answer'
      if (content.sdp?.type !== expected || typeof content.sdp.sdp !== 'string') throw new Error('Invalid signed SDP')
    }
    if ((type === 'call_restart_offer' || type === 'call_restart_answer') &&
        (typeof content.negotiation !== 'string' || !content.negotiation)) throw new Error('Invalid restart binding')
    const slot = JSON.stringify([receiver, payload.from, payload.call_id, type])
    const time = now()
    for (const [key, entry] of received) {
      if (time - entry.accepted > MAX_AGE * 2) received.delete(key)
    }
    const previous = received.get(slot)?.sequence || 0
    if (envelope.sequence <= previous) throw new Error('Replayed call signaling')
    if (!received.has(slot) && received.size >= 10000) throw new Error('Call replay cache full')
    received.set(slot, { sequence: envelope.sequence, accepted: time })
    return { ...content, from: payload.from }
  }

  function release(callId) {
    let removed = 0
    for (const slot of sent.keys()) {
      if (JSON.parse(slot)[2] !== callId) continue
      sent.delete(slot)
      removed++
    }
    return removed
  }

  return { seal, open, release }
}
