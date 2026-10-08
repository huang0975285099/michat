<template>
  <q-page ref="pageEl" class="column group-chat-page">
    <div class="header">
      <q-btn flat round dense icon="arrow_back" @click="$router.push('/chats')" />
      <div class="header-info" @click="$router.push(`/group/${groupId}/info`)">
        <div class="header-name">{{ groupName }}</div>
        <div class="header-sub">{{ memberCount }} 成员</div>
      </div>
      <q-btn flat round dense icon="more_vert" @click="$router.push(`/group/${groupId}/info`)" />
    </div>

    <div v-if="dissolved" class="dissolved-notice">
      群已解散
    </div>
    <div v-else-if="removed" class="dissolved-notice">
      你已被移出群聊
    </div>

    <div class="messages-container" ref="messagesContainer">
      <div v-if="messages.length === 0" class="empty-hint">{{ t('chats.emptyHint') }}</div>
      <div
        v-for="(msg, idx) in messages"
        :key="msg.id"
        class="message-row"
        :class="{ mine: msg.mine }"
        :style="{ paddingTop: shouldCompact(messages, idx) ? '2px' : '8px' }"
      >
        <!-- 对方消息：头像在左 -->
        <template v-if="!msg.mine">
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="msg.from" :size="28" class="avatar-side q-mr-xs" />
          <div v-else class="avatar-placeholder" />
          <div class="message-content">
            <div class="message-sender">{{ senderName(msg.from) }}</div>
            <div class="message-bubble">
              <span v-if="msg.text">{{ msg.text }}</span>
              <span v-else-if="msg.decryptionFailed" style="color: #e8463a">[解密失败]</span>
              <span v-else-if="msg.type === 'file'" class="file-msg">📎 {{ msg.filename }} ({{ formatFileSize(msg.filesize) }})</span>
            </div>
          </div>
        </template>
        <!-- 我的消息：头像在最右（row-reverse 下 DOM 靠前的元素显示在右侧） -->
        <template v-else>
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="identity.chatId" :size="28" class="avatar-side q-ml-xs" />
          <div v-else class="avatar-placeholder" />
          <div class="message-content">
            <div class="message-bubble mine">
              <span v-if="msg.text">{{ msg.text }}</span>
              <span v-else-if="msg.decryptionFailed" style="color: #e8463a">[解密失败]</span>
              <span v-else-if="msg.type === 'file'" class="file-msg">📎 {{ msg.filename }} ({{ formatFileSize(msg.filesize) }})</span>
            </div>
            <div class="message-actions" v-if="!dissolved && !removed">
              <q-btn flat dense size="xs" label="撤回" @click="onRecall(msg)" />
            </div>
          </div>
        </template>
      </div>
    </div>

    <div class="composer" v-if="!dissolved && !removed">
      <div v-if="muted" class="muted-notice">
        你已被禁言<span v-if="muteEndTime"> 至 {{ muteEndTime }}</span>
      </div>
      <div v-else class="input-row">
        <q-btn flat round dense icon="attach_file" @click="onPickFile" :disable="!canInput" />
        <q-input
          v-model="inputText"
          dense
          outlined
          :placeholder="t('chat.inputPlaceholder')"
          @keydown.enter.prevent="onSend"
          :disable="!canInput"
          class="message-input"
        />
        <q-btn flat round dense icon="send" @click="onSend" :disable="!canSend" />
      </div>
    </div>
    <input ref="fileInput" type="file" style="display:none" @change="onFileSelected" />
  </q-page>
</template>

<script setup>
import { ref, computed, onActivated, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'src/i18n'
import { useChatStore } from 'src/stores/chat'
import { useGroupStore } from 'src/stores/group'
import { useIdentityStore } from 'src/stores/identity'
import DeterministicAvatar from 'src/components/DeterministicAvatar.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const groupStore = useGroupStore()
const identity = useIdentityStore()

const groupId = route.params.groupId
const inputText = ref('')
const messagesContainer = ref(null)
const fileInput = ref(null)
const pageEl = ref(null)
let heightResizeObserver = null

const messages = computed(() => chatStore.messages[groupId] || [])
const groupName = computed(() => groupStore.getGroupName(groupId))
const memberCount = computed(() => groupStore.getMembers(groupId).length)
const dissolved = computed(() => groupStore.isDissolved(groupId))
const removed = computed(() => groupStore.isRemoved(groupId))
const muted = computed(() => groupStore.amIMuted(groupId))
const muteEndTime = computed(() => {
  const members = groupStore.getMembers(groupId)
  const me = members.find(m => m.chat_id === identity.chatId)
  return me?.muted_until ? new Date(me.muted_until).toLocaleString() : null
})
const canInput = computed(() => !muted.value && !dissolved.value && !removed.value)
const canSend = computed(() => inputText.value.trim().length > 0 && canInput.value)

// 动态计算 q-page 高度：Quasar QPage 默认只设置 min-height，不给确定高度
// 会导致 flex:1 的消息区拿不到固定高度，整页在 body 上滚动、输入框被底部 tab 栏挡住。
// 与 ChatPage.updatePageHeight 相同的做法：视口高度减去实际测量的 header/footer 高度。
function updatePageHeight() {
  const el = pageEl.value?.$el
  if (!el) return
  const header = document.querySelector('.q-header')
  const footer = document.querySelector('.q-footer')
  const headerH = header ? Math.round(header.getBoundingClientRect().height) : 0
  const footerH = footer ? Math.round(footer.getBoundingClientRect().height) : 0
  const viewportHeight = Math.round(window.visualViewport?.height || window.innerHeight)
  el.style.height = `${Math.max(0, viewportHeight - headerH - footerH)}px`
}

onMounted(async () => {
  groupStore.setMyChatId(identity.chatId)
  // 先确定页面高度再加载消息，保证滚动到底部计算正确
  updatePageHeight()
  nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(updatePageHeight)
    })
  })
  // 监听 header/footer 高度变化（如断线提示条的出现/消失）
  const header = document.querySelector('.q-header')
  const footer = document.querySelector('.q-footer')
  if (header || footer) {
    heightResizeObserver = new ResizeObserver(() => updatePageHeight())
    if (header) heightResizeObserver.observe(header)
    if (footer) heightResizeObserver.observe(footer)
  }
  window.addEventListener('resize', updatePageHeight)
  window.visualViewport?.addEventListener('resize', updatePageHeight)
  await groupStore.loadGroupDetail(groupId)
  await chatStore.loadMessages(groupId)
  await nextTick()
  scrollToBottom()
})

onUnmounted(() => {
  heightResizeObserver?.disconnect()
  heightResizeObserver = null
  window.removeEventListener('resize', updatePageHeight)
  window.visualViewport?.removeEventListener('resize', updatePageHeight)
})

onActivated(() => {
  scrollToBottom()
})

function scrollToBottom() {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

async function onSend() {
  const text = inputText.value.trim()
  if (!text) return
  inputText.value = ''
  try {
    await chatStore.sendGroupMessage(groupId, text)
  } catch (e) {
    console.error('[group] send failed', e)
  }
  await nextTick()
  scrollToBottom()
}

async function onRecall(msg) {
  try {
    await chatStore.recallGroupMessage(groupId, msg.id)
  } catch (e) {
    console.warn('recall failed', e)
  }
}

function onPickFile() {
  fileInput.value?.click()
}

async function onFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    await chatStore.sendGroupFile(groupId, file)
    await nextTick()
    scrollToBottom()
  } catch (err) {
    console.error('group file send failed', err)
  }
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
  return Math.round(bytes / (1024 * 1024)) + ' MB'
}

function senderName(chatId) {
  const m = groupStore.getMembers(groupId).find(m => m.chat_id === chatId)
  return m?.nickname || chatId
}

/**
 * 连续消息紧凑显示：同一发送者 60 秒内隐藏头像
 */
function shouldCompact(msgs, idx) {
  if (idx === 0) return false
  const prev = msgs[idx - 1]
  const curr = msgs[idx]
  return prev.mine === curr.mine && prev.from === curr.from && (curr.ts - prev.ts) < 60000
}
</script>

<style scoped>
.group-chat-page { background: #fff; }
.header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(0,0,0,0.08); flex-shrink: 0; }
.header-info { flex: 1; cursor: pointer; }
.header-name { font-weight: 600; font-size: 16px; }
.header-sub { font-size: 12px; color: #888; }
.messages-container { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }
.empty-hint { text-align: center; color: #999; padding: 40px 20px; font-size: 14px; }
.message-row { display: flex; align-items: flex-start; margin-bottom: 0; }
.message-row.mine { flex-direction: row-reverse; }
.message-content { display: flex; flex-direction: column; min-width: 0; max-width: 75%; }
.message-row.mine .message-content { align-items: flex-end; }
.message-sender { font-size: 11px; color: #888; margin-bottom: 2px; }
.message-bubble { padding: 8px 12px; border-radius: 12px; background: #f0f0f0; word-break: break-word; }
.message-bubble.mine { background: #0FDC78; color: white; }
.message-actions { margin-top: 2px; }
.avatar-side { flex-shrink: 0; align-self: flex-start; border-radius: 8px; overflow: hidden; }
.avatar-placeholder { width: 28px; flex-shrink: 0; }
.composer { border-top: 1px solid rgba(0,0,0,0.08); padding: 8px 12px; flex-shrink: 0; }
.input-row { display: flex; align-items: center; gap: 8px; }
.message-input { flex: 1; }
.muted-notice, .dissolved-notice { text-align: center; color: #e8463a; padding: 8px; font-size: 13px; }
.file-msg { font-size: 13px; }
</style>
