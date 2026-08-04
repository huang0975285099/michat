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
    addListener: (_event, _cb) => ({ remove: () => {} }),
  }),
})

export { ChatService }
