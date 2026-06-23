<template>
  <q-page class="column" style="height: calc(100vh - 110px)">
    <!-- 顶部好友信息 -->
    <div class="row items-center q-pa-sm q-gutter-sm bg-grey-2">
      <deterministic-avatar :seed="friendChatId" :size="32" />
      <div class="col">
        <div class="text-subtitle2">{{ friendNickname }}<span class="text-caption text-grey">（{{ friendChatId }}）</span></div>
        
      </div>
      <q-icon name="circle" :color="friendOnline ? 'positive' : 'grey-4'" size="12px">
        <q-tooltip>{{ friendOnline ? '在线' : '离线' }}</q-tooltip>
      </q-icon>
      <q-btn
        flat round dense icon="call" color="grey-7"
        :disable="callStore.state !== 'idle'"
        @click="callStore.startCall(friendChatId, friendNickname, 'audio')"
      >
        <q-tooltip>语音通话</q-tooltip>
      </q-btn>
      <q-btn
        flat round dense icon="videocam" color="grey-7"
        :disable="callStore.state !== 'idle'"
        @click="callStore.startCall(friendChatId, friendNickname, 'video')"
      >
        <q-tooltip>视频通话</q-tooltip>
      </q-btn>
      <!-- <q-btn flat round dense icon="more_vert">
        <q-menu anchor="bottom right" self="top right">
          <q-list dense style="min-width: 140px">
            <q-item clickable v-close-popup @click="clearHistory" class="text-negative items-center q-gutter-xs">
              <q-icon name="delete_sweep" size="sm" />
              <span>清空聊天记录</span>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn> -->
    </div>

    <!-- 消息列表（虚拟滚动：仅渲染视口内的消息，长历史也保持流畅） -->
    <q-virtual-scroll
      ref="virtualScrollEl"
      :items="messages"
      :virtual-scroll-item-size="60"
      class="col q-pa-md"
      style="min-height: 0"
      v-slot="{ item: msg, index: idx }"
    >
      <div
        :key="msg.id"
        class="row items-end"
        :class="msg.mine ? 'justify-end' : 'justify-start'"
        :style="{ paddingTop: shouldCompact(messages, idx) ? '2px' : '8px' }"
      >
        <!-- 对方消息：头像在左 -->
        <template v-if="!msg.mine">
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="friendChatId" :size="28" class="avatar-side q-mr-xs" />
          <div v-else class="avatar-placeholder" />
          <div class="q-pa-sm bubble-theirs" :class="{ 'bubble-burn': msg.burnAfterRead }">
            <!-- 文件消息 -->
            <template v-if="msg.type === 'file'">
              <img v-if="isMsgImage(msg) && msg.objectUrl" :src="msg.objectUrl" class="file-img" @click="imagePreview = { show: true, url: msg.objectUrl }" />
              <video v-else-if="isMsgVideo(msg) && msg.objectUrl" :src="msg.objectUrl" controls class="file-video" />
              <div v-else class="file-card file-card-theirs">
                <span class="file-icon">{{ getFileIcon(msg.filetype) }}</span>
                <div class="file-meta">
                  <div class="file-name">{{ msg.filename }}</div>
                  <div class="file-size">{{ formatFileSize(msg.filesize) }}</div>
                </div>
                <a v-if="msg.objectUrl" :href="msg.objectUrl" :download="msg.filename" class="file-dl" @click.stop>⬇️</a>
                <span v-else class="file-expired">已过期</span>
              </div>
            </template>
            <!-- 普通文字消息 -->
            <template v-else>
              <div>{{ msg.text }}</div>
            </template>
            <div class="text-caption q-mt-xs text-grey row items-center q-gutter-xs">
              <span>{{ formatTime(msg.ts) }}</span>
              <q-icon v-if="msg.burnAfterRead" name="local_fire_department" size="14px" color="orange">
                <q-tooltip>阅读后2小时自动删除</q-tooltip>
              </q-icon>
            </div>
            <!-- <q-menu context-menu v-if="msg.type !== 'file'">
              <q-list dense style="min-width: 100px">
                <q-item v-if="canRecall(msg)" clickable v-close-popup @click="recall(msg)" class="text-negative items-center q-gutter-xs">
                  <q-icon name="undo" size="sm" />
                  <span>双方删除</span>
                </q-item>
                <q-item v-else clickable v-close-popup @click="deleteMsg(msg)" class="text-negative items-center q-gutter-xs">
                  <q-icon name="delete" size="sm" />
                  <span>为我删除</span>
                </q-item>
              </q-list>
            </q-menu> -->
          </div>
        </template>

        <!-- 我的消息：头像在右 -->
        <template v-else>
          <div class="q-pa-sm bubble-mine" :class="{ 'bubble-burn': msg.burnAfterRead }">
            <!-- 文件消息 -->
            <template v-if="msg.type === 'file'">
              <img v-if="isMsgImage(msg) && msg.objectUrl" :src="msg.objectUrl" class="file-img" @click="imagePreview = { show: true, url: msg.objectUrl }" />
              <video v-else-if="isMsgVideo(msg) && msg.objectUrl" :src="msg.objectUrl" controls class="file-video" />
              <div v-else class="file-card file-card-mine">
                <span class="file-icon">{{ getFileIcon(msg.filetype) }}</span>
                <div class="file-meta">
                  <div class="file-name">{{ msg.filename }}</div>
                  <div class="file-size">{{ formatFileSize(msg.filesize) }}</div>
                </div>
                <a v-if="msg.objectUrl" :href="msg.objectUrl" :download="msg.filename" class="file-dl" @click.stop>⬇️</a>
                <span v-else class="file-expired">已过期</span>
              </div>
            </template>
            <!-- 普通文字消息 -->
            <template v-else>
              <div>{{ msg.text }}</div>
            </template>
            <div class="text-caption q-mt-xs text-blue-2 row items-center q-gutter-xs">
              <span>{{ formatTime(msg.ts) }}</span>
              <div>
                <span v-if="msg.read" class="read-status">✔✔</span>
                <span v-else class="read-status">✔</span>
                <q-tooltip v-if="msg.read">对方已读</q-tooltip>
                <q-tooltip v-else>对方未读</q-tooltip>
              </div>
              <q-icon v-if="msg.burnAfterRead" name="local_fire_department" size="14px" color="orange">
                <q-tooltip v-if="msg.burnAt">{{ formatBurnCountdown(msg.burnAt) }}</q-tooltip>
                <q-tooltip v-else>对方未读：对方阅读后2小时自动删除</q-tooltip>
              </q-icon>
            </div>
            <q-menu context-menu>
              <q-list dense style="min-width: 100px">
                <q-item v-if="canRecall(msg)" clickable v-close-popup @click="recall(msg)" class="text-negative items-center q-gutter-xs">
                  <q-icon name="undo" size="sm" />
                  <span>双方删除</span>
                </q-item>
                <q-item v-else clickable v-close-popup @click="deleteMsg(msg)" class="text-negative items-center q-gutter-xs">
                  <q-icon name="delete" size="sm" />
                  <span>为我删除</span>
                </q-item>
              </q-list>
            </q-menu>
          </div>
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="identityStore.chatId" :size="28" class="avatar-side q-ml-xs" />
          <div v-else class="avatar-placeholder" />
        </template>
      </div>
    </q-virtual-scroll>

    <!-- 文件传输进度条（有进行中的传输时显示） -->
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
        {{ activeTransfer.status === 'error' ? '失败' : activeTransfer.status === 'done' ? '完成' : activeTransfer.progress + '%' }}
      </span>
      <q-icon v-if="activeTransfer.status === 'error'" name="error_outline" color="negative" size="18px" />
      <q-icon v-else-if="activeTransfer.status === 'done'" name="check_circle_outline" color="positive" size="18px" />
    </div>

    <!-- 输入栏 -->
    <div class="row q-pa-sm q-gutter-xs items-center bg-white" style="border-top: 1px solid #eee; padding-left: 0;">
      <!-- 隐藏的文件选择器 -->
      <input
        ref="fileInputEl"
        type="file"
        style="display: none"
        :accept="allowedFileTypes"
        @change="onFileSelected"
      />
      <!-- 阅后即焚开关 -->
      <q-btn
        round
        flat
        :icon="burnMode ? 'local_fire_department' : 'local_fire_department'"
        :color="burnMode ? 'orange' : 'grey-5'"
        @click="burnMode = !burnMode"
      >
        <q-tooltip>{{ burnMode ? '阅后即焚已开启：对方阅读后2小时自动删除' : '开启阅后即焚' }}</q-tooltip>
      </q-btn>
      <q-input
        ref="inputEl"
        v-model="inputText"
        outlined
        dense
        rounded
        placeholder="输入消息..."
        class="col"
        @keyup.enter="sendMsg"
        :disable="sending"
      />
      <!-- 附件按钮 -->
      <q-btn
        round
        flat
        icon="attach_file"
        color="grey-7"
        :disable="sending || isTransferring"
        @click="fileInputEl.click()"
      >
        <q-tooltip>发送文件（最大10MB）</q-tooltip>
      </q-btn>
      <q-btn round flat icon="sentiment_satisfied_alt" color="grey-7">
        <q-menu anchor="top right" self="bottom right" :offset="[0, 8]" max-height="260px">
          <div style="width: 288px">
            <q-tabs v-model="emojiTab" dense align="justify" class="bg-grey-2 text-grey-8" indicator-color="primary" style="font-size:18px">
              <q-tab v-for="cat in emojiData" :key="cat.name" :name="cat.name" :label="cat.icon" />
            </q-tabs>
            <div class="q-pa-xs overflow-auto" style="max-height: 200px">
              <span
                v-for="e in currentEmojis"
                :key="e"
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
        :loading="sending"
        @click="sendMsg"
      />
    </div>

    <!-- 图片全屏预览 -->
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
import { on, off } from 'src/services/websocket'
import DeterministicAvatar from 'src/components/DeterministicAvatar.vue'

// ── 文件工具函数 ────────────────────────────────────────────────

function getFileIcon(filetype) {
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

const $q = useQuasar()
const route = useRoute()
const chatStore = useChatStore()
const identityStore = useIdentityStore()
const callStore = useCallStore()

// chatId 格式验证：NNNN-AAAA（4位数字-4位大写字母）
const CHAT_ID_PATTERN = /^\d{4}-[A-Z]{4}$/
const friendChatId = route.params.chatId
if (!CHAT_ID_PATTERN.test(friendChatId)) {
  $q.notify({ type: 'negative', message: '无效的聊天 ID' })
  throw new Error('Invalid chatId format')
}
const virtualScrollEl = ref(null)
const inputEl = ref(null)
const fileInputEl = ref(null)
const inputText = ref('')
const sending = ref(false)
const burnMode = ref(false)  // 阅后即焚模式
// 每分钟自增的响应式时间戳，驱动阅后即焚倒计时刷新（Date.now() 本身不是响应式的）
const now = ref(Date.now())
let nowTimer = null
const imagePreview = ref({ show: false, url: '' })

// 允许的文件类型（用于 input accept 属性）
const allowedFileTypes = [
  'image/jpeg,image/png,image/gif,image/webp,image/bmp,image/svg+xml',
  'video/mp4,video/webm,video/quicktime',
  'application/pdf',
  'application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip,application/x-rar-compressed,application/x-7z-compressed,application/x-tar,application/gzip',
  'application/vnd.android.package-archive,.apk'
].join(',')

// 当前进行中的传输（发送或接收）
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

// ── 表情面板 ────────────────────────────────────────────────────
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
  const input = native?.querySelector('input, textarea')
  if (input) {
    const start = input.selectionStart ?? inputText.value.length
    const end = input.selectionEnd ?? inputText.value.length
    inputText.value = inputText.value.slice(0, start) + emoji + inputText.value.slice(end)
    nextTick(() => {
      input.focus()
      const pos = start + [...emoji].length
      input.setSelectionRange(pos, pos)
    })
  } else {
    inputText.value += emoji
  }
}

// 好友信息（从缓存或 API 获取）
const friendNickname = ref('...')
const friendOnline = ref(false)

// 获取好友公钥：仅从可信来源获取（本地缓存或 API），禁止从 URL 参数注入
const friendPubKey = ref(identityStore.getFriendPubKey(friendChatId) || '')

const messages = computed(() => chatStore.getMessages(friendChatId))

let stopStatus = null

onMounted(async () => {
  // 先注册状态监听，避免在 loadMessages/fetchFriendInfo 异步等待期间遗漏状态变更事件
  stopStatus = onStatusUpdate((chatId, online) => {
    if (chatId === friendChatId) {
      friendOnline.value = online
    }
  })

  await chatStore.loadMessages(friendChatId)
  await fetchFriendInfo()

  // 打开聊天时标记所有对方消息为已读
  await chatStore.markAsRead(friendChatId)
  // 从服务器拉取离线期间错过的已读回执，补齐 ✔✔ 状态
  await chatStore.syncReadStatus(friendChatId)

  // 启动阅后即焚定时删除检查
  chatStore.startBurnTimer()
  chatStore.checkExpiredMessages()

  // 每分钟刷新一次响应式时间，驱动倒计时显示递减
  nowTimer = setInterval(() => { now.value = Date.now() }, 60000)

  // 虚拟滚动需待首屏项渲染、测量后再定位到底部
  nextTick(scrollToBottom)
})

onUnmounted(() => {
  stopStatus && stopStatus()
  chatStore.stopBurnTimer()
  if (nowTimer) { clearInterval(nowTimer); nowTimer = null }
})

// 仅监听消息条数变化（新增/删除），避免对整个数组做 deep 遍历，
// 也避免已读回执等字段变更触发不必要的强制滚动
watch(() => messages.value.length, () => {
  const newMsgs = messages.value
  // 仅当用户本就在底部附近时才自动滚动，回看历史时不打断
  if (isNearBottom()) {
    nextTick(scrollToBottom)
  }
  // 有新消息时自动标记为已读
  const unread = newMsgs.filter(m => !m.mine && !m.read)
  if (unread.length > 0) {
    chatStore.markAsRead(friendChatId)
  }
})

/**
 * 通过 API 获取好友公钥（fallback）
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
    $q.notify({ type: 'warning', message: '无法获取对方公钥' })
  }
}

/**
 * 监听好友在线状态变更
 */
function onStatusUpdate(callback) {
  function handler(payload) {
    // 安全验证：检查 payload 结构
    if (!payload || typeof payload.chat_id !== 'string' || typeof payload.online !== 'boolean') {
      console.warn('[ChatPage] invalid status payload:', payload)
      return
    }
    // 验证 chat_id 格式
    if (!CHAT_ID_PATTERN.test(payload.chat_id)) {
      console.warn('[ChatPage] invalid chat_id in status:', payload.chat_id)
      return
    }
    callback(payload.chat_id, payload.online)
  }
  on('status', handler)
  return () => off('status', handler)
}

// ── 文件发送 ────────────────────────────────────────────────────

function onFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''  // 允许重复选同一文件
  if (!file) return

  if (file.size > 10 * 1024 * 1024) {
    $q.notify({ type: 'warning', message: '文件超过 10MB 限制' })
    return
  }

  $q.dialog({
    title: '发送文件',
    message: `确定发送「${file.name}」（${formatFileSize(file.size)}）？\n\n请确保双方网络稳定。如因网络中断，需重新发送。`,
    cancel: { label: '取消', flat: true },
    ok: { label: '发送', color: 'primary' },
    persistent: true
  }).onOk(() => doSendFile(file))
}

async function doSendFile(file) {
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: '无法获取对方公钥，请刷新重试' })
    return
  }
  if (!friendOnline.value) {
    $q.notify({ type: 'warning', message: '对方不在线，无法发送文件' })
    return
  }
  try {
    await chatStore.sendFile(friendChatId, friendPubKey.value, file)
  } catch (e) {
    $q.notify({ type: 'negative', message: '文件发送失败：' + e.message })
  }
}

// 消息最大长度限制（防止 DoS）
const MAX_MESSAGE_LENGTH = 10000

async function sendMsg() {
  const text = inputText.value.trim()
  if (!text) return
  // 安全检查：消息长度限制
  if (text.length > MAX_MESSAGE_LENGTH) {
    $q.notify({ type: 'warning', message: `消息过长，最多 ${MAX_MESSAGE_LENGTH} 字符` })
    return
  }
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: '无法获取对方公钥，请刷新重试' })
    return
  }
  sending.value = true
  inputText.value = ''
  try {
    const ok = await chatStore.sendMessage(friendChatId, friendPubKey.value, text, burnMode.value)
    if (!ok) {
      $q.notify({ type: 'warning', message: '消息发送失败，请检查网络' })
      inputText.value = text
    }
  } catch (e) {
    $q.notify({ type: 'negative', message: '加密失败：' + e.message })
    inputText.value = text
  } finally {
    sending.value = false
  }
}

const RECALL_LIMIT_MS = 144 * 60 * 60 * 1000 // 144小时（6天）内可撤回

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
    title: '清空聊天记录',
    message: `确定清空与「${friendNickname.value}」的所有聊天记录？此操作不可恢复。`,
    cancel: true,
    persistent: true
  }).onOk(async () => {
    await chatStore.clearChatMessages(friendChatId)
    $q.notify({ type: 'positive', message: '聊天记录已清空' })
  })
}

function scrollToBottom() {
  const vs = virtualScrollEl.value
  if (vs && messages.value.length) {
    vs.scrollTo(messages.value.length - 1, 'end-force')
  }
}

// 用户是否处于（接近）最底部：仅在此情况下新消息才自动滚动，避免回看历史时被强制拉回
function isNearBottom() {
  const el = virtualScrollEl.value?.$el
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 200
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * 格式化阅后即焚倒计时
 */
function formatBurnCountdown(burnAt) {
  // 依赖响应式 now，使倒计时随定时器自动刷新（不要改成 Date.now()）
  const remaining = burnAt - now.value
  if (remaining <= 0) return '即将删除'
  const hours = Math.floor(remaining / (60 * 60 * 1000))
  const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000))
  if (hours > 0) {
    return hours + '小时' + minutes + '分钟后自动删除'
  }
  return minutes + '分钟后自动删除'
}

/**
 * 连续消息紧凑显示：隐藏头像，缩小间距
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
</style>
