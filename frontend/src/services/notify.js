/**
 * Message reminder tool
 * - Electron: Taskbar flash (window.myAPI.flashWindow)
 * - Web page: System desktop notification (Notification API) + tab title flashing
 *
 * Privacy: This application is end-to-end encrypted, and system notifications only display "new message received" and do not display clear text content.
 */

const NOTIFY_TITLE = 'Yunmi'
const NOTIFY_BODY = 'new message received'

// ── Notification permissions ───────────────────────────────────────────

function notificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

/**
 * Request desktop notification authorization.
 * Browsers require this to be triggered in a user gesture, so it is automatically requested once on the first click/key press.
 * Registration can be done by calling initNotifications() after the user logs in.
 */
export function initNotifications() {
  if (!notificationSupported()) return
  if (Notification.permission !== 'default') return  //Authorized or rejected, no need to ask again

  const requestOnce = () => {
    window.removeEventListener('click', requestOnce)
    window.removeEventListener('keydown', requestOnce)
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }
  window.addEventListener('click', requestOnce, { once: true })
  window.addEventListener('keydown', requestOnce, { once: true })
}

// ──Tab title flashes ──────────────────────────────────────

let titleFlashTimer = null
let originalTitle = ''

function startTitleFlash() {
  if (typeof document === 'undefined') return
  if (titleFlashTimer) return
  originalTitle = document.title
  let toggled = false
  titleFlashTimer = setInterval(() => {
    document.title = toggled ? originalTitle : `【${NOTIFY_BODY}】`
    toggled = !toggled
  }, 1000)
}

function stopTitleFlash() {
  if (titleFlashTimer) {
    clearInterval(titleFlashTimer)
    titleFlashTimer = null
    document.title = originalTitle
  }
}

// Stop flickering when window regains focus
if (typeof window !== 'undefined') {
  window.addEventListener('focus', stopTitleFlash)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) stopTitleFlash()
  })
}

// ──Desktop notifications───────────────────────────────────────────

function showWebNotification() {
  if (!notificationSupported() || Notification.permission !== 'granted') return
  try {
    const n = new Notification(NOTIFY_TITLE, {
      body: NOTIFY_BODY,
      tag: 'michat-new-message',  //Merge with tags to avoid accumulation of multiple entries
      renotify: true,
    })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    // In some environments (such as Service Worker requirements), the construction will throw an error and will be ignored.
  }
}

/**
 * Called when a new message is received.
 * Only alert when the page is not in the foreground to avoid disturbing users while they are viewing it.
 */
export function notifyNewMessage() {
  // Electron: Play native system Toast + taskbar flashing
  if (window.myAPI?.isElectron) {
    window.myAPI.notify?.(NOTIFY_BODY)
    window.myAPI.flashWindow?.()
    return
  }

  // Web pages: Alert only when page is not visible
  const hidden = typeof document !== 'undefined' && document.hidden
  if (!hidden) return

  showWebNotification()
  startTitleFlash()
}
