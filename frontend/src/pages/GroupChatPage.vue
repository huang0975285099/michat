<template>
  <q-page ref="pageEl" class="column group-chat-page">
    <div class="header">
      <q-btn flat round dense icon="arrow_back" :aria-label="t('nav.chats')" @click="$router.push('/chats')" />
      <deterministic-avatar :seed="groupId" :size="36" class="header-avatar" />
      <div class="header-info" @click="$router.push(`/group/${groupId}/info`)">
        <div class="header-name">{{ groupName }}</div>
        <div class="header-sub">{{ t('groups.memberCount', { count: memberCount }) }}</div>
      </div>
      <q-btn flat round dense icon="more_vert" :aria-label="t('chat.more')" @click="$router.push(`/group/${groupId}/info`)" />
      <q-btn flat round dense icon="delete_sweep" class="header-clear" :aria-label="t('chat.clearTitle')" @click="clearHistory" />
    </div>

    <div v-if="dissolved" class="dissolved-notice">
      {{ t('groups.dissolved') }}
    </div>
    <div v-else-if="removed" class="dissolved-notice">
      {{ t('groups.removed') }}
    </div>

    <div class="messages-container" ref="messagesContainer" @scroll="onMessagesScroll">
      <div v-if="messages.length === 0" class="empty-hint">{{ t('groups.noMessages') }}</div>
      <div
        v-for="(msg, idx) in messages"
        :key="msg.id"
        :data-message-id="msg.id"
        class="message-row"
        :class="{ mine: msg.mine, 'message-target-highlight': highlightedMessageId === msg.id }"
        :style="{ paddingTop: shouldCompact(messages, idx) ? '2px' : '8px' }"
      >
        <!-- 对方消息：头像在左 -->
        <template v-if="!msg.mine">
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="msg.from" :size="28" class="avatar-side q-mr-xs" />
          <div v-else class="avatar-placeholder" />
          <div class="message-content">
            <div class="message-sender" v-if="!shouldCompact(messages, idx)">{{ senderName(msg.from) }}</div>
            <div class="message-bubble">
              <button v-if="msg.reply" type="button" class="message-reply-quote" @click.stop="scrollToRepliedMessage(msg.reply)">
                <span class="message-reply-author">{{ replySenderName(msg.reply) }}</span>
                <span class="message-reply-preview">{{ replyPreviewText(msg.reply) }}</span>
              </button>
              <div v-if="msg.text" class="message-text">{{ msg.text }}</div>
              <span v-else-if="msg.decryptionFailed" class="decryption-error">{{ t('chat.decryptionFailed') }}</span>
              <template v-else-if="msg.type === 'file'">
                <img
                  v-if="isMsgImage(msg) && msg.objectUrl"
                  :src="msg.objectUrl"
                  :alt="msg.filename || t('chat.imageMessage')"
                  class="file-img"
                  @click="openImagePreview(msg)"
                />
                <div v-else class="file-card file-card-theirs" :class="{ 'file-card-image': isMsgImage(msg) }" @click="onPreviewFile(msg)">
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
              <message-action-menu :can-reply="canReply(msg)" :can-copy="canCopy(msg)" :can-delete="canDelete(msg)" @reply="startReply(msg)" @copy="copyMessage(msg)" @delete="deleteMessage(msg)" />
            </div>
          </div>
        </template>
        <!-- 我的消息：头像在最右（row-reverse 下 DOM 靠前的元素显示在右侧） -->
        <template v-else>
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="identity.chatId" :size="28" class="avatar-side q-ml-xs" />
          <div v-else class="avatar-placeholder" />
          <div class="message-content">
            <div class="message-bubble mine">
              <button v-if="msg.reply" type="button" class="message-reply-quote" @click.stop="scrollToRepliedMessage(msg.reply)">
                <span class="message-reply-author">{{ replySenderName(msg.reply) }}</span>
                <span class="message-reply-preview">{{ replyPreviewText(msg.reply) }}</span>
              </button>
              <div v-if="msg.text" class="message-text">{{ msg.text }}</div>
              <span v-else-if="msg.decryptionFailed" class="decryption-error">{{ t('chat.decryptionFailed') }}</span>
              <template v-else-if="msg.type === 'file'">
                <img
                  v-if="isMsgImage(msg) && msg.objectUrl"
                  :src="msg.objectUrl"
                  :alt="msg.filename || t('chat.imageMessage')"
                  class="file-img"
                  @click="openImagePreview(msg)"
                />
                <div v-else class="file-card file-card-mine" :class="{ 'file-card-image': isMsgImage(msg) }" @click="onPreviewFile(msg)">
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
              <div class="message-meta">
                {{ formatTime(msg.ts) }}
                <q-icon v-if="msg.status === 'pending'" name="schedule" size="13px"><q-tooltip>{{ t('chat.sending') }}</q-tooltip></q-icon>
                <q-icon v-else-if="msg.status === 'queued'" name="cloud_upload" size="13px"><q-tooltip>{{ t('chat.queued') }}</q-tooltip></q-icon>
                <q-icon v-else-if="msg.status === 'failed'" name="error_outline" size="13px"><q-tooltip>{{ t('chat.messageSendFailed') }}</q-tooltip></q-icon>
              </div>
              <message-action-menu :can-reply="canReply(msg)" :can-copy="canCopy(msg)" :can-delete="canDelete(msg)" :can-recall="canRecall(msg)" @reply="startReply(msg)" @copy="copyMessage(msg)" @delete="deleteMessage(msg)" @recall="onRecall(msg)" />
            </div>
          </div>
        </template>
      </div>
    </div>

    <div v-if="selectedImages.length || imageProcessing.active || imageSending.active" class="image-selection-tray">
      <div class="image-selection-header">
        <span>{{ t('chat.sendImages', { count: selectedImages.length }) }}</span>
        <q-btn v-if="!imageProcessing.active && !imageSending.active" flat dense no-caps :label="t('chat.clearImages')" @click="clearSelectedImages" />
      </div>
      <div v-if="selectedImages.length && !imageSending.active" class="image-send-options" role="group" :aria-label="t('chat.imageSendQuality')">
        <button type="button" :disabled="imageProcessing.active" :class="{ active: imageSendMode === 'high_quality' }" @click="imageSendMode = 'high_quality'">{{ t('chat.highQuality') }}</button>
        <button type="button" :disabled="imageProcessing.active" :class="{ active: imageSendMode === 'original' }" @click="imageSendMode = 'original'">{{ t('chat.originalImage') }}</button>
      </div>
      <div v-if="imageOriginalOversize" class="image-original-warning">{{ t('chat.originalImageTooLarge', { count: selectedImages.filter(item => item.originalFile.size > MAX_IMAGE_FILE_BYTES).length, maxSize: formatFileSize(MAX_IMAGE_FILE_BYTES) }) }}</div>
      <div v-if="selectedImages.length" class="image-selection-list">
        <div v-for="item in selectedImages" :key="item.id" class="image-selection-item">
          <img :src="item.previewUrl" :alt="item.originalFile.name" />
          <button v-if="!imageSending.active && !imageProcessing.active" type="button" class="image-selection-remove" :aria-label="t('chat.removeImage', { name: item.originalFile.name })" @click="removeSelectedImage(item.id)"><q-icon name="close" size="16px" /></button>
          <span class="image-selection-name">{{ item.originalFile.name }}</span>
        </div>
      </div>
      <div v-if="imageProcessing.active || imageSending.active" class="image-batch-progress">
        {{ imageProcessing.active ? t('chat.processingImages', { current: imageProcessing.current, total: imageProcessing.total }) : t('chat.sendingImages', { current: imageSending.current, total: imageSending.total }) }}
        <q-linear-progress indeterminate rounded color="primary" />
      </div>
      <div v-else class="image-selection-footer">
        <span>{{ t('chat.imageSelectionHint') }}</span>
        <q-btn unelevated no-caps rounded color="primary" icon="send" :label="t('chat.sendImages', { count: selectedImages.length })" :disable="!canInput || imageOriginalOversize" @click="sendSelectedImages" />
      </div>
    </div>
    <div class="composer" v-if="!dissolved && !removed">
      <div v-if="muted" class="muted-notice">
        {{ t('groups.muted') }}<span v-if="muteEndTime"> {{ t('groups.mutedUntil', { time: muteEndTime }) }}</span>
      </div>
      <template v-else>
      <div v-if="replyTarget" class="reply-composer-bar">
        <q-icon name="reply" size="19px" color="primary" />
        <div class="reply-composer-content">
          <div class="reply-composer-title">{{ t('chat.replyingTo', { name: replySenderName(replyTarget) }) }}</div>
          <div class="reply-composer-preview">{{ replyPreviewText(replyTarget) }}</div>
        </div>
        <q-btn flat round dense icon="close" size="sm" :aria-label="t('chat.cancelReply')" @click="cancelReply" />
      </div>
      <div class="input-row">
        <q-input
          ref="inputEl"
          v-model="inputText"
          dense
          outlined
          rounded
          :placeholder="t('chat.inputPlaceholder')"
          @keyup.enter="onSend"
          @keyup.esc="cancelReply"
          @paste="onComposerPaste"
          @focus="morePanelOpen = false"
          :disable="!canInput"
          class="message-input"
        />
        <q-btn round flat dense icon="sentiment_satisfied_alt" color="grey-7" :aria-label="t('chat.emoji')">
          <q-menu anchor="top right" self="bottom right" :offset="[0, 8]" max-height="260px">
            <div class="emoji-menu">
              <q-tabs v-model="emojiTab" dense align="justify" class="bg-grey-2 text-grey-8" indicator-color="primary">
                <q-tab v-for="category in emojiData" :key="category.name" :name="category.name" :label="category.icon" />
              </q-tabs>
              <div class="emoji-list">
                <span v-for="(emoji, emojiIndex) in currentEmojis" :key="emojiTab + '-' + emojiIndex" class="emoji-item" @click="insertEmoji(emoji)">{{ emoji }}</span>
              </div>
            </div>
          </q-menu>
        </q-btn>
        <q-btn v-if="canSend" round unelevated dense color="primary" icon="send" :loading="sending" :aria-label="t('chat.send')" @click="onSend" />
        <q-btn v-else round flat dense :icon="morePanelOpen ? 'close' : 'add'" color="grey-7" :aria-label="t('chat.more')" @click="toggleMorePanel" />
      </div>
      <q-slide-transition>
        <div v-show="morePanelOpen" class="composer-more-panel">
          <button type="button" class="composer-more-action" :disabled="sending || imageProcessing.active || imageSending.active" @click="onPickImage">
            <span class="composer-more-icon"><q-icon name="photo_library" size="26px" /></span>
            <span>{{ t('chat.images') }}</span>
            <small>{{ t('chat.imagePickerHint') }}</small>
          </button>
          <button type="button" class="composer-more-action" :disabled="sending || imageProcessing.active || imageSending.active" @click="onPickFile">
            <span class="composer-more-icon"><q-icon name="attach_file" size="26px" /></span>
            <span>{{ t('chat.file') }}</span>
            <small>{{ t('chat.maxFileSize') }}</small>
          </button>
        </div>
      </q-slide-transition>
      </template>
    </div>
    <input ref="fileInput" type="file" style="display:none" @change="onFileSelected" />
    <input ref="imageInput" type="file" multiple accept=".jpg,.jpeg,.png,.gif,.webp,.bmp,image/jpeg,image/png,image/gif,image/webp,image/bmp" style="display:none" @change="onImagesSelected" />

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
import { copyToClipboard, useQuasar } from 'quasar'
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
import { normalizeReplyReference } from 'src/services/chat-message-content.mjs'
import { emojiData } from 'src/services/chat-emoji.mjs'
import { compressImageForSending } from 'src/services/image-compression.mjs'
import { extractClipboardImageFiles, imageSelectionKey, inferImageMimeType, mergeImageSelection, MAX_IMAGE_BATCH_BYTES, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_SELECTION, MAX_IMAGE_SOURCE_BYTES } from 'src/services/image-selection.mjs'
import { saveChunkReaderWithBrowserPicker, saveChunkReaderWithCapacitor, saveObjectUrlWithTauri, triggerBrowserDownload } from 'src/services/file-download.mjs'
import { isCapacitor, isTauri } from 'src/services/platform.js'
import { getServerNow } from 'src/services/websocket.js'

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
const inputEl = ref(null)
const sending = ref(false)
const replyTarget = ref(null)
const highlightedMessageId = ref(null)
const emojiTab = ref('face')
const currentEmojis = computed(() => emojiData.find(category => category.name === emojiTab.value)?.emojis ?? [])
const morePanelOpen = ref(false)
const selectedImages = ref([])
const imageSendMode = ref('high_quality')
const imageProcessing = ref({ active: false, current: 0, total: 0 })
const imageSending = ref({ active: false, current: 0, total: 0 })
const imageOriginalOversize = computed(() => imageSendMode.value === 'original' && selectedImages.value.some(item => item.originalFile.size > MAX_IMAGE_FILE_BYTES))
const messagesContainer = ref(null)
const fileInput = ref(null)
const imageInput = ref(null)
const previewUrls = new Map()
const pageEl = ref(null)
let heightResizeObserver = null
let highlightTimer = null
let pageUnmounted = false
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
const canSend = computed(() => inputText.value.trim().length > 0 && canInput.value && !sending.value)

function canReply(message) {
  return Boolean(message?.id && !message.decryptionFailed && canInput.value)
}

function canCopy(message) {
  return Boolean(message?.type !== 'file' && typeof message?.text === 'string' && !message.decryptionFailed)
}

function canDelete(message) {
  return Boolean(message?.id && message.status !== 'pending')
}

function canRecall(message) {
  return Boolean(message?.mine && !dissolved.value && !removed.value && message.status === 'sent' &&
    Number.isFinite(message.ts) && getServerNow() - message.ts < 144 * 60 * 60 * 1000)
}

function replySenderName(reply) {
  return reply?.senderId === identity.chatId ? t('chat.you') : senderName(reply?.senderId)
}

function replyPreviewText(reply) {
  if (!reply) return ''
  if (reply.kind === 'image') return reply.preview || t('chat.imageMessage')
  if (reply.kind === 'video') return reply.preview || t('chat.videoMessage')
  if (reply.kind === 'file') return reply.preview || t('chat.fileMessage')
  return reply.preview || t('chat.originalUnavailable')
}

function startReply(message) {
  if (!canReply(message)) return
  const kind = message.type === 'file'
    ? isMsgImage(message) ? 'image' : message.filetype?.startsWith('video/') ? 'video' : 'file'
    : 'text'
  replyTarget.value = normalizeReplyReference({
    messageId: message.id,
    senderId: message.mine ? identity.chatId : message.from,
    kind,
    preview: kind === 'text' ? message.text : message.filename || '',
  })
  morePanelOpen.value = false
  nextTick(() => inputEl.value?.focus?.())
}

function cancelReply() {
  replyTarget.value = null
}

async function scrollToRepliedMessage(reply) {
  const full = chatStore.getMessages(groupId)
  const index = full.findIndex(message => message.id === reply?.messageId)
  if (index < 0) {
    $q.notify({ type: 'info', message: t('chat.originalNotFound'), timeout: 1800 })
    return
  }
  await chatStore.ensureHistoryWindowAtLeast(groupId, full.length - index)
  await nextTick()
  const row = Array.from(messagesContainer.value?.querySelectorAll('[data-message-id]') || [])
    .find(element => element.dataset.messageId === reply.messageId)
  row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  highlightedMessageId.value = reply.messageId
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlightedMessageId.value = null }, 1600)
}

function insertEmoji(emoji) {
  const native = inputEl.value?.getNativeElement?.()
  const input = native?.matches?.('input, textarea') ? native : native?.querySelector?.('input, textarea')
  if (!input) {
    inputText.value += emoji
    return
  }
  const start = input.selectionStart ?? inputText.value.length
  const end = input.selectionEnd ?? inputText.value.length
  inputText.value = inputText.value.slice(0, start) + emoji + inputText.value.slice(end)
  nextTick(() => {
    input.focus()
    input.setSelectionRange(start + emoji.length, start + emoji.length)
  })
}

function toggleMorePanel() {
  morePanelOpen.value = !morePanelOpen.value
  if (pinnedToBottom.value) nextTick(scrollToBottom)
}

function onPickImage() {
  morePanelOpen.value = false
  imageInput.value?.click()
}

function disposeSelectedImage(item) {
  URL.revokeObjectURL(item.previewUrl)
}

function removeSelectedImage(id) {
  if (imageProcessing.value.active || imageSending.value.active) return
  const index = selectedImages.value.findIndex(item => item.id === id)
  if (index < 0) return
  disposeSelectedImage(selectedImages.value.splice(index, 1)[0])
}

function clearSelectedImages() {
  if (imageProcessing.value.active || imageSending.value.active) return
  selectedImages.value.forEach(disposeSelectedImage)
  selectedImages.value = []
}

function normalizedImageFile(file) {
  if (file.type) return file
  const type = inferImageMimeType(file.name)
  return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file
}

function notifyImageRejections(rejected) {
  const keys = {
    not_image: 'imageRejectedType',
    file_size: 'imageRejectedSourceSize',
    count: 'imageRejectedCount',
    total_size: 'imageRejectedTotalSize',
  }
  const counts = new Map()
  for (const item of rejected) {
    if (item.reason === 'duplicate') continue
    counts.set(item.reason, (counts.get(item.reason) || 0) + 1)
  }
  if (!counts.size) return
  const message = [...counts.entries()].map(([reason, count]) => t(`chat.${keys[reason] || 'imageRejectedType'}`, {
    count,
    maxCount: MAX_IMAGE_SELECTION,
    maxSize: formatFileSize(MAX_IMAGE_FILE_BYTES),
    maxSource: formatFileSize(MAX_IMAGE_SOURCE_BYTES),
    maxTotal: formatFileSize(MAX_IMAGE_BATCH_BYTES),
  })).join('; ')
  $q.notify({ type: 'warning', message })
}

async function addSelectedImages(files) {
  if (imageProcessing.value.active || imageSending.value.active || !canInput.value) return
  const existing = new Map(selectedImages.value.map(item => [imageSelectionKey(item.originalFile), item]))
  const merged = mergeImageSelection(selectedImages.value.map(item => item.originalFile), Array.from(files || [], normalizedImageFile))
  const next = []
  imageProcessing.value = { active: true, current: 0, total: merged.files.length - existing.size }
  try {
    for (const file of merged.files) {
      const item = existing.get(imageSelectionKey(file))
      if (item) {
        next.push(item)
        continue
      }
      if (pageUnmounted) break
      imageProcessing.value.current++
      try {
        const prepared = await compressImageForSending(file)
        if (prepared.file.size > MAX_IMAGE_FILE_BYTES) throw new Error(t('chat.attachmentFileTooLarge', { size: formatFileSize(prepared.file.size), max: formatFileSize(MAX_IMAGE_FILE_BYTES) }))
        chatStore.validateFile(prepared.file)
        next.push({ id: crypto.randomUUID(), originalFile: file, preparedFile: prepared.file, previewUrl: URL.createObjectURL(prepared.file) })
      } catch (error) {
        if (error?.code !== 'dimensions_too_large' && file.size <= MAX_IMAGE_FILE_BYTES) {
          try {
            chatStore.validateFile(file)
            next.push({ id: crypto.randomUUID(), originalFile: file, preparedFile: file, previewUrl: URL.createObjectURL(file) })
            continue
          } catch {}
        }
        $q.notify({ type: 'warning', message: attachmentFailureText(error) })
      }
    }
  } finally {
    imageProcessing.value = { active: false, current: 0, total: 0 }
  }
  if (pageUnmounted) {
    next.forEach(disposeSelectedImage)
    return
  }
  selectedImages.value = next
  notifyImageRejections(merged.rejected)
}

async function onImagesSelected(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  await addSelectedImages(files)
}

async function onComposerPaste(event) {
  const files = extractClipboardImageFiles(event.clipboardData, { baseName: t('chat.clipboardScreenshotName'), timestamp: Date.now() })
  if (!files.length) return
  event.preventDefault()
  await addSelectedImages(files)
}

async function sendSelectedImages() {
  if (!selectedImages.value.length || imageSending.value.active || imageProcessing.value.active || imageOriginalOversize.value || !canInput.value) return
  const queue = [...selectedImages.value]
  imageSending.value = { active: true, current: 0, total: queue.length }
  try {
    for (const item of queue) {
      if (pageUnmounted) break
      imageSending.value.current++
      const file = imageSendMode.value === 'original' ? item.originalFile : item.preparedFile
      try {
        chatStore.validateFile(file)
        const sent = await chatStore.sendGroupFile(groupId, file)
        if (!sent) throw new Error(t('chat.messageSendFailed'))
        const index = selectedImages.value.findIndex(selected => selected.id === item.id)
        if (index >= 0) disposeSelectedImage(selectedImages.value.splice(index, 1)[0])
      } catch (error) {
        $q.notify({ type: 'negative', message: t('chat.imageBatchFailed', { name: file.name, error: attachmentFailureText(error) }) })
        break
      }
    }
    if (!selectedImages.value.length && !pageUnmounted) {
      $q.notify({ type: 'positive', message: t('chat.imagesSent', { count: queue.length }), timeout: 1800 })
    }
  } finally {
    imageSending.value = { active: false, current: 0, total: 0 }
    await nextTick()
    scrollToBottom()
  }
}

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
  pageUnmounted = true
  selectedImages.value.forEach(disposeSelectedImage)
  selectedImages.value = []
  if (highlightTimer) clearTimeout(highlightTimer)
  for (const [message, url] of previewUrls) {
    if (message.objectUrl === url) message.objectUrl = null
    URL.revokeObjectURL(url)
  }
  previewUrls.clear()
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

async function loadGroupFile(message) {
  const localUrl = message.objectUrl || (message.localFileAvailable ? await chatStore.ensureFileObjectUrl(message) : null)
  if (localUrl) return fetch(localUrl).then(response => response.blob())
  const metadata = message.offlineAttachment
  if (!metadata?.attachmentId) return null
  return downloadOfflineAttachment(metadata, { api: attachmentApi })
}

async function onPreviewFile(message) {
  if (!isMsgImage(message) || fileBusy.value[message.id]) return
  if (message.objectUrl) {
    openImagePreview(message)
    return
  }
  await loadGroupImagePreview(message, true)
}

async function loadGroupImagePreview(message, openPreview = false) {
  if (fileBusy.value[message.id] || pageUnmounted) return
  fileBusy.value[message.id] = true
  try {
    if (message.localFileAvailable && await chatStore.ensureFileObjectUrl(message)) {
      if (openPreview) openImagePreview(message)
      return
    }
    const blob = await loadGroupFile(message)
    if (!blob) return
    try {
      const cached = await chatStore.cacheGroupAttachment(groupId, message.id, blob, message.filetype)
      if (!cached) return
      await acknowledgeGroupAttachment(message.offlineAttachment, { api: groupApi }).catch(error => {
        console.warn('[group] attachment ack failed', error)
      })
    } catch (error) {
      console.warn('[group] local image cache failed', error)
      message.objectUrl = URL.createObjectURL(blob)
      previewUrls.set(message, message.objectUrl)
    }
    await nextTick()
    if (openPreview) openImagePreview(message)
  } catch (error) {
    if (openPreview) $q.notify({ type: 'negative', message: t('chat.actionFailed') })
  } finally {
    fileBusy.value[message.id] = false
  }
}

const autoPreviewAttempted = new Set()
watch(
  () => messages.value.filter(message => isMsgImage(message) && message.offlineAttachment?.attachmentId && message.filesize <= 20 * 1024 * 1024).map(message => message.id).join(','),
  async () => {
    for (const message of messages.value) {
      if (pageUnmounted || !isMsgImage(message) || message.objectUrl || !message.offlineAttachment?.attachmentId || message.filesize > 20 * 1024 * 1024 || autoPreviewAttempted.has(message.id)) continue
      autoPreviewAttempted.add(message.id)
      await loadGroupImagePreview(message)
    }
  },
  { immediate: true },
)

async function onDownloadFile(msg) {
  if (fileBusy.value[msg.id]) return
  if (!msg.objectUrl && !msg.localFileAvailable && !msg.offlineAttachment?.attachmentId) return
  fileBusy.value[msg.id] = true
  let temporaryUrl = null
  let browserDownloadStarted = false
  try {
    const blob = await loadGroupFile(msg)
    if (!blob) return
    const chunkSize = 1024 * 1024
    const getDescriptor = async () => ({
      size: blob.size,
      chunkCount: Math.ceil(blob.size / chunkSize),
      readChunk: async index => new Uint8Array(await blob.slice(index * chunkSize, Math.min(blob.size, (index + 1) * chunkSize)).arrayBuffer()),
    })
    let saved = null
    if (isTauri()) {
      temporaryUrl = URL.createObjectURL(blob)
      saved = await saveObjectUrlWithTauri({ objectUrl: temporaryUrl, filename: msg.filename, totalBytes: blob.size, dialogTitle: t('chat.saveFileTitle') })
    } else if (isCapacitor()) {
      saved = await saveChunkReaderWithCapacitor({ filename: msg.filename, mimeType: msg.filetype, totalBytes: blob.size, getDescriptor })
    } else if (blob.size > 20 * 1024 * 1024) {
      const result = await saveChunkReaderWithBrowserPicker({ filename: msg.filename, totalBytes: blob.size, getDescriptor })
      if (!result.unsupported) saved = result
    }
    if (saved?.canceled) return
    if (!saved) {
      temporaryUrl = URL.createObjectURL(blob)
      triggerBrowserDownload(temporaryUrl, msg.filename)
      browserDownloadStarted = true
    }
    if (!msg.localFileAvailable) {
      try {
        await chatStore.cacheGroupAttachment(groupId, msg.id, blob, msg.filetype)
      } catch (error) {
        console.warn('[group] local file cache failed', error)
      }
    }
    if (msg.localFileAvailable) {
      await acknowledgeGroupAttachment(msg.offlineAttachment, { api: groupApi }).catch(error => {
        console.warn('[group] attachment ack failed', error)
      })
    }
    $q.notify({ type: saved ? 'positive' : 'info', message: t(saved ? 'chat.fileDownloadComplete' : 'chat.fileDownloadStarted', { name: msg.filename }), timeout: 3000 })
  } catch (e) {
    console.error('[group] file download failed', e)
    $q.notify({ type: 'negative', message: t('chat.actionFailed') })
  } finally {
    if (temporaryUrl) {
      if (browserDownloadStarted) setTimeout(() => URL.revokeObjectURL(temporaryUrl), 30000)
      else URL.revokeObjectURL(temporaryUrl)
    }
    fileBusy.value[msg.id] = false
  }
}

async function onSend(event) {
  // 中文等输入法按回车确认候选词时不能触发发送（与 ChatPage.sendMsg 一致）
  if (event?.isComposing || event?.keyCode === 229) return
  const text = inputText.value.trim()
  if (!text || !canInput.value || sending.value) return
  // 安全检查：消息长度限制
  if (text.length > MAX_MESSAGE_LENGTH) {
    $q.notify({ type: 'warning', message: t('chat.messageTooLong', { count: MAX_MESSAGE_LENGTH }) })
    return
  }
  sending.value = true
  const pendingReply = replyTarget.value
  inputText.value = ''
  replyTarget.value = null
  try {
    const sent = await chatStore.sendGroupMessage(groupId, text, pendingReply)
    if (!sent) throw new Error(t('chat.messageSendFailed'))
  } catch (e) {
    console.error('[group] send failed', e)
    inputText.value = text
    replyTarget.value = pendingReply
    $q.notify({ type: 'negative', message: t('chat.messageSendError', { error: e.message }) })
  } finally {
    sending.value = false
  }
  await nextTick()
  scrollToBottom()
}

async function onRecall(msg) {
  if (!canRecall(msg)) return
  try {
    await chatStore.recallGroupMessage(groupId, msg.id)
  } catch (e) {
    console.warn('recall failed', e)
    $q.notify({ type: 'negative', message: t('chat.actionFailed') })
  }
}

async function deleteMessage(message) {
  if (!canDelete(message)) return
  try {
    await chatStore.deleteLocalMessage(groupId, message.id)
    $q.notify({ type: 'positive', message: t('chat.messageDeleted'), timeout: 1200 })
  } catch (error) {
    $q.notify({ type: 'negative', message: t('chat.actionFailed') })
  }
}

function clearHistory() {
  $q.dialog({
    title: t('chat.clearTitle'),
    message: t('chat.clearMessage', { name: groupName.value }),
    cancel: true,
    persistent: true,
  }).onOk(async () => {
    await chatStore.clearChatMessages(groupId)
    $q.notify({ type: 'positive', message: t('chat.historyCleared') })
  })
}

async function copyMessage(msg) {
  if (!canCopy(msg)) return
  try {
    await copyToClipboard(msg.text)
    $q.notify({ type: 'positive', message: t('chat.messageCopied'), timeout: 1200 })
  } catch (e) {
    $q.notify({ type: 'negative', message: t('chat.copyFailed', { error: e?.message || t('chat.unknownError') }) })
  }
}

function onPickFile() {
  morePanelOpen.value = false
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
  if (!file || !canInput.value) return
  try {
    chatStore.validateFile(file)
  } catch (error) {
    $q.notify({ type: 'warning', message: attachmentFailureText(error) })
    return
  }
  try {
    const sent = await chatStore.sendGroupFile(groupId, file)
    if (!sent) throw new Error(t('chat.messageSendFailed'))
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
.group-chat-page { background: #f5f7fa; color: #243448; }
.header { display: flex; align-items: center; gap: 7px; min-height: 62px; padding: 8px 11px; border-bottom: 1px solid #e6edf4; flex-shrink: 0; background: #fff; box-shadow: 0 2px 10px rgba(26,52,82,0.035); }
.header-avatar { flex: none; border-radius: 11px; overflow: hidden; }
.header-info { flex: 1; min-width: 0; cursor: pointer; line-height: 1.2; }
.header-name { overflow: hidden; font-weight: 700; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.header-sub { margin-top: 2px; font-size: 11px; color: #8a9aaa; }
.header-clear { color: #bd6570; background: #fff3f3; }
.messages-container { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 12px; }
.empty-hint { text-align: center; color: #999; padding: 40px 20px; font-size: 14px; }
.message-row { display: flex; align-items: flex-start; margin-bottom: 0; }
.message-row.mine { flex-direction: row-reverse; }
.message-content { display: flex; flex-direction: column; min-width: 0; max-width: min(80%, 560px); }
.message-row:not(.mine) .message-content { align-items: flex-start; }
.message-row.mine .message-content { align-items: flex-end; }
.message-sender { font-size: 11px; color: #8a9aaa; margin-bottom: 2px; }
.message-meta { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #8a9aaa; margin-top: 4px; line-height: 1.2; }
.message-bubble.mine .message-meta { text-align: right; }
.message-bubble {
  display: inline-block;
  vertical-align: top;
  padding: 8px;
  border-radius: 5px 16px 16px 16px;
  background: #fff;
  color: #243448;
  border: 1px solid #e6edf4;
  min-width: 0;
  overflow-wrap: anywhere;
  box-shadow: 0 3px 10px rgba(0,0,0,0.035);
}
.message-bubble.mine {
  background: #1976d2;
  color: #fff;
  border-color: #1976d2;
  border-radius: 16px 5px 16px 16px;
  box-shadow: 0 3px 10px rgba(25, 118, 210, 0.12);
}
.message-bubble.mine .message-meta { color: #bbdefb; justify-content: flex-end; }
.message-text { white-space: pre-wrap; line-height: 1.5; }
.decryption-error { color: #e8463a; }
.message-reply-quote { width: 100%; min-width: 130px; margin: 0 0 6px; padding: 5px 7px; display: flex; flex-direction: column; gap: 1px; border: 0; border-left: 3px solid currentColor; border-radius: 4px; color: #1565c0; background: rgba(25,118,210,0.08); font: inherit; text-align: left; cursor: pointer; }
.message-bubble.mine .message-reply-quote { color: #e3f2fd; background: rgba(255,255,255,0.16); }
.message-reply-author { font-size: 11px; font-weight: 700; line-height: 1.25; }
.message-reply-preview { display: -webkit-box; overflow: hidden; opacity: 0.9; font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.message-target-highlight .message-bubble { animation: message-target-pulse 1.5s ease-out; }
@keyframes message-target-pulse { 0%, 35% { box-shadow: 0 0 0 4px rgba(255,152,0,0.5); } 100% { box-shadow: 0 0 0 0 rgba(255,152,0,0); } }
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
.composer { flex-shrink: 0; background: #fff; }
.input-row { display: flex; align-items: center; gap: 5px; min-height: 60px; padding: 8px 10px; border-top: 1px solid #e6edf4; box-shadow: 0 -3px 12px rgba(26,52,82,0.04); }
.input-row :deep(.q-btn) { flex: 0 0 auto; min-width: 38px; min-height: 38px; }
.message-input { flex: 1 1 auto; min-width: 0; }
.message-input :deep(.q-field__control) { min-height: 40px; height: 40px; border-radius: 14px; background: #f8fafc; }
.message-input :deep(.q-field__control::before) { border-color: #e2e8f0; }
.emoji-menu { width: 288px; }
.emoji-list { max-height: 200px; padding: 4px; overflow: auto; }
.emoji-item { display: inline-flex; align-items: center; justify-content: center; width: 33px; height: 33px; font-size: 22px; cursor: pointer; }
.image-selection-tray { flex: 0 0 auto; padding: 9px 10px 10px; background: #f5f7fa; border-top: 1px solid #e2e8f0; }
.image-selection-header, .image-selection-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #455a64; font-size: 12px; font-weight: 600; }
.image-send-options { display: inline-flex; gap: 2px; margin-top: 6px; padding: 2px; border-radius: 10px; background: #e7edf3; }
.image-send-options button { min-height: 27px; padding: 3px 9px; border: 0; border-radius: 8px; background: transparent; color: #607d8b; font: inherit; font-size: 11px; cursor: pointer; }
.image-send-options button.active { background: #fff; color: #1565c0; font-weight: 650; box-shadow: 0 1px 4px rgba(38,50,56,0.14); }
.image-send-options button:disabled { cursor: default; opacity: 0.6; }
.image-original-warning { margin-top: 4px; color: #c62828; font-size: 10px; }
.image-selection-list { display: flex; gap: 8px; margin: 7px -2px 8px; padding: 2px; overflow-x: auto; }
.image-selection-item { position: relative; flex: 0 0 78px; min-width: 0; padding: 3px; border: 1px solid #d9e2ec; border-radius: 10px; background: #e9eef3; }
.image-selection-item img { width: 70px; height: 70px; border-radius: 7px; object-fit: cover; }
.image-selection-remove { position: absolute; top: -5px; right: -5px; width: 23px; height: 23px; padding: 0; display: grid; place-items: center; border: 2px solid white; border-radius: 50%; background: #455a64; color: white; cursor: pointer; }
.image-selection-name { display: block; overflow: hidden; color: #78909c; font-size: 9px; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.image-batch-progress { color: #546e7a; font-size: 11px; }
.image-batch-progress .q-linear-progress { height: 5px; margin-top: 5px; }
.image-selection-footer { color: #8794a1; font-size: 10px; font-weight: 400; }
.reply-composer-bar { min-height: 48px; padding: 5px 8px 5px 12px; display: flex; align-items: center; gap: 8px; background: #f1f6fc; border-top: 1px solid #e3e8ef; }
.reply-composer-content { flex: 1; min-width: 0; padding-left: 8px; border-left: 3px solid #1976d2; }
.reply-composer-title { color: #1565c0; font-size: 11px; font-weight: 600; line-height: 1.25; }
.reply-composer-preview { overflow: hidden; color: #616161; font-size: 12px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.composer-more-panel { min-height: 116px; padding: 13px 10px 16px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 6px; background: #f5f7fa; border-top: 1px solid #e6edf4; }
.composer-more-action { width: 100%; padding: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; border: 0; background: transparent; color: #444; font: inherit; cursor: pointer; }
.composer-more-icon { width: 52px; height: 52px; display: flex; align-items: center; justify-content: center; border: 1px solid #e6edf4; border-radius: 15px; background: #fff; color: #557693; box-shadow: 0 2px 8px rgba(26,52,82,0.035); }
.composer-more-action:disabled { opacity: 0.5; cursor: default; }
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
.file-card-image { cursor: zoom-in; }
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
