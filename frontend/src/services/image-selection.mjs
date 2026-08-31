export const MAX_IMAGE_SELECTION = 9
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_SOURCE_BYTES = 100 * 1024 * 1024
export const MAX_IMAGE_BATCH_BYTES = 100 * 1024 * 1024

const IMAGE_MIMES_BY_EXTENSION = Object.freeze({
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  bmp: ['image/bmp', 'image/x-ms-bmp'],
})

const IMAGE_EXTENSION_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
})

function extensionOf(filename) {
  return typeof filename === 'string' ? filename.split('.').pop()?.toLowerCase() || '' : ''
}

export function inferImageMimeType(filename) {
  return IMAGE_MIMES_BY_EXTENSION[extensionOf(filename)]?.[0] || ''
}

export function isSupportedImageFile(file) {
  const allowedTypes = IMAGE_MIMES_BY_EXTENSION[extensionOf(file?.name)]
  if (!allowedTypes) return false
  return file?.type === '' || allowedTypes.includes(file?.type)
}

export function imageSelectionKey(file) {
  return JSON.stringify([file?.name || '', file?.size || 0, file?.lastModified || 0])
}

function clipboardTimestamp(value) {
  const date = new Date(Number.isFinite(value) ? value : Date.now())
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date()
  const pad = part => String(part).padStart(2, '0')
  return [
    safeDate.getUTCFullYear(),
    pad(safeDate.getUTCMonth() + 1),
    pad(safeDate.getUTCDate()),
    '_',
    pad(safeDate.getUTCHours()),
    pad(safeDate.getUTCMinutes()),
    pad(safeDate.getUTCSeconds()),
  ].join('')
}

function safeClipboardBaseName(value) {
  const name = String(value || 'Screenshot').trim().replace(/[\\/:*?"<>|]/g, '_')
  return name || 'Screenshot'
}

function createRenamedClipboardFile(file, type, index, options) {
  const extension = IMAGE_EXTENSION_BY_MIME[type]
  if (!extension) return null

  const currentName = typeof file?.name === 'string' ? file.name.trim() : ''
  const currentExtension = extensionOf(currentName)
  const hasMatchingName = IMAGE_MIMES_BY_EXTENSION[currentExtension]?.includes(type) === true
  const hasGenericName = /^(?:image|blob)(?:[-_ ]?\d+)?\.[^.]+$/i.test(currentName)
  if (hasMatchingName && !hasGenericName) return file

  const timestamp = Number.isFinite(options.timestamp) ? options.timestamp : Date.now()
  const suffix = index > 0 ? `_${index + 1}` : ''
  const filename = `${safeClipboardBaseName(options.baseName)}_${clipboardTimestamp(timestamp)}${suffix}.${extension}`
  const lastModified = Number.isFinite(file?.lastModified) && file.lastModified > 0
    ? file.lastModified
    : timestamp
  const createFile = options.createFile || ((parts, name, fileOptions) => new File(parts, name, fileOptions))

  return createFile([file], filename, { type, lastModified })
}

/**
 * Returns supported clipboard images without reading their bytes. Text-only
 * clipboard data returns an empty array so the input keeps its native paste.
 */
export function extractClipboardImageFiles(clipboardData, options = {}) {
  if (!clipboardData) return []

  const candidates = []
  for (const item of Array.from(clipboardData.items || [])) {
    const type = String(item?.type || '').toLowerCase()
    if (item?.kind !== 'file' || !IMAGE_EXTENSION_BY_MIME[type]) continue
    const file = item.getAsFile?.()
    if (file) candidates.push({ file, type: String(file.type || type).toLowerCase() })
  }

  if (!candidates.length) {
    for (const file of Array.from(clipboardData.files || [])) {
      const type = String(file?.type || '').toLowerCase()
      if (IMAGE_EXTENSION_BY_MIME[type]) candidates.push({ file, type })
    }
  }

  return candidates
    .map(({ file, type }, index) => createRenamedClipboardFile(file, type, index, options))
    .filter(Boolean)
}

/**
 * Merge gallery selections in stable order. No bytes are read and the function
 * accepts File-like objects so it can be unit tested outside a browser.
 */
export function mergeImageSelection(currentFiles, incomingFiles, options = {}) {
  const maxCount = options.maxCount ?? MAX_IMAGE_SELECTION
  const maxFileBytes = options.maxFileBytes ?? MAX_IMAGE_SOURCE_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? MAX_IMAGE_BATCH_BYTES
  const files = Array.isArray(currentFiles) ? [...currentFiles] : []
  const rejected = []
  const keys = new Set(files.map(imageSelectionKey))
  let totalBytes = files.reduce((sum, file) => sum + (Number.isFinite(file?.size) ? file.size : 0), 0)

  for (const file of Array.from(incomingFiles || [])) {
    if (!isSupportedImageFile(file)) {
      rejected.push({ file, reason: 'not_image' })
      continue
    }
    if (!Number.isInteger(file.size) || file.size <= 0 || file.size > maxFileBytes) {
      rejected.push({ file, reason: 'file_size' })
      continue
    }
    const key = imageSelectionKey(file)
    if (keys.has(key)) {
      rejected.push({ file, reason: 'duplicate' })
      continue
    }
    if (files.length >= maxCount) {
      rejected.push({ file, reason: 'count' })
      continue
    }
    if (totalBytes + file.size > maxTotalBytes) {
      rejected.push({ file, reason: 'total_size' })
      continue
    }

    files.push(file)
    keys.add(key)
    totalBytes += file.size
  }

  return { files, rejected, totalBytes }
}
