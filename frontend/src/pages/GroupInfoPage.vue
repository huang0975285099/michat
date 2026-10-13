<template>
  <div class="group-info-page">
    <div class="header">
      <q-btn flat round dense icon="arrow_back" @click="$router.back()" />
      <div class="header-name">{{ groupName }}</div>
    </div>

    <div class="info-section">
      <div class="info-row">
        <span class="label">群 ID</span>
        <span class="value">{{ groupId }}</span>
      </div>
      <div class="info-row">
        <span class="label">创建时间</span>
        <span class="value">{{ createdAt }}</span>
      </div>
    </div>

    <div class="members-section">
      <h3>成员（{{ members.length }}）</h3>
      <div v-for="m in members" :key="m.chat_id" class="member-row">
        <div class="member-info">
          <span class="member-name">{{ m.nickname }}</span>
          <span class="member-id">{{ m.chat_id }}</span>
          <span v-if="m.state === 'removed'" class="badge removed">已移除</span>
          <span v-else-if="isMuted(m)" class="badge muted">禁言中</span>
        </div>
      </div>
    </div>

    <div class="files-section">
      <h3>群文件（{{ groupFiles.length }}）</h3>
      <div v-if="groupFiles.length === 0" class="empty-hint">暂无文件</div>
      <div v-for="f in groupFiles" :key="f.id" class="file-card">
        <span class="file-icon">{{ getFileIcon(f.filetype, f.filename) }}</span>
        <div class="file-meta">
          <div class="file-name">{{ f.filename || f.id.slice(0,8) }}</div>
          <div class="file-sub">{{ formatSize(f.filesize) }} · {{ senderName(f.from) }}</div>
        </div>
        <button class="file-dl" :disabled="fileBusy[f.id]" @click="onDownloadFile(f)">
          <q-icon :name="fileBusy[f.id] ? 'downloading' : 'download'" size="18px" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useGroupStore } from 'src/stores/group'
import { useChatStore } from 'src/stores/chat'
import { attachmentApi, groupApi } from 'src/services/api.js'
import { downloadOfflineAttachment, acknowledgeGroupAttachment } from 'src/services/offline-attachment.mjs'

const route = useRoute()
const groupStore = useGroupStore()
const chatStore = useChatStore()
const groupId = route.params.groupId

const groupName = computed(() => groupStore.getGroupName(groupId))
const members = computed(() => groupStore.getMembers(groupId))
const groupDetail = computed(() => groupStore.getGroupDetail(groupId))

const groupFiles = computed(() => {
  const msgs = chatStore.messages[groupId] || []
  return msgs.filter(m => m.type === 'file').map(m => ({
    id: m.id,
    filename: m.filename,
    filesize: m.filesize,
    filetype: m.filetype,
    from: m.from,
    offlineAttachment: m.offlineAttachment,
    attachmentId: m.attachmentId,
  }))
})
const createdAt = computed(() => {
  const ts = groupDetail.value?.created_at
  if (!ts) return ''
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
})

function isMuted(m) {
  if (!m.muted_until) return false
  return new Date(m.muted_until) > new Date()
}

function formatSize(bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
  return Math.round(bytes / (1024 * 1024)) + ' MB'
}

// 文件类型图标（与聊天卡片一致）
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

function senderName(chatId) {
  const m = groupStore.getMembers(groupId).find(m => m.chat_id === chatId)
  return m?.nickname || chatId
}

// 群文件下载（复用聊天下载逻辑）
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
    await acknowledgeGroupAttachment(meta, { api: groupApi }).catch(e => {
      console.warn('[group] attachment ack failed', e)
    })
  } catch (e) {
    console.error('[group] file download failed', e)
  } finally {
    fileBusy.value[msg.id] = false
  }
}

onMounted(async () => {
  await groupStore.loadGroupDetail(groupId)
  await chatStore.loadMessages(groupId)
})
</script>

<style scoped>
.group-info-page { padding: 0 0 40px; }
.header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(0,0,0,0.08); }
.header-name { font-weight: 600; font-size: 18px; }
.info-section { padding: 12px 16px; }
.info-row { display: flex; justify-content: space-between; padding: 6px 0; }
.label { color: #888; font-size: 14px; }
.value { font-size: 14px; }
.members-section { padding: 12px 16px; }
.members-section h3 { margin: 0 0 8px; font-size: 16px; }
.member-row { padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.05); }
.member-info { display: flex; align-items: center; gap: 8px; }
.member-name { font-weight: 500; }
.member-id { color: #888; font-size: 13px; }
.badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; }
.badge.removed { background: #fee; color: #c33; }
.badge.muted { background: #fef3cd; color: #856404; }
.files-section { padding: 12px 16px; }
.files-section h3 { margin: 0 0 8px; font-size: 16px; }
.empty-hint { color: #999; font-size: 14px; padding: 8px 0; }
.file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #f7f8fa;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  margin-bottom: 10px;
}
.file-icon { font-size: 28px; flex-shrink: 0; line-height: 1; }
.file-meta { flex: 1; min-width: 0; }
.file-name { font-size: 14px; font-weight: 500; color: #111; word-break: break-all; line-height: 1.3; }
.file-sub { font-size: 12px; color: #888; margin-top: 3px; }
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
