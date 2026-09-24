<template>
  <q-page class="q-pa-md">
    <div class="text-h6 q-mb-md">{{ locale === 'zh-CN' ? '机器人资讯' : 'Robot news' }}</div>
    <q-spinner v-if="loading" color="primary" size="32px" />
    <q-banner v-else-if="error" class="bg-red-1 text-negative" rounded>
      {{ locale === 'zh-CN' ? '加载失败，请重试' : 'Could not load articles' }}
      <q-btn flat color="primary" :label="locale === 'zh-CN' ? '重试' : 'Retry'" @click="load" />
    </q-banner>
    <div v-else-if="!articles.length" class="text-grey text-center q-mt-xl">
      {{ locale === 'zh-CN' ? '暂无资讯' : 'No articles yet' }}
    </div>
    <q-list v-else bordered separator class="rounded-borders">
      <q-item v-for="article in articles" :key="article.id" clickable @click="router.push(`/robot/${article.id}`)">
        <q-item-section>
          <q-item-label class="text-subtitle1 text-weight-medium">{{ article.title }}</q-item-label>
          <q-item-label caption lines="2">{{ article.summary }}</q-item-label>
          <q-item-label caption>{{ new Date(article.published_at).toLocaleDateString() }}</q-item-label>
        </q-item-section>
        <q-item-section side><q-icon name="chevron_right" /></q-item-section>
      </q-item>
    </q-list>
  </q-page>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { robotApi } from 'src/services/api'
import { useI18n } from 'src/i18n'

const router = useRouter()
const { locale } = useI18n()
const articles = ref([])
const loading = ref(false)
const error = ref(false)
async function load() {
  loading.value = true
  error.value = false
  try { articles.value = (await robotApi.list()).data.articles || [] }
  catch { error.value = true }
  finally { loading.value = false }
}
onMounted(load)
</script>
