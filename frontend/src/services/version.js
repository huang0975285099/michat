// Version and update checking tools
// APP_VERSION / BUILD_TIME are injected at build time (see build.env in quasar.config.js)
import { versionApi } from 'src/services/api'
export { cmpVersion, getUpdateStatus } from './version-compare.mjs'

export const APP_VERSION = process.env.APP_VERSION || ''
export const BUILD_TIME = process.env.BUILD_TIME || ''

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
