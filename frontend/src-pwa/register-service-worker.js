import { register } from 'register-service-worker'
import { Notify } from 'quasar'
import { fetchVersionInfo, cmpVersion, APP_VERSION } from 'src/services/version'

// The ready(), registered(), cached(), updatefound() and updated()
// events passes a ServiceWorkerRegistration instance in their arguments.
// ServiceWorkerRegistration: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration

register(process.env.SERVICE_WORKER_FILE, {
  // The registrationOptions object will be passed as the second argument
  // to ServiceWorkerContainer.register()
  // https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register#Parameter

  // registrationOptions: { scope: './' },

  ready (/* registration */) {
    // console.log('Service worker is active.')
  },

  registered (/* registration */) {
    // console.log('Service worker has been registered.')
  },

  cached (/* registration */) {
    // console.log('Content has been cached for offline use.')
  },

  updatefound (/* registration */) {
    // console.log('New content is downloading.')
  },

  async updated (/* registration */) {
    // 与「我」页横幅口径统一：仅当后端 latest 版本号确实高于当前版本时才提示，
    // 避免同版本重新构建/部署也弹「发现新版本」
    try {
      const info = await fetchVersionInfo()
      const latest = info.latest || ''
      if (!latest || !APP_VERSION) return                  // 版本信息缺失则不弹
      if (cmpVersion(APP_VERSION, latest) >= 0) return     // 已是最新 / 同版本重构建 → 不弹
      // 低于 min_supported 属于强制更新范围，交给 MainLayout 的硬性弹窗，软提示不重复弹
      if (info.min_supported && cmpVersion(APP_VERSION, info.min_supported) < 0) return
      Notify.create({
        type: 'info',
        message: '发现新版本',
        caption: '点击刷新即可更新到最新版',
        timeout: 0,
        position: 'top',
        actions: [
          { label: '刷新', color: 'white', handler: () => window.location.reload() },
          { label: '稍后', color: 'white', handler: () => {} }
        ]
      })
    } catch {
      // 拉取版本信息失败：不弹，避免误弹（更新仍由「我」页横幅 / 强制弹窗兜底）
    }
  },

  offline () {
    // console.log('No internet connection found. App is running in offline mode.')
  },

  error (/* err */) {
    // console.error('Error during service worker registration:', err)
  }
})
