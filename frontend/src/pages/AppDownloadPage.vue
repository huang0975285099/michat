<template>
  <q-page class="app-download-page q-pa-md">
    <div class="text-body2 text-grey-7 q-mb-md">{{ t('appDownload.intro') }}</div>

    <q-card flat bordered class="download-card q-mb-md">
      <q-card-section class="row items-center no-wrap q-gutter-md">
        <q-icon name="desktop_windows" color="primary" size="36px" />
        <div>
          <div class="text-subtitle1 text-weight-medium">{{ t('appDownload.windows') }}</div>
          <div class="text-caption text-grey-7">{{ t('appDownload.windowsHint') }}</div>
        </div>
      </q-card-section>
      <q-card-actions align="right" class="q-pa-md q-pt-none">
        <q-btn unelevated color="primary" icon="download" :label="t('appDownload.downloadWindows')" @click="downloadPackage('yunChat.exe')" />
      </q-card-actions>
    </q-card>

    <q-card flat bordered class="download-card q-mb-md">
      <q-card-section class="row items-center no-wrap q-gutter-md">
        <q-icon name="android" color="positive" size="36px" />
        <div>
          <div class="text-subtitle1 text-weight-medium">{{ t('appDownload.android') }}</div>
          <div class="text-caption text-grey-7">{{ t('appDownload.androidHint') }}</div>
        </div>
      </q-card-section>
      <q-card-actions align="right" class="q-pa-md q-pt-none">
        <q-btn unelevated color="primary" icon="download" :label="t('appDownload.downloadAndroid')" @click="downloadPackage('yunChat.apk')" />
      </q-card-actions>
    </q-card>

    <q-btn flat no-caps color="primary" icon="verified" :label="t('appDownload.checksum')" @click="downloadPackage('SHA256SUMS.txt')" />
  </q-page>
</template>

<script setup>
import { useQuasar } from 'quasar'
import { useI18n } from 'src/i18n'
import { openUpdateUrl } from 'src/services/native-update.mjs'

const $q = useQuasar()
const { t } = useI18n()

async function downloadPackage(filename) {
  try {
    await openUpdateUrl(`https://m.yzs88.com:8088/download/${filename}`)
  } catch (error) {
    console.warn('[download] unable to open installer', error)
    $q.notify({ type: 'negative', message: t('update.openFailed') })
  }
}
</script>

<style scoped>
.app-download-page { max-width: 760px; margin: 0 auto; background: #f5f7fa; }
.download-card { border-radius: 14px; }
</style>
