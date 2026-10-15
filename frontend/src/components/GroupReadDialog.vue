<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card class="group-read-card">
      <q-card-section class="group-read-header">
        <q-icon name="done_all" size="25px" color="primary" />
        <div class="group-read-title">{{ t('groupReads.title') }}</div>
        <q-btn flat round dense icon="close" :aria-label="t('common.close')" v-close-popup />
      </q-card-section>
      <q-card-section class="group-read-body">
        <div class="group-read-hint">{{ t('groupReads.senderOnly') }}</div>
        <div v-if="!receipts.length" class="group-read-empty">{{ t('groupReads.empty') }}</div>
        <div v-for="receipt in receipts" :key="receipt.chat_id" class="group-reader">
          <deterministic-avatar :seed="receipt.chat_id" :size="36" />
          <div class="group-reader-name">
            <strong>{{ receipt.nickname || receipt.chat_id }}</strong>
            <span>{{ receipt.chat_id }}</span>
          </div>
          <div class="group-reader-state" :class="{ 'is-read': receipt.verified }">
            <span>{{ t(receipt.verified ? 'groupReads.read' : receipt.proof ? 'groupReads.unverified' : 'groupReads.unread') }}</span>
            <small v-if="receipt.verified">{{ new Date(receipt.readAt).toLocaleString() }}</small>
          </div>
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { useI18n } from 'src/i18n'
import DeterministicAvatar from 'src/components/DeterministicAvatar.vue'
defineProps({ modelValue: Boolean, receipts: { type: Array, default: () => [] } })
defineEmits(['update:modelValue'])
const { t } = useI18n()
</script>

<style scoped>
.group-read-card { width: 430px; max-width: calc(100vw - 32px); border-radius: 18px; }
.group-read-header { display: flex; align-items: center; gap: 10px; padding: 16px; border-bottom: 1px solid #edf1f6; }
.group-read-title { flex: 1; font-size: 17px; font-weight: 650; }
.group-read-body { padding: 12px 16px 18px; max-height: 65vh; overflow-y: auto; }
.group-read-hint { margin-bottom: 12px; color: #8190a3; font-size: 12px; }
.group-read-empty { padding: 24px 0; color: #8190a3; text-align: center; }
.group-reader { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-bottom: 1px solid #edf1f6; }
.group-reader-name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.group-reader-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.group-reader-name span { color: #8a97a7; font-size: 11px; }
.group-reader-state { display: flex; flex-direction: column; align-items: flex-end; color: #8995a3; font-size: 12px; }
.group-reader-state.is-read { color: #1976d2; }
.group-reader-state small { margin-top: 3px; font-size: 10px; color: #8190a3; }
</style>
