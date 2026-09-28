<template>
  <q-page class="detail-page">
    <main class="detail-shell">
      <div v-if="loadingCompany" class="state"><q-spinner size="30px" color="primary" /></div>
      <div v-else-if="!company" class="state">
        <span>{{ t('公司资料暂不可用', 'Company profile unavailable') }}</span>
        <q-btn flat color="primary" no-caps :label="t('重试', 'Retry')" @click="loadCompany" />
      </div>
      <template v-else>
        <header class="profile-card">
          <div class="eyebrow">COMPANY TRACKER</div>
          <h1>{{ displayName(company) }}</h1>
          <div v-if="secondaryName(company)" class="secondary-name">{{ secondaryName(company) }}</div>
          <div v-if="company.region || company.focus" class="profile-meta">
            <span v-if="company.region">{{ company.region }}</span>
            <span v-if="company.focus">{{ company.focus }}</span>
          </div>
          <p v-if="company.description">{{ company.description }}</p>
          <div v-if="company.aliases?.length" class="aliases">
            <span class="aliases-label">{{ t('别名', 'Aliases') }}</span>
            <span v-for="alias in company.aliases" :key="alias" class="alias">{{ alias }}</span>
          </div>
          <a v-if="company.website" :href="company.website" target="_blank" rel="noopener noreferrer" class="website"><q-icon name="open_in_new" size="15px" />{{ t('官方网站', 'Official website') }}</a>
        </header>

        <section class="detail-section" :aria-label="t('官方来源', 'Official sources')">
          <div class="section-heading"><h2>{{ t('官方来源', 'Official sources') }}</h2><span>{{ sources.length }}</span></div>
          <p class="section-note">{{ t('链接由后台人工核对，系统暂未自动监测这些渠道。', 'Links are reviewed by editors; automated monitoring is not active yet.') }}</p>
          <div v-if="sources.length" class="source-list">
            <a v-for="source in sources" :key="source.id" :href="source.url" target="_blank" rel="noopener noreferrer" class="source-row">
              <span class="source-icon"><q-icon :name="sourceIcon(source.kind)" size="18px" /></span>
              <span class="source-content"><strong>{{ source.label }}</strong><small>{{ source.url }}</small></span>
              <q-icon name="open_in_new" size="17px" class="source-arrow" />
            </a>
          </div>
          <div v-else class="empty-note">{{ t('官方来源待补充', 'Official sources pending') }}</div>
        </section>

        <section class="detail-section" :aria-label="t('公司动态', 'Company updates')">
          <div class="section-heading"><h2>{{ t('公司动态', 'Company updates') }}</h2><span>{{ company.article_count }}</span></div>
          <p class="section-note">{{ t('仅显示后台人工关联、已发布且附有原始链接的资讯。', 'Shows published articles that editors linked to this company with original sources.') }}</p>
          <div v-if="loadingUpdates && !updates.length" class="state short"><q-spinner size="26px" color="primary" /></div>
          <div v-else-if="updatesError && !updates.length" class="state short"><span>{{ t('动态加载失败', 'Could not load updates') }}</span><q-btn flat color="primary" no-caps :label="t('重试', 'Retry')" @click="loadUpdates(true)" /></div>
          <div v-else-if="!updates.length" class="empty-note">{{ t('暂无已发布动态', 'No published updates yet') }}</div>
          <div v-else class="timeline">
            <button v-for="update in updates" :key="update.id" type="button" class="update-row" @click="openArticle(update.id)">
              <span class="timeline-dot" aria-hidden="true" />
              <span class="update-card">
                <span class="update-date">{{ dateLabel(update) }}<span v-if="update.category"> · {{ update.category }}</span></span>
                <strong>{{ update.title }}</strong>
                <span v-if="update.summary" class="update-summary">{{ update.summary }}</span>
                <span v-if="update.source" class="update-source">{{ t('来源：', 'Source: ') }}{{ update.source }}</span>
              </span>
              <q-icon name="chevron_right" size="20px" class="update-arrow" />
            </button>
          </div>
          <div v-if="updates.length && (hasMore || updatesError)" class="load-more">
            <q-btn flat color="primary" no-caps :loading="loadingUpdates" :label="updatesError ? t('重试', 'Retry') : t('加载更多', 'Load more')" @click="loadUpdates(false)" />
          </div>
        </section>
      </template>
    </main>
  </q-page>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { companyApi, robotApi } from 'src/services/api'
import { useI18n } from 'src/i18n'

const route = useRoute()
const router = useRouter()
const { locale } = useI18n()
const t = (zh, en) => locale.value === 'zh-CN' ? zh : en
const company = ref(null)
const sources = ref([])
const updates = ref([])
const loadingCompany = ref(false)
const loadingUpdates = ref(false)
const updatesError = ref(false)
const hasMore = ref(false)
let companyRequestId = 0
let updatesRequestId = 0

function displayName(item) { return (locale.value === 'zh-CN' ? item.name_zh || item.name_en : item.name_en || item.name_zh) || item.slug }
function secondaryName(item) { return locale.value === 'zh-CN' ? item.name_en && item.name_en !== item.name_zh ? item.name_en : '' : item.name_zh && item.name_zh !== item.name_en ? item.name_zh : '' }
function sourceIcon(kind) { return ({ github: 'code', youtube: 'smart_display', social: 'alternate_email', filing: 'description', blog: 'article' })[kind] || 'language' }
function dateLabel(item) {
  if (item.occurred_on) return item.occurred_on
  if (!item.published_at) return t('日期待核对', 'Date pending')
  const date = new Date(item.published_at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
async function loadCompany() {
  const current = ++companyRequestId
  company.value = null
  sources.value = []
  updates.value = []
  loadingCompany.value = true
  try {
    const { data } = await companyApi.get(route.params.slug)
    if (current !== companyRequestId) return
    company.value = data.company
    sources.value = data.sources || []
    loadUpdates(true)
  } catch { /* The unavailable state offers a retry. */ }
  finally { if (current === companyRequestId) loadingCompany.value = false }
}
async function loadUpdates(reset = false) {
  if (loadingUpdates.value && !reset) return
  const current = ++updatesRequestId
  if (reset) { updates.value = []; hasMore.value = false }
  loadingUpdates.value = true
  updatesError.value = false
  try {
    const { data } = await robotApi.list({ company: route.params.slug, limit: 20, offset: updates.value.length })
    if (current !== updatesRequestId) return
    updates.value = reset ? (data.articles || []) : [...updates.value, ...(data.articles || [])]
    hasMore.value = !!data.has_more
  } catch { if (current === updatesRequestId) updatesError.value = true }
  finally { if (current === updatesRequestId) loadingUpdates.value = false }
}
function openArticle(id) {
  router.push({ path: `/robot/${id}`, query: { from: `/robot/tracker/companies/${route.params.slug}` } })
}
watch(() => route.params.slug, loadCompany)
onMounted(loadCompany)
</script>

<style scoped>
.detail-page { min-height:100%; background:#f5f7fa; color:#1b2b3c; }
.detail-shell { max-width:760px; margin:auto; padding:18px 16px 44px; }
.profile-card { padding:22px; border-radius:17px; background:#173d65; color:#fff; }
.eyebrow { color:#9dcbf6; font-size:10px; font-weight:700; letter-spacing:1.5px; }
h1 { margin:8px 0 5px; font-size:25px; line-height:1.3; overflow-wrap:anywhere; }
.secondary-name { color:#c6ddef; font-size:13px; }
.profile-meta { display:flex; flex-wrap:wrap; gap:7px; margin-top:14px; }
.profile-meta span { padding:4px 9px; border-radius:6px; background:rgba(255,255,255,.12); font-size:11px; }
.profile-card p { margin:15px 0 0; color:#e2edf6; font-size:13px; line-height:1.6; white-space:pre-wrap; }
.aliases { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:13px; }
.aliases-label { color:#aec7dd; font-size:11px; }
.alias { padding:2px 7px; border:1px solid rgba(255,255,255,.2); border-radius:5px; color:#e2edf6; font-size:11px; }
.website { display:inline-flex; align-items:center; gap:5px; margin-top:15px; color:#bce0ff; font-size:12px; text-decoration:none; }
.detail-section { margin-top:28px; }
.section-heading { display:flex; align-items:baseline; gap:8px; }
.section-heading h2 { margin:0; font-size:18px; }
.section-heading span { color:#91a3b4; font-size:12px; }
.section-note { margin:6px 0 15px; color:#74869a; font-size:12px; line-height:1.5; }
.source-list { display:grid; gap:8px; }
.source-row { display:flex; align-items:center; gap:10px; padding:12px; border:1px solid #e2eaf2; border-radius:11px; background:#fff; color:inherit; text-decoration:none; }
.source-icon { display:flex; flex:none; align-items:center; justify-content:center; width:32px; height:32px; border-radius:8px; background:#edf5fd; color:#1976d2; }
.source-content { display:flex; min-width:0; flex:1; flex-direction:column; gap:2px; }
.source-content strong { font-size:13px; }
.source-content small { overflow:hidden; color:#8394a5; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.source-arrow { flex:none; color:#8da0b2; }
.empty-note { padding:24px; border:1px dashed #d7e2ec; border-radius:11px; color:#8293a4; font-size:12px; text-align:center; }
.timeline { margin-left:7px; border-left:2px solid #d7e5f3; }
.update-row { display:flex; position:relative; width:calc(100% + 7px); align-items:center; gap:8px; margin-bottom:9px; padding:5px 0 5px 19px; border:0; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
.update-row:focus-visible { outline:2px solid #1976d2; outline-offset:2px; }
.timeline-dot { position:absolute; top:22px; left:-6px; width:10px; height:10px; border:2px solid #1976d2; border-radius:50%; background:#fff; }
.update-card { display:flex; min-width:0; flex:1; flex-direction:column; gap:5px; padding:14px; border:1px solid #e2eaf2; border-radius:11px; background:#fff; }
.update-date,.update-source { color:#8293a4; font-size:11px; }
.update-card strong { font-size:14px; line-height:1.45; overflow-wrap:anywhere; }
.update-summary { display:-webkit-box; overflow:hidden; color:#64778a; font-size:12px; line-height:1.45; -webkit-box-orient:vertical; -webkit-line-clamp:3; }
.update-arrow { flex:none; color:#91a1b2; }
.state { min-height:270px; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:12px; color:#7b8da0; font-size:13px; }
.state.short { min-height:110px; }
.load-more { display:flex; justify-content:center; padding:12px; }
</style>
