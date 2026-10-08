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
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useGroupStore } from 'src/stores/group'

const route = useRoute()
const groupStore = useGroupStore()
const groupId = route.params.groupId

const groupName = computed(() => groupStore.getGroupName(groupId))
const members = computed(() => groupStore.getMembers(groupId))
const createdAt = computed(() => {
  // from group detail if available
  return ''
})

function isMuted(m) {
  if (!m.muted_until) return false
  return new Date(m.muted_until) > new Date()
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
</style>
