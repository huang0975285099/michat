import { b64ToBuf, bufToB64 } from './crypto.js'

function canonicalContent(content, context) {
  if (typeof content !== 'string' || !Array.isArray(context) || context.length !== 6) throw new Error('Invalid authenticated message')
  return new TextEncoder().encode(JSON.stringify({ context, content }))
}

export async function sealSignedContent(content, context, privateKey) {
  const rawKey = await crypto.subtle.exportKey('pkcs8', privateKey)
  const signingKey = await crypto.subtle.importKey('pkcs8', rawKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, canonicalContent(content, context))
  return JSON.stringify({ marker: 'yunmi.signed-content', version: 2, context, content, signature: bufToB64(signature) })
}

export async function openSignedContent(value, context, publicKeyB64) {
  const parsed = JSON.parse(value)
  if (parsed?.marker !== 'yunmi.signed-content' || parsed.version !== 2 || JSON.stringify(parsed.context) !== JSON.stringify(context)) {
    throw new Error('Message is unsigned or has an invalid context')
  }
  const publicKey = await crypto.subtle.importKey('spki', b64ToBuf(publicKeyB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64ToBuf(parsed.signature), canonicalContent(parsed.content, context))
  if (!valid) throw new Error('Message sender signature is invalid')
  return parsed.content
}

export async function openSignedGroupContent(value, context, publicKeyB64) {
  const parsed = JSON.parse(value)
  const signedContext = parsed?.context
  if (parsed?.marker !== 'yunmi.signed-content' || parsed.version !== 2 || !Array.isArray(signedContext) || signedContext.length !== 6 ||
      signedContext[0] !== context[0] || signedContext[1] !== context[1] || signedContext[2] !== context[2] ||
      signedContext[3] !== context[3] || signedContext[5] !== context[5] ||
      typeof signedContext[4] !== 'string' || !signedContext[4].startsWith('group:')) {
    throw new Error('Message has an invalid group authentication context')
  }
  const publicKey = await crypto.subtle.importKey('spki', b64ToBuf(publicKeyB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64ToBuf(parsed.signature), canonicalContent(parsed.content, signedContext))
  if (!valid) throw new Error('Message sender signature is invalid')
  return parsed.content
}

export async function safetyNumber(firstId, firstKey, secondId, secondKey) {
  const identities = [[firstId, firstKey], [secondId, secondKey]].sort((first, second) => first[0].localeCompare(second[0], 'en'))
  const encoded = new TextEncoder().encode(JSON.stringify(['yunmi.safety-number.v2', ...identities]))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g).join(' ')
}
