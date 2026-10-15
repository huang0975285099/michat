<template>
  <div class="group-info-page">
    <safety-number-dialog v-model="showSafetyNumberDialog" :number="selectedSafetyNumber" :peer-name="selectedMemberName" :peer-id="selectedMemberId" :key-changed="selectedMemberKeyChanged || identity.hasFriendKeyChanged(selectedMemberId)" />
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

    <section class="security-section">
      <div class="security-heading">
        <div class="security-icon"><q-icon name="verified_user" size="21px" /></div>
        <div class="security-heading-copy">
          <h3>{{ t('groupSecurity.title') }}</h3>
          <span>{{ t('groupSecurity.subtitle') }}</span>
        </div>
      </div>

      <div class="security-status" :class="groupStore.isMembershipTrusted(groupId) ? 'is-trusted' : 'is-unapproved'" role="status">
        <q-icon :name="groupStore.isMembershipTrusted(groupId) ? 'check_circle' : 'gpp_maybe'" size="20px" />
        <span>{{ t(groupStore.isMembershipTrusted(groupId) ? 'groupSecurity.trusted' : 'groupSecurity.unapproved') }}</span>
      </div>

      <p class="security-instructions">{{ t('groupSecurity.instructions') }}</p>

      <div class="verification-number">
        <div class="verification-number-label">
          <q-icon name="tag" size="17px" />
          <span>{{ t('groupSecurity.number') }}</span>
        </div>
        <div class="verification-number-value">{{ membership?.number || '—' }}</div>
      </div>

      <div class="fingerprints-heading">
        <span>{{ t('groupSecurity.members') }}</span>
        <q-badge color="grey-3" text-color="grey-8" :label="activeMembers.length" />
      </div>
      <div class="fingerprint-list">
        <div v-for="member in activeMembers" :key="member.chat_id" class="fingerprint-row">
          <div class="fingerprint-member">
            <deterministic-avatar :seed="member.chat_id" :size="36" />
            <div class="fingerprint-member-copy">
              <strong>{{ member.nickname || member.chat_id }}</strong>
              <span>{{ member.chat_id }}</span>
            </div>
          </div>
          <code class="fingerprint-value">{{ membership?.fingerprints?.[member.chat_id] || '—' }}</code>
        </div>
        <div v-if="activeMembers.length === 0" class="fingerprint-empty">{{ t('groupSecurity.noMembers') }}</div>
      </div>

      <div v-if="membership?.pinError" class="security-warning">
        <q-icon name="warning_amber" size="20px" />
        <span>{{ t('groupSecurity.pinConflict') }}</span>
      </div>

      <q-checkbox v-model="independentlyVerified" class="verification-check" :label="t('groupSecurity.verified')" :disable="identity.isLocked || !membership?.snapshot" />

      <div class="security-actions">
        <q-btn unelevated color="primary" icon="verified" :label="t('groupSecurity.approve')" :loading="approving" :disable="identity.isLocked || approving || !independentlyVerified || !membership?.snapshot || membership?.pinError" @click="approveDisplayedRoster" />
        <q-btn outline color="primary" icon="refresh" :label="t('groupSecurity.refresh')" :loading="refreshingRoster" :disable="refreshingRoster" @click="refreshRoster" />
      </div>

      <details class="security-limitations">
        <summary>{{ t('groupSecurity.limitationsTitle') }}</summary>
        <p>{{ t('groupSecurity.limitations') }}</p>
      </details>
    </section>

    <div class="members-section">
      <h3>成员（{{ members.length }}）</h3>
      <div v-for="m in members" :key="m.chat_id" class="member-row">
        <div class="member-info">
          <span class="member-name">{{ m.nickname }}</span>
          <span class="member-id">{{ m.chat_id }}</span>
          <span v-if="m.state === 'removed'" class="badge removed">已移除</span>
          <span v-else-if="isMuted(m)" class="badge muted">禁言中</span>
          <q-btn v-if="m.chat_id !== identity.chatId && m.public_key" flat round dense icon="verified_user" :aria-label="t('chat.verifyIdentity')" @click="showMemberSafetyNumber(m)" />
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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useGroupStore } from 'src/stores/group'
import { useChatStore } from 'src/stores/chat'
import { useIdentityStore } from 'src/stores/identity'
import { useQuasar } from 'quasar'
import { useI18n } from 'src/i18n'
import { loadKeyPair } from 'src/services/crypto.js'
import { safetyNumber } from 'src/services/signed-content.mjs'
import { attachmentApi, groupApi } from 'src/services/api.js'
import { downloadOfflineAttachment, acknowledgeGroupAttachment } from 'src/services/offline-attachment.mjs'
import DeterministicAvatar from 'src/components/DeterministicAvatar.vue'
import SafetyNumberDialog from 'src/components/SafetyNumberDialog.vue'

const route = useRoute()
const groupStore = useGroupStore()
const chatStore = useChatStore()
const identity = useIdentityStore()
const $q = useQuasar()
const { t } = useI18n()
const groupId = route.params.groupId
const membership = computed(() => groupStore.membershipStatus[groupId])
const activeMembers = computed(() => members.value.filter(member => member.state === 'active'))
const independentlyVerified = ref(true)
const approving = ref(false)
const refreshingRoster = ref(false)
const showSafetyNumberDialog = ref(false)
const selectedSafetyNumber = ref('')
const selectedMemberName = ref('')
const selectedMemberId = ref('')
const selectedMemberKeyChanged = ref(false)
let reviewLockGeneration = 0
watch(() => identity.isLocked, () => { reviewLockGeneration += 1 }, { flush: 'sync' })
watch(() => [membership.value?.snapshot, identity.isLocked], () => { independentlyVerified.value = true }, { flush: 'sync' })

async function approveDisplayedRoster() {
  if (!independentlyVerified.value || identity.isLocked || approving.value) return
  const snapshot = membership.value?.snapshot
  const generation = reviewLockGeneration
  approving.value = true
  try {
    await groupStore.approveMembership(groupId, snapshot, () => !identity.isLocked && generation === reviewLockGeneration)
    await chatStore.processPendingMessages()
  } catch {
    $q.notify({ type: 'negative', message: t('groupSecurity.approvalFailed') })
  } finally {
    independentlyVerified.value = true
    approving.value = false
  }
}

async function refreshRoster() {
  if (refreshingRoster.value) return
  refreshingRoster.value = true
  try {
    await groupStore.loadGroupDetail(groupId)
  } finally {
    refreshingRoster.value = false
  }
}

async function showMemberSafetyNumber(member) {
  try {
    const ownKeys = await loadKeyPair()
    selectedSafetyNumber.value = await safetyNumber(identity.chatId, ownKeys.pubKeyB64, member.chat_id, member.public_key)
    selectedMemberName.value = member.nickname || ''
    selectedMemberId.value = member.chat_id
    selectedMemberKeyChanged.value = membership.value?.changedMemberIds?.includes(member.chat_id) || false
    showSafetyNumberDialog.value = true
  } catch {
    $q.notify({ type: 'negative', message: t('chat.actionFailed') })
  }
}

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
  groupStore.setMyChatId(identity.chatId)
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
.security-section {
  margin: 16px;
  padding: 18px;
  overflow: hidden;
  border: 1px solid rgba(35, 105, 190, 0.13);
  border-radius: 18px;
  background: linear-gradient(150deg, #fff 0%, #f7faff 100%);
  box-shadow: 0 8px 24px rgba(32, 71, 120, 0.07);
}
.security-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.security-icon { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 14px; color: #1769c2; background: #e8f2ff; }
.security-heading-copy { min-width: 0; }
.security-heading h3 { margin: 0; color: #172b45; font-size: 17px; font-weight: 700; }
.security-heading-copy > span { display: block; margin-top: 3px; color: #8190a3; font-size: 12px; }
.security-status { display: flex; align-items: flex-start; gap: 9px; padding: 12px; border-radius: 12px; font-size: 13px; line-height: 1.5; }
.security-status.is-trusted { color: #16734a; background: #eaf8f0; }
.security-status.is-unapproved { color: #a75b00; background: #fff5e5; }
.security-status .q-icon { flex: 0 0 auto; margin-top: 1px; }
.security-instructions { margin: 14px 2px 16px; color: #65758a; font-size: 13px; line-height: 1.65; }
.verification-number { padding: 13px 14px; border: 1px solid #dce8f6; border-radius: 13px; background: #fff; }
.verification-number-label { display: flex; align-items: center; gap: 6px; color: #74849a; font-size: 12px; }
.verification-number-value { margin-top: 8px; color: #135dae; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: clamp(19px, 5vw, 26px); font-weight: 750; letter-spacing: 0.08em; line-height: 1.35; overflow-wrap: anywhere; }
.fingerprints-heading { display: flex; align-items: center; gap: 8px; margin: 18px 1px 9px; color: #344860; font-size: 13px; font-weight: 650; }
.fingerprint-list { overflow: hidden; border: 1px solid #e7edf4; border-radius: 13px; background: #fff; }
.fingerprint-row { padding: 12px; }
.fingerprint-row + .fingerprint-row { border-top: 1px solid #edf1f5; }
.fingerprint-member { display: flex; align-items: center; gap: 10px; min-width: 0; }
.fingerprint-member-copy { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.fingerprint-member-copy strong { overflow: hidden; color: #273b52; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.fingerprint-member-copy span { overflow: hidden; color: #8a97a7; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.fingerprint-value { display: block; margin: 9px 0 0 46px; color: #37618d; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; white-space: normal; }
.fingerprint-empty { padding: 18px 12px; color: #8a97a7; font-size: 13px; text-align: center; }
.security-warning { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 11px; border-radius: 11px; color: #a53630; background: #fff0ef; font-size: 12px; line-height: 1.5; }
.security-warning .q-icon { flex: 0 0 auto; }
.verification-check { display: flex; width: 100%; min-height: 40px; align-items: flex-start; margin: 12px 0 4px; color: #40546a; font-size: 13px; }
.verification-check :deep(.q-checkbox__inner) { flex: 0 0 40px; }
.verification-check :deep(.q-checkbox__label) { flex: 1 1 auto; min-width: 0; padding-top: 9px; line-height: 1.5; white-space: normal; }
.security-actions { display: flex; width: 100%; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: 9px; margin-top: 10px; }
.security-actions .q-btn { min-height: 40px; border-radius: 10px; }
.security-limitations { margin-top: 15px; border-top: 1px solid #e6edf5; color: #8190a3; font-size: 11px; line-height: 1.65; }
.security-limitations summary { padding-top: 12px; color: #687b91; cursor: pointer; font-weight: 600; }
.security-limitations p { margin: 8px 0 0; }
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
@media (max-width: 420px) {
  .security-section { margin: 12px; padding: 15px; border-radius: 16px; }
  .security-actions { flex-direction: column; }
  .security-actions .q-btn { width: 100%; }
}
</style>
