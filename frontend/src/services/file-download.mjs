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

async function loadTauriAdapters() {
  const [{ save }, { open, remove }, { downloadDir, join }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
    import('@tauri-apps/api/path'),
  ])
  return { save, open, remove, downloadDir, join, fetch: globalThis.fetch }
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
