<template>
  <q-page class="robot-page">
    <div class="feed-shell">
      <div class="search-row">
        <q-input v-model="searchText" borderless dense clearable debounce="350" :placeholder="t('搜索具身智能资讯', 'Search embodied AI news')" class="search-input" @update:model-value="applyFilters">
          <template #prepend><q-icon name="search" size="20px" /></template>
        </q-input>
        <q-btn flat round icon="refresh" class="refresh-btn" :aria-label="t('刷新', 'Refresh')" :loading="loading" @click="load(true)" />
      </div>

      <div v-if="filterOptions.categories.length" class="category-strip" :aria-label="t('分类', 'Categories')">
        <button v-for="option in categoryChoices" :key="option.value || 'all'" type="button" class="category-pill" :class="{ selected: category === option.value }" @click="category = option.value; applyFilters()">{{ option.label }}</button>
      </div>

      <div class="feed-heading">
        <div>
          <div class="section-kicker">{{ t('资讯速览', 'LATEST UPDATES') }}</div>
          <div class="section-title">{{ bookmarkedOnly ? t('我的收藏', 'Saved articles') : t('最新发布', 'Latest stories') }}</div>
        </div>
        <div class="feed-actions">
          <q-btn-dropdown v-if="filterOptions.tags.length" flat no-caps class="filter-button" icon="sell" :label="tag || t('标签', 'Tags')">
            <q-list dense class="tag-menu">
              <q-item clickable v-close-popup @click="tag = null; applyFilters()"><q-item-section>{{ t('全部标签', 'All tags') }}</q-item-section></q-item>
              <q-item v-for="option in filterOptions.tags" :key="option" clickable v-close-popup @click="tag = option; applyFilters()"><q-item-section>{{ option }}</q-item-section></q-item>
            </q-list>
          </q-btn-dropdown>
          <q-btn flat round :icon="bookmarkedOnly ? 'bookmark' : 'bookmark_border'" :color="bookmarkedOnly ? 'primary' : undefined" :aria-label="t('我的收藏', 'Saved articles')" @click="bookmarkedOnly = !bookmarkedOnly; applyFilters()" />
        </div>
      </div>

      <div v-if="loading && !articles.length" class="feed-state"><q-spinner color="primary" size="32px" /></div>
      <div v-else-if="error && !articles.length" class="feed-state">
        <q-icon name="wifi_off" size="36px" color="grey-5" />
        <div>{{ t('资讯加载失败', 'Could not load articles') }}</div>
        <q-btn flat color="primary" :label="t('重试', 'Retry')" @click="load(true)" />
      </div>
      <div v-else-if="!articles.length" class="feed-state">
        <q-icon :name="bookmarkedOnly ? 'bookmark_border' : 'article'" size="38px" color="grey-5" />
        <div>{{ bookmarkedOnly ? t('还没有收藏的资讯', 'No saved articles yet') : t('暂无资讯', 'No articles yet') }}</div>
      </div>
      <div v-else class="article-list">
        <button v-for="article in articles" :key="article.id" type="button" class="article-card" @click="router.push(`/robot/${article.id}`)">
          <div class="article-content">
            <div class="article-overline">
              <span v-if="article.category" class="article-category">{{ article.category }}</span>
              <span v-if="article.pinned" class="pinned"><q-icon name="push_pin" size="13px" /> {{ t('置顶', 'Pinned') }}</span>
              <span v-if="!article.category && !article.pinned" class="article-category">{{ t('资讯', 'News') }}</span>
            </div>
            <div class="article-title">{{ article.title }}</div>
            <div v-if="article.summary" class="article-summary">{{ article.summary }}</div>
            <div v-if="article.source" class="article-source">{{ t('来源：', 'Source: ') }}{{ article.source }}</div>
            <div class="article-meta">
              <span>{{ formatDate(article.published_at) }}</span>
              <span v-if="article.read" class="read-status"><q-icon name="done" size="15px" />{{ t('已读', 'Read') }}</span>
              <q-icon v-if="article.bookmarked" name="bookmark" size="17px" color="primary" class="saved-icon" />
            </div>
          </div>
        </button>
      </div>
      <div v-if="articles.length && (hasMore || error)" class="load-more">
        <q-btn flat no-caps color="primary" :loading="loading" :label="error ? t('重试', 'Retry') : t('加载更多', 'Load more')" @click="load(false)" />
      </div>
    </div>
  </q-page>
</template>

<script setup>
import { computed, ref, onMounted, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { robotApi } from 'src/services/api'
import { useI18n } from 'src/i18n'

const router = useRouter()
const { locale } = useI18n()
const t = (zh, en) => locale.value === 'zh-CN' ? zh : en
const articles = ref([])
const loading = ref(false)
const error = ref(false)
const hasMore = ref(false)
const filterOptions = ref({ categories: [], tags: [] })
const searchText = ref('')
const category = ref(null)
const tag = ref(null)
const bookmarkedOnly = ref(false)
const categoryChoices = computed(() => [
  { value: null, label: t('全部', 'All') },
  ...filterOptions.value.categories.map(value => ({ value, label: value }))
])
let requestId = 0

function formatDate(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : ''
}
function applyFilters() { load(true) }
async function load(reset = false) {
  if (loading.value && !reset) return
  const current = ++requestId
  if (reset) { articles.value = []; hasMore.value = false }
  loading.value = true
  error.value = false
  try {
    const params = { limit: 20, offset: articles.value.length }
    if (searchText.value?.trim()) params.search = searchText.value.trim()
    if (category.value) params.category = category.value
    if (tag.value) params.tag = tag.value
    if (bookmarkedOnly.value) params.bookmarked = 1
    const { data } = await robotApi.list(params)
    if (current !== requestId) return
    articles.value = reset ? (data.articles || []) : [...articles.value, ...(data.articles || [])]
    hasMore.value = !!data.has_more
  } catch { if (current === requestId) error.value = true }
  finally { if (current === requestId) loading.value = false }
}
async function loadFilters() {
  try { filterOptions.value = (await robotApi.filters()).data } catch { /* List remains usable. */ }
}
onMounted(() => { load(true); loadFilters() })
onActivated(() => { if (articles.value.length) load(true) })
</script>

<style scoped>
.robot-page { min-height: 100%; background: #f5f7fa; color: #182536; }
.feed-shell { max-width: 760px; margin: 0 auto; padding: 18px 16px 38px; }
.search-row { display: flex; align-items: center; gap: 8px; }
.search-input { flex: 1; min-width: 0; height: 44px; padding: 0 13px; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 2px 8px rgba(21, 43, 70, .03); }
.search-input :deep(.q-field__control) { height: 42px; min-height: 42px; }
.search-input :deep(.q-field__prepend) { color: #8997a8; }
.refresh-btn { flex: none; color: #537291; }
.category-strip { display: flex; gap: 8px; overflow-x: auto; padding: 16px 0 6px; scrollbar-width: none; }
.category-strip::-webkit-scrollbar { display: none; }
.category-pill { flex: none; border: 1px solid #e2e8f0; border-radius: 999px; background: #fff; color: #66778a; padding: 7px 16px; font: inherit; font-size: 13px; cursor: pointer; }
.category-pill.selected { background: #1976d2; border-color: #1976d2; color: #fff; font-weight: 600; }
.feed-heading { display: flex; align-items: end; justify-content: space-between; gap: 8px; margin: 24px 0 14px; }
.section-kicker { color: #8495a7; font-size: 10px; font-weight: 700; letter-spacing: 1.5px; }
.section-title { margin-top: 3px; font-size: 20px; line-height: 1.3; font-weight: 700; }
.feed-actions { display: flex; align-items: center; flex: none; color: #587089; }
.filter-button { min-height: 36px; padding: 0 2px; font-size: 12px; }
.tag-menu { min-width: 150px; max-height: 300px; overflow-y: auto; }
.article-list { display: grid; gap: 12px; }
.article-card { width: 100%; padding: 0; overflow: hidden; text-align: left; font: inherit; color: inherit; border: 1px solid #e7ecf2; border-radius: 16px; background: #fff; box-shadow: 0 4px 14px rgba(25, 48, 75, .035); cursor: pointer; }
.article-card:focus-visible, .category-pill:focus-visible { outline: 2px solid #1976d2; outline-offset: 2px; }
.article-content { padding: 16px 17px 15px; }
.article-overline { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 11px; font-weight: 700; }
.article-category { color: #1976d2; }
.pinned { color: #d27b2b; }
.article-title { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; font-size: 17px; font-weight: 700; line-height: 1.45; overflow-wrap: anywhere; }
.article-summary { margin-top: 7px; color: #68798b; font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.article-source { margin-top: 9px; color: #66798d; font-size: 11px; overflow-wrap: anywhere; }
.article-meta { display: flex; align-items: center; gap: 14px; min-height: 20px; margin-top: 14px; color: #94a1af; font-size: 11px; }
.read-status { display: inline-flex; align-items: center; gap: 2px; }
.saved-icon { margin-left: auto; }
.feed-state { display: flex; min-height: 210px; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #8291a2; font-size: 13px; }
.load-more { padding-top: 12px; text-align: center; }
@media (min-width: 640px) { .feed-shell { padding: 28px 28px 52px; } }
</style>
