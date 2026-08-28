import { isCapacitor, isElectron, isTauri } from './platform.js'

export function getUpdatePlatform() {
  if (isCapacitor()) return 'apk'
  if (isTauri() || isElectron()) return 'windows'
  return 'web'
}

export function selectUpdateUrl(info = {}, platform = getUpdatePlatform()) {
  if (platform === 'windows') return info.windows || info.url || ''
  if (platform === 'apk') return info.apk || info.url || ''
  return info.url || info.windows || info.apk || ''
}

export function validateUpdateUrl(value) {
  const parsed = new URL(String(value || ''))
  if (parsed.protocol !== 'https:') throw new TypeError('Update URL must use HTTPS')
  return parsed.href
}

export async function openUpdateUrl(value, platform = getUpdatePlatform()) {
  const url = validateUpdateUrl(value)

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
