import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { loadKeyPair, generateAndStoreKeyPair, clearKeyPair, exportPrivateKey, hasSecurityCode, isUnlocked, unlock, lock, startAutoLock, loadLockConfig, saveLockConfig, setupSecurityCode, disableSecurityCode, pinPeerPublicKey, canonicalPeerPublicKey } from 'src/services/crypto'
import { identityApi, friendApi } from 'src/services/api'
import { registerPushToken } from 'src/boot/chat-service'
import { connect, disconnect, clearPendingQueue } from 'src/services/websocket'
import { useChatStore } from 'src/stores/chat'
import { deleteAccountThenClear } from './account-deletion.mjs'

export const useIdentityStore = defineStore('identity', () => {
  const chatId = ref(localStorage.getItem('chat_id') || '')
  const nickname = ref(localStorage.getItem('nickname') || '')
  const hasPrivateKey = ref(false)
  const serverReady = ref(false)
  const isAdmin = ref(false)

  // Security code locked status
  const isLocked = ref(false)        //Is it currently locked?
  const restoringLocalData = ref(false)
  const hasCode = ref(false)         //Is a security code set?
  const lockTimeout = ref(1/6)       //Timeout (hours), default 10 minutes
  let autoLockCleanup = null         //Automatic lock cleaning function

  const isReady = computed(() => !!chatId.value && hasPrivateKey.value && serverReady.value)

  // Friend public key cache
  const friendPubKeys = ref({})
  const friendKeyChanges = ref({})
  // Friend nickname cache { chatId -> nickname }
  const friendNames = ref({})
  // Number of friend requests pending
  const pendingRequestCount = ref(0)
  let pendingRequestRefresh = Promise.resolve()

  function refreshPendingRequestCount() {
    pendingRequestRefresh = pendingRequestRefresh.catch(() => {}).then(async () => {
      if (!isReady.value) return
      const accountId = chatId.value
      const token = localStorage.getItem('session_token')
      const { data } = await friendApi.getRequests()
      if (isReady.value && chatId.value === accountId && localStorage.getItem('session_token') === token) {
        pendingRequestCount.value = (data || []).filter(request => request.status === 'pending').length
      }
    })
    return pendingRequestRefresh
  }

  /**
   * trigger lock
   */
  function onLocked() {
    isLocked.value = true
    useChatStore().lockLocalData()
    sessionStorage.removeItem('sec_code_unlocked')
  }

  /**
   * Restore state from local storage and IndexedDB
   */
  async function load() {
    const token = localStorage.getItem('session_token')
    const storedChatId = localStorage.getItem('chat_id')

    if (!token || !storedChatId) {
      hasPrivateKey.value = false
      serverReady.value = false
      return
    }

    chatId.value = storedChatId
    nickname.value = localStorage.getItem('nickname') || ''

    // Check if security code is set
    hasCode.value = await hasSecurityCode()

    if (hasCode.value) {
      // There is a security code: check if there is a private key cache (the cache is lost after refreshing)
      if (isUnlocked()) {
        // With cache: unlocked status
        hasPrivateKey.value = true
        serverReady.value = true
        isLocked.value = false
        lockTimeout.value = await loadLockConfig()
        sessionStorage.setItem('sec_code_unlocked', '1')
        autoLockCleanup = startAutoLock(onLocked)
        await loadFriendPubKeys()
      } else {
        // No cache: need to re-unlock
        hasPrivateKey.value = true
        serverReady.value = true
        isLocked.value = true
        lockTimeout.value = await loadLockConfig()
        sessionStorage.removeItem('sec_code_unlocked')
      }
      return
    }

    // No security code: plain text mode, direct loading
    const kp = await loadKeyPair()
    hasPrivateKey.value = !!kp

    if (hasPrivateKey.value) {
      try {
        const { data } = await identityApi.me()
        serverReady.value = data.is_ready
        isAdmin.value = !!data.is_admin
        if (serverReady.value) {
          await connect()
          await loadFriendPubKeys()
        } else {
          await uploadPublicKey()
        }
      } catch {
        serverReady.value = false
      }
    }
  }

  /**
   * Unlock (enter security code)
   */
  async function unlockWithCode(code) {
    if (restoringLocalData.value) return false
    const success = await unlock(code)
    if (success) {
      restoringLocalData.value = true
      isLocked.value = false
      serverReady.value = true
      try {
        await useChatStore().waitForSecurityCleanup()
        await useChatStore().protectLocalData()
        await useChatStore().loadAllMessages()
      } catch (error) {
        lock()
        onLocked()
        throw error
      } finally {
        restoringLocalData.value = false
      }
      // Mark the current session as unlocked (not lost on refresh)
      sessionStorage.setItem('sec_code_unlocked', '1')
      // A correct local security code must unlock even when the network layer
      // fails synchronously. WebSocket reconnection continues independently.
      try {
        await connect()
      } catch (error) {
        console.warn('[identity] reconnect after unlock failed:', error)
      }
      await loadFriendPubKeys()
      // Start auto-lock (clean old one first)
      if (autoLockCleanup) autoLockCleanup()
      autoLockCleanup = startAutoLock(onLocked)
    }
    return success
  }

  /**
   * Lock now
   */
  function lockNow() {
    lock()
    sessionStorage.removeItem('sec_code_unlocked')
    onLocked()
  }

  /**
   * Set security code
   */
  async function enableSecurityCode(code, timeoutHours = 1) {
    await useChatStore().protectLocalData()
    await setupSecurityCode(code)
    hasCode.value = true
    onLocked()
    lockTimeout.value = timeoutHours
    await saveLockConfig(timeoutHours)
  }

  /**
   * Turn off security code
   */
  async function disableSecCode(code) {
    await disableSecurityCode(code)
    hasCode.value = false
    isLocked.value = false
    sessionStorage.removeItem('sec_code_unlocked')
    localStorage.removeItem('sec_code_errors')
    localStorage.removeItem('sec_code_cooldown_end')
    if (autoLockCleanup) {
      autoLockCleanup()
      autoLockCleanup = null
    }
  }

  /**
   * Modify timeout
   */
  async function setLockTimeout(hours) {
    lockTimeout.value = hours
    await saveLockConfig(hours)
  }

  /**
   * Preload friend public key cache
   */
  async function loadFriendPubKeys() {
    try {
      const { data } = await friendApi.getFriends()
      const keys = {}
      const names = {}
      for (const f of data) {
        names[f.chat_id] = f.nickname
        try {
          keys[f.chat_id] = await cacheFriendPubKey(f.chat_id, f.public_key)
        } catch (error) {
          throw error
        }
      }
      friendPubKeys.value = keys
      friendNames.value = names
    } catch (e) {
      console.warn('[identity] load friend pubkeys failed:', e)
    }
  }

  function getFriendPubKey(chatId) {
    return friendPubKeys.value[chatId] || null
  }

  function hasFriendKeyChanged(peerId) {
    return !!friendKeyChanges.value[peerId]
  }

  function getFriendName(chatId) {
    return friendNames.value[chatId] || chatId
  }

  async function cacheFriendPubKey(peerId, pubKey) {
    try {
      const pinned = await pinPeerPublicKey(chatId.value, peerId, pubKey)
      friendPubKeys.value[peerId] = pinned
      return pinned
    } catch (error) {
      if (error.code !== 'peer_key_changed') throw error
      const currentKey = await canonicalPeerPublicKey(pubKey)
      friendPubKeys.value[peerId] = currentKey
      friendKeyChanges.value[peerId] = true
      return currentKey
    }
  }

  /**
   * New initialization
   * @param {string} inviteCode - optional invitation code
   */
  async function initialize(inviteCode = '') {
    const { data } = await identityApi.init(inviteCode)
    localStorage.setItem('session_token', data.session_token)
    localStorage.setItem('chat_id', data.chat_id)
    localStorage.setItem('nickname', data.nickname)
    chatId.value = data.chat_id
    nickname.value = data.nickname

    const pubKeyB64 = await generateAndStoreKeyPair()
    hasPrivateKey.value = true

    await identityApi.uploadPubkey(pubKeyB64)
    serverReady.value = true
    await connect()
    registerPushToken() //Non-blocking, Aurora token is reported after logging in

    return data.inviter_chat_id //Returns the inviter chat_id (if any)
  }

  /**
   * Retry uploading the public key
   */
  async function uploadPublicKey() {
    const kp = await loadKeyPair()
    if (!kp) return
    const { bufToB64 } = await import('src/services/crypto')
    const pubBuf = await crypto.subtle.exportKey('spki', kp.publicKey)
    await identityApi.uploadPubkey(bufToB64(pubBuf))
    serverReady.value = true
  }

  /**
   * Export private key
   */
  async function exportKey() {
    return exportPrivateKey()
  }

  /**
   * Clear local identity (user actively logs out)
   */
  async function clear() {
    await deleteAccountThenClear(() => identityApi.deleteAccount(), clearLocalState)
  }

  // Sign out this device without deleting the server-side identity.
  async function logout() {
    try { await identityApi.logout() } catch (error) {
      // A missing or expired session is already logged out; continue clearing local state.
      if (error?.response?.status !== 401) throw error
    }
    await clearLocalState()
  }

  async function clearLocalState() {
        if (autoLockCleanup) {
          autoLockCleanup()
          autoLockCleanup = null
        }
        sessionStorage.removeItem('sec_code_unlocked')
        localStorage.removeItem('sec_code_errors')
        localStorage.removeItem('sec_code_cooldown_end')
        await clearKeyPair()
        await useChatStore().clearAll()
        clearPendingQueue()
        disconnect()
        localStorage.removeItem('session_token')
        localStorage.removeItem('chat_id')
        localStorage.removeItem('nickname')
        chatId.value = ''
        nickname.value = ''
        isAdmin.value = false
        hasPrivateKey.value = false
        serverReady.value = false
        hasCode.value = false
        isLocked.value = false
        friendPubKeys.value = {}
        friendKeyChanges.value = {}
        pendingRequestCount.value = 0
  }

  async function updateNickname(name) {
    await identityApi.updateNickname(name)
    nickname.value = name
    localStorage.setItem('nickname', name)
  }

  return {
    chatId, nickname, hasPrivateKey, serverReady, isReady, isAdmin,
    isLocked, restoringLocalData, hasCode, lockTimeout,
    friendPubKeys, friendKeyChanges, getFriendPubKey, getFriendName, cacheFriendPubKey, hasFriendKeyChanged,
    pendingRequestCount,
    setPendingRequestCount: (n) => { pendingRequestCount.value = n },
    incPendingRequestCount: () => { pendingRequestCount.value++ },
    refreshPendingRequestCount,
    load, loadFriendPubKeys, initialize, exportKey, clear, logout,
    unlockWithCode, lockNow, enableSecurityCode, disableSecCode, setLockTimeout,
    updateNickname
  }
})
