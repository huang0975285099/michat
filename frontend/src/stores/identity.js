import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { loadKeyPair, generateAndStoreKeyPair, clearKeyPair, exportPrivateKey, hasSecurityCode, isUnlocked, unlock, lock, startAutoLock, loadLockConfig, saveLockConfig, setupSecurityCode, disableSecurityCode } from 'src/services/crypto'
import { identityApi, friendApi, inviteApi, deviceApi } from 'src/services/api'
import { registerPushToken } from 'src/boot/chat-service'
import { connect } from 'src/services/websocket'
import { useChatStore } from 'src/stores/chat'

export const useIdentityStore = defineStore('identity', () => {
  const chatId = ref(localStorage.getItem('chat_id') || '')
  const nickname = ref(localStorage.getItem('nickname') || '')
  const hasPrivateKey = ref(false)
  const serverReady = ref(false)

  // 安全码锁定状态
  const isLocked = ref(false)        // 当前是否锁定
  const hasCode = ref(false)         // 是否设置了安全码
  const lockTimeout = ref(1/6)       // 超时时间（小时），默认 10 分钟
  let autoLockCleanup = null         // 自动锁定清理函数

  const isReady = computed(() => !!chatId.value && hasPrivateKey.value && serverReady.value)

  // 好友公钥缓存
  const friendPubKeys = ref({})
  // 好友昵称缓存 { chatId -> nickname }
  const friendNames = ref({})
  // 待处理的好友申请数
  const pendingRequestCount = ref(0)

  /**
   * 触发锁定
   */
  function onLocked() {
    isLocked.value = true
    sessionStorage.removeItem('sec_code_unlocked')
  }

  /**
   * 从本地存储和 IndexedDB 恢复状态
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

    // 检查是否设置了安全码
    hasCode.value = await hasSecurityCode()

    if (hasCode.value) {
      // 有安全码：检查是否有私钥缓存（刷新后缓存丢失）
      if (isUnlocked()) {
        // 有缓存：已解锁状态
        hasPrivateKey.value = true
        serverReady.value = true
        isLocked.value = false
        lockTimeout.value = await loadLockConfig()
        sessionStorage.setItem('sec_code_unlocked', '1')
        autoLockCleanup = startAutoLock(onLocked)
        await loadFriendPubKeys()
      } else {
        // 无缓存：需要重新解锁
        hasPrivateKey.value = true
        serverReady.value = true
        isLocked.value = true
        lockTimeout.value = await loadLockConfig()
        sessionStorage.removeItem('sec_code_unlocked')
      }
      return
    }

    // 无安全码：明文模式，直接加载
    const kp = await loadKeyPair()
    hasPrivateKey.value = !!kp

    if (hasPrivateKey.value) {
      try {
        const { data } = await identityApi.me()
        serverReady.value = data.is_ready
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
   * 解锁（输入安全码）
   */
  async function unlockWithCode(code) {
    const success = await unlock(code)
    if (success) {
      isLocked.value = false
      serverReady.value = true
      // 标记当前会话已解锁（刷新不丢失）
      sessionStorage.setItem('sec_code_unlocked', '1')
      await connect()
      await loadFriendPubKeys()
      // 启动自动锁定（先清理旧的）
      if (autoLockCleanup) autoLockCleanup()
      autoLockCleanup = startAutoLock(onLocked)
    }
    return success
  }

  /**
   * 立即锁定
   */
  function lockNow() {
    lock()
    sessionStorage.removeItem('sec_code_unlocked')
    onLocked()
  }

  /**
   * 设置安全码
   */
  async function enableSecurityCode(code, timeoutHours = 1) {
    await setupSecurityCode(code)
    hasCode.value = true
    isLocked.value = true
    lockTimeout.value = timeoutHours
    await saveLockConfig(timeoutHours)
  }

  /**
   * 关闭安全码
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
   * 修改超时时间
   */
  async function setLockTimeout(hours) {
    lockTimeout.value = hours
    await saveLockConfig(hours)
  }

  /**
   * 预加载好友公钥缓存
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
   * 全新初始化
   * @param {string} inviteCode - 可选邀请码
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
    registerPushToken() // 非阻塞，登录后上报极光 token

    return data.inviter_chat_id // 返回邀请者 chat_id（如果有）
  }

  /**
   * 重试上传公钥
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
   * 导出私钥
   */
  async function exportKey() {
    return exportPrivateKey()
  }

  /**
   * 清除本地身份（用户主动注销）
   */
  async function clear() {
    // 清理自动锁定
    if (autoLockCleanup) {
      autoLockCleanup()
      autoLockCleanup = null
    }

    try {
      await deviceApi.remove()
    } catch {
      // 忽略，本地数据照常清除
    }
    try {
      await identityApi.deleteAccount()
    } catch {
      console.warn('[identity] deleteAccount failed, clearing local data anyway')
    }

    sessionStorage.removeItem('sec_code_unlocked')
    localStorage.removeItem('sec_code_errors')
    localStorage.removeItem('sec_code_cooldown_end')

    await clearKeyPair()
    await useChatStore().clearAll()
    localStorage.removeItem('session_token')
    localStorage.removeItem('chat_id')
    localStorage.removeItem('nickname')
    chatId.value = ''
    nickname.value = ''
    hasPrivateKey.value = false
    serverReady.value = false
    hasCode.value = false
    isLocked.value = false
    friendPubKeys.value = {}
  }

  async function updateNickname(name) {
    await identityApi.updateNickname(name)
    nickname.value = name
    localStorage.setItem('nickname', name)
  }

  return {
    chatId, nickname, hasPrivateKey, serverReady, isReady,
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
