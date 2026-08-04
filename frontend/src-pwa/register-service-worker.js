import { register } from 'register-service-worker'
import { Notify } from 'quasar'
import { fetchVersionInfo, getUpdateStatus, APP_VERSION } from 'src/services/version'
import { t } from 'src/i18n'

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
    // The same caliber as the "Me" page banner: it will only prompt if the latest version number of the backend is indeed higher than the current version.
    // Avoid re-building/deployment of the same version and "discover new version"
    try {
      const info = await fetchVersionInfo()
      const latest = info.latest || ''
      if (!latest || !APP_VERSION) return                  //If the version information is missing, it will not play.
      const updateStatus = getUpdateStatus(APP_VERSION, latest, info.min_supported)
      if (updateStatus !== 'available') return
      Notify.create({
        type: 'info',
        message: t('update.available'),
        caption: t('update.refreshHint'),
        timeout: 0,
        position: 'top',
        actions: [
          { label: t('update.refresh'), color: 'white', handler: () => window.location.reload() },
          { label: t('update.later'), color: 'white', handler: () => {} }
        ]
      })
    } catch {
      // Failed to pull version information: no pop-up to avoid accidental pop-ups (updates are still covered by the "Me" page banner/forced pop-up window)
    }
  },

  offline () {
    // console.log('No internet connection found. App is running in offline mode.')
  },

  error (/* err */) {
    // console.error('Error during service worker registration:', err)
  }
})
