<template>
  <q-page class="tracker-page">
    <main class="tracker-shell">
      <header class="tracker-intro">
        <div class="eyebrow">EMBODIED AI INTELLIGENCE</div>
        <h1>{{ t('追踪变化', 'Track what changed') }}</h1>
        <p>{{ t('从公司、机器人、数据路线和证据，持续观察具身智能的进展。', 'Follow companies, robots, data pathways and evidence as embodied AI evolves.') }}</p>
      </header>

      <div class="tracker-notice" role="status">
        <q-icon name="info_outline" size="20px" />
        <span>{{ t('公司档案与人工关联的动态已开放；机器人、数据路线和自动采集尚未上线。', 'Company profiles and editor-linked updates are available. Robot and data tracking and automated collection are not live yet.') }}</span>
      </div>

      <section class="tracker-section" :aria-label="t('追踪维度', 'Tracking dimensions')">
        <div class="section-head">
          <div class="section-kicker">TRACKING LAYERS</div>
          <h2>{{ t('追踪维度', 'Tracking dimensions') }}</h2>
        </div>
        <div class="dimension-grid">
          <component :is="item.path ? 'button' : 'div'" v-for="item in dimensions" :key="item.key" class="dimension-card" :class="{ interactive: item.path }" :type="item.path ? 'button' : undefined" @click="item.path && router.push(item.path)">
            <div class="dimension-icon"><q-icon :name="item.icon" size="21px" /></div>
            <strong>{{ item.title }}</strong>
            <span>{{ item.description }}</span>
            <small>{{ item.path ? t('查看公司', 'View companies') : t('待接入', 'Planned') }}</small>
          </component>
        </div>
      </section>

      <section class="tracker-section leads-section" :aria-label="t('已有资讯线索', 'Existing article leads')">
        <div class="section-head leads-head">
          <div>
            <div class="section-kicker">CURRENT LEADS</div>
            <h2>{{ t('已有资讯线索', 'Existing article leads') }}</h2>
          </div>
          <q-btn flat no-caps color="primary" :label="t('全部资讯', 'All articles')" @click="router.push('/robot')" />
        </div>
        <p class="section-note">{{ t('这些内容尚未按公司、机器人、数据路线和可信度完成结构化核查。', 'These articles have not yet been structured and verified by company, robot, data pathway and confidence.') }}</p>

        <div v-if="loading" class="leads-state"><q-spinner color="primary" size="28px" /></div>
        <div v-else-if="error" class="leads-state">
          <span>{{ t('线索加载失败', 'Could not load leads') }}</span>
          <q-btn flat no-caps color="primary" :label="t('重试', 'Retry')" @click="loadLeads" />
        </div>
        <div v-else-if="!leads.length" class="leads-state">{{ t('暂无已发布资讯', 'No published articles yet') }}</div>
        <div v-else class="lead-timeline">
          <button v-for="lead in leads" :key="lead.id" type="button" class="lead-row" @click="openLead(lead.id)">
            <span class="lead-dot" aria-hidden="true" />
            <span class="lead-content">
              <span class="lead-date">{{ formatDate(lead.published_at) }}</span>
              <strong>{{ lead.title }}</strong>
              <span v-if="lead.source" class="lead-source">{{ lead.source }}</span>
            </span>
            <q-icon name="chevron_right" size="20px" class="lead-arrow" />
          </button>
        </div>
      </section>
    </main>
  </q-page>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { robotApi } from 'src/services/api'
import { useI18n } from 'src/i18n'

const router = useRouter()
const { locale } = useI18n()
const t = (zh, en) => locale.value === 'zh-CN' ? zh : en
const leads = ref([])
const loading = ref(false)
const error = ref(false)
const dimensions = computed(() => [
  { key: 'company', icon: 'domain', title: t('公司', 'Companies'), description: t('档案、来源与动态', 'Profiles, sources and updates'), path: '/robot/tracker/companies' },
  { key: 'robot', icon: 'precision_manufacturing', title: t('机器人', 'Robots'), description: t('产品与量产进展', 'Products and production') },
  { key: 'data', icon: 'dataset', title: t('数据路线', 'Data pathways'), description: t('采集、状态与动作', 'Collection, state and action') },
  { key: 'evidence', icon: 'fact_check', title: t('来源证据', 'Evidence'), description: t('原始来源与可信度', 'Sources and confidence') }
])

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

async function loadLeads() {
  loading.value = true
  error.value = false
  try {
    const { data } = await robotApi.list({ limit: 8, offset: 0 })
    leads.value = data.articles || []
  } catch { error.value = true }
  finally { loading.value = false }
}

function openLead(id) {
  router.push({ path: `/robot/${id}`, query: { from: 'tracker' } })
}

onMounted(loadLeads)
</script>

<style scoped>
.tracker-page { min-height: 100%; background: #f5f7fa; color: #1c2b3c; }
.tracker-shell { max-width: 760px; margin: 0 auto; padding: 20px 16px 42px; }
.tracker-intro { padding: 23px 22px; border-radius: 18px; background: #173d65; color: #fff; }
.eyebrow { color: #a6d1f7; font-size: 10px; font-weight: 700; letter-spacing: 1.8px; }
.tracker-intro h1 { margin: 9px 0 8px; font-size: 25px; line-height: 1.25; }
.tracker-intro p { max-width: 530px; margin: 0; color: #d6e8f7; font-size: 13px; line-height: 1.6; }
.tracker-notice { display: flex; align-items: flex-start; gap: 9px; margin: 14px 0 26px; padding: 12px 14px; border: 1px solid #dce9f6; border-radius: 12px; background: #edf5fc; color: #49647e; font-size: 12px; line-height: 1.5; }
.tracker-notice .q-icon { flex: none; color: #1976d2; }
.tracker-section { margin-top: 28px; }
.section-head h2 { margin: 3px 0 14px; font-size: 18px; line-height: 1.3; }
.section-kicker { color: #748ba2; font-size: 10px; font-weight: 700; letter-spacing: 1.3px; }
.dimension-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.dimension-card { display: flex; min-width: 0; flex-direction: column; gap: 4px; padding: 15px; border: 1px solid #e3eaf1; border-radius: 13px; background: #fff; }
.dimension-card.interactive { color: inherit; text-align: left; font: inherit; cursor: pointer; }
.dimension-card.interactive:focus-visible { outline: 2px solid #1976d2; outline-offset: 2px; }
.dimension-card.interactive small { background: #e8f3ff; color: #1976d2; }
.dimension-icon { color: #1976d2; }
.dimension-card strong { font-size: 14px; }
.dimension-card span { color: #687c90; font-size: 11px; line-height: 1.4; }
.dimension-card small { align-self: flex-start; margin-top: 4px; padding: 2px 7px; border-radius: 5px; background: #f0f4f8; color: #75889a; font-size: 10px; }
.leads-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; }
.leads-head h2 { margin-bottom: 0; }
.section-note { margin: 7px 0 17px; color: #74869a; font-size: 12px; line-height: 1.5; }
.leads-state { display: flex; min-height: 110px; align-items: center; justify-content: center; gap: 10px; color: #7d8ea0; font-size: 13px; }
.lead-timeline { position: relative; margin-left: 7px; border-left: 2px solid #d8e6f4; }
.lead-row { display: flex; width: calc(100% + 7px); align-items: center; gap: 8px; position: relative; margin: 0 0 8px 0; padding: 10px 10px 10px 19px; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
.lead-row:focus-visible { outline: 2px solid #1976d2; outline-offset: 2px; }
.lead-dot { position: absolute; left: -6px; top: 18px; width: 10px; height: 10px; border: 2px solid #1976d2; border-radius: 50%; background: #fff; }
.lead-content { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; padding: 11px 13px; border: 1px solid #e3eaf1; border-radius: 11px; background: #fff; }
.lead-date, .lead-source { color: #8293a3; font-size: 11px; }
.lead-content strong { font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
.lead-arrow { flex: none; color: #8293a3; }
@media (min-width: 640px) { .tracker-shell { padding: 28px 24px 54px; } }
</style>
