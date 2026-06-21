import { registerPlugin } from '@capacitor/core'

/**
 * ChatService — Capacitor 插件桥接
 * Android 端对应 ChatServicePlugin.java
 * Web/Electron 端提供空实现，不影响运行
 */
const ChatService = registerPlugin('ChatService', {
  web: () => ({
    getRegistrationId: async () => ({ registrationId: '' }),
    setForeground: async () => {},
    getPendingNotification: async () => ({}),
    requestNotificationPermission: async () => ({ granted: true }),
    addListener: (_event, _cb) => ({ remove: () => {} }),
  }),
})

export { ChatService }
