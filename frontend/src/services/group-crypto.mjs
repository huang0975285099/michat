import { bufToB64, b64ToBuf, encryptMessage, decryptMessageWithPrivateKey } from './crypto.js'

const GROUP_TEXT_MARKER = 'yunmi.group.text'
const GROUP_KEY_MARKER = 'yunmi.group.key'
const GROUP_VERSION = 1

/**
 * Generate a random 256-bit AES-GCM content key as raw bytes (Base64).
 */
export function generateContentKey() {
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  return bufToB64(rawKey.buffer)
}

/**
 * Import a Base64 raw content key into a CryptoKey for AES-GCM.
 */
async function importContentKey(contentKeyB64, usage) {
  return crypto.subtle.importKey('raw', b64ToBuf(contentKeyB64), { name: 'AES-GCM', length: 256 }, false, [usage])
}

/**
 * Encrypt plaintext with a content key (AES-256-GCM).
 * Returns { iv, ciphertext } in Base64.
 */
async function encryptWithContentKey(plaintext, contentKeyB64) {
  const key = await importContentKey(contentKeyB64, 'encrypt')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  return { iv: bufToB64(iv.buffer), ciphertext: bufToB64(ciphertextBuf) }
}

/**
 * Decrypt ciphertext with a content key (AES-256-GCM).
 * Returns plaintext string.
 */
async function decryptWithContentKey(ivB64, ciphertextB64, contentKeyB64) {
  const key = await importContentKey(contentKeyB64, 'decrypt')
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(ivB64) },
    key,
    b64ToBuf(ciphertextB64),
  )
  return new TextDecoder().decode(plainBuf)
}

/**
 * Wrap a content key for a single member using their public key (ECDH P-256).
 * The encrypted payload includes msg_id binding to prevent envelope swapping.
 * Returns { to, ephemeral_pub_key, iv, key_ciphertext }.
 */
export async function wrapContentKey(contentKeyB64, memberPubKeyB64, msgId) {
  const payload = JSON.stringify({
    marker: GROUP_KEY_MARKER,
    version: GROUP_VERSION,
    msg_id: msgId,
    content_key: contentKeyB64,
  })
  const encrypted = await encryptMessage(payload, memberPubKeyB64)
  return {
    to: '', // caller sets the target chat_id
    ephemeral_pub_key: encrypted.ephemeralPubKey,
    iv: encrypted.iv,
    key_ciphertext: encrypted.ciphertext,
  }
}

/**
 * Unwrap a content key from a key envelope using the member's private key.
 * Validates the msg_id binding. Returns the content key (Base64).
 */
export async function unwrapContentKey(keyEnvelope, privateKey, expectedMsgId) {
  const payload = await decryptMessageWithPrivateKey(
    { ephemeralPubKey: keyEnvelope.ephemeral_pub_key, iv: keyEnvelope.iv, ciphertext: keyEnvelope.key_ciphertext },
    privateKey,
  )
  const parsed = JSON.parse(payload)
  if (parsed.marker !== GROUP_KEY_MARKER || parsed.version !== GROUP_VERSION) {
    throw new Error('invalid key envelope')
  }
  if (expectedMsgId && parsed.msg_id !== expectedMsgId) {
    throw new Error('key envelope msg_id mismatch')
  }
  return parsed.content_key
}

/**
 * Encrypt a group message: one ciphertext + per-member key envelopes.
 * @param {string} plaintext - the message text
 * @param {Array<{chat_id: string, public_key: string}>} memberPubKeys - members (excluding sender)
 * @param {string} msgId - message ID for key envelope binding
 * @returns {Promise<{iv: string, ciphertext: string, key_envelopes: Array}>}
 */
export async function encryptGroupMessageContent(plaintext, memberPubKeys, msgId) {
  if (!memberPubKeys || memberPubKeys.length === 0) {
    throw new Error('at least one member is required')
  }
  if (!msgId) {
    throw new Error('msg_id is required')
  }
  if (plaintext === undefined || plaintext === null) {
    throw new Error('plaintext is required')
  }

  const contentKey = generateContentKey()
  const innerPayload = JSON.stringify({
    marker: GROUP_TEXT_MARKER,
    version: GROUP_VERSION,
    text: plaintext,
  })
  const { iv, ciphertext } = await encryptWithContentKey(innerPayload, contentKey)

  const keyEnvelopes = []
  for (const member of memberPubKeys) {
    const env = await wrapContentKey(contentKey, member.public_key, msgId)
    env.to = member.chat_id
    keyEnvelopes.push(env)
  }

  return { iv, ciphertext, key_envelopes: keyEnvelopes }
}

/**
 * Decrypt a group message using the member's private key.
 * @param {Object} params - { iv, ciphertext, key_envelope }
 * @param {CryptoKey} privateKey - the member's ECDH P-256 private key
 * @param {string} [expectedMsgId] - optional msg_id for binding validation
 * @returns {Promise<string>} the plaintext message
 */
export async function decryptGroupMessageContent({ iv, ciphertext, key_envelope }, privateKey, expectedMsgId) {
  if (!iv || !ciphertext || !key_envelope) {
    throw new Error('invalid group message payload')
  }

  const contentKey = await unwrapContentKey(key_envelope, privateKey, expectedMsgId)
  const innerPayload = await decryptWithContentKey(iv, ciphertext, contentKey)
  const parsed = JSON.parse(innerPayload)
  if (parsed.marker !== GROUP_TEXT_MARKER || parsed.version !== GROUP_VERSION) {
    throw new Error('invalid group message content')
  }
  return parsed.text
}
