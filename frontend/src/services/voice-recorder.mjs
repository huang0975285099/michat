export const MAX_VOICE_DURATION_MS = 60 * 1000
export const MIN_VOICE_DURATION_MS = 500

const VOICE_FORMATS = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
  { mimeType: 'audio/mp4', extension: 'mp4' },
  { mimeType: 'audio/webm', extension: 'webm' },
]

export function chooseVoiceFormat(MediaRecorderClass = globalThis.MediaRecorder) {
  if (!MediaRecorderClass) throw new Error(t('chat.micUnsupported'))
  const supported = VOICE_FORMATS.find(({ mimeType }) =>
    typeof MediaRecorderClass.isTypeSupported !== 'function' || MediaRecorderClass.isTypeSupported(mimeType)
  )
  if (!supported) throw new Error(t('chat.voiceCodecUnavailable'))
  return supported
}

export function createVoiceFilename(extension, timestamp = Date.now()) {
  const safeExtension = VOICE_FORMATS.some(format => format.extension === extension) ? extension : 'webm'
  return `voice-${timestamp}.${safeExtension}`
}

export function formatVoiceDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.ceil((durationMs || 0) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}
import { t } from '../i18n/index.js'
