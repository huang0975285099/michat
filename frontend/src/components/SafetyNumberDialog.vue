<template>
  <q-dialog v-model="open" :maximized="$q.screen.lt.sm">
    <q-card class="safety-dialog">
      <q-card-section class="safety-header">
        <div class="safety-mark" :class="{ 'has-risk': keyChanged }"><q-icon :name="keyChanged ? 'gpp_maybe' : 'verified_user'" size="25px" /></div>
        <div class="safety-title-wrap">
          <div class="safety-title">{{ t('chat.verifyIdentity') }}</div>
          <div class="safety-peer" v-if="peerName || peerId">{{ peerName || peerId }}</div>
        </div>
        <q-btn flat round dense icon="close" :aria-label="t('common.close')" v-close-popup />
      </q-card-section>

      <q-card-section class="safety-body">
        <div v-if="keyChanged" class="safety-risk" role="alert">
          <q-icon name="gpp_maybe" size="22px" />
          <div>
            <strong>{{ t('chat.keyChangeRiskTitle') }}</strong>
            <p>{{ t('chat.keyChangeRiskHint') }}</p>
          </div>
        </div>
        <div class="safety-intro">
          <q-icon name="info" size="19px" />
          <p>{{ t('chat.verifyIdentityHint') }}</p>
        </div>

        <div class="safety-number-card">
          <div class="safety-number-label">{{ t('chat.safetyNumber') }}</div>
          <div class="safety-number" aria-live="polite">{{ formattedNumber }}</div>
          <q-btn class="copy-button" outline color="primary" icon="content_copy" :label="t('chat.copySafetyNumber')" @click="copyNumber" />
        </div>

        <div class="safety-reminder">
          <q-icon name="handshake" size="20px" />
          <span>{{ t('chat.safetyNumberReminder') }}</span>
        </div>
      </q-card-section>

      <q-card-actions align="right" class="safety-actions">
        <q-btn unelevated color="primary" :label="t('common.close')" v-close-popup />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { copyToClipboard, useQuasar } from 'quasar'
import { useI18n } from 'src/i18n'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  number: { type: String, default: '' },
  peerName: { type: String, default: '' },
  peerId: { type: String, default: '' },
  keyChanged: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])
const $q = useQuasar()
const { t } = useI18n()
const open = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value),
})
const formattedNumber = computed(() => props.number.match(/.{1,4}/g)?.join(' ') || props.number)

async function copyNumber() {
  try {
    await copyToClipboard(props.number)
    $q.notify({ type: 'positive', message: t('chat.safetyNumberCopied') })
  } catch {
    $q.notify({ type: 'negative', message: t('chat.actionFailed') })
  }
}
</script>

<style scoped>
.safety-dialog { width: min(460px, calc(100vw - 32px)); overflow: hidden; border-radius: 20px; background: #f7f9fc; }
.safety-header { display: flex; align-items: center; gap: 12px; padding: 20px 20px 16px; background: #fff; }
.safety-mark { display: grid; width: 46px; height: 46px; flex: 0 0 auto; place-items: center; border-radius: 15px; color: #1769c2; background: #e9f2ff; }
.safety-mark.has-risk { color: #c62828; background: #ffebee; }
.safety-title-wrap { flex: 1; min-width: 0; }
.safety-title { color: #172b45; font-size: 18px; font-weight: 700; }
.safety-peer { margin-top: 3px; overflow: hidden; color: #8290a2; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.safety-body { padding: 18px 20px 12px; }
.safety-risk { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 15px; padding: 12px; border: 1px solid #f2c0bc; border-radius: 12px; color: #a52620; background: #fff0ef; }
.safety-risk > .q-icon { flex: 0 0 auto; }
.safety-risk strong { display: block; font-size: 13px; }
.safety-risk p { margin: 4px 0 0; font-size: 12px; line-height: 1.55; }
.safety-intro { display: flex; align-items: flex-start; gap: 9px; color: #52657b; }
.safety-intro .q-icon { flex: 0 0 auto; margin-top: 2px; color: #5983b5; }
.safety-intro p { margin: 0; font-size: 13px; line-height: 1.65; }
.safety-number-card { margin-top: 18px; padding: 17px 15px 14px; border: 1px solid #dce8f7; border-radius: 16px; background: linear-gradient(145deg, #fff, #f1f7ff); text-align: center; }
.safety-number-label { color: #71839a; font-size: 12px; font-weight: 600; }
.safety-number { margin: 12px 0 16px; color: #145eac; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: clamp(20px, 6vw, 27px); font-weight: 750; letter-spacing: 0.08em; line-height: 1.55; overflow-wrap: anywhere; }
.copy-button { min-height: 38px; border-radius: 10px; }
.safety-reminder { display: flex; align-items: flex-start; gap: 9px; margin-top: 14px; padding: 12px; border-radius: 12px; color: #58708b; background: #edf2f8; font-size: 12px; line-height: 1.55; }
.safety-reminder .q-icon { flex: 0 0 auto; color: #668bb5; }
.safety-actions { padding: 4px 20px 18px; }
.safety-actions .q-btn { min-width: 92px; min-height: 40px; border-radius: 10px; }
@media (max-width: 599px) {
  .safety-dialog { width: 100%; max-width: none; border-radius: 20px 20px 0 0; align-self: flex-end; }
}
</style>
