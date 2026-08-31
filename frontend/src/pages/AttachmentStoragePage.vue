<template>
  <q-page class="attachment-storage-page q-pa-md">
    <q-card flat bordered class="summary-card q-mb-md">
      <q-card-section>
        <div class="row items-center no-wrap">
          <q-icon name="shield" color="primary" size="32px" class="q-mr-md" />
          <div>
            <div class="text-subtitle1 text-weight-medium">{{ t('attachmentStorage.localAttachments') }}</div>
            <div class="text-h5 text-weight-bold">{{ formatBytes(stats.attachmentBytes) }}</div>
            <div class="text-caption text-grey-7">{{ t('attachmentStorage.files', { count: stats.messageCount }) }}</div>
          </div>
        </div>
        <q-linear-progress
          v-if="stats.storage.supported && stats.storage.quota"
          rounded
          size="8px"
          color="primary"
          track-color="blue-grey-2"
          :value="Math.min(1, stats.storage.usage / stats.storage.quota)"
          class="q-mt-md"
        />
        <div class="row justify-between text-caption text-grey-7 q-mt-sm">
          <span>{{ t('attachmentStorage.appStorage') }}：{{ storageUsage }}</span>
          <span>{{ t('attachmentStorage.remaining') }}：{{ storageAvailable }}</span>
        </div>
        <div v-if="stats.temporaryBytes" class="text-caption text-orange-9 q-mt-xs">
          {{ t('attachmentStorage.temporary', { size: formatBytes(stats.temporaryBytes) }) }}
        </div>
      </q-card-section>
    </q-card>

    <q-card flat bordered class="summary-card q-mb-md">
      <q-card-section>
        <div class="row items-center no-wrap">
          <q-icon name="cloud_queue" color="indigo" size="32px" class="q-mr-md" />
          <div class="col">
            <div class="text-subtitle1 text-weight-medium">{{ t('attachmentStorage.serverTemporary') }}</div>
            <template v-if="serverQuota.supported">
              <div class="text-h6 text-weight-bold">{{ t('attachmentStorage.serverQuotaUsed', { used: formatBytes(serverQuota.usedBytes), limit: formatBytes(serverQuota.limitBytes) }) }}</div>
              <div class="text-caption text-grey-7">{{ t('attachmentStorage.serverQuotaRemaining', { remaining: formatBytes(serverQuota.remainingBytes) }) }}</div>
            </template>
            <div v-else class="text-body2 text-grey-7">{{ t('attachmentStorage.serverQuotaUnavailable') }}</div>
          </div>
        </div>
        <q-linear-progress
          v-if="serverQuota.supported && serverQuota.limitBytes"
          rounded size="8px" color="indigo" track-color="blue-grey-2"
          :value="Math.min(1, serverQuota.usedBytes / serverQuota.limitBytes)"
          class="q-mt-md"
        />
        <div class="text-caption text-grey-7 q-mt-sm">{{ t('attachmentStorage.serverQuotaHint') }}</div>
      </q-card-section>
    </q-card>

    <q-card flat bordered class="summary-card q-mb-md">
      <q-item tag="label">
        <q-item-section>
          <q-item-label>{{ t('attachmentStorage.autoCleanReceived') }}</q-item-label>
          <q-item-label caption>{{ t('attachmentStorage.autoCleanReceivedHint') }}</q-item-label>
        </q-item-section>
        <q-item-section side>
          <q-toggle v-model="autoCleanReceived" color="primary" @update:model-value="updateAutoClean" />
        </q-item-section>
      </q-item>
    </q-card>

    <q-banner rounded class="bg-blue-1 text-blue-grey-9 q-mb-md">
      <template #avatar><q-icon name="info" color="primary" /></template>
      {{ t('attachmentStorage.cleanableHint') }}
    </q-banner>

    <div class="row q-col-gutter-sm q-mb-md">
      <div class="col-12 col-sm-6">
        <q-btn outline color="primary" icon="auto_delete" class="full-width" :loading="cleaningStale" :label="t('attachmentStorage.cleanupStale')" @click="cleanStale" />
      </div>
      <div class="col-12 col-sm-6">
        <q-btn unelevated color="negative" icon="delete_sweep" class="full-width" :disable="!stats.attachmentBytes" :loading="cleaningAll" :label="t('attachmentStorage.cleanupAll')" @click="confirmCleanAll" />
      </div>
    </div>

    <q-list v-if="stats.chats.length" bordered separator rounded-borders class="bg-white">
      <q-item v-for="chat in stats.chats" :key="chat.chatId">
        <q-item-section avatar><deterministic-avatar :seed="chat.chatId" :size="42" /></q-item-section>
        <q-item-section>
          <q-item-label>{{ chatName(chat.chatId) }}</q-item-label>
          <q-item-label caption>{{ chat.chatId }} · {{ t('attachmentStorage.files', { count: chat.messageCount }) }}</q-item-label>
        </q-item-section>
        <q-item-section side class="items-end">
          <div class="text-weight-medium q-mb-xs">{{ formatBytes(chat.bytes) }}</div>
          <q-btn flat dense color="negative" :label="t('attachmentStorage.cleanupChat')" @click="confirmCleanChat(chat)" />
        </q-item-section>
      </q-item>
    </q-list>
    <div v-else-if="!loading" class="text-center text-grey-6 q-py-xl">
      <q-icon name="folder_off" size="48px" class="q-mb-sm" />
      <div>{{ t('attachmentStorage.noAttachments') }}</div>
    </div>
    <q-inner-loading :showing="loading"><q-spinner color="primary" size="36px" /></q-inner-loading>
  </q-page>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useQuasar } from 'quasar'
import { useChatStore } from 'src/stores/chat'
import { useIdentityStore } from 'src/stores/identity'
import { useI18n } from 'src/i18n'
import { formatStorageBytes } from 'src/services/attachment-storage.mjs'
import { attachmentApi } from 'src/services/api'
import { loadAttachmentAutoClean, saveAttachmentAutoClean } from 'src/services/chat-preferences.mjs'
import DeterministicAvatar from 'src/components/DeterministicAvatar.vue'

const $q = useQuasar()
const chatStore = useChatStore()
const identity = useIdentityStore()
const { locale, t } = useI18n()
const loading = ref(true)
const cleaningAll = ref(false)
const cleaningStale = ref(false)
const autoCleanReceived = ref(loadAttachmentAutoClean(identity.chatId))
const stats = reactive({ attachmentBytes: 0, temporaryBytes: 0, messageCount: 0, chats: [], storage: { supported: false } })
const serverQuota = reactive({ supported: false, usedBytes: 0, limitBytes: 0, remainingBytes: 0 })
const formatBytes = bytes => formatStorageBytes(bytes, locale.value)
const storageUsage = computed(() => stats.storage.supported ? formatBytes(stats.storage.usage) : t('attachmentStorage.unavailable'))
const storageAvailable = computed(() => stats.storage.supported ? formatBytes(stats.storage.available) : t('attachmentStorage.unavailable'))
const chatName = chatId => identity.getFriendName(chatId) || chatId

function applyStats(next) { Object.assign(stats, next) }
async function refresh() {
  loading.value = true
  const [localResult, quotaResult] = await Promise.allSettled([
    chatStore.getAttachmentStorageStats(),
    attachmentApi.quota(),
  ])
  if (localResult.status === 'fulfilled') applyStats(localResult.value)
  else $q.notify({ type: 'negative', message: t('attachmentStorage.loadFailed') })
  if (quotaResult.status === 'fulfilled') {
    const data = quotaResult.value?.data || {}
    Object.assign(serverQuota, {
      supported: true,
      usedBytes: Number(data.used_bytes) || 0,
      limitBytes: Number(data.limit_bytes) || 0,
      remainingBytes: Number(data.remaining_bytes) || 0,
    })
  } else {
    serverQuota.supported = false
  }
  autoCleanReceived.value = loadAttachmentAutoClean(identity.chatId)
  loading.value = false
}
function updateAutoClean(enabled) { saveAttachmentAutoClean(identity.chatId, enabled) }
async function clean(chatId = null) {
  const before = stats.attachmentBytes
  try {
    applyStats(await chatStore.clearAttachmentStorage(chatId))
    const freed = Math.max(0, before - stats.attachmentBytes)
    $q.notify({ type: freed ? 'positive' : 'info', message: freed ? t('attachmentStorage.cleaned', { size: formatBytes(freed) }) : t('attachmentStorage.nothingToClean') })
  } catch { $q.notify({ type: 'negative', message: t('attachmentStorage.cleanupFailed') }) }
}
function confirmCleanAll() {
  $q.dialog({ title: t('attachmentStorage.confirmAllTitle'), message: t('attachmentStorage.confirmAllMessage'), cancel: true, persistent: true }).onOk(async () => {
    cleaningAll.value = true
    try { await clean() } finally { cleaningAll.value = false }
  })
}
function confirmCleanChat(chat) {
  $q.dialog({ title: t('attachmentStorage.confirmChatTitle'), message: t('attachmentStorage.confirmChatMessage', { name: chatName(chat.chatId) }), cancel: true, persistent: true }).onOk(() => clean(chat.chatId))
}
async function cleanStale() {
  cleaningStale.value = true
  try {
    const result = await chatStore.cleanupStaleAttachmentStorage(0)
    await refresh()
    $q.notify({ type: result.removedBytes ? 'positive' : 'info', message: result.removedBytes ? t('attachmentStorage.cleaned', { size: formatBytes(result.removedBytes) }) : t('attachmentStorage.nothingToClean') })
  } catch { $q.notify({ type: 'negative', message: t('attachmentStorage.cleanupFailed') }) }
  finally { cleaningStale.value = false }
}
onMounted(refresh)
</script>

<style scoped>
.attachment-storage-page { max-width: 760px; margin: 0 auto; }
.summary-card { border-radius: 14px; }
</style>
