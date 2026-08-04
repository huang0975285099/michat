// Which shell is the app running inside?
//
// Every shell serves the page from a different origin, so this sniffing has to
// live in one place — scattered `location.protocol === 'file:'` checks silently
// misclassify Tauri, which serves over http(s) like the web build does:
//
//   web / PWA          https://yb.yzs88.com
//   Electron           file://
//   Tauri (Windows)    http://tauri.localhost
//   Tauri (mac/Linux)  tauri://localhost
//   Tauri (dev)        http://localhost:9999   ← same origin as `quasar dev`
//   Capacitor Android  https://localhost
//
// Note the dev case: Tauri loads the Quasar dev server, so the origin alone
// cannot tell it apart from a browser tab. Detection goes through the injected
// globals instead, which are present in dev and production alike.

export function isElectron() {
  return window.location.protocol === 'file:' || !!window.myAPI?.isElectron
}

export function isTauri() {
  return !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
}

// Capacitor Android serves from https://localhost. Checked host-exactly so the
// Tauri host (tauri.localhost) does not fall through to here.
export function isCapacitor() {
  return window.location.protocol === 'https:' && window.location.hostname === 'localhost'
}

// True for any packaged native client. These update by downloading a new
// installer rather than by refreshing a Service Worker.
export function isNativeShell() {
  return isElectron() || isTauri() || isCapacitor()
}
