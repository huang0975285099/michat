import { Capacitor } from '@capacitor/core'
import { ChatService } from 'src/services/chat-service-plugin'
import { deviceApi } from 'src/services/api'

/**
 * 将极光 Registration ID 上报到后端，后端用它向该设备推送通知。
 * 登录后调用一次即可；Registration ID 变更时（极光回调）自动重新上报。
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
 * 检查是否有通知点击带来的待跳转会话，有则路由过去。
 * 在 App 启动和每次从后台切回前台时调用。
 */
async function checkPendingNavigation(router) {
  try {
    const { senderChatId } = await ChatService.getPendingNotification()
    if (senderChatId) {
      router.push('/chat/' + senderChatId)
    }
  } catch (e) {
    // 忽略
  }
}

export default async ({ router }) => {
  if (Capacitor.getPlatform() !== 'android') return

  // 请求 Android 13+ 通知权限
  ChatService.requestNotificationPermission().catch(() => {})

  // 监听极光异步回调的新 Registration ID（首次安装注册时会触发）
  ChatService.addListener('registrationId', ({ registrationId }) => {
    if (registrationId) {
      deviceApi.save(registrationId).catch(() => {})
    }
  })

  // 如果已登录，立即上报 token
  if (localStorage.getItem('session_token')) {
    await registerPushToken()
  }

  // 监听前台/后台切换
  document.addEventListener('visibilitychange', async () => {
    const isActive = document.visibilityState === 'visible'
    ChatService.setForeground({ active: isActive })
    if (isActive) {
      await checkPendingNavigation(router)
    }
  })

  // 启动时检查（App 从通知点击冷启动的情况）
  await checkPendingNavigation(router)
}
