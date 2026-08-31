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
