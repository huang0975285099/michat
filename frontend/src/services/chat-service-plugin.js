import { registerPlugin } from '@capacitor/core'

/**
 * ChatService — Capacitor plug-in bridge
 * Android side corresponds to ChatServicePlugin.java
 * The Web/Electron side provides an empty implementation and does not affect the operation.
 */
const ChatService = registerPlugin('ChatService', {
  web: () => ({
    getRegistrationId: async () => ({ registrationId: '' }),
    setForeground: async () => {},
    getPendingNotification: async () => ({}),
    requestNotificationPermission: async () => ({ granted: true }),
    setSecureScreen: async () => ({}),
    addListener: (_event, _cb) => ({ remove: () => {} }),
  }),
})

export async function setSecureScreen(secure) {
  try {
    await ChatService.setSecureScreen({ secure: Boolean(secure) })
  } catch (error) {
    console.warn('[privacy] failed to update secure-screen state', error)
  }
}

export { ChatService }
