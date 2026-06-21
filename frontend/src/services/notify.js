/**
 * 消息提醒工具
 * - Electron：任务栏闪烁（window.myAPI.flashWindow）
 * - 网页：系统桌面通知（Notification API）+ 标签页标题闪烁兜底
 *
 * 隐私：本应用端到端加密，系统通知只显示「收到新消息」，不展示明文内容。
 */

const NOTIFY_TITLE = '云密'
const NOTIFY_BODY = '收到新消息'

// ── 通知权限 ──────────────────────────────────────────────

function notificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

/**
 * 请求桌面通知授权。
 * 浏览器要求在用户手势中触发，因此在首次点击/按键时自动请求一次。
 * 可在用户登录后调用 initNotifications() 注册。
 */
export function initNotifications() {
  if (!notificationSupported()) return
  if (Notification.permission !== 'default') return  // 已授权或已拒绝，无需再问

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

// ── 标签页标题闪烁 ────────────────────────────────────────

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

// 窗口重新获得焦点时停止闪烁
if (typeof window !== 'undefined') {
  window.addEventListener('focus', stopTitleFlash)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) stopTitleFlash()
  })
}

// ── 桌面通知 ──────────────────────────────────────────────

function showWebNotification() {
  if (!notificationSupported() || Notification.permission !== 'granted') return
  try {
    const n = new Notification(NOTIFY_TITLE, {
      body: NOTIFY_BODY,
      tag: 'michat-new-message',  // 同 tag 合并，避免堆积多条
      renotify: true,
    })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    // 部分环境（如 Service Worker 要求）下构造会抛错，忽略
  }
}

/**
 * 收到新消息时调用。
 * 仅在页面不在前台时提醒，避免用户正在看时打扰。
 */
export function notifyNewMessage() {
  // Electron：任务栏闪烁
  if (window.myAPI?.flashWindow) {
    window.myAPI.flashWindow()
    return
  }

  // 网页：仅当页面不可见时提醒
  const hidden = typeof document !== 'undefined' && document.hidden
  if (!hidden) return

  showWebNotification()
  startTitleFlash()
}
