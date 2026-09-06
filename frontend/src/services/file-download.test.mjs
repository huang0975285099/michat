import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bindFetchTo,
  sanitizeDownloadFilename,
  saveChunkReaderWithBrowserPicker,
  saveChunkReaderWithCapacitor,
  saveChunkReaderWithTauri,
  saveObjectUrlWithTauri,
} from './file-download.mjs'

test('sanitizes file names before using them as a save-dialog default', () => {
  assert.equal(sanitizeDownloadFilename('../report:final?.docx'), '.._report_final_.docx')
  assert.equal(sanitizeDownloadFilename('name. '), 'name')
})

test('streams a file to disk and reports progress without duplicating the whole file', async () => {
  const writes = []
  const progress = []
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
  let chunkIndex = 0
  const adapters = {
    downloadDir: async () => 'C:\\Downloads',
    join: async (...parts) => parts.join('\\'),
    save: async () => 'C:\\Downloads\\report.docx',
    fetch: async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => chunkIndex < chunks.length
            ? { done: false, value: chunks[chunkIndex++] }
            : { done: true },
        }),
      },
    }),
    open: async () => ({
      write: async bytes => { writes.push(...bytes); return bytes.byteLength },
      close: async () => {},
    }),
    remove: async () => {},
  }

  const result = await saveObjectUrlWithTauri({
    objectUrl: 'blob:test',
    filename: 'report.docx',
    totalBytes: 5,
    onProgress: value => progress.push(value),
  }, adapters)

  assert.deepEqual(writes, [1, 2, 3, 4, 5])
  assert.deepEqual(progress, [40, 99, 100])
  assert.deepEqual(result, {
    canceled: false,
    path: 'C:\\Downloads\\report.docx',
    bytesWritten: 5,
  })
})

test('does not open or fetch the file when the save dialog is canceled', async () => {
  const adapters = {
    downloadDir: async () => 'C:\\Downloads',
    join: async (...parts) => parts.join('\\'),
    save: async () => null,
    fetch: async () => { throw new Error('must not fetch') },
    open: async () => { throw new Error('must not open') },
    remove: async () => {},
  }

  const result = await saveObjectUrlWithTauri({
    objectUrl: 'blob:test',
    filename: 'report.docx',
    totalBytes: 5,
  }, adapters)

  assert.deepEqual(result, { canceled: true })
})

test('binds native fetch to its Window-like receiver', async () => {
  const windowLike = { marker: 'window' }
  const nativeFetch = function (url) {
    assert.equal(this, windowLike)
    return { url }
  }
  const fetch = bindFetchTo(windowLike, nativeFetch)
  assert.deepEqual(fetch('blob:test'), { url: 'blob:test' })
})

function chunkDescriptor() {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
  return {
    size: 5,
    chunkCount: chunks.length,
    readChunk: async index => chunks[index],
  }
}

test('writes encrypted local chunks directly to a Tauri destination', async () => {
  const writes = []
  const adapters = {
    downloadDir: async () => 'C:\\Downloads',
    join: async (...parts) => parts.join('\\'),
    save: async () => 'C:\\Downloads\\large.zip',
    open: async () => ({
      write: async bytes => { writes.push(...bytes); return bytes.byteLength },
      close: async () => {},
    }),
    remove: async () => {},
  }
  const result = await saveChunkReaderWithTauri({
    filename: 'large.zip',
    totalBytes: 5,
    getDescriptor: async () => chunkDescriptor(),
  }, adapters)
  assert.deepEqual(writes, [1, 2, 3, 4, 5])
  assert.equal(result.bytesWritten, 5)
})

test('streams Base64-sized chunks through the Android document plugin', async () => {
  const writes = []
  const adapter = {
    begin: async () => ({ canceled: false, uri: 'content://downloads/1' }),
    append: async ({ data }) => { writes.push(...Uint8Array.from(atob(data), char => char.charCodeAt(0))) },
    finish: async () => ({ uri: 'content://downloads/1', bytesWritten: 5 }),
    abort: async () => { throw new Error('must not abort') },
  }
  const result = await saveChunkReaderWithCapacitor({
    filename: 'large.zip',
    mimeType: 'application/zip',
    totalBytes: 5,
    getDescriptor: async () => chunkDescriptor(),
  }, adapter)
  assert.deepEqual(writes, [1, 2, 3, 4, 5])
  assert.equal(result.bytesWritten, 5)
})

test('uses the browser file picker before streaming local chunks', async () => {
  const writes = []
  const writable = {
    write: async bytes => { writes.push(...bytes) },
    close: async () => {},
    abort: async () => {},
  }
  const result = await saveChunkReaderWithBrowserPicker({
    filename: 'large.zip',
    totalBytes: 5,
    getDescriptor: async () => chunkDescriptor(),
  }, {
    showSaveFilePicker: async () => ({ name: 'large.zip', createWritable: async () => writable }),
  })
  assert.deepEqual(writes, [1, 2, 3, 4, 5])
  assert.equal(result.bytesWritten, 5)
})
