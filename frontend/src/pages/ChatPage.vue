<template>
  <q-page ref="pageEl" class="column">
    <!-- Top friend information -->
    <div class="row items-center q-pa-sm q-gutter-sm bg-grey-2">
      <deterministic-avatar :seed="friendChatId" :size="32" />
      <div class="col">
        <div class="text-subtitle2">{{ friendNickname }}<span class="text-caption text-grey">（{{ friendChatId }}）</span></div>
        
      </div>
      <q-icon name="circle" :color="friendOnline ? 'positive' : 'grey-4'" size="12px">
        <q-tooltip>{{ friendOnline ? 'online' : 'Offline' }}</q-tooltip>
      </q-icon>
      <q-btn
        flat round dense icon="call" color="grey-7"
        :disable="callStore.state !== 'idle'"
        @click="callStore.startCall(friendChatId, friendNickname, 'audio')"
      >
        <q-tooltip>voice call</q-tooltip>
      </q-btn>
      <q-btn
        flat round dense icon="videocam" color="grey-7"
        :disable="callStore.state !== 'idle'"
        @click="callStore.startCall(friendChatId, friendNickname, 'video')"
      >
        <q-tooltip>video call</q-tooltip>
      </q-btn>
      <!-- <q-btn flat round dense icon="more_vert">
        <q-menu anchor="bottom right" self="top right">
          <q-list dense style="min-width: 140px">
            <q-item clickable v-close-popup @click="clearHistory" class="text-negative items-center q-gutter-xs">
              <q-icon name="delete_sweep" size="sm" />
              <span>Clear chat history</span>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn> -->
    </div>

    <!-- Message list (virtual scrolling: only render messages within the viewport, long history remains smooth) -->
    <q-virtual-scroll
      ref="virtualScrollEl"
      :items="messages"
      :virtual-scroll-item-size="60"
      class="col q-pa-md"
      :style="{ minHeight: 0, overflowAnchor: 'none', opacity: scrolled ? 1 : 0, transition: 'opacity 0.08s' }"
      v-slot="{ item: msg, index: idx }"
    >
      <div
        :key="msg.id"
        class="row items-end"
        :class="msg.mine ? 'justify-end' : 'justify-start'"
        :style="{ paddingTop: shouldCompact(messages, idx) ? '2px' : '8px' }"
      >
        <!-- Message from the other party: The avatar is on the left -->
        <template v-if="!msg.mine">
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="friendChatId" :size="28" class="avatar-side q-mr-xs" />
          <div v-else class="avatar-placeholder" />
          <div class="q-pa-sm bubble-theirs" :class="{ 'bubble-burn': msg.burnAfterRead }">
            <!-- file message -->
            <template v-if="msg.type === 'file'">
              <button
                v-if="isMsgVoice(msg)"
                type="button"
                class="voice-message voice-message-theirs"
                :disabled="!msg.objectUrl"
                @click="toggleVoicePlayback(msg)"
              >
                <q-icon :name="playingVoiceId === msg.id ? 'pause' : 'play_arrow'" size="22px" />
                <span class="voice-message-wave">▂▄▆▃▇▅▂▄▆</span>
                <span>{{ formatVoiceDuration(msg.durationMs) }}</span>
              </button>
              <img v-else-if="isMsgImage(msg) && msg.objectUrl" :src="msg.objectUrl" class="file-img" @click="imagePreview = { show: true, url: msg.objectUrl }" />
              <video v-else-if="isMsgVideo(msg) && msg.objectUrl" :src="msg.objectUrl" controls class="file-video" />
              <div v-else class="file-card file-card-theirs">
                <span class="file-icon">{{ getFileIcon(msg.filetype, msg.filename) }}</span>
                <div class="file-meta">
                  <div class="file-name">{{ msg.filename }}</div>
                  <div class="file-size">{{ formatFileSize(msg.filesize) }}</div>
                </div>
                <a v-if="msg.objectUrl" :href="msg.objectUrl" :download="msg.filename" class="file-dl" @click.stop>⬇️</a>
                <span v-else class="file-expired">Expired</span>
              </div>
            </template>
            <!-- Ordinary text message -->
            <template v-else>
              <div>{{ msg.text }}</div>
            </template>
            <div class="text-caption q-mt-xs text-grey row items-center q-gutter-xs">
              <span>{{ formatTime(msg.ts) }}</span>
              <q-icon v-if="msg.burnAfterRead" name="local_fire_department" size="14px" color="orange">
                <q-tooltip v-if="msg.burnAt">{{ formatBurnCountdown(msg.burnAt) }}</q-tooltip>
                <q-tooltip v-else>After reading2Automatically delete after hours</q-tooltip>
              </q-icon>
            </div>
            <!-- <q-menu context-menu v-if="msg.type !== 'file'">
              <q-list dense style="min-width: 100px">
                <q-item v-if="canRecall(msg)" clickable v-close-popup @click="recall(msg)" class="text-negative items-center q-gutter-xs">
                  <q-icon name="undo" size="sm" />
                  <span>Delete both sides</span>
                </q-item>
                <q-item v-else clickable v-close-popup @click="deleteMsg(msg)" class="text-negative items-center q-gutter-xs">
                  <q-icon name="delete" size="sm" />
                  <span>Delete for me</span>
                </q-item>
              </q-list>
            </q-menu> -->
          </div>
        </template>

        <!-- My message: Avatar is on the right -->
        <template v-else>
          <div class="q-pa-sm bubble-mine" :class="{ 'bubble-burn': msg.burnAfterRead }">
            <!-- file message -->
            <template v-if="msg.type === 'file'">
              <button
                v-if="isMsgVoice(msg)"
                type="button"
                class="voice-message voice-message-mine"
                :disabled="!msg.objectUrl"
                @click="toggleVoicePlayback(msg)"
              >
                <q-icon :name="playingVoiceId === msg.id ? 'pause' : 'play_arrow'" size="22px" />
                <span class="voice-message-wave">▂▄▆▃▇▅▂▄▆</span>
                <span>{{ formatVoiceDuration(msg.durationMs) }}</span>
              </button>
              <img v-else-if="isMsgImage(msg) && msg.objectUrl" :src="msg.objectUrl" class="file-img" @click="imagePreview = { show: true, url: msg.objectUrl }" />
              <video v-else-if="isMsgVideo(msg) && msg.objectUrl" :src="msg.objectUrl" controls class="file-video" />
              <div v-else class="file-card file-card-mine">
                <span class="file-icon">{{ getFileIcon(msg.filetype, msg.filename) }}</span>
                <div class="file-meta">
                  <div class="file-name">{{ msg.filename }}</div>
                  <div class="file-size">{{ formatFileSize(msg.filesize) }}</div>
                </div>
                <a v-if="msg.objectUrl" :href="msg.objectUrl" :download="msg.filename" class="file-dl" @click.stop>⬇️</a>
                <span v-else class="file-expired">Expired</span>
              </div>
            </template>
            <!-- Ordinary text message -->
            <template v-else>
              <div>{{ msg.text }}</div>
            </template>
            <div class="text-caption q-mt-xs text-blue-2 row items-center q-gutter-xs">
              <span>{{ formatTime(msg.ts) }}</span>
              <div>
                <q-icon v-if="msg.status === 'pending'" name="schedule" size="13px">
                  <q-tooltip>Sending</q-tooltip>
                </q-icon>
                <q-icon v-else-if="msg.status === 'failed'" name="error_outline" size="14px" color="negative">
                  <q-tooltip>Server not confirmed，Please check the network and try again</q-tooltip>
                </q-icon>
                <template v-else>
                  <span v-if="msg.read" class="read-status">✔✔</span>
                  <span v-else class="read-status">✔</span>
                  <q-tooltip v-if="msg.read">The other party has read</q-tooltip>
                  <q-tooltip v-else>Server has received，The other party has not read</q-tooltip>
                </template>
              </div>
              <q-icon v-if="msg.burnAfterRead" name="local_fire_department" size="14px" color="orange">
                <q-tooltip v-if="msg.burnAt">{{ formatBurnCountdown(msg.burnAt) }}</q-tooltip>
                <q-tooltip v-else>The other party has not read：After the other party reads2Automatically delete after hours</q-tooltip>
              </q-icon>
            </div>
            <q-menu v-if="msg.status !== 'pending'" context-menu>
              <q-list dense style="min-width: 100px">
                <q-item v-if="canRecall(msg)" clickable v-close-popup @click="recall(msg)" class="text-negative items-center q-gutter-xs">
                  <q-icon name="undo" size="sm" />
                  <span>Delete both sides</span>
                </q-item>
                <q-item v-else clickable v-close-popup @click="deleteMsg(msg)" class="text-negative items-center q-gutter-xs">
                  <q-icon name="delete" size="sm" />
                  <span>Delete for me</span>
                </q-item>
              </q-list>
            </q-menu>
          </div>
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="identityStore.chatId" :size="28" class="avatar-side q-ml-xs" />
          <div v-else class="avatar-placeholder" />
        </template>
      </div>
    </q-virtual-scroll>

    <!-- File transfer progress bar (displayed when there is a transfer in progress) -->
    <div v-if="activeTransfer" class="q-px-md q-py-xs bg-blue-1 row items-center q-gutter-sm" style="border-top: 1px solid #bbdefb">
      <q-icon name="attach_file" color="primary" size="18px" />
      <div class="col">
        <div class="text-caption text-grey-8 ellipsis" style="max-width: 200px">{{ activeTransfer.filename }}</div>
        <q-linear-progress
          :value="activeTransfer.progress / 100"
          :color="activeTransfer.status === 'error' ? 'negative' : 'primary'"
          rounded
          style="height: 4px"
        />
      </div>
      <span class="text-caption text-grey-7">
        {{ activeTransfer.status === 'error' ? 'failed' : activeTransfer.status === 'done' ? 'Complete' : activeTransfer.progress + '%' }}
      </span>
      <q-icon v-if="activeTransfer.status === 'error'" name="error_outline" color="negative" size="18px" />
      <q-icon v-else-if="activeTransfer.status === 'done'" name="check_circle_outline" color="positive" size="18px" />
    </div>

    <div v-if="voicePreparing || voiceRecording" class="voice-record-overlay" :class="{ cancelling: voiceCancelling }">
      <div class="voice-record-card">
        <q-icon :name="voiceCancelling ? 'delete_outline' : 'mic'" size="34px" />
        <div class="voice-record-time">{{ voicePreparing ? '正在启用麦克风…' : formatVoiceDuration(voiceDurationMs) }}</div>
        <div v-if="!voicePreparing" class="voice-levels" aria-hidden="true">
          <span
            v-for="index in 15"
            :key="index"
            :style="{ height: voiceBarHeight(index) + 'px' }"
          />
        </div>
        <div class="voice-record-hint">{{ voiceCancelling ? '松开取消' : '松开发送，上滑取消' }}</div>
      </div>
    </div>

    <!-- Input field -->
    <div class="row q-pa-sm q-gutter-xs items-center bg-white" style="border-top: 1px solid #eee; padding-left: 0;">
      <!-- Hidden file picker -->
      <input
        ref="fileInputEl"
        type="file"
        style="display: none"
        :accept="allowedFileTypes"
        @change="onFileSelected"
      />
      <!-- Burn after reading switch -->
      <q-btn
        round
        flat
        icon="local_fire_department"
        :color="burnMode ? 'orange' : 'grey-5'"
        @click="burnMode = !burnMode"
      >
        <q-tooltip>{{ burnMode ? 'Burn after reading is enabled：After the other party reads2Automatically delete after hours' : 'Turn on and burn after reading' }}</q-tooltip>
      </q-btn>
      <q-input
        ref="inputEl"
        v-model="inputText"
        outlined
        dense
        rounded
        placeholder="Enter message..."
        class="col"
        @keyup.enter="sendMsg"
        :disable="sending || voiceSending || voiceRecording"
      />
      <q-btn
        round
        flat
        icon="mic"
        :color="voiceRecording ? 'negative' : 'grey-7'"
        :disable="sending || voiceSending || isTransferring || callStore.state !== 'idle'"
        class="voice-record-button"
        @pointerdown.prevent="beginVoiceGesture"
        @contextmenu.prevent
      >
        <q-tooltip>按住说话</q-tooltip>
      </q-btn>
      <!-- Attachment button -->
      <q-btn
        round
        flat
        icon="attach_file"
        color="grey-7"
        :disable="sending || voiceSending || voiceRecording || isTransferring"
        @click="fileInputEl.click()"
      >
        <q-tooltip>Send files（maximum100MB）</q-tooltip>
      </q-btn>
      <q-btn round flat icon="sentiment_satisfied_alt" color="grey-7">
        <q-menu anchor="top right" self="bottom right" :offset="[0, 8]" max-height="260px">
          <div style="width: 288px">
            <q-tabs v-model="emojiTab" dense align="justify" class="bg-grey-2 text-grey-8" indicator-color="primary" style="font-size:18px">
              <q-tab v-for="cat in emojiData" :key="cat.name" :name="cat.name" :label="cat.icon" />
            </q-tabs>
            <div class="q-pa-xs overflow-auto" style="max-height: 200px">
              <span
                v-for="(e, emojiIndex) in currentEmojis"
                :key="emojiTab + '-' + emojiIndex"
                class="emoji-item"
                @click="insertEmoji(e)"
              >{{ e }}</span>
            </div>
          </div>
        </q-menu>
      </q-btn>
      <q-btn
        round
        unelevated
        :color="burnMode ? 'orange' : 'primary'"
        icon="send"
        :loading="sending || voiceSending"
        @click="sendMsg"
      />
    </div>

    <!-- Picture full screen preview -->
    <q-dialog v-model="imagePreview.show" maximized>
      <q-card class="bg-black column items-center justify-center" style="cursor: zoom-out" @click="imagePreview.show = false">
        <img :src="imagePreview.url" style="max-width: 100%; max-height: 100vh; object-fit: contain" />
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useQuasar } from 'quasar'
import { useChatStore } from 'src/stores/chat'
import { useIdentityStore } from 'src/stores/identity'
import { useCallStore } from 'src/stores/call'
import { friendApi } from 'src/services/api'
import { on, off, getServerNow } from 'src/services/websocket'
import {
  MAX_VOICE_DURATION_MS,
  MIN_VOICE_DURATION_MS,
  chooseVoiceFormat,
  createVoiceFilename,
  formatVoiceDuration,
} from 'src/services/voice-recorder.mjs'
import DeterministicAvatar from 'src/components/DeterministicAvatar.vue'

// ── File utility functions ─────────────────────────────────────────────

const COMPRESSED_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz'])

function getFileIcon(filetype, filename) {
  const ext = filename?.split('.').pop()?.toLowerCase() ?? ''
  if (COMPRESSED_EXTENSIONS.has(ext)) return '🗜️'
  if (!filetype) return '📎'
  if (filetype.startsWith('image/')) return '🖼️'
  if (filetype.startsWith('video/')) return '🎬'
  if (filetype.includes('pdf')) return '📄'
  if (filetype.includes('word') || filetype.includes('document')) return '📝'
  if (filetype.includes('excel') || filetype.includes('sheet')) return '📊'
  if (filetype.includes('powerpoint') || filetype.includes('presentation')) return '📋'
  if (filetype.includes('zip') || filetype.includes('rar') || filetype.includes('7z') || filetype.includes('tar') || filetype.includes('gzip')) return '🗜️'
  if (filetype.includes('android') || filetype.includes('apk')) return '🤖'
  return '📎'
}

function formatFileSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function isMsgImage(msg) { return msg.filetype?.startsWith('image/') }
function isMsgVideo(msg) { return msg.filetype?.startsWith('video/') }
function isMsgVoice(msg) { return msg.kind === 'voice' || msg.filetype?.startsWith('audio/') }

const $q = useQuasar()
const route = useRoute()
const chatStore = useChatStore()
const identityStore = useIdentityStore()
const callStore = useCallStore()

// chatId format verification: NNNN-AAAA (4 digits - 4 uppercase letters)
const CHAT_ID_PATTERN = /^\d{4}-[A-Z]{4}$/
const friendChatId = route.params.chatId
if (!CHAT_ID_PATTERN.test(friendChatId)) {
  $q.notify({ type: 'negative', message: 'Invalid chat ID' })
  throw new Error('Invalid chatId format')
}
const virtualScrollEl = ref(null)
const pageEl = ref(null)
const inputEl = ref(null)
const fileInputEl = ref(null)
const inputText = ref('')
const sending = ref(false)
const burnMode = ref(false)  //Burn after reading mode
// The message area is displayed only after the initial scroll to the bottom is completed to avoid users seeing jitter when jumping from the middle to the bottom.
const scrolled = ref(false)
// The server calibration time is refreshed every minute, and the driver displays a countdown that burns after reading.
const now = ref(getServerNow())
let nowTimer = null
let nudgeTimer = null
let heightResizeObserver = null
let rafNudgeId = null
const imagePreview = ref({ show: false, url: '' })
const voicePreparing = ref(false)
const voiceRecording = ref(false)
const voiceCancelling = ref(false)
const voiceSending = ref(false)
const voiceDurationMs = ref(0)
const voiceLevel = ref(0)
const playingVoiceId = ref(null)

let voiceStream = null
let mediaRecorder = null
let voiceChunks = []
let voiceFormat = null
let voiceStartedAt = 0
let voiceStartY = 0
let voicePointerHeld = false
let voiceStopping = false
let voiceElapsedTimer = null
let voiceMaxTimer = null
let voiceAudioContext = null
let voiceAnalyser = null
let voiceLevelFrame = null
let voicePlayer = null

// Allowed file types (for input accept attribute)
const allowedFileTypes = [
  '.jpg,.jpeg,.png,.gif,.webp,.bmp,.svg',
  '.mp4,.webm,.mov',
  '.doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf',
  '.zip,.rar,.7z,.tar,.gz,.apk'
].join(',')

// ── Voice recording and playback ───────────────────────────────────

function voiceBarHeight(index) {
  const shape = 0.45 + Math.abs(Math.sin(index * 1.37)) * 0.55
  return 4 + Math.round(voiceLevel.value * shape * 30)
}

function addVoicePointerListeners() {
  window.addEventListener('pointermove', updateVoiceGesture, { passive: true })
  window.addEventListener('pointerup', endVoiceGesture, { once: true })
  window.addEventListener('pointercancel', cancelVoiceGesture, { once: true })
}

function removeVoicePointerListeners() {
  window.removeEventListener('pointermove', updateVoiceGesture)
  window.removeEventListener('pointerup', endVoiceGesture)
  window.removeEventListener('pointercancel', cancelVoiceGesture)
}

async function beginVoiceGesture(event) {
  if (voicePreparing.value || voiceRecording.value || voiceStopping) return
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: '无法获取对方公钥，请刷新后重试' })
    return
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    $q.notify({ type: 'warning', message: '当前环境不支持麦克风录音' })
    return
  }

  voicePointerHeld = true
  voiceStartY = event.clientY
  voiceCancelling.value = false
  voicePreparing.value = true
  try { event.currentTarget?.setPointerCapture?.(event.pointerId) } catch { /* unsupported capture */ }
  addVoicePointerListeners()

  try {
    voiceFormat = chooseVoiceFormat()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    })

    if (!voicePointerHeld) {
      stream.getTracks().forEach(track => track.stop())
      voicePreparing.value = false
      return
    }

    voiceStream = stream
    voiceChunks = []
    mediaRecorder = new MediaRecorder(stream, { mimeType: voiceFormat.mimeType })
    mediaRecorder.addEventListener('dataavailable', event => {
      if (event.data?.size) voiceChunks.push(event.data)
    })
    mediaRecorder.start(200)

    voicePreparing.value = false
    voiceRecording.value = true
    voiceStartedAt = Date.now()
    voiceDurationMs.value = 0
    startVoiceLevelMeter(stream)
    voiceElapsedTimer = setInterval(() => {
      voiceDurationMs.value = Date.now() - voiceStartedAt
    }, 100)
    voiceMaxTimer = setTimeout(() => {
      voicePointerHeld = false
      removeVoicePointerListeners()
      finishVoiceRecording(false)
    }, MAX_VOICE_DURATION_MS)
  } catch (error) {
    voicePointerHeld = false
    voicePreparing.value = false
    removeVoicePointerListeners()
    stopVoiceCaptureResources()
    const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError'
    $q.notify({
      type: 'warning',
      message: denied ? '麦克风权限未开启，请在系统设置中允许后重试' : `录音启动失败：${error?.message || '未知错误'}`
    })
  }
}

function updateVoiceGesture(event) {
  if (!voicePointerHeld) return
  voiceCancelling.value = voiceStartY - event.clientY > 80
}

function endVoiceGesture() {
  const shouldCancel = voiceCancelling.value
  voicePointerHeld = false
  removeVoicePointerListeners()
  if (voicePreparing.value) return
  finishVoiceRecording(shouldCancel)
}

function cancelVoiceGesture() {
  voicePointerHeld = false
  removeVoicePointerListeners()
  if (voicePreparing.value) return
  finishVoiceRecording(true)
}

function startVoiceLevelMeter(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) return
  try {
    voiceAudioContext = new AudioContextClass()
    voiceAnalyser = voiceAudioContext.createAnalyser()
    voiceAnalyser.fftSize = 256
    voiceAudioContext.createMediaStreamSource(stream).connect(voiceAnalyser)
    const samples = new Uint8Array(voiceAnalyser.frequencyBinCount)
    const update = () => {
      if (!voiceAnalyser || !voiceRecording.value) return
      voiceAnalyser.getByteFrequencyData(samples)
      const average = samples.reduce((sum, value) => sum + value, 0) / samples.length
      voiceLevel.value = Math.min(1, average / 90)
      voiceLevelFrame = requestAnimationFrame(update)
    }
    update()
  } catch {
    voiceLevel.value = 0.2
  }
}

function clearVoiceTimers() {
  if (voiceElapsedTimer) { clearInterval(voiceElapsedTimer); voiceElapsedTimer = null }
  if (voiceMaxTimer) { clearTimeout(voiceMaxTimer); voiceMaxTimer = null }
  if (voiceLevelFrame) { cancelAnimationFrame(voiceLevelFrame); voiceLevelFrame = null }
}

function stopVoiceCaptureResources() {
  clearVoiceTimers()
  voiceStream?.getTracks().forEach(track => track.stop())
  voiceStream = null
  voiceAnalyser = null
  if (voiceAudioContext) voiceAudioContext.close().catch(() => {})
  voiceAudioContext = null
  voiceLevel.value = 0
}

async function finishVoiceRecording(cancelled) {
  if (voiceStopping || !mediaRecorder) return
  voiceStopping = true
  const recorder = mediaRecorder
  const durationMs = Math.min(MAX_VOICE_DURATION_MS, Math.max(0, Date.now() - voiceStartedAt))
  clearVoiceTimers()

  try {
    const blob = await new Promise(resolve => {
      recorder.addEventListener('stop', () => {
        resolve(new Blob(voiceChunks, { type: recorder.mimeType || voiceFormat.mimeType }))
      }, { once: true })
      recorder.stop()
    })

    if (cancelled) {
      $q.notify({ type: 'info', message: '已取消录音' })
      return
    }
    if (durationMs < MIN_VOICE_DURATION_MS || blob.size === 0) {
      $q.notify({ type: 'warning', message: '说话时间太短' })
      return
    }

    const file = new File(
      [blob],
      createVoiceFilename(voiceFormat.extension),
      { type: recorder.mimeType || voiceFormat.mimeType, lastModified: Date.now() }
    )
    voiceSending.value = true
    await chatStore.sendFile(
      friendChatId,
      friendPubKey.value,
      file,
      burnMode.value,
      { kind: 'voice', durationMs: Math.round(durationMs) }
    )
  } catch (error) {
    $q.notify({ type: 'negative', message: `语音发送失败：${error?.message || '未知错误'}` })
  } finally {
    mediaRecorder = null
    voiceChunks = []
    voiceRecording.value = false
    voicePreparing.value = false
    voiceCancelling.value = false
    voiceSending.value = false
    voiceDurationMs.value = 0
    stopVoiceCaptureResources()
    voiceStopping = false
  }
}

function toggleVoicePlayback(msg) {
  if (!msg.objectUrl) return
  if (playingVoiceId.value === msg.id && voicePlayer) {
    voicePlayer.pause()
    playingVoiceId.value = null
    return
  }
  if (voicePlayer) voicePlayer.pause()
  voicePlayer = new Audio(msg.objectUrl)
  playingVoiceId.value = msg.id
  voicePlayer.addEventListener('ended', () => { playingVoiceId.value = null }, { once: true })
  voicePlayer.addEventListener('error', () => {
    playingVoiceId.value = null
    $q.notify({ type: 'warning', message: '语音无法播放' })
  }, { once: true })
  voicePlayer.play().catch(() => {
    playingVoiceId.value = null
    $q.notify({ type: 'warning', message: '语音播放失败' })
  })
}

// Transmission currently in progress (send or receive)
const activeTransfer = computed(() => {
  const transfers = Object.values(chatStore.fileTransfers)
  return transfers.find(t =>
    (t.toChatId === friendChatId || t.fromChatId === friendChatId) &&
    (t.status === 'pending' || t.status === 'transferring')
  ) || transfers.find(t =>
    (t.toChatId === friendChatId || t.fromChatId === friendChatId) &&
    t.status === 'error' && Date.now() - (t.errorAt || 0) < 5000
  ) || null
})

const isTransferring = computed(() =>
  Object.values(chatStore.fileTransfers).some(t =>
    (t.toChatId === friendChatId || t.fromChatId === friendChatId) &&
    (t.status === 'pending' || t.status === 'transferring')
  )
)

// ── Expression Panel ────────────────────────────────────────────────
const emojiTab = ref('face')

const emojiData = [
  {
    name: 'face', icon: '😊',
    emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖']
  },
  {
    name: 'gesture', icon: '👋',
    emojis: ['👋','🤚','🖐️','✋','🖖','🤙','👌','🤌','🤏','✌️','🤞','🤟','🤘','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🙏','💪','🤳','🫶','🫱','🫲','🧑','👦','👧','👨','👩','🧒','👶','👴','👵','🧓','👮','👷','💂','🕵️','👩‍⚕️','👨‍⚕️','👩‍🍳','👨‍🍳','👩‍🎓','👨‍🎓','👩‍🏫','👨‍🏫','💆','💇','🚶','🧍','🧎','🏃','💃','🕺','🧖','🛀','🧗','🤸','⛹️','🏋️','🤼','🤺','🤾','🏇','⛷️','🏂','🏌️','🚵','🚴','🧘']
  },
  {
    name: 'heart', icon: '❤️',
    emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','✡️','🆘','❌','⭕','🛑','⛔','🚫','💯','✅','☑️','✔️','❎','🔝','🆙','🆒','🆕','🆓','🆗','🅰️','🅱️','🆎','🆑','🅾️','🆘','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔲','🔳','▪️','▫️','◾','◽','◼️','◻️','🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🟫']
  },
  {
    name: 'animal', icon: '🐱',
    emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🐈','🐓','🦃','🦚','🦜','🦢','🕊️','🐇','🦝','🦨','🦡','🦦','🦥','🐿️','🦔','🐉','🐲']
  },
  {
    name: 'food', icon: '🍎',
    emojis: ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🍞','🥖','🧀','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🥪','🥙','🌮','🌯','🥗','🥘','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🍤','🍙','🍚','🍘','🍥','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🧃','🥤','🧋','☕','🍵','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🍾','🥄','🍴','🍽️']
  },
  {
    name: 'activity', icon: '⚽',
    emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🥅','⛳','🎣','🤿','🎽','🎿','🛷','🥌','🎯','🎳','🎮','🕹️','🎰','🧩','♟️','🎭','🎨','🎬','🎤','🎧','🎼','🎵','🎶','🎷','🎸','🎹','🥁','🎺','🎻','🏆','🥇','🥈','🥉','🏅','🎖️','🎗️','🎫','🎟️','🎪','🤹','🎠','🎡','🎢','🎆','🎇','🧨','🎉','🎊','🎈','🎁','🎀','🎋','🎍','🎑','🎐','🧧','🎎','🧸','🪆','🪅','🏮']
  },
  {
    name: 'object', icon: '💡',
    emojis: ['📱','💻','⌨️','🖥️','🖨️','🖱️','💾','💿','📀','📸','📷','📹','🎥','📞','☎️','📺','📻','🧭','⏰','⌛','⏳','🔋','🔌','💡','🔦','🕯️','💵','💳','💎','💍','👑','🏺','🧸','🎁','🎀','🧲','🔧','🔨','⚙️','🔩','🪛','🔫','🧨','💣','🗡️','⚔️','🛡️','🚪','🪑','🛁','🚽','🧴','🧹','🧺','🧻','🪣','🧼','🪥','🛒','🚬','⚗️','🔭','🔬','🩺','💊','🩹','🩻','🩼','🩺','🧬','🦠','🌡️','🔑','🗝️','🔐','🔏','🔒','🔓','📦','📫','📬','📭','📮','🗳️','✏️','✒️','🖊️','📝','📄','📃','📋','📁','📂','🗂️','📅','📆','📇','📈','📉','📊','📌','📍','✂️','🗃️','🗄️','🗑️','🔎','🔍','🔏','🔐','🔒','🔓']
  }
]

const currentEmojis = computed(() => emojiData.find(c => c.name === emojiTab.value)?.emojis ?? [])

function insertEmoji(emoji) {
  const native = inputEl.value?.getNativeElement?.()
  // QInput.getNativeElement() returns the native input/textarea; it is compatible with older versions that may return containers.
  const input = native?.matches?.('input, textarea')
    ? native
    : native?.querySelector?.('input, textarea')
  if (input) {
    const start = input.selectionStart ?? inputText.value.length
    const end = input.selectionEnd ?? inputText.value.length
    inputText.value = inputText.value.slice(0, start) + emoji + inputText.value.slice(end)
    nextTick(() => {
      input.focus()
      // selectionStart/setSelectionRange uses UTF-16 code unit index, consistent with String.length.
      const pos = start + emoji.length
      input.setSelectionRange(pos, pos)
    })
  } else {
    inputText.value += emoji
  }
}

// Friend information (obtained from cache or API)
const friendNickname = ref('...')
const friendOnline = ref(false)

// Obtain friend's public key: only obtain it from trusted sources (local cache or API), prohibit injection from URL parameters
const friendPubKey = ref(identityStore.getFriendPubKey(friendChatId) || '')

const messages = computed(() => chatStore.getMessages(friendChatId))

let stopStatus = null

function handleVoiceVisibilityChange() {
  if (!document.hidden) return
  voicePointerHeld = false
  removeVoicePointerListeners()
  if (voiceRecording.value) finishVoiceRecording(true)
}

onMounted(async () => {
  // Register status listeners first to avoid missing status change events during asynchronous waiting.
  stopStatus = onStatusUpdate((chatId, online) => {
    if (chatId === friendChatId) {
      friendOnline.value = online
    }
  })

  // Precisely set the q-page height: the first synchronization attempt, and then add it after nextTick + rAF,
  // Ensure that the header/footer size is accurate after Quasar completes the layout
  updatePageHeight()
  nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => updatePageHeight())
    })
  })
  // Monitor header/footer height changes (such as the appearance/disappearance of the disconnection prompt bar)
  const header = document.querySelector('.q-header')
  const footer = document.querySelector('.q-footer')
  if (header || footer) {
    heightResizeObserver = new ResizeObserver(() => updatePageHeight())
    if (header) heightResizeObserver.observe(header)
    if (footer) heightResizeObserver.observe(footer)
  }
  window.addEventListener('resize', updatePageHeight)
  document.addEventListener('visibilitychange', handleVoiceVisibilityChange)

  // Loading messages - scroll to the end as soon as the message arrives, without waiting for subsequent network requests
  await chatStore.loadMessages(friendChatId)

  // Wait for the DOM to update and scroll immediately after the page height takes effect.
  nextTick(() => {
    requestAnimationFrame(() => {
      // Force the scroll to the end for the first time (execute vs.scrollTo when opacity:0 is invisible to ensure that the last item is rendered into the DOM)
      scrollToBottom()
      // Wait another frame for the browser to apply scrollTop, and then display the content (what the user sees is the bottom and will not see the jump)
      requestAnimationFrame(() => {
        scrolled.value = true
        // Lightly align frame by frame after the content is visible (only scrollTop is set, vs.scrollTo() is not called),
        // Correct the slight deviation in the measured item height caused by virtual scrolling
        startRafNudge(30)
        // Start a 3-second nudge timer to cover bounces caused by asynchronous status updates (read receipts, online status, etc.)
        let nudgeCount = 0
        nudgeTimer = setInterval(() => {
          nudgeCount++
          if (nudgeCount > 20 || !isNearBottom()) {
            clearInterval(nudgeTimer)
            nudgeTimer = null
            return
          }
          nudgeToBottom()
        }, 150)
      })
    })
  })

  // The scheduled deletion check for disappearing after reading has been moved to the MainLayout application-level life cycle.
  // Ensure that the countdown continues after the user leaves the chat page and is deleted on time.

  // The responsive time is refreshed every minute, and the driver countdown display decreases.
  now.value = getServerNow()
  nowTimer = setInterval(() => { now.value = getServerNow() }, 60000)

  // The following are asynchronous operations that do not affect the layout of the first screen and do not block scrolling:
  // Obtaining friend information, marking read, and synchronizing read receipts—these network requests take a long time.
  // But it will not change the message list height (only update the avatar/online status/read mark),
  // nudgeTimer automatically corrects possible small offsets after they trigger a reactive update.
  fetchFriendInfo()
  chatStore.markAsRead(friendChatId)
  chatStore.syncReadStatus(friendChatId)
})

onUnmounted(() => {
  stopStatus && stopStatus()
  if (nowTimer) { clearInterval(nowTimer); nowTimer = null }
  if (nudgeTimer) { clearInterval(nudgeTimer); nudgeTimer = null }
  cancelRafNudge()
  if (heightResizeObserver) { heightResizeObserver.disconnect(); heightResizeObserver = null }
  window.removeEventListener('resize', updatePageHeight)
  document.removeEventListener('visibilitychange', handleVoiceVisibilityChange)
  voicePointerHeld = false
  removeVoicePointerListeners()
  if (voiceRecording.value) finishVoiceRecording(true)
  else stopVoiceCaptureResources()
  if (voicePlayer) { voicePlayer.pause(); voicePlayer = null }
})

// Only monitor changes in the number of messages (new/deleted) to avoid deep traversal of the entire array.
// It also avoids unnecessary forced scrolling caused by changes in fields such as read receipts.
watch(() => messages.value.length, () => {
  const newMsgs = messages.value
  // Automatically scroll only when the user is already near the bottom, without interrupting when reviewing history
  if (isNearBottom()) {
    nextTick(() => scrollToBottomReliable())
  }
  // Automatically mark new messages as read
  const unread = newMsgs.filter(m => !m.mine && !m.read)
  if (unread.length > 0) {
    chatStore.markAsRead(friendChatId)
  }
})

/**
 * Obtain friend's public key through API (fallback)
 */
async function fetchFriendInfo() {
  try {
    const { data } = await friendApi.getFriends()
    const friend = data.find(f => f.chat_id === friendChatId)
    if (friend) {
      friendPubKey.value = friend.public_key
      identityStore.cacheFriendPubKey(friendChatId, friend.public_key)
      friendNickname.value = friend.nickname
      friendOnline.value = !!friend.online
    }
  } catch {
    $q.notify({ type: 'warning', message: 'Unable to obtain the counterparty public key' })
  }
}

/**
 * Monitor friends’ online status changes
 */
function onStatusUpdate(callback) {
  function handler(payload) {
    // Security verification: check payload structure
    if (!payload || typeof payload.chat_id !== 'string' || typeof payload.online !== 'boolean') {
      console.warn('[ChatPage] invalid status payload:', payload)
      return
    }
    // Verify chat_id format
    if (!CHAT_ID_PATTERN.test(payload.chat_id)) {
      console.warn('[ChatPage] invalid chat_id in status:', payload.chat_id)
      return
    }
    callback(payload.chat_id, payload.online)
  }
  on('status', handler)
  return () => off('status', handler)
}

// ── File sending ───────────────────────────────────────────────

function onFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''  //Allow repeated selection of the same file
  if (!file) return

  try {
    chatStore.validateFile(file)
  } catch (error) {
    $q.notify({ type: 'warning', message: error.message })
    return
  }

  $q.dialog({
    title: 'Send files',
    message: `OK to send「${file.name}」（${formatFileSize(file.size)}）？\n\nPlease ensure that the network of both parties is stable。If due to network interruption，Need to resend。`,
    cancel: { label: 'Cancel', flat: true },
    ok: { label: 'send', color: 'primary' },
    persistent: true
  }).onOk(() => doSendFile(file))
}

async function doSendFile(file) {
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: 'Unable to obtain the counterparty public key. Please refresh and try again' })
    return
  }
  try {
    await chatStore.sendFile(friendChatId, friendPubKey.value, file, burnMode.value)
  } catch (e) {
    $q.notify({ type: 'negative', message: 'File sending failed：' + e.message })
  }
}

// Maximum message length limit (to prevent DoS)
const MAX_MESSAGE_LENGTH = 10000

async function sendMsg(event) {
  // When pressing Enter to confirm the candidate word in Chinese and other input methods, sending cannot be triggered.
  if (event?.isComposing || event?.keyCode === 229) return
  const text = inputText.value.trim()
  if (!text) return
  // Security Check: Message Length Limit
  if (text.length > MAX_MESSAGE_LENGTH) {
    $q.notify({ type: 'warning', message: `Message too long，most ${MAX_MESSAGE_LENGTH} character` })
    return
  }
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: 'Unable to obtain the counterparty public key. Please refresh and try again' })
    return
  }
  sending.value = true
  inputText.value = ''
  try {
    const ok = await chatStore.sendMessage(friendChatId, friendPubKey.value, text, burnMode.value)
    if (!ok) {
      $q.notify({ type: 'warning', message: 'Message sending failed，Please check the network' })
      inputText.value = text
    }
  } catch (e) {
    $q.notify({ type: 'negative', message: 'Message sending failed：' + e.message })
    inputText.value = text
  } finally {
    sending.value = false
  }
}

const RECALL_LIMIT_MS = 144 * 60 * 60 * 1000 //Can be withdrawn within 144 hours (6 days)

function canRecall(msg) {
  return Date.now() - msg.ts < RECALL_LIMIT_MS
}

function recall(msg) {
  chatStore.recallMessage(friendChatId, msg.id, friendChatId)
}

function deleteMsg(msg) {
  chatStore.recallMessage(friendChatId, msg.id, null)
}

function clearHistory() {
  $q.dialog({
    title: 'Clear chat history',
    message: `Make sure to clear the「${friendNickname.value}」All chat history of？This operation is irreversible。`,
    cancel: true,
    persistent: true
  }).onOk(async () => {
    await chatStore.clearChatMessages(friendChatId)
    $q.notify({ type: 'positive', message: 'Chat history has been cleared' })
  })
}

// Dynamically calculate the height of q-page: Quasar QPage only sets min-height by default.
// Not giving height will cause the child elements of flex:1 (virtual scrolling) to be unable to obtain a certain height.
// This causes the entire page to scroll on the body and the last message to be obscured by the bottom bar.
// Accurately measure the actual height of q-header and q-footer (including dynamic elements such as breakage prompts),
// Subtract 100vh to get the exact height of the q-page.
function updatePageHeight() {
  const el = pageEl.value?.$el
  if (!el) return
  const header = document.querySelector('.q-header')
  const footer = document.querySelector('.q-footer')
  const headerH = header ? Math.round(header.getBoundingClientRect().height) : 0
  const footerH = footer ? Math.round(footer.getBoundingClientRect().height) : 0
  el.style.height = `calc(100vh - ${headerH + footerH}px)`
  // After height change, light alignment to avoid gaps if user is near the bottom
  if (isNearBottom()) nudgeToBottom()
}

// Cancel the ongoing rAF nudge loop (used for cleanup when components are unloaded)
function cancelRafNudge() {
  if (rafNudgeId !== null) {
    cancelAnimationFrame(rafNudgeId)
    rafNudgeId = null
  }
}

// Start rAF frame-by-frame lightweight alignment (stop automatically after tries frames) for initial scrolling phase
function startRafNudge(tries = 30) {
  cancelRafNudge()
  const tick = (remaining) => {
    rafNudgeId = requestAnimationFrame(() => {
      rafNudgeId = null
      const el = virtualScrollEl.value?.$el
      if (!el || remaining <= 0) return
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      if (dist > 0) nudgeToBottom()
      tick(remaining - 1)
    })
  }
  tick(tries)
}

function scrollToBottom() {
  const vs = virtualScrollEl.value
  if (!vs || !messages.value.length) return
  // 1) Let the last item be rendered into the DOM first (virtual scrolling only renders the items in the viewport)
  vs.scrollTo(messages.value.length - 1, 'end-force')
  // 2) scrollTo can only align the end of the last item to the bottom of the viewport, and cannot scroll into the padding of the subsequent container;
  // Press directly to scrollHeight to stick to the real bottom
  const el = vs.$el
  if (el) el.scrollTop = el.scrollHeight
}

// Lightweight alignment: only set scrollTop, do not call vs.scrollTo(), and avoid triggering q-virtual-scroll
// Internal virtual position recalculation (recalculation will overwrite scrollTop in asynchronous frames, causing "bounce")
function nudgeToBottom() {
  const el = virtualScrollEl.value?.$el
  if (el) el.scrollTop = el.scrollHeight
}

// The virtual scrolling first screen is positioned according to the estimated height. After jumping to the bottom, each item will be corrected by actual measurement and there will be a deviation of "not touching the bottom".
// Use scrollToBottom() for the first time to let the last item enter rendering, and then use lightweight alignment correction frame by frame.
// No longer call vs.scrollTo() repeatedly to avoid triggering virtual scroll internal recalculation to overwrite scrollTop.
function scrollToBottomReliable(tries = 30) {
  scrollToBottom()
  startRafNudge(tries)
}

// Whether the user is at (nearly) the bottom: only in this case new messages will be automatically scrolled to avoid being forced back when looking back in history
function isNearBottom() {
  const el = virtualScrollEl.value?.$el
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 200
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * Formatted countdown that will burn after reading
 */
function formatBurnCountdown(burnAt) {
  // Rely on responsive now to automatically refresh the countdown with the timer (do not change to Date.now())
  const remaining = burnAt - now.value
  if (remaining <= 0) return 'About to be deleted'
  const hours = Math.floor(remaining / (60 * 60 * 1000))
  const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000))
  if (hours > 0) {
    return hours + 'hours' + minutes + 'Automatically delete after minutes'
  }
  return minutes + 'Automatically delete after minutes'
}

/**
 * Compact display of continuous messages: hide avatars and reduce spacing
 */
function shouldCompact(msgs, idx) {
  if (idx === 0) return false
  const prev = msgs[idx - 1]
  const curr = msgs[idx]
  return prev.mine === curr.mine && (curr.ts - prev.ts) < 60000
}
</script>

<style scoped>
.avatar-placeholder {
  width: 28px;
  flex-shrink: 0;
}
.avatar-side {
  flex-shrink: 0;
  align-self: flex-start;
}
.emoji-item {
  display: inline-block;
  font-size: 22px;
  width: 36px;
  height: 36px;
  line-height: 36px;
  text-align: center;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
}
.emoji-item:hover {
  background: rgba(0, 0, 0, 0.08);
}
.bubble-mine {
  background: #1976d2;
  color: white;
  border-radius: 16px 4px 16px 16px;
  max-width: 70vw;
  word-wrap: break-word;
}
.bubble-theirs {
  background: #f0f0f0;
  color: #222;
  border-radius: 4px 16px 16px 16px;
  max-width: 70vw;
  word-wrap: break-word;
}
.bubble-burn {
  border: 4px solid #ff9800;
}
.read-status {
  font-size: 11px;
  line-height: 1;
  min-width: 14px;
  letter-spacing: -1px;
  font-weight: bold;
}
.file-img {
  max-width: 220px;
  max-height: 220px;
  border-radius: 8px;
  display: block;
  cursor: zoom-in;
}
.file-video {
  max-width: 240px;
  border-radius: 8px;
  display: block;
}
.file-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  min-width: 180px;
  max-width: 260px;
}
.file-card-mine {
  background: rgba(255,255,255,0.18);
}
.file-card-theirs {
  background: rgba(0,0,0,0.06);
}
.file-icon {
  font-size: 28px;
  flex-shrink: 0;
}
.file-meta {
  flex: 1;
  min-width: 0;
}
.file-name {
  font-size: 13px;
  font-weight: 500;
  word-break: break-all;
  line-height: 1.3;
}
.file-size {
  font-size: 11px;
  opacity: 0.65;
  margin-top: 2px;
}
.file-dl {
  font-size: 18px;
  text-decoration: none;
  flex-shrink: 0;
}
.file-expired {
  font-size: 11px;
  opacity: 0.5;
  flex-shrink: 0;
}
.voice-message {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 145px;
  border: 0;
  padding: 7px 9px;
  border-radius: 10px;
  font: inherit;
  cursor: pointer;
}
.voice-message:disabled {
  cursor: default;
  opacity: 0.55;
}
.voice-message-mine {
  color: white;
  background: rgba(255,255,255,0.16);
}
.voice-message-theirs {
  color: #222;
  background: rgba(0,0,0,0.06);
}
.voice-message-wave {
  flex: 1;
  letter-spacing: -1px;
  opacity: 0.8;
  white-space: nowrap;
}
.voice-record-button {
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.voice-record-overlay {
  position: fixed;
  inset: 0;
  z-index: 6000;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  background: rgba(0, 0, 0, 0.18);
}
.voice-record-card {
  width: 220px;
  min-height: 170px;
  padding: 22px 18px;
  border-radius: 18px;
  background: rgba(25, 118, 210, 0.95);
  color: white;
  text-align: center;
  box-shadow: 0 10px 36px rgba(0,0,0,0.28);
}
.voice-record-overlay.cancelling .voice-record-card {
  background: rgba(211, 47, 47, 0.95);
}
.voice-record-time {
  margin-top: 8px;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.voice-levels {
  height: 42px;
  margin: 10px 0 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
}
.voice-levels span {
  display: block;
  width: 4px;
  min-height: 4px;
  border-radius: 3px;
  background: white;
  transition: height 0.08s linear;
}
.voice-record-hint {
  font-size: 13px;
  opacity: 0.92;
}
</style>
