// Version and update checking tools
// APP_VERSION / BUILD_TIME are injected at build time (see build.env in quasar.config.js)
import { versionApi } from 'src/services/api'

export const APP_VERSION = process.env.APP_VERSION || ''
export const BUILD_TIME = process.env.BUILD_TIME || ''

// Semantic version number comparison: a>b returns 1, a<b returns -1, and equality returns 0
export function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

// Pull online version information (latest/min_supported/url/notes)
export async function fetchVersionInfo() {
  const { data } = await versionApi.get()
  return data || {}
}

// Whether it is a native client (desktop Electron / Android Capacitor); to update the native client, download the installation package
export function isNativeClient() {
  return (
    window.location.protocol === 'file:' ||
    (window.location.protocol === 'https:' && window.location.hostname === 'localhost')
  )
}

// Browser/PWA forced refresh: clear cache + log out of Service Worker and then reload, users do not need to force refresh manually
export async function forceRefresh() {
  try {
    if (window.caches) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
  } catch {
    // Continue to refresh even if cleanup fails
  }
  // Jump with timestamp to bypass the browser's HTTP cache of index.html
  const { pathname, hash } = window.location
  window.location.replace(pathname + '?_r=' + Date.now() + (hash || ''))
}
