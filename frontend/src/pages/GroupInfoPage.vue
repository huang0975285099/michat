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
      <h3>群文件</h3>
      <div v-if="groupFiles.length === 0" class="empty-hint">暂无文件</div>
      <div v-for="f in groupFiles" :key="f.id" class="file-row">
        <span class="file-name">📎 {{ f.filename || f.id.slice(0,8) }}</span>
        <span class="file-meta">{{ formatSize(f.filesize) }} · {{ f.from }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useGroupStore } from 'src/stores/group'
import { useChatStore } from 'src/stores/chat'

const route = useRoute()
const groupStore = useGroupStore()
const chatStore = useChatStore()
const groupId = route.params.groupId

const groupName = computed(() => groupStore.getGroupName(groupId))
const members = computed(() => groupStore.getMembers(groupId))

const groupFiles = computed(() => {
  const msgs = chatStore.messages[groupId] || []
  return msgs.filter(m => m.type === 'file').map(m => ({
    id: m.id, filename: m.filename, filesize: m.filesize, from: m.from,
  }))
})
const createdAt = computed(() => {
  // from group detail if available
  return ''
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

onMounted(async () => {
  await groupStore.loadGroupDetail(groupId)
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
.file-row { padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.05); display: flex; flex-direction: column; gap: 2px; }
.file-name { font-weight: 500; font-size: 14px; }
.file-meta { color: #888; font-size: 12px; }
</style>
