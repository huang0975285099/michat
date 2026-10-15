import { isCapacitor, isTauri } from './platform.js'

export function getUpdatePlatform() {
  if (isCapacitor()) return 'apk'
  if (isTauri()) return 'windows'
  return 'web'
}

export function selectUpdateUrl(info = {}, platform = getUpdatePlatform()) {
  const installer = platform === 'windows' ? info.windows : platform === 'apk' ? info.apk : ''
  if (installer) return validateUpdateUrl(installer)
  if (info.url) return validateUpdateUrl(info.url, { allowHomepage: true })
  const fallback = info.windows || info.apk
  return fallback ? validateUpdateUrl(fallback) : ''
}

export function validateUpdateUrl(value, { allowHomepage = false } = {}) {
  if (typeof value !== 'string' || value !== value.trim() || /[\\\u0000-\u0020\u007f]/.test(value)) {
    throw new TypeError('Invalid update URL')
  }
  const parsed = new URL(String(value || ''))
  if (parsed.protocol !== 'https:') throw new TypeError('Update URL must use HTTPS')
  if (parsed.origin !== 'https://m.yzs88.com:8088' || parsed.username || parsed.password) {
    throw new TypeError('Update URL must use the approved origin')
  }
  const homepage = allowHomepage && parsed.pathname === '/' && !parsed.search && !parsed.hash
  if (!homepage && (!parsed.pathname.startsWith('/download/') || parsed.pathname === '/download/' ||
    /%|\/\//.test(parsed.pathname) || parsed.search || parsed.hash)) {
    throw new TypeError('Update URL must use an approved download path')
  }
  return parsed.href
}

export async function openUpdateUrl(value, platform = getUpdatePlatform()) {
  const url = validateUpdateUrl(value, { allowHomepage: true })

  if (platform === 'windows' && isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
    return
  }

  if (platform === 'apk' && isCapacitor()) {
    const { Browser } = await import('@capacitor/browser')
    await Browser.open({ url })
    return
  }

  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened) throw new Error('The browser blocked the update window')
}
