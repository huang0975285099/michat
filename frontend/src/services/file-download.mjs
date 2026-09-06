export function sanitizeDownloadFilename(filename) {
  const cleaned = String(filename || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
  return cleaned || 'download'
}

export function triggerBrowserDownload(objectUrl, filename, documentRef = document) {
  const anchor = documentRef.createElement('a')
  anchor.href = objectUrl
  anchor.download = sanitizeDownloadFilename(filename)
  anchor.style.display = 'none'
  documentRef.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function bindFetchTo(receiver, fetchFn = receiver?.fetch) {
  if (typeof fetchFn !== 'function') throw new Error('Fetch is unavailable')
  return (...args) => Reflect.apply(fetchFn, receiver, args)
}

async function loadTauriAdapters() {
  const [{ save }, { open, remove }, { downloadDir, join }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
    import('@tauri-apps/api/path'),
  ])
  // Chromium/WebView requires fetch to be invoked with Window as its receiver.
  // Storing the native function directly on this adapter makes `api.fetch()` use
  // the adapter object as `this`, which throws "Illegal invocation" in Tauri.
  return { save, open, remove, downloadDir, join, fetch: bindFetchTo(globalThis) }
}

async function writeAll(file, bytes, onWritten) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await file.write(bytes.subarray(offset))
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('Unable to write the downloaded file')
    }
    offset += written
    onWritten(written)
  }
}

function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  const batchSize = 8192
  for (let offset = 0; offset < bytes.byteLength; offset += batchSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + batchSize))
  }
  return btoa(binary)
}

function progressReporter(totalBytes, onProgress) {
  let completedBytes = 0
  return {
    add(written) {
      completedBytes += written
      if (totalBytes > 0) onProgress(Math.min(99, Math.round(completedBytes / totalBytes * 100)))
    },
    finish() {
      if (completedBytes !== totalBytes) throw new Error('Saved file size does not match the attachment')
      onProgress(100)
      return completedBytes
    },
  }
}

async function writeDescriptor(descriptor, writeChunk, totalBytes, onProgress) {
  if (!descriptor || descriptor.size !== totalBytes || !Number.isInteger(descriptor.chunkCount) || descriptor.chunkCount <= 0) {
    throw new Error('Local attachment copy is invalid')
  }
  const progress = progressReporter(totalBytes, onProgress)
  for (let index = 0; index < descriptor.chunkCount; index++) {
    const bytes = await descriptor.readChunk(index)
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error('Local attachment chunk is invalid')
    await writeChunk(bytes, progress.add.bind(progress))
  }
  return progress.finish()
}

async function loadCapacitorFileSave() {
  const { registerPlugin } = await import('@capacitor/core')
  return registerPlugin('FileSave')
}

export async function saveObjectUrlWithTauri({
  objectUrl,
  filename,
  totalBytes,
  dialogTitle,
  onProgress = () => {},
}, adapters) {
  const api = adapters || await loadTauriAdapters()
  const safeFilename = sanitizeDownloadFilename(filename)
  const defaultPath = await api.join(await api.downloadDir(), safeFilename)
  const destination = await api.save({ title: dialogTitle, defaultPath })
  if (!destination) return { canceled: true }

  let file = null
  let reader = null
  try {
    const response = await api.fetch(objectUrl)
    if (!response || response.ok === false) throw new Error('Unable to read the local file')

    file = await api.open(destination, { write: true, create: true, truncate: true })
    let completedBytes = 0
    const reportWritten = written => {
      completedBytes += written
      if (totalBytes > 0) {
        onProgress(Math.min(99, Math.round(completedBytes / totalBytes * 100)))
      }
    }

    if (response.body?.getReader) {
      reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value?.byteLength) await writeAll(file, value, reportWritten)
      }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer())
      await writeAll(file, bytes, reportWritten)
    }

    await file.close()
    file = null
    onProgress(100)
    return { canceled: false, path: destination, bytesWritten: completedBytes }
  } catch (error) {
    try { await reader?.cancel() } catch { /* ignore cleanup errors */ }
    try { await file?.close() } catch { /* ignore cleanup errors */ }
    try { await api.remove(destination) } catch { /* ignore cleanup errors */ }
    throw error
  }
}

export async function saveChunkReaderWithTauri({
  filename,
  totalBytes,
  dialogTitle,
  getDescriptor,
  onProgress = () => {},
}, adapters) {
  const api = adapters || await loadTauriAdapters()
  const safeFilename = sanitizeDownloadFilename(filename)
  const defaultPath = await api.join(await api.downloadDir(), safeFilename)
  const destination = await api.save({ title: dialogTitle, defaultPath })
  if (!destination) return { canceled: true }

  let file = null
  try {
    file = await api.open(destination, { write: true, create: true, truncate: true })
    const descriptor = await getDescriptor()
    const bytesWritten = await writeDescriptor(
      descriptor,
      (bytes, reportWritten) => writeAll(file, bytes, reportWritten),
      totalBytes,
      onProgress,
    )
    await file.close()
    file = null
    return { canceled: false, path: destination, bytesWritten }
  } catch (error) {
    try { await file?.close() } catch { /* ignore cleanup errors */ }
    try { await api.remove(destination) } catch { /* ignore cleanup errors */ }
    throw error
  }
}

export async function saveChunkReaderWithCapacitor({
  filename,
  mimeType,
  totalBytes,
  getDescriptor,
  onProgress = () => {},
}, adapter) {
  const api = adapter || await loadCapacitorFileSave()
  const started = await api.begin({ filename: sanitizeDownloadFilename(filename), mimeType: mimeType || 'application/octet-stream' })
  if (started?.canceled) return { canceled: true }
  try {
    const descriptor = await getDescriptor()
    const bytesWritten = await writeDescriptor(
      descriptor,
      async (bytes, reportWritten) => {
        await api.append({ data: bytesToBase64(bytes) })
        reportWritten(bytes.byteLength)
      },
      totalBytes,
      onProgress,
    )
    const finished = await api.finish()
    if (Number(finished?.bytesWritten) !== bytesWritten) throw new Error('Android saved file size does not match the attachment')
    return { canceled: false, path: finished?.uri || started?.uri || sanitizeDownloadFilename(filename), bytesWritten }
  } catch (error) {
    try { await api.abort() } catch { /* ignore cleanup errors */ }
    throw error
  }
}

export async function saveChunkReaderWithBrowserPicker({
  filename,
  totalBytes,
  getDescriptor,
  onProgress = () => {},
}, adapters = {}) {
  const showSaveFilePicker = adapters.showSaveFilePicker || globalThis.showSaveFilePicker
  if (typeof showSaveFilePicker !== 'function') return { unsupported: true }
  let writable = null
  try {
    const handle = await showSaveFilePicker({ suggestedName: sanitizeDownloadFilename(filename) })
    writable = await handle.createWritable()
    const descriptor = await getDescriptor()
    const bytesWritten = await writeDescriptor(
      descriptor,
      async (bytes, reportWritten) => {
        await writable.write(bytes)
        reportWritten(bytes.byteLength)
      },
      totalBytes,
      onProgress,
    )
    await writable.close()
    writable = null
    return { canceled: false, path: handle.name || sanitizeDownloadFilename(filename), bytesWritten }
  } catch (error) {
    try { await writable?.abort() } catch { /* ignore cleanup errors */ }
    if (error?.name === 'AbortError') return { canceled: true }
    throw error
  }
}
