<template>
  <q-menu context-menu touch-position>
    <q-list dense class="message-action-list">
      <q-item v-if="canReply" clickable v-close-popup @click="emit('reply')">
        <q-item-section avatar><q-icon name="reply" size="20px" /></q-item-section>
        <q-item-section>{{ t('chat.reply') }}</q-item-section>
      </q-item>

      <q-item v-if="canCopy" clickable v-close-popup @click="emit('copy')">
        <q-item-section avatar><q-icon name="content_copy" size="20px" /></q-item-section>
        <q-item-section>{{ t('chat.copy') }}</q-item-section>
      </q-item>

      <q-item v-if="canRetry" clickable v-close-popup class="text-primary" @click="emit('retry')">
        <q-item-section avatar><q-icon name="refresh" size="20px" /></q-item-section>
        <q-item-section>{{ t('chat.resend') }}</q-item-section>
      </q-item>

      <q-separator v-if="canDelete || canRecall" />

      <q-item v-if="canDelete" clickable v-close-popup class="text-negative" @click="emit('delete')">
        <q-item-section avatar><q-icon name="delete_outline" size="20px" /></q-item-section>
        <q-item-section>{{ t('chat.deleteMine') }}</q-item-section>
      </q-item>

      <q-item v-if="canRecall" clickable v-close-popup class="text-negative" @click="emit('recall')">
        <q-item-section avatar><q-icon name="undo" size="20px" /></q-item-section>
        <q-item-section>{{ t('chat.deleteBoth') }}</q-item-section>
      </q-item>
    </q-list>
  </q-menu>
</template>

<script setup>
import { useI18n } from 'src/i18n'

defineProps({
  canReply: Boolean,
  canCopy: Boolean,
  canRetry: Boolean,
  canDelete: Boolean,
  canRecall: Boolean,
})

const emit = defineEmits(['reply', 'copy', 'retry', 'delete', 'recall'])
const { t } = useI18n()
</script>

<style scoped>
.message-action-list {
  min-width: 156px;
  padding: 4px 0;
}
.message-action-list :deep(.q-item__section--avatar) {
  min-width: 34px;
}
</style>
