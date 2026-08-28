import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { loadKeyPair, generateAndStoreKeyPair, clearKeyPair, exportPrivateKey, hasSecurityCode, isUnlocked, unlock, lock, startAutoLock, loadLockConfig, saveLockConfig, setupSecurityCode, disableSecurityCode } from 'src/services/crypto'
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
  const hasCode = ref(false)         //Is a security code set?
  const lockTimeout = ref(1/6)       //Timeout (hours), default 10 minutes
  let autoLockCleanup = null         //Automatic lock cleaning function

  const isReady = computed(() => !!chatId.value && hasPrivateKey.value && serverReady.value)

  // Friend public key cache
  const friendPubKeys = ref({})
  // Friend nickname cache { chatId -> nickname }
  const friendNames = ref({})
  // Number of friend requests pending
  const pendingRequestCount = ref(0)

  /**
   * trigger lock
   */
  function onLocked() {
    isLocked.value = true
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
    const success = await unlock(code)
    if (success) {
      isLocked.value = false
      serverReady.value = true
      // Mark the current session as unlocked (not lost on refresh)
      sessionStorage.setItem('sec_code_unlocked', '1')
      await connect()
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
    await setupSecurityCode(code)
    hasCode.value = true
    isLocked.value = true
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
        keys[f.chat_id] = f.public_key
        names[f.chat_id] = f.nickname
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

  function getFriendName(chatId) {
    return friendNames.value[chatId] || chatId
  }

  function cacheFriendPubKey(chatId, pubKey) {
    friendPubKeys.value[chatId] = pubKey
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
    await deleteAccountThenClear(
      () => identityApi.deleteAccount(),
      async () => {
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
      },
    )
  }

  async function updateNickname(name) {
    await identityApi.updateNickname(name)
    nickname.value = name
    localStorage.setItem('nickname', name)
  }

  return {
    chatId, nickname, hasPrivateKey, serverReady, isReady, isAdmin,
    isLocked, hasCode, lockTimeout,
    friendPubKeys, getFriendPubKey, getFriendName, cacheFriendPubKey,
    pendingRequestCount,
    setPendingRequestCount: (n) => { pendingRequestCount.value = n },
    incPendingRequestCount: () => { pendingRequestCount.value++ },
    load, loadFriendPubKeys, initialize, exportKey, clear,
    unlockWithCode, lockNow, enableSecurityCode, disableSecCode, setLockTimeout,
    updateNickname
  }
})
