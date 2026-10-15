import { openSignedContent, sealSignedContent } from './signed-content.mjs'

const CONTROL_KINDS = new Set(['read', 'recall', 'group-recall', 'group-read'])

function context(from, to, msgId, kind) {
  if (!CONTROL_KINDS.has(kind) || !from || !to || !msgId) throw new Error('Invalid control context')
  return ['yunmi.control.v2', from, to, msgId, kind, false]
}

export async function signControlProof({ from, to, msgId, kind, at }, privateKey) {
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Invalid control timestamp')
  return sealSignedContent(JSON.stringify({ at }), context(from, to, msgId, kind), privateKey)
}

export async function verifyControlProof({ from, to, msgId, kind, proof }, publicKey) {
  if (typeof proof !== 'string' || !proof) throw new Error('Unsigned control event')
  const parsed = JSON.parse(await openSignedContent(proof, context(from, to, msgId, kind), publicKey))
  if (!Number.isSafeInteger(parsed.at) || parsed.at <= 0) throw new Error('Invalid signed control timestamp')
  return parsed.at
}
