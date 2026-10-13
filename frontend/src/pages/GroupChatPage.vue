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

    <div class="messages-container" ref="messagesContainer" @scroll="onMessagesScroll">
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
            <div class="message-sender" v-if="!shouldCompact(messages, idx)">{{ senderName(msg.from) }}</div>
            <div class="message-bubble">
              <div v-if="msg.text" class="message-text">{{ msg.text }}</div>
              <span v-else-if="msg.decryptionFailed" style="color: #e8463a">[解密失败]</span>
              <template v-else-if="msg.type === 'file'">
                <img
                  v-if="isMsgImage(msg) && msg.objectUrl"
                  :src="msg.objectUrl"
                  :alt="msg.filename || t('chat.imageMessage')"
                  class="file-img"
                  @click="openImagePreview(msg)"
                />
                <div v-else class="file-card" :class="msg.mine ? 'file-card-mine' : 'file-card-theirs'">
                  <span class="file-icon">{{ getFileIcon(msg.filetype, msg.filename) }}</span>
                  <div class="file-meta">
                    <div class="file-name">{{ msg.filename }}</div>
                    <div class="file-size">{{ formatFileSize(msg.filesize) }}</div>
                  </div>
                  <button
                    type="button"
                    class="file-dl"
                    :disabled="fileBusy[msg.id]"
                    @click.stop="onDownloadFile(msg)"
                  >
                    <q-icon :name="fileBusy[msg.id] ? 'downloading' : 'download'" size="18px" />
                  </button>
                </div>
              </template>
              <div class="message-meta">{{ formatTime(msg.ts) }}</div>
              <message-action-menu :can-copy="!!msg.text" @copy="copyMessage(msg)" />
            </div>
          </div>
        </template>
        <!-- 我的消息：头像在最右（row-reverse 下 DOM 靠前的元素显示在右侧） -->
        <template v-else>
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="identity.chatId" :size="28" class="avatar-side q-ml-xs" />
          <div v-else class="avatar-placeholder" />
          <div class="message-content">
            <div class="message-bubble mine">
              <div v-if="msg.text" class="message-text">{{ msg.text }}</div>
              <span v-else-if="msg.decryptionFailed" style="color: #e8463a">[解密失败]</span>
              <template v-else-if="msg.type === 'file'">
                <img
                  v-if="isMsgImage(msg) && msg.objectUrl"
                  :src="msg.objectUrl"
                  :alt="msg.filename || t('chat.imageMessage')"
                  class="file-img"
                  @click="openImagePreview(msg)"
                />
                <div v-else class="file-card" :class="msg.mine ? 'file-card-mine' : 'file-card-theirs'">
                  <span class="file-icon">{{ getFileIcon(msg.filetype, msg.filename) }}</span>
                  <div class="file-meta">
                    <div class="file-name">{{ msg.filename }}</div>
                    <div class="file-size">{{ formatFileSize(msg.filesize) }}</div>
                  </div>
                  <button
                    type="button"
                    class="file-dl"
                    :disabled="fileBusy[msg.id]"
                    @click.stop="onDownloadFile(msg)"
                  >
                    <q-icon :name="fileBusy[msg.id] ? 'downloading' : 'download'" size="18px" />
                  </button>
                </div>
              </template>
              <div class="message-meta">{{ formatTime(msg.ts) }}</div>
              <message-action-menu :can-copy="!!msg.text" :can-recall="!dissolved && !removed" @copy="copyMessage(msg)" @recall="onRecall(msg)" />
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
          @keyup.enter="onSend"
          :disable="!canInput"
          class="message-input"
        />
        <q-btn flat round dense icon="send" @click="onSend" :disable="!canSend" />
      </div>
    </div>
    <input ref="fileInput" type="file" style="display:none" @change="onFileSelected" />

    <image-gallery-dialog
      v-model="imagePreview.show"
      :images="galleryImages"
      :start-id="imagePreview.startId"
      @download="downloadGalleryImage"
    />
  </q-page>
</template>

<script setup>
import { ref, computed, watch, onActivated, onDeactivated, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuasar } from 'quasar'
import { useI18n } from 'src/i18n'
import { useChatStore } from 'src/stores/chat'
import { useGroupStore } from 'src/stores/group'
import { useIdentityStore } from 'src/stores/identity'
import DeterministicAvatar from 'src/components/DeterministicAvatar.vue'
import MessageActionMenu from 'src/components/MessageActionMenu.vue'
import ImageGalleryDialog from 'src/components/ImageGalleryDialog.vue'
import { attachmentApi, groupApi } from 'src/services/api.js'
import { downloadOfflineAttachment, acknowledgeGroupAttachment } from 'src/services/offline-attachment.mjs'
import { useChatHistoryWindow } from 'src/composables/useChatHistoryWindow'

const { t } = useI18n()
const $q = useQuasar()
const route = useRoute()
const router = useRouter()
const chatStore = useChatStore()
const groupStore = useGroupStore()
const identity = useIdentityStore()

const groupId = route.params.groupId

// 最大消息长度限制（防止 DoS，与 ChatPage 一致）
const MAX_MESSAGE_LENGTH = 10000

const inputText = ref('')
const messagesContainer = ref(null)
const fileInput = ref(null)
const pageEl = ref(null)
let heightResizeObserver = null
const isPageActive = ref(false)

// 历史窗口：全量消息留在 store（群信息页等依赖全量数组），页面只渲染最近一窗口，
// 滚动到顶部补页——与 ChatPage 共用同一机制（useChatHistoryWindow）
const { visibleMessages, hasOlder, loadingOlder, loadOlder } = useChatHistoryWindow(chatStore, groupId)
const messages = visibleMessages

// 图片预览画廊（与 ChatPage 一致）
const imagePreview = ref({ show: false, startId: '' })
const galleryImages = computed(() => messages.value
  .filter(message => isMsgImage(message) && message.objectUrl)
  .map(message => ({
    id: message.id,
    url: message.objectUrl,
    name: message.filename || t('chat.imageMessage'),
  })))

function openImagePreview(message) {
  if (!message?.id || !message.objectUrl) return
  imagePreview.value = { show: true, startId: message.id }
}

function downloadGalleryImage(image) {
  const message = messages.value.find(item => item.id === image?.id)
  if (message) onDownloadFile(message)
}

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
  // 历史窗口化加载：与 ChatPage 同一入口（冷路径全量、热路径只补窗口内 file blob）
  await chatStore.ensureMessagesLoaded(groupId)
  // 进入群聊时把已加载的未读消息标为已读（群聊没有服务端已读回执，只清本地红点）
  chatStore.markAsReadLocal(groupId).catch(() => {})
  await nextTick()
  scrollToBottom()
  // 容器高度在 updatePageHeight 的最终 rAF 后才稳定，再校正一次保证停在最新消息
  requestAnimationFrame(() => {
    requestAnimationFrame(scrollToBottom)
  })
})

onUnmounted(() => {
  heightResizeObserver?.disconnect()
  heightResizeObserver = null
  window.removeEventListener('resize', updatePageHeight)
  window.visualViewport?.removeEventListener('resize', updatePageHeight)
})

// 回到本页时：仅当离开时就在底部附近才钉底，否则保留用户上翻历史的阅读位置
onActivated(() => {
  isPageActive.value = true
  chatStore.markAsReadLocal(groupId).catch(() => {})
  nextTick(() => requestAnimationFrame(() => {
    if (isNearBottom()) scrollToBottom()
  }))
})

onDeactivated(() => {
  isPageActive.value = false
})

function scrollToBottom() {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

// 用户是否已在（接近）底部：仅在此情况下新消息才自动跟随，避免打断上翻历史
function isNearBottom() {
  const el = messagesContainer.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 200
}

// 钉底状态由 scroll 事件维护（始终反映用户最近一次滚动后的位置）。
// 比 watch 回调里现测 isNearBottom() 更可靠：pre-flush 的 watch 在 DOM 更新前执行，
// 测到的是旧布局，内容增长时会误判
const pinnedToBottom = ref(true)

function onMessagesScroll() {
  pinnedToBottom.value = isNearBottom()
  // 接近顶部且有更旧历史时补页（80px 阈值；内容不足一屏时没有滚动事件，天然不触发）
  const el = messagesContainer.value
  if (el && el.scrollTop <= 80 && hasOlder.value) {
    prependHistory()
  }
}

// ---- 历史消息补页（与 ChatPage 共用同一窗口机制）----
// 普通滚动容器：补页插在顶部会使内容整体下移，用 scrollHeight 差值补偿 scrollTop，
// 保持原顶部消息贴在视口上沿，阅读位置不跳动
let prependingHistory = false  // 补页期间抑制"新消息追底"的 watch（长度增长会被误判为追加）

async function prependHistory() {
  if (loadingOlder.value || prependingHistory || !hasOlder.value) return
  prependingHistory = true
  try {
    const el = messagesContainer.value
    const prevScrollTop = el ? el.scrollTop : 0
    const prevScrollHeight = el ? el.scrollHeight : 0
    const added = await loadOlder()
    if (added > 0) {
      await nextTick()
      const el2 = messagesContainer.value
      if (el2) {
        el2.scrollTop = prevScrollTop + (el2.scrollHeight - prevScrollHeight)
      }
    }
  } finally {
    // watch 是 pre-flush：赋值当帧先执行（此时标志仍为 true），下一帧再释放
    requestAnimationFrame(() => { prependingHistory = false })
  }
}

// 新消息到达时自动跟随到底（与单聊行为一致）：用户在底部或最新一条是自己发的才滚动，
// 正在上翻历史时不强制拉回，防止阅读被打断。
// 注意监听的是全量数组长度：窗口化后新消息追加时窗口滑动、可见长度不变，
// 若监听可见长度，新消息将不会自动跟随。
watch(
  () => (chatStore.messages[groupId] || []).length,
  () => {
    if (prependingHistory) return
    const list = messages.value
    const last = list[list.length - 1]
    if (pinnedToBottom.value || (last && last.mine)) {
      nextTick(scrollToBottom)
    }
    // 群聊没有服务端已读回执，只在本地清红点；切到后台时不清，避免没看就消失
    if (isPageActive.value) {
      chatStore.markAsReadLocal(groupId).catch(() => {})
    }
  }
)

// ── 群文件下载 ──
const fileBusy = ref({})

async function onDownloadFile(msg) {
  if (fileBusy.value[msg.id]) return
  const meta = msg.offlineAttachment
  if (!meta?.attachmentId) return
  fileBusy.value[msg.id] = true
  try {
    const blob = await downloadOfflineAttachment(meta, { api: attachmentApi })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = msg.filename || 'file'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    // Acknowledge so the server can release the attachment once all members have downloaded
    await acknowledgeGroupAttachment(meta, { api: groupApi }).catch(e => {
      console.warn('[group] attachment ack failed (server expiry remains the fallback)', e)
    })
  } catch (e) {
    console.error('[group] file download failed', e)
  } finally {
    fileBusy.value[msg.id] = false
  }
}

async function onSend(event) {
  // 中文等输入法按回车确认候选词时不能触发发送（与 ChatPage.sendMsg 一致）
  if (event?.isComposing || event?.keyCode === 229) return
  const text = inputText.value.trim()
  if (!text) return
  // 安全检查：消息长度限制
  if (text.length > MAX_MESSAGE_LENGTH) {
    $q.notify({ type: 'warning', message: t('chat.messageTooLong', { count: MAX_MESSAGE_LENGTH }) })
    return
  }
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

async function copyMessage(msg) {
  if (!msg.text) return
  try {
    await navigator.clipboard.writeText(msg.text)
  } catch (e) {
    console.warn('copy failed', e)
  }
}

function onPickFile() {
  fileInput.value?.click()
}

function attachmentFailureText(error) {
  if (error?.code === 'attachment_file_too_large') {
    return t('chat.attachmentFileTooLarge', {
      size: formatFileSize(error.fileSize || 0),
      max: formatFileSize(error.maxBytes || 500 * 1024 * 1024),
    })
  }
  if (error?.code === 'attachment_file_empty') return t('chat.attachmentFileEmpty')
  if (error?.code === 'attachment_filename_invalid') return t('chat.attachmentFilenameInvalid')
  if (error?.code === 'attachment_filetype_invalid') return t('chat.attachmentFiletypeInvalid')
  if (error?.code === 'attachment_filetype_unsupported') return t('chat.attachmentFiletypeUnsupported')
  return error?.message || t('chat.unknownError')
}

async function onFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    chatStore.validateFile(file)
  } catch (error) {
    $q.notify({ type: 'warning', message: attachmentFailureText(error) })
    return
  }
  try {
    await chatStore.sendGroupFile(groupId, file)
    await nextTick()
    scrollToBottom()
  } catch (err) {
    console.error('group file send failed', err)
    $q.notify({ type: 'negative', message: t('chat.fileSendFailed', { error: attachmentFailureText(err) }) })
  }
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
  return Math.round(bytes / (1024 * 1024)) + ' MB'
}

function isMsgImage(msg) {
  return msg.filetype?.startsWith('image/')
}

function getFileIcon(filetype, filename) {
  const ext = filename?.split('.').pop()?.toLowerCase() ?? ''
  if (filetype?.startsWith('image/')) return '🖼️'
  if (filetype?.startsWith('video/')) return '🎬'
  if (filetype?.startsWith('audio/')) return '🎵'
  if (filetype?.includes('pdf')) return '📄'
  if (filetype?.includes('word') || filetype?.includes('document')) return '📝'
  if (filetype?.includes('excel') || filetype?.includes('sheet')) return '📊'
  if (filetype?.includes('powerpoint') || filetype?.includes('presentation')) return '📋'
  if (filetype?.includes('zip') || filetype?.includes('rar') || filetype?.includes('7z') || filetype?.includes('tar') || filetype?.includes('gzip')) return '🗜️'
  if (filetype?.includes('android') || filetype?.includes('apk')) return '🤖'
  if (['txt', 'md', 'json', 'xml', 'csv', 'log'].includes(ext)) return '📃'
  return '📎'
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
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
.group-chat-page { background: #f5f7fa; }
.header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(0,0,0,0.08); flex-shrink: 0; background: #fff; }
.header-info { flex: 1; cursor: pointer; }
.header-name { font-weight: 600; font-size: 16px; }
.header-sub { font-size: 12px; color: #888; }
.messages-container { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 12px; }
.empty-hint { text-align: center; color: #999; padding: 40px 20px; font-size: 14px; }
.message-row { display: flex; align-items: flex-start; margin-bottom: 0; }
.message-row.mine { flex-direction: row-reverse; }
.message-content { display: flex; flex-direction: column; min-width: 0; max-width: 80%; }
.message-row:not(.mine) .message-content { align-items: flex-start; }
.message-row.mine .message-content { align-items: flex-end; }
.message-sender { font-size: 11px; color: #888; margin-bottom: 2px; }
.message-meta { font-size: 11px; color: #888; margin-top: 4px; line-height: 1.2; }
.message-bubble.mine .message-meta { text-align: right; }
.message-bubble {
  display: inline-block;
  vertical-align: top;
  padding: 8px;
  border-radius: 5px 16px 16px 16px;
  background: #f0f0f0;
  color: #111;
  min-width: 0;
  overflow-wrap: anywhere;
  box-shadow: 0 3px 10px rgba(0,0,0,0.035);
}
.message-bubble.mine {
  background: #95EC69;
  border-radius: 16px 5px 16px 16px;
  box-shadow: 0 3px 10px rgba(149, 236, 105, 0.35);
}
.message-text { white-space: pre-wrap; line-height: 1.5; }
.file-img {
  width: auto;
  max-width: 100%;
  max-height: min(42vh, 360px);
  border-radius: 10px;
  display: block;
  object-fit: contain;
  background: rgba(0,0,0,0.04);
  cursor: zoom-in;
}
.avatar-side { flex-shrink: 0; align-self: flex-start; border-radius: 8px; overflow: hidden; }
.avatar-placeholder { width: 28px; flex-shrink: 0; }
.composer { border-top: 1px solid rgba(0,0,0,0.08); padding: 8px 12px; flex-shrink: 0; background: #fff; }
.input-row { display: flex; align-items: center; gap: 8px; }
.message-input { flex: 1; }
.muted-notice, .dissolved-notice { text-align: center; color: #e8463a; padding: 8px; font-size: 13px; }
.file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  min-width: 180px;
  max-width: min(100%, 280px);
  background: #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}
.file-card-mine { background: rgba(255,255,255,0.92); }
.file-card-theirs { background: #fff; }
.file-icon { font-size: 32px; flex-shrink: 0; line-height: 1; }
.file-meta { flex: 1; min-width: 0; }
.file-name { font-size: 13px; font-weight: 500; color: #111; word-break: break-all; line-height: 1.3; }
.file-size { font-size: 11px; color: #888; margin-top: 3px; }
.file-dl {
  width: 34px;
  height: 34px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: rgba(25, 118, 210, 0.1);
  color: #1976d2;
  flex-shrink: 0;
  cursor: pointer;
}
.file-dl:hover { background: rgba(25, 118, 210, 0.18); }
.file-dl:disabled { cursor: wait; opacity: 0.7; }
</style>
