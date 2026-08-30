import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeDownloadFilename, saveObjectUrlWithTauri } from './file-download.mjs'

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
