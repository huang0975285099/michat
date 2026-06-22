// 版本与更新检查工具
// APP_VERSION / BUILD_TIME 由构建时注入（见 quasar.config.js 的 build.env）
import { versionApi } from 'src/services/api'

export const APP_VERSION = process.env.APP_VERSION || ''
export const BUILD_TIME = process.env.BUILD_TIME || ''

// 语义化版本号比较：a>b 返回 1，a<b 返回 -1，相等返回 0
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

// 拉取线上版本信息（latest/min_supported/url/notes）
export async function fetchVersionInfo() {
  const { data } = await versionApi.get()
  return data || {}
}

// 是否为原生客户端（桌面 Electron / 安卓 Capacitor）；原生端更新走下载安装包
export function isNativeClient() {
  return (
    window.location.protocol === 'file:' ||
    (window.location.protocol === 'https:' && window.location.hostname === 'localhost')
  )
}

// 浏览器 / PWA 强制刷新：清理缓存 + 注销 Service Worker 后 reload，用户无需手动强刷
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
    // 清理失败也继续刷新
  }
  window.location.reload()
}
