<template>
  <q-page class="q-pa-md">
    <q-spinner v-if="loading" color="primary" size="32px" />
    <q-banner v-else-if="error" class="bg-red-1 text-negative" rounded>
      {{ locale === 'zh-CN' ? '资讯不存在或加载失败' : 'Article not found or unavailable' }}
    </q-banner>
    <article v-else-if="article" class="article">
      <h1 class="text-h5 text-weight-bold q-mb-sm">{{ article.title }}</h1>
      <div class="text-caption text-grey q-mb-lg">{{ new Date(article.published_at).toLocaleString() }}</div>
      <div class="article-body" v-html="article.content" />
    </article>
  </q-page>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { robotApi } from 'src/services/api'
import { useI18n } from 'src/i18n'

const route = useRoute()
const { locale } = useI18n()
const article = ref(null)
const loading = ref(true)
const error = ref(false)
onMounted(async () => {
  try {
    article.value = (await robotApi.get(route.params.id)).data
    robotApi.recordView(route.params.id).catch(() => {})
  }
  catch { error.value = true }
  finally { loading.value = false }
})
</script>

<style scoped>
.article { max-width: 760px; margin: 0 auto; }
.article-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; }
.article-body :deep(img), .article-body :deep(video) { display: block; max-width: 100%; max-height: 70vh; margin: 16px 0; border-radius: 8px; }
.article-body :deep(a) { color: var(--q-primary); }
</style>
