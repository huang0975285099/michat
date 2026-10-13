import { computed, ref } from 'vue'

/**
 * 聊天历史窗口（单聊/群聊共用同一机制）：
 * store 持有全量消息数组（聊天列表未读数/预览等依赖全量），页面只渲染
 * 窗口内的最近若干条，滚动到顶部时补页。两个页面的差异只在锚定策略——
 * 虚拟滚动用 scrollTo(index, 'start-force') 重锚定，普通容器用
 * scrollHeight 差值补偿——由各自页面实现，补页状态在这里统一管理。
 *
 * @param {ReturnType<import('src/stores/chat').useChatStore>} chatStore
 * @param {string} chatId 会话 ID（单聊好友 chatId / 群 groupId）
 */
export function useChatHistoryWindow(chatStore, chatId) {
  const loadingOlder = ref(false)

  // 页面渲染用的窗口切片（store 全量数组的最近 win 条）
  const visibleMessages = computed(() => chatStore.getVisibleMessages(chatId))
  const hasOlder = computed(() => chatStore.hasOlderMessages(chatId))

  /**
   * 补一页历史，返回新增条数（0 表示已到最早）。
   * 并发触发（滚动事件高频到达）由 loadingOlder 挡住，只放行一次。
   */
  async function loadOlder() {
    if (loadingOlder.value || !chatStore.hasOlderMessages(chatId)) return 0
    loadingOlder.value = true
    try {
      return await chatStore.loadOlderMessages(chatId)
    } finally {
      loadingOlder.value = false
    }
  }

  return { visibleMessages, hasOlder, loadingOlder, loadOlder }
}
