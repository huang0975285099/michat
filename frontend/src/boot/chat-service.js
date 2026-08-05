import { Capacitor } from '@capacitor/core'
import { ChatService } from 'src/services/chat-service-plugin'
import { deviceApi } from 'src/services/api'

/**
 * Report the Jiguang Registration ID to the backend, and the backend uses it to push notifications to the device.
 * Just call it once after logging in; it will be automatically re-reported when the Registration ID changes (Aurora callback).
 */
export async function registerPushToken() {
  if (Capacitor.getPlatform() !== 'android') return
  try {
    const { registrationId } = await ChatService.getRegistrationId()
    if (registrationId) {
      await deviceApi.save(registrationId)
    }
  } catch (e) {
    console.warn('[push] token registration failed', e)
  }
}

/**
 * Check whether there is a session to be jumped brought by the notification click, and route it if there is.
 * Called when the app starts and every time it switches back to the foreground from the background.
 */
async function checkPendingNavigation(router) {
  try {
    const { senderChatId } = await ChatService.getPendingNotification()
    if (senderChatId) {
      router.push('/chat/' + senderChatId)
    }
  } catch {
    // ignore
  }
}

export default async ({ router }) => {
  if (Capacitor.getPlatform() !== 'android') return

  // Request Android 13+ notification permission
  ChatService.requestNotificationPermission().catch(() => {})

  // Listen to the new Registration ID of Jiguang asynchronous callback (triggered when registration is installed for the first time)
  ChatService.addListener('registrationId', ({ registrationId }) => {
    if (registrationId) {
      deviceApi.save(registrationId).catch(() => {})
    }
  })

  // If you are logged in, report the token immediately
  if (localStorage.getItem('session_token')) {
    await registerPushToken()
  }

  // Monitor foreground/background switching
  document.addEventListener('visibilitychange', async () => {
    const isActive = document.visibilityState === 'visible'
    ChatService.setForeground({ active: isActive })
    if (isActive) {
      await checkPendingNavigation(router)
    }
  })

  // Check on startup (when App clicks cold start from notification)
  await checkPendingNavigation(router)
}
