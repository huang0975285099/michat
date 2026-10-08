<template>
  <div class="group-chat-page">
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
        v-for="msg in messages"
        :key="msg.id"
        class="message-row"
        :class="{ mine: msg.mine }"
      >
        <div class="message-sender" v-if="!msg.mine">{{ msg.from }}</div>
        <div class="message-bubble" :class="{ mine: msg.mine }">
          <span v-if="msg.text">{{ msg.text }}</span>
          <span v-else-if="msg.decryptionFailed" style="color: #e8463a">[解密失败]</span>
          <span v-else-if="msg.type === 'file'" class="file-msg">📎 {{ msg.filename }} ({{ formatFileSize(msg.filesize) }})</span>
        </div>
        <div class="message-actions" v-if="msg.mine && !dissolved && !removed">
          <q-btn flat dense size="xs" label="撤回" @click="onRecall(msg)" />
        </div>
      </div>
    </div>

    <div class="composer" v-if="!dissolved && !removed">
      <div v-if="muted" class="muted-notice">
        你已被禁言<span v-if="muteEndTime"> 至 {{ muteEndTime }}</span>
      </div>
      <div v-else class="input-row">
        <q-btn flat round dense icon="attach_file" @click="onPickFile" :disable="!canSend" />
        <q-input
          v-model="inputText"
          dense
          outlined
          :placeholder="t('chat.inputPlaceholder')"
          @keydown.enter.prevent="onSend"
          :disable="!canSend"
          class="message-input"
        />
        <q-btn flat round dense icon="send" @click="onSend" :disable="!canSend" />
      </div>
    </div>
    <input ref="fileInput" type="file" style="display:none" @change="onFileSelected" />
  </div>
</template>

<script setup>
import { ref, computed, onActivated, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n/composable'
import { useChatStore } from 'src/stores/chat'
import { useGroupStore } from 'src/stores/group'
import { useIdentityStore } from 'src/stores/identity'

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
const canSend = computed(() => inputText.value.trim().length > 0 && !muted.value && !dissolved.value && !removed.value)

onMounted(async () => {
  groupStore.setMyChatId(identity.chatId)
  await groupStore.loadGroupDetail(groupId)
  await chatStore.loadMessages(groupId)
  await nextTick()
  scrollToBottom()
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
  await chatStore.sendGroupMessage(groupId, text)
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
</script>

<style scoped>
.group-chat-page { display: flex; flex-direction: column; height: 100vh; }
.header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(0,0,0,0.08); }
.header-info { flex: 1; cursor: pointer; }
.header-name { font-weight: 600; font-size: 16px; }
.header-sub { font-size: 12px; color: #888; }
.messages-container { flex: 1; overflow-y: auto; padding: 12px; }
.empty-hint { text-align: center; color: #999; padding: 40px 20px; font-size: 14px; }
.message-row { margin-bottom: 8px; }
.message-row.mine { text-align: right; }
.message-sender { font-size: 11px; color: #888; margin-bottom: 2px; }
.message-bubble { display: inline-block; max-width: 75%; padding: 8px 12px; border-radius: 12px; background: #f0f0f0; word-break: break-word; }
.message-bubble.mine { background: #0FDC78; color: white; }
.message-actions { display: inline-block; margin-left: 4px; }
.composer { border-top: 1px solid rgba(0,0,0,0.08); padding: 8px 12px; }
.input-row { display: flex; align-items: center; gap: 8px; }
.message-input { flex: 1; }
.muted-notice, .dissolved-notice { text-align: center; color: #e8463a; padding: 8px; font-size: 13px; }
.file-msg { font-size: 13px; }
</style>
