import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_IMAGE_BATCH_BYTES,
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_SELECTION,
  MAX_IMAGE_SOURCE_BYTES,
  extractClipboardImageFiles,
  imageSelectionKey,
  inferImageMimeType,
  isSupportedImageFile,
  mergeImageSelection,
} from './image-selection.mjs'

function image(name, size, lastModified = 1, type = 'image/jpeg') {
  return { name, size, lastModified, type }
}

function clipboardItem(file, type = file.type, kind = 'file') {
  return { kind, type, getAsFile: () => file }
}

function createTestFile([source], name, options) {
  return { ...source, name, type: options.type, lastModified: options.lastModified }
}

test('extracts clipboard screenshots, assigns stable names, and preserves real filenames', () => {
  const screenshot = image('image.png', 20, 4, 'image/png')
  const copiedFile = image('holiday.jpg', 30, 5, 'image/jpeg')
  const files = extractClipboardImageFiles({
    items: [clipboardItem(screenshot), clipboardItem(copiedFile)],
  }, {
    baseName: '截图',
    timestamp: Date.UTC(2026, 7, 31, 0, 31, 0),
    createFile: createTestFile,
  })

  assert.equal(files[0].name, '截图_20260831_003100.png')
  assert.equal(files[0].type, 'image/png')
  assert.equal(files[1], copiedFile)
})

test('leaves text paste untouched and ignores unsupported clipboard image formats', () => {
  const text = { kind: 'string', type: 'text/plain', getAsFile: () => null }
  const svg = clipboardItem(image('image.svg', 20, 1, 'image/svg+xml'))
  assert.deepEqual(extractClipboardImageFiles({ items: [text, svg] }), [])
})

test('uses clipboard file fallback and unique names for multiple unnamed images', () => {
  const first = image('', 10, 1, 'image/png')
  const second = image('', 11, 2, 'image/png')
  const files = extractClipboardImageFiles({ files: [first, second] }, {
    baseName: 'Screenshot',
    timestamp: Date.UTC(2026, 7, 31, 1, 2, 3),
    createFile: createTestFile,
  })

  assert.deepEqual(files.map(file => file.name), [
    'Screenshot_20260831_010203.png',
    'Screenshot_20260831_010203_2.png',
  ])
})

test('keeps image selection order and accepts extension-based Android files without a MIME type', () => {
  const first = image('1.jpg', 10)
  const second = image('2.png', 20, 2, '')
  const result = mergeImageSelection([], [first, second])
  assert.deepEqual(result.files, [first, second])
  assert.equal(result.totalBytes, 30)
  assert.equal(inferImageMimeType('2.PNG'), 'image/png')
  assert.equal(inferImageMimeType('photo.JPEG'), 'image/jpeg')
  assert.equal(inferImageMimeType('photo.svg'), '')
})

test('limits a batch to nine unique images', () => {
  const files = Array.from({ length: 11 }, (_, index) => image(`${index}.jpg`, 10, index))
  const result = mergeImageSelection([], files)
  assert.equal(MAX_IMAGE_SELECTION, 9)
  assert.equal(result.files.length, MAX_IMAGE_SELECTION)
  assert.deepEqual(result.rejected.map(item => item.reason), ['count', 'count'])
})

test('rejects duplicate, non-image, SVG, empty, and oversized selections', () => {
  const original = image('same.jpg', 10, 3)
  const result = mergeImageSelection([original], [
    { ...original },
    image('report.pdf', 10, 4, 'application/pdf'),
    image('vector.svg', 10, 5, 'image/svg+xml'),
    image('empty.png', 0, 6, 'image/png'),
    image('large.jpg', MAX_IMAGE_SOURCE_BYTES + 1, 7),
  ])
  assert.deepEqual(result.rejected.map(item => item.reason), [
    'duplicate',
    'not_image',
    'not_image',
    'file_size',
    'file_size',
  ])
})

test('accepts sources through 100 MiB so oversized originals can be compressed locally', () => {
  assert.equal(MAX_IMAGE_FILE_BYTES, 20 * 1024 * 1024)
  assert.equal(MAX_IMAGE_SOURCE_BYTES, 100 * 1024 * 1024)
  const atLimit = image('limit.jpg', MAX_IMAGE_SOURCE_BYTES, 1)
  const tooLarge = image('large.jpg', MAX_IMAGE_SOURCE_BYTES + 1, 2)
  const result = mergeImageSelection([], [atLimit, tooLarge], {
    maxTotalBytes: MAX_IMAGE_SOURCE_BYTES * 2,
  })
  assert.deepEqual(result.files, [atLimit])
  assert.deepEqual(result.rejected.map(item => item.reason), ['file_size'])
})

test('requires an exact extension-to-MIME match and rejects disguised files', () => {
  const accepted = [
    image('a.jpg', 1, 1, 'image/jpeg'),
    image('b.jpeg', 1, 2, 'image/jpeg'),
    image('c.png', 1, 3, 'image/png'),
    image('d.gif', 1, 4, 'image/gif'),
    image('e.webp', 1, 5, 'image/webp'),
    image('f.bmp', 1, 6, 'image/bmp'),
    image('g.BMP', 1, 7, 'image/x-ms-bmp'),
  ]
  const disguised = [
    image('fake.jpg', 1, 8, 'image/png'),
    image('fake.png', 1, 9, 'image/jpeg'),
    image('fake.jpg', 1, 10, 'image/svg+xml'),
    image('fake.svg', 1, 11, 'image/jpeg'),
    image('fake.jpg.exe', 1, 12, 'image/jpeg'),
  ]

  const result = mergeImageSelection([], [...accepted, ...disguised])
  assert.deepEqual(result.files, accepted)
  assert.deepEqual(result.rejected.map(item => item.reason), disguised.map(() => 'not_image'))
  assert.equal(isSupportedImageFile(image('android.webp', 1, 13, '')), true)
  assert.equal(isSupportedImageFile(image('android.svg', 1, 14, '')), false)
})

test('deduplicates the same file even when the browser reports MIME differently', () => {
  const first = image('same.png', 10, 9, '')
  const repeated = image('same.png', 10, 9, 'image/png')
  const distinct = image('same.png', 11, 9, 'image/png')
  const result = mergeImageSelection([first], [repeated, distinct])
  assert.deepEqual(result.files, [first, distinct])
  assert.equal(result.rejected[0].reason, 'duplicate')
  assert.equal(imageSelectionKey(first), imageSelectionKey(repeated))
})

test('accepts exactly 100 MiB in aggregate and rejects the next byte', () => {
  assert.equal(MAX_IMAGE_BATCH_BYTES, 100 * 1024 * 1024)
  const atLimit = Array.from({ length: 5 }, (_, index) =>
    image(`${index}.jpg`, MAX_IMAGE_FILE_BYTES, index),
  )
  const overLimit = image('over.jpg', 1, 10)
  const result = mergeImageSelection([], [...atLimit, overLimit])

  assert.deepEqual(result.files, atLimit)
  assert.equal(result.totalBytes, MAX_IMAGE_BATCH_BYTES)
  assert.deepEqual(result.rejected, [{ file: overLimit, reason: 'total_size' }])
})

test('applies count, file, and aggregate checks without disturbing accepted order', () => {
  const first = image('first.jpg', 7, 1)
  const duplicate = image('first.jpg', 7, 1, '')
  const tooLarge = image('large.png', 11, 2, 'image/png')
  const totalOverflow = image('overflow.gif', 5, 3, 'image/gif')
  const acceptedLast = image('last.webp', 3, 4, 'image/webp')
  const result = mergeImageSelection([], [first, duplicate, tooLarge, totalOverflow, acceptedLast], {
    maxCount: 2,
    maxFileBytes: 10,
    maxTotalBytes: 10,
  })

  assert.deepEqual(result.files, [first, acceptedLast])
  assert.deepEqual(result.rejected.map(item => item.reason), [
    'duplicate',
    'file_size',
    'total_size',
  ])
  assert.equal(result.totalBytes, 10)
})
