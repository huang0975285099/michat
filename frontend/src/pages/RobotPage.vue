<template>
  <q-page class="q-pa-md">
    <div class="row items-center justify-between q-mb-md">
      <div class="text-h6">{{ t('机器人资讯', 'Robot news') }}</div>
      <q-btn flat round icon="refresh" :aria-label="t('刷新', 'Refresh')" @click="load(true)" />
    </div>
    <q-input v-model="searchText" outlined dense clearable debounce="350" :placeholder="t('搜索标题或摘要', 'Search articles')" class="q-mb-sm" @update:model-value="applyFilters">
      <template #prepend><q-icon name="search" /></template>
    </q-input>
    <div class="row q-gutter-sm q-mb-md">
      <q-select v-model="category" dense outlined clearable :options="filterOptions.categories" :label="t('分类', 'Category')" style="min-width:125px" @update:model-value="applyFilters" />
      <q-select v-model="tag" dense outlined clearable :options="filterOptions.tags" :label="t('标签', 'Tag')" style="min-width:125px" @update:model-value="applyFilters" />
      <q-btn :outline="!bookmarkedOnly" color="primary" icon="bookmark" :label="t('收藏', 'Saved')" @click="bookmarkedOnly = !bookmarkedOnly; applyFilters()" />
    </div>
    <div v-if="loading && !articles.length" class="text-center q-pa-xl"><q-spinner color="primary" size="32px" /></div>
    <q-banner v-else-if="error && !articles.length" class="bg-red-1 text-negative" rounded>
      {{ t('加载失败，请重试', 'Could not load articles') }}
      <q-btn flat color="primary" :label="t('重试', 'Retry')" @click="load(true)" />
    </q-banner>
    <div v-else-if="!articles.length" class="text-grey text-center q-mt-xl">{{ t('暂无资讯', 'No articles yet') }}</div>
    <q-list v-else bordered separator class="rounded-borders">
      <q-item v-for="article in articles" :key="article.id" clickable @click="router.push(`/robot/${article.id}`)">
        <q-item-section v-if="article.cover_url" avatar><q-img :src="article.cover_url" fit="cover" class="cover" /></q-item-section>
        <q-item-section>
          <q-item-label class="text-subtitle1 text-weight-medium">
            <q-badge v-if="article.pinned" color="orange" class="q-mr-xs">{{ t('置顶', 'Pinned') }}</q-badge>{{ article.title }}
          </q-item-label>
          <q-item-label caption lines="2">{{ article.summary }}</q-item-label>
          <q-item-label caption class="q-mt-xs">
            <span v-if="article.category">{{ article.category }} · </span>{{ formatDate(article.published_at) }}
            <span v-if="article.read" class="q-ml-sm">{{ t('已读', 'Read') }}</span>
            <q-icon v-if="article.bookmarked" name="bookmark" color="primary" class="q-ml-sm" />
          </q-item-label>
          <q-item-label v-if="article.tags?.length" caption>{{ article.tags.map(value => `#${value}`).join(' ') }}</q-item-label>
        </q-item-section>
        <q-item-section side><q-icon name="chevron_right" /></q-item-section>
      </q-item>
    </q-list>
    <div v-if="articles.length && (hasMore || error)" class="text-center q-mt-md">
      <q-btn outline color="primary" :loading="loading" :label="error ? t('重试', 'Retry') : t('加载更多', 'Load more')" @click="load(false)" />
    </div>
  </q-page>
</template>

<script setup>
import { ref, onMounted, onActivated } from 'vue'
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
let requestId = 0

function formatDate(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : ''
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
.cover { width: 64px; height: 64px; border-radius: 6px; }
</style>
