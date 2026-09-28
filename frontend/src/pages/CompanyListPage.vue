<template>
  <q-page class="company-page">
    <main class="company-shell">
      <header class="page-intro">
        <div class="eyebrow">COMPANY TRACKER</div>
        <h1>{{ t('公司追踪', 'Company tracker') }}</h1>
        <p>{{ t('查看经过人工核对的公司档案、官方来源和相关动态。', 'Explore reviewed company profiles, official sources and related updates.') }}</p>
      </header>

      <q-input v-model="search" outlined dense clearable debounce="300" :placeholder="t('搜索公司、别名或方向', 'Search companies, aliases or focus')" class="search" @update:model-value="load(true)">
        <template #prepend><q-icon name="search" size="20px" /></template>
      </q-input>

      <div v-if="loading && !companies.length" class="state"><q-spinner size="30px" color="primary" /></div>
      <div v-else-if="error && !companies.length" class="state">
        <span>{{ t('公司目录加载失败', 'Could not load companies') }}</span>
        <q-btn flat color="primary" no-caps :label="t('重试', 'Retry')" @click="load(true)" />
      </div>
      <div v-else-if="!companies.length" class="state">
        <q-icon name="domain" size="38px" color="grey-5" />
        <span>{{ search ? t('没有找到相关公司', 'No companies found') : t('后台尚未公开公司档案', 'No company profiles have been published yet') }}</span>
      </div>
      <div v-else class="company-list">
        <button v-for="company in companies" :key="company.id" type="button" class="company-card" @click="router.push(`/robot/tracker/companies/${company.slug}`)">
          <span class="company-icon"><q-icon name="domain" size="22px" /></span>
          <span class="company-content">
            <strong>{{ displayName(company) }}</strong>
            <span v-if="secondaryName(company)" class="secondary">{{ secondaryName(company) }}</span>
            <span v-if="company.focus" class="focus">{{ company.focus }}</span>
            <span class="meta">{{ company.region || t('地区待补充', 'Region pending') }}<span class="dot">·</span>{{ company.article_count }} {{ t('条动态', 'updates') }}</span>
          </span>
          <q-icon name="chevron_right" size="21px" class="arrow" />
        </button>
      </div>
      <div v-if="companies.length && (hasMore || error)" class="load-more">
        <q-btn flat color="primary" no-caps :loading="loading" :label="error ? t('重试', 'Retry') : t('加载更多', 'Load more')" @click="load(false)" />
      </div>
    </main>
  </q-page>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { companyApi } from 'src/services/api'
import { useI18n } from 'src/i18n'

const router = useRouter()
const { locale } = useI18n()
const t = (zh, en) => locale.value === 'zh-CN' ? zh : en
const search = ref('')
const companies = ref([])
const loading = ref(false)
const error = ref(false)
const hasMore = ref(false)
let requestId = 0

function displayName(company) {
  return (locale.value === 'zh-CN' ? company.name_zh || company.name_en : company.name_en || company.name_zh) || company.slug
}
function secondaryName(company) {
  return locale.value === 'zh-CN' ? company.name_en && company.name_en !== company.name_zh ? company.name_en : '' : company.name_zh && company.name_zh !== company.name_en ? company.name_zh : ''
}
async function load(reset = false) {
  if (loading.value && !reset) return
  const current = ++requestId
  if (reset) { companies.value = []; hasMore.value = false }
  loading.value = true
  error.value = false
  try {
    const { data } = await companyApi.list({ search: search.value?.trim() || undefined, limit: 20, offset: companies.value.length })
    if (current !== requestId) return
    companies.value = reset ? (data.companies || []) : [...companies.value, ...(data.companies || [])]
    hasMore.value = !!data.has_more
  } catch { if (current === requestId) error.value = true }
  finally { if (current === requestId) loading.value = false }
}
onMounted(() => load(true))
</script>

<style scoped>
.company-page { min-height:100%; background:#f5f7fa; color:#1b2b3c; }
.company-shell { max-width:760px; margin:auto; padding:18px 16px 42px; }
.page-intro { margin-bottom:20px; }
.eyebrow { color:#1976d2; font-size:10px; font-weight:700; letter-spacing:1.5px; }
h1 { margin:5px 0 6px; font-size:25px; line-height:1.25; }
.page-intro p { margin:0; color:#718297; font-size:13px; line-height:1.5; }
.search { margin-bottom:18px; background:#fff; border-radius:9px; }
.company-list { display:grid; gap:10px; }
.company-card { width:100%; display:flex; align-items:center; gap:12px; padding:16px 14px; border:1px solid #e2eaf2; border-radius:14px; background:#fff; text-align:left; color:inherit; font:inherit; cursor:pointer; }
.company-card:focus-visible { outline:2px solid #1976d2; outline-offset:2px; }
.company-icon { display:flex; flex:none; align-items:center; justify-content:center; width:38px; height:38px; border-radius:10px; background:#eaf3fd; color:#1976d2; }
.company-content { display:flex; min-width:0; flex:1; flex-direction:column; gap:3px; }
.company-content strong { font-size:16px; line-height:1.35; overflow-wrap:anywhere; }
.secondary,.meta { color:#8191a2; font-size:11px; }
.focus { color:#50657a; font-size:12px; line-height:1.4; }
.dot { margin:0 6px; }
.arrow { flex:none; color:#8da0b2; }
.state { min-height:230px; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:12px; color:#798a9d; font-size:13px; text-align:center; }
.load-more { display:flex; justify-content:center; padding:15px 0; }
</style>
