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
    // The same caliber as the "Me" page banner: it will only prompt if the latest version number of the backend is indeed higher than the current version.
    // Avoid re-building/deployment of the same version and "discover new version"
    try {
      const info = await fetchVersionInfo()
      const latest = info.latest || ''
      if (!latest || !APP_VERSION) return                  //If the version information is missing, it will not play.
      if (cmpVersion(APP_VERSION, latest) >= 0) return     //Already the latest / rebuilt with the same version → will not play
      // Lower than min_supported belongs to the forced update range and is handed over to the hard pop-up window of MainLayout. The soft prompt will not pop up repeatedly.
      if (info.min_supported && cmpVersion(APP_VERSION, info.min_supported) < 0) return
      Notify.create({
        type: 'info',
        message: 'new version found',
        caption: 'Click Refresh to update to the latest version',
        timeout: 0,
        position: 'top',
        actions: [
          { label: 'Refresh', color: 'white', handler: () => window.location.reload() },
          { label: 'later', color: 'white', handler: () => {} }
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
