import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTO_COMPRESS_THRESHOLD_BYTES,
  MAX_COMPRESSED_IMAGE_BYTES,
  compressImageForSending,
  compressedImageName,
  fitImageDimensions,
  imageCompressionPolicy,
} from './image-compression.mjs'

function image(name, size, type = 'image/jpeg') {
  return { name, size, type }
}

test('keeps small photos unchanged and compresses photos above two MiB', () => {
  assert.equal(imageCompressionPolicy(image('small.jpg', AUTO_COMPRESS_THRESHOLD_BYTES)).shouldCompress, false)
  assert.equal(imageCompressionPolicy(image('large.jpg', AUTO_COMPRESS_THRESHOLD_BYTES + 1)).shouldCompress, true)
})

test('preserves animated GIF files and converts BMP files even when small', () => {
  assert.deepEqual(imageCompressionPolicy(image('animated.gif', 8 * 1024 * 1024, 'image/gif')), {
    shouldCompress: false,
    reason: 'animated',
    outputType: 'image/gif',
    quality: 1,
  })
  assert.equal(imageCompressionPolicy(image('legacy.bmp', 100, 'image/bmp')).shouldCompress, true)
})

test('uses a higher quality setting for PNG screenshots', () => {
  const png = imageCompressionPolicy(image('screen.png', AUTO_COMPRESS_THRESHOLD_BYTES + 1, 'image/png'))
  const jpeg = imageCompressionPolicy(image('photo.jpg', AUTO_COMPRESS_THRESHOLD_BYTES + 1))
  assert.equal(png.outputType, 'image/webp')
  assert.ok(png.quality > jpeg.quality)
})

test('fits landscape and portrait dimensions within a 2560px long edge', () => {
  assert.deepEqual(fitImageDimensions(6000, 4000), { width: 2560, height: 1707 })
  assert.deepEqual(fitImageDimensions(3000, 6000), { width: 1280, height: 2560 })
  assert.deepEqual(fitImageDimensions(1200, 900), { width: 1200, height: 900 })
})

test('creates an extension matching the encoded MIME type', () => {
  assert.equal(compressedImageName('holiday.JPG', 'image/webp'), 'holiday.webp')
  assert.equal(compressedImageName('screen.png', 'image/png'), 'screen.png')
  assert.equal(compressedImageName('', 'image/jpeg'), 'image.jpg')
  assert.equal(MAX_COMPRESSED_IMAGE_BYTES, 20 * 1024 * 1024)
})

test('rejects invalid dimensions', () => {
  assert.throws(() => fitImageDimensions(0, 200), /Invalid image dimensions/)
  assert.throws(() => fitImageDimensions(Number.NaN, 200), /Invalid image dimensions/)
})

test('inspects small photos for pixel safety without re-encoding normal dimensions', async () => {
  const file = image('small.jpg', 500 * 1024)
  let cleaned = false
  const result = await compressImageForSending(file, {
    decodeImage: async () => ({
      source: {},
      width: 1600,
      height: 1200,
      cleanup: () => { cleaned = true },
    }),
  })
  assert.equal(result.file, file)
  assert.equal(result.compressed, false)
  assert.equal(cleaned, true)
})

test('rejects excessive decoded pixel dimensions before allocating a canvas', async () => {
  const file = image('bomb.jpg', 500 * 1024)
  await assert.rejects(
    compressImageForSending(file, {
      decodeImage: async () => ({ source: {}, width: 20000, height: 20000, cleanup() {} }),
    }),
    error => error.code === 'dimensions_too_large',
  )
})

test('encodes a large photo to a smaller WebP file with bounded dimensions', async () => {
  const file = { ...image('large.jpg', 6 * 1024 * 1024), lastModified: 7 }
  const drawCalls = []
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      clearRect() {},
      drawImage(_source, _x, _y, width, height) { drawCalls.push([width, height]) },
    }),
  }
  const result = await compressImageForSending(file, {
    decodeImage: async () => ({ source: {}, width: 6000, height: 4000, cleanup() {} }),
    createCanvas: () => canvas,
    encodeCanvas: async (_canvas, type) => new Blob(['compressed'], { type }),
    createFile: (parts, name, options) => ({
      name,
      type: options.type,
      size: parts[0].size,
      lastModified: options.lastModified,
    }),
  })

  assert.equal(result.compressed, true)
  assert.equal(result.file.name, 'large.webp')
  assert.equal(result.file.type, 'image/webp')
  assert.deepEqual(drawCalls, [[2560, 1707]])
  assert.ok(result.outputBytes < result.originalBytes)
})
