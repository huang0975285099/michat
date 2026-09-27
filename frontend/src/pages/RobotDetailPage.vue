<template>
  <q-page class="q-pa-md">
    <div class="article q-mb-md"><q-btn flat icon="arrow_back" :label="t('返回资讯', 'Back to news')" @click="router.push('/robot')" /></div>
    <div v-if="loading" class="text-center q-pa-xl"><q-spinner color="primary" size="32px" /></div>
    <q-banner v-else-if="error" class="bg-red-1 text-negative" rounded>
      {{ error === 'missing' ? t('资讯不存在或已下架', 'Article not found') : t('加载失败，请重试', 'Could not load article') }}
      <q-btn v-if="error !== 'missing'" flat color="primary" :label="t('重试', 'Retry')" @click="load" />
    </q-banner>
    <article v-else-if="article" class="article">
      <h1 class="text-h5 text-weight-bold q-mb-sm">{{ article.title }}</h1>
      <div class="row items-center q-gutter-sm q-mb-md">
        <span v-if="article.category" class="text-caption text-grey">{{ article.category }}</span>
        <span v-if="formatDate(article.published_at)" class="text-caption text-grey">{{ formatDate(article.published_at) }}</span>
        <q-badge v-if="read" color="grey-6">{{ t('已读', 'Read') }}</q-badge>
        <q-space />
        <q-btn flat :icon="bookmarked ? 'bookmark' : 'bookmark_border'" color="primary" :loading="saving" :label="bookmarked ? t('已收藏', 'Saved') : t('收藏', 'Save')" @click="toggleBookmark" />
      </div>
      <div v-if="article.tags?.length" class="q-mb-md"><q-chip v-for="value in article.tags" :key="value" dense>{{ value }}</q-chip></div>
      <q-btn v-if="hasVideo" flat icon="fullscreen" :label="t('全屏播放视频', 'Play video fullscreen')" class="q-mb-sm" @click="fullscreenVideo" />
      <q-banner v-if="videoError" dense class="bg-orange-1 text-warning q-mb-sm">{{ t('视频无法播放', 'Video could not be played') }}</q-banner>
      <div ref="bodyEl" class="article-body" v-html="article.content" @click="handleBodyClick" @error.capture="handleMediaError" />
    </article>
    <ImageGalleryDialog v-model="galleryOpen" :images="galleryImages" :start-id="galleryStart" @download="downloadImage" />
  </q-page>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { robotApi } from 'src/services/api'
import { useI18n } from 'src/i18n'
import ImageGalleryDialog from 'src/components/ImageGalleryDialog.vue'

const route = useRoute()
const router = useRouter()
const { locale } = useI18n()
const t = (zh, en) => locale.value === 'zh-CN' ? zh : en
const article = ref(null)
const loading = ref(true)
const error = ref('')
const read = ref(false)
const bookmarked = ref(false)
const saving = ref(false)
const galleryOpen = ref(false)
const galleryImages = ref([])
const galleryStart = ref('')
const bodyEl = ref(null)
const videoError = ref(false)
const hasVideo = computed(() => /<video\b/i.test(article.value?.content || ''))
let requestId = 0
function formatDate(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : ''
}
async function load() {
  const current = ++requestId
  article.value = null
  error.value = ''
  videoError.value = false
  loading.value = true
  try {
    const id = route.params.id
    const detail = (await robotApi.get(id)).data
    if (current !== requestId) return
    article.value = detail
    const state = await robotApi.state(id).catch(() => null)
    if (current !== requestId) return
    read.value = !!state?.data?.read
    bookmarked.value = !!state?.data?.bookmarked
    await robotApi.recordView(id).then(() => { if (current === requestId) read.value = true }).catch(() => {})
  }
  catch (err) { if (current === requestId) error.value = err?.response?.status === 404 ? 'missing' : 'network' }
  finally { if (current === requestId) loading.value = false }
}
async function toggleBookmark() {
  if (saving.value) return
  saving.value = true
  try { await robotApi.bookmark(route.params.id, !bookmarked.value); bookmarked.value = !bookmarked.value }
  catch { /* Keep the previous state when saving fails. */ }
  finally { saving.value = false }
}
function handleBodyClick(event) {
  if (event.target?.tagName !== 'IMG') return
  const images = [...event.currentTarget.querySelectorAll('img')]
  galleryImages.value = images.map((img, index) => ({ id: String(index), url: img.currentSrc || img.src }))
  galleryStart.value = String(images.indexOf(event.target))
  galleryOpen.value = true
}
function downloadImage(image) {
  const url = image?.url
  if (!url) return
  const link = document.createElement('a')
  link.href = url
  link.download = url.split('/').pop() || 'image'
  link.click()
}
function handleMediaError(event) { if (event.target?.tagName === 'VIDEO') videoError.value = true }
function fullscreenVideo() {
  const video = bodyEl.value?.querySelector('video')
  if (!video) return
  if (video.requestFullscreen) video.requestFullscreen().catch(() => {})
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen()
  video.play().catch(() => {})
}
onMounted(load)
watch(() => route.params.id, load)
</script>

<style scoped>
.article { max-width: 760px; margin: 0 auto; }
.article-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; }
.article-body :deep(img), .article-body :deep(video) { display: block; max-width: 100%; max-height: 70vh; margin: 16px 0; border-radius: 8px; }
.article-body :deep(img) { cursor: zoom-in; }
.article-body :deep(video) { width: 100%; background: #000; }
@media (orientation: landscape) and (max-height: 500px) { .article-body :deep(video) { max-height: 85vh; } }
.article-body :deep(a) { color: var(--q-primary); }
</style>
