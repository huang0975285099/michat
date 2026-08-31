const CONTENT_MARKER = 'yunmi.chat.text'
const CONTENT_VERSION = 1
const CHAT_ID_PATTERN = /^\d{4}-[A-Z]{4}$/
const MESSAGE_ID_PATTERN = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/
const REPLY_KINDS = new Set(['text', 'file', 'image', 'video', 'voice', 'burn'])

export const MAX_REPLY_PREVIEW_LENGTH = 160

function cleanPreview(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY_PREVIEW_LENGTH)
}

export function normalizeReplyReference(value) {
  if (!value || typeof value !== 'object') return null
  if (!MESSAGE_ID_PATTERN.test(value.messageId || '')) return null
  if (!CHAT_ID_PATTERN.test(value.senderId || '')) return null
  if (!REPLY_KINDS.has(value.kind)) return null

  return {
    messageId: value.messageId,
    senderId: value.senderId,
    kind: value.kind,
    preview: value.kind === 'burn' ? '' : cleanPreview(value.preview),
  }
}

/** Versioned envelope used only inside the client's encrypted IndexedDB record. */
export function serializeChatMessageContent(text, reply = null) {
  if (typeof text !== 'string') throw new TypeError('message text must be a string')
  const normalizedReply = normalizeReplyReference(reply)
  if (!normalizedReply) return text

  return JSON.stringify({
    marker: CONTENT_MARKER,
    version: CONTENT_VERSION,
    text,
    reply: normalizedReply,
  })
}

/** New clients can read both legacy local records and versioned reply records. */
export function parseChatMessageContent(value) {
  if (typeof value !== 'string') return { text: '', reply: null }
  if (value.length < 2 || value[0] !== '{') return { text: value, reply: null }

  try {
    const parsed = JSON.parse(value)
    if (
      parsed?.marker !== CONTENT_MARKER ||
      parsed?.version !== CONTENT_VERSION ||
      typeof parsed.text !== 'string'
    ) {
      return { text: value, reply: null }
    }

    return {
      text: parsed.text,
      reply: normalizeReplyReference(parsed.reply),
    }
  } catch {
    return { text: value, reply: null }
  }
}

/** Reply references are encrypted independently from the legacy text body on the wire. */
export function serializeReplyReference(reply) {
  const normalized = normalizeReplyReference(reply)
  return normalized ? JSON.stringify(normalized) : null
}

export function parseReplyReference(value) {
  if (typeof value !== 'string' || !value) return null
  try {
    return normalizeReplyReference(JSON.parse(value))
  } catch {
    return null
  }
}
