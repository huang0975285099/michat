<template>
  <q-page class="detail-page">
    <div class="detail-shell">
      <div v-if="loading" class="detail-state"><q-spinner color="primary" size="32px" /></div>
      <div v-else-if="error" class="detail-state">
        <q-icon :name="error === 'missing' ? 'article' : 'wifi_off'" size="38px" color="grey-5" />
        <div>{{ error === 'missing' ? t('资讯不存在或已下架', 'Article not found') : t('加载失败，请重试', 'Could not load article') }}</div>
        <q-btn v-if="error !== 'missing'" flat color="primary" :label="t('重试', 'Retry')" @click="load" />
      </div>
      <article v-else-if="article" class="article">
        <div class="article-head">
          <div class="detail-category">{{ article.category || t('具身智能资讯', 'Embodied AI News') }}</div>
          <h1>{{ article.title }}</h1>
          <div class="detail-meta">
            <span v-if="formatDate(article.published_at)">{{ formatDate(article.published_at) }}</span>
            <span v-if="read" class="read-status"><q-icon name="done" size="15px" />{{ t('已读', 'Read') }}</span>
          </div>
          <div v-if="article.source" class="detail-source">{{ t('来源：', 'Source: ') }}{{ article.source }}</div>
          <div v-if="article.tags?.length" class="detail-tags"><span v-for="value in article.tags" :key="value">#{{ value }}</span></div>
        </div>
        <div class="article-body-wrap">
          <section v-if="article.summary" class="summary-block" :aria-label="t('摘要', 'Summary')">
            <div class="summary-label">{{ t('摘要', 'Summary') }}</div>
            <p>{{ article.summary }}</p>
          </section>
          <q-btn v-if="hasVideo" flat no-caps icon="fullscreen" :label="t('全屏播放视频', 'Play video fullscreen')" class="video-action" @click="fullscreenVideo" />
          <q-banner v-if="videoError" dense class="bg-orange-1 text-warning q-mb-sm">{{ t('视频无法播放', 'Video could not be played') }}</q-banner>
          <div ref="bodyEl" class="article-body" v-html="renderedContent" @click="handleBodyClick" @error.capture="handleMediaError" />
        </div>
        <div class="article-footer">
          <q-btn unelevated no-caps :icon="bookmarked ? 'bookmark' : 'bookmark_border'" :label="bookmarked ? t('已收藏', 'Saved') : t('收藏文章', 'Save article')" :loading="saving" class="save-button" @click="toggleBookmark" />
        </div>
      </article>
    </div>
    <ImageGalleryDialog v-model="galleryOpen" :images="galleryImages" :start-id="galleryStart" @download="downloadImage" />
  </q-page>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import api, { robotApi } from 'src/services/api'
import { resolveRobotContentMedia } from 'src/services/robot-media'
import { useI18n } from 'src/i18n'
import ImageGalleryDialog from 'src/components/ImageGalleryDialog.vue'

const route = useRoute()
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
const renderedContent = computed(() => resolveRobotContentMedia(article.value?.content, api.defaults.baseURL))
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
.detail-page { min-height: 100%; background: #f5f7fa; color: #182536; }
.detail-shell { max-width: 760px; margin: 0 auto; padding: 16px 12px 36px; }
.article { overflow: hidden; border: 1px solid #e7ecf2; border-radius: 16px; background: #fff; box-shadow: 0 4px 14px rgba(25, 48, 75, .035); }
.article-head { padding: 25px 20px 21px; border-bottom: 1px solid #edf0f4; }
.detail-category { margin-bottom: 11px; color: #1976d2; font-size: 12px; font-weight: 700; }
h1 { margin: 0; font-size: clamp(23px, 5vw, 30px); line-height: 1.42; font-weight: 700; overflow-wrap: anywhere; }
.detail-meta { display: flex; align-items: center; gap: 15px; margin-top: 15px; color: #8a98a7; font-size: 12px; }
.detail-source { margin-top: 10px; color: #68798b; font-size: 12px; overflow-wrap: anywhere; }
.read-status { display: inline-flex; align-items: center; gap: 2px; }
.detail-tags { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 15px; }
.detail-tags span { padding: 5px 9px; border-radius: 7px; background: #f1f6fc; color: #47729e; font-size: 11px; }
.article-body-wrap { padding: 20px; }
.summary-block { margin-bottom: 22px; padding: 15px 16px; border-left: 3px solid #1976d2; border-radius: 0 10px 10px 0; background: #f2f7fd; }
.summary-label { margin-bottom: 7px; color: #1976d2; font-size: 11px; font-weight: 700; }
.summary-block p { margin: 0; color: #41576d; font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.article-body { overflow-wrap: anywhere; font-size: 15px; line-height: 1.8; }
.article-body :deep(p) { margin: 0 0 1.1em; }
.article-body :deep(h2), .article-body :deep(h3) { margin: 1.4em 0 .6em; line-height: 1.35; }
.article-body :deep(img), .article-body :deep(video) { display: block; max-width: 100%; max-height: 70vh; margin: 18px 0; border-radius: 10px; }
.article-body :deep(img) { cursor: zoom-in; }
.article-body :deep(video) { width: 100%; background: #000; }
@media (orientation: landscape) and (max-height: 500px) { .article-body :deep(video) { max-height: 85vh; } }
.article-body :deep(a) { color: var(--q-primary); }
.video-action { color: #47729e; margin: -8px 0 8px; }
.article-footer { padding: 0 20px 22px; }
.save-button { width: 100%; border-radius: 10px; background: #edf5fd; color: #1976d2; }
.detail-state { display: flex; min-height: 260px; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #8291a2; font-size: 13px; }
@media (min-width: 640px) { .detail-shell { padding: 28px 24px 52px; } .article-head { padding: 36px 40px 26px; } .article-body-wrap { padding: 30px 40px; } .article-footer { padding: 0 40px 34px; } }
</style>
