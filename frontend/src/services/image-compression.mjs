export const AUTO_COMPRESS_THRESHOLD_BYTES = 2 * 1024 * 1024
export const MAX_IMAGE_LONG_EDGE = 2560
export const MAX_IMAGE_SOURCE_PIXELS = 80 * 1000 * 1000
export const MAX_COMPRESSED_IMAGE_BYTES = 20 * 1024 * 1024

const COMPRESSIBLE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp'])

function extensionOf(filename) {
  return typeof filename === 'string' ? filename.split('.').pop()?.toLowerCase() || '' : ''
}

export function imageCompressionPolicy(file) {
  const extension = extensionOf(file?.name)
  if (extension === 'gif' || file?.type === 'image/gif') {
    return { shouldCompress: false, reason: 'animated', outputType: 'image/gif', quality: 1 }
  }
  if (!COMPRESSIBLE_EXTENSIONS.has(extension)) {
    return { shouldCompress: false, reason: 'unsupported', outputType: file?.type || '', quality: 1 }
  }

  const isBitmap = extension === 'bmp'
  const shouldCompress = isBitmap || file.size > AUTO_COMPRESS_THRESHOLD_BYTES
  return {
    shouldCompress,
    reason: shouldCompress ? 'large' : 'small',
    outputType: 'image/webp',
    quality: extension === 'png' ? 0.9 : 0.82,
  }
}

export function fitImageDimensions(width, height, maxLongEdge = MAX_IMAGE_LONG_EDGE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Invalid image dimensions')
  }
  const longest = Math.max(width, height)
  if (longest <= maxLongEdge) return { width: Math.round(width), height: Math.round(height) }
  const scale = maxLongEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function compressedImageName(filename, mimeType = 'image/webp') {
  const base = String(filename || 'image').replace(/\.[^.]+$/, '') || 'image'
  const extension = mimeType === 'image/jpeg'
    ? 'jpg'
    : mimeType === 'image/png'
      ? 'png'
      : 'webp'
  return `${base}.${extension}`
}

function imageDecodeError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

async function decodeBrowserImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      }
    } catch {
      // Older WebViews may not understand imageOrientation; use the Image fallback.
    }
  }

  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw imageDecodeError('Image decoding is unavailable', 'decode_unavailable')
  }

  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(imageDecodeError('Unable to decode image', 'decode_failed'))
      image.src = objectUrl
    })
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    }
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error
  }
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(imageDecodeError('Unable to encode image', 'encode_failed'))
    }, mimeType, quality)
  })
}

/**
 * Compresses a local image before E2EE encryption. No Base64 copy is created.
 * Animated GIFs and already-small images are returned unchanged.
 */
export async function compressImageForSending(file, options = {}) {
  const policy = imageCompressionPolicy(file)
  if (!policy.shouldCompress && policy.reason !== 'small') {
    return {
      file,
      compressed: false,
      reason: policy.reason,
      originalBytes: file.size,
      outputBytes: file.size,
    }
  }

  const decoded = await (options.decodeImage || decodeBrowserImage)(file)
  let canvas = null
  try {
    const pixels = decoded.width * decoded.height
    if (!Number.isFinite(pixels) || pixels <= 0 || pixels > (options.maxSourcePixels || MAX_IMAGE_SOURCE_PIXELS)) {
      throw imageDecodeError('Image dimensions are too large', 'dimensions_too_large')
    }
    const configuredLongEdge = options.maxLongEdge || MAX_IMAGE_LONG_EDGE
    if (!policy.shouldCompress && Math.max(decoded.width, decoded.height) <= configuredLongEdge) {
      return {
        file,
        compressed: false,
        reason: policy.reason,
        originalBytes: file.size,
        outputBytes: file.size,
      }
    }
    if (!options.createCanvas && typeof document === 'undefined') {
      throw imageDecodeError('Image encoding is unavailable', 'encode_unavailable')
    }

    canvas = options.createCanvas ? options.createCanvas() : document.createElement('canvas')
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw imageDecodeError('Image encoding is unavailable', 'encode_unavailable')

    let longEdge = configuredLongEdge
    let quality = policy.quality
    let bestBlob = null

    for (let attempt = 0; attempt < 3; attempt++) {
      const dimensions = fitImageDimensions(decoded.width, decoded.height, longEdge)
      canvas.width = dimensions.width
      canvas.height = dimensions.height
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height)

      const blob = await (options.encodeCanvas || canvasToBlob)(canvas, policy.outputType, quality)
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob
      if (blob.size <= (options.maxOutputBytes || MAX_COMPRESSED_IMAGE_BYTES)) break
      longEdge = Math.max(1280, Math.round(longEdge * 0.75))
      quality = Math.max(0.68, quality - 0.07)
    }

    if (!bestBlob || bestBlob.size >= file.size) {
      return {
        file,
        compressed: false,
        reason: 'not_smaller',
        originalBytes: file.size,
        outputBytes: file.size,
      }
    }

    const outputType = bestBlob.type || policy.outputType
    const fileParts = [bestBlob]
    const outputName = compressedImageName(file.name, outputType)
    const fileOptions = { type: outputType, lastModified: file.lastModified }
    const outputFile = options.createFile
      ? options.createFile(fileParts, outputName, fileOptions)
      : new File(fileParts, outputName, fileOptions)
    return {
      file: outputFile,
      compressed: true,
      reason: 'compressed',
      originalBytes: file.size,
      outputBytes: outputFile.size,
    }
  } finally {
    if (canvas) {
      canvas.width = 1
      canvas.height = 1
    }
    decoded.cleanup?.()
  }
}
