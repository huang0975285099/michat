const encode = value => new TextEncoder().encode(value)
const toBase64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)))
const fromBase64 = value => Uint8Array.from(atob(value), character => character.charCodeAt(0))

export async function canonicalPublicKey(value) {
  const key = await crypto.subtle.importKey('spki', fromBase64(value), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  return toBase64(await crypto.subtle.exportKey('spki', key))
}

export function rosterContent(groupId, members) {
  if (!groupId || !Array.isArray(members)) throw new Error('Invalid group roster')
  const active = members.filter(member => member.state === 'active').map(member => {
    if (typeof member.chat_id !== 'string' || !member.chat_id || typeof member.public_key !== 'string' || !member.public_key) throw new Error('Incomplete group identity')
    return [member.chat_id, member.public_key]
  }).sort((first, second) => first[0] < second[0] ? -1 : first[0] > second[0] ? 1 : 0)
  if (!active.length || new Set(active.map(member => member[0])).size !== active.length) throw new Error('Invalid active roster')
  return JSON.stringify(['yunmi.group-roster.v1', groupId, active])
}

export function approvalContent(accountId, ownKey, roster) {
  const parsed = JSON.parse(roster)
  if (!accountId || !parsed[2].some(member => member[0] === accountId && member[1] === ownKey)) throw new Error('Own identity is not in roster')
  return JSON.stringify(['yunmi.local-group-approval.v2', accountId, ownKey, roster])
}

export async function fingerprint(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encode(value)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g).join(' ')
}

export async function signApproval(content, privateKey) {
  const raw = await crypto.subtle.exportKey('pkcs8', privateKey)
  const key = await crypto.subtle.importKey('pkcs8', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return { content, signature: toBase64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encode(content))) }
}

export async function verifyApproval(record, content, ownKey) {
  try {
    if (record?.content !== content) return false
    const key = await crypto.subtle.importKey('spki', fromBase64(ownKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64(record.signature), encode(content))
  } catch { return false }
}

export function approvalStorageKey(accountId, groupId) {
  return JSON.stringify(['yunmi.group-approval.v2', accountId, groupId])
}

export function createMembershipGate() {
  let revision = 0
  let current = null
  let trusted = false
  return {
    invalidate() { revision += 1; current = null; trusted = false; return revision },
    publish(token, content, approved) {
      if (token !== revision) return false
      current = content
      trusted = approved === true
      return true
    },
    matches(token, content) { return token === revision && current === content },
    trust(token, content) {
      if (token !== revision || current !== content) throw new Error('Group roster changed during approval')
      trusted = true
    },
    get revision() { return revision },
    get content() { return current },
    get trusted() { return trusted },
  }
}
