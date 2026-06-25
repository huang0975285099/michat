<template>
  <q-page class="ironfist-page">
    <!-- ── 大厅 ─────────────────────────────────────────── -->
    <div v-if="view === 'lobby'" class="q-pa-md">
      <div class="row items-center q-mb-md">
        <q-btn flat round dense icon="arrow_back" color="white" @click="goHome" />
        <div style="font-size: 24px" class="q-ml-sm">🥊</div>
        <div class="text-h6 q-ml-xs">铁拳</div>
        <q-space />
        <span class="text-caption text-grey-5">回合制心理博弈</span>
      </div>

      <div class="mode-card mode-card--pve" @click="startPve">
        <div class="mode-emoji">🤖</div>
        <div>
          <div class="text-subtitle1 text-bold">人机对战</div>
          <div class="text-caption text-grey-4">随时练习，无需联网</div>
        </div>
        <q-icon name="chevron_right" size="24px" class="q-ml-auto" />
      </div>

      <div class="mode-card mode-card--pvp" @click="showFriends = !showFriends">
        <div class="mode-emoji">👥</div>
        <div>
          <div class="text-subtitle1 text-bold">好友对战</div>
          <div class="text-caption text-grey-4">实时 1v1，邀请在线好友</div>
        </div>
        <q-icon :name="showFriends ? 'expand_less' : 'chevron_right'" size="24px" class="q-ml-auto" />
      </div>

      <q-slide-transition>
        <q-list v-show="showFriends" bordered separator rounded class="q-mt-sm friend-list">
          <q-item v-if="loadingFriends">
            <q-item-section class="text-center text-grey-5 q-py-md">
              <q-spinner-dots color="primary" size="30px" />
            </q-item-section>
          </q-item>
          <template v-else-if="onlineFriends.length">
            <q-item v-for="f in onlineFriends" :key="f.chat_id" clickable v-ripple @click="startInvite(f)">
              <q-item-section avatar>
                <q-avatar color="purple" text-color="white" size="38px">
                  {{ (f.nickname || f.chat_id).slice(0, 1).toUpperCase() }}
                </q-avatar>
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ f.nickname || f.chat_id }}</q-item-label>
                <q-item-label caption class="text-positive">在线</q-item-label>
              </q-item-section>
              <q-item-section side><q-icon name="chevron_right" color="grey-4" /></q-item-section>
            </q-item>
          </template>
          <q-item v-else>
            <q-item-section class="text-center text-grey-5 q-py-lg">暂无在线好友</q-item-section>
          </q-item>
        </q-list>
      </q-slide-transition>

      <div class="rules">
        <div class="text-subtitle2 text-grey-6 q-mb-xs">玩法 · 4 种动作克制关系</div>
        <div class="rule-grid">
          <div v-for="a in actionList" :key="a.key" class="rule-item">
            <span class="rule-icon">{{ a.icon }}</span>
            <span class="rule-name">{{ a.name }}</span>
            <span class="rule-hint">{{ a.hint }}</span>
          </div>
        </div>
        <div class="text-caption text-grey-6 q-mt-sm">
          攻击克蓄力 · 防御克攻击 · 反击克攻击 · 蓄力下回合伤害翻倍
        </div>
      </div>
    </div>

    <!-- ── 邀请中 ───────────────────────────────────────── -->
    <div v-else-if="view === 'inviting'" class="flex flex-center column full-h q-gutter-md q-pa-xl">
      <q-spinner-dots color="purple" size="64px" />
      <div class="text-h6">等待对方接受…</div>
      <div class="text-caption text-grey-5">{{ gameStore.opponentNickname }}</div>
      <q-btn flat color="negative" label="取消邀请" @click="gameStore.cancelInvite()" />
    </div>

    <!-- ── 对战 ─────────────────────────────────────────── -->
    <div v-else-if="view === 'playing'" class="battle">
      <!-- 顶部信息栏 -->
      <div class="hud-top">
        <span>第 {{ round }} 回合</span>
        <q-space />
        <span class="countdown" :class="{ urgent: countdown <= 5 }" v-if="phase === 'deciding'">
          ⏳ {{ countdown }}s
        </span>
      </div>

      <!-- 出招记录（上=对手，下=你；横向滚动，最新在右） -->
      <div v-if="moveHistory.length" ref="moveLogRef" class="move-log">
        <div v-for="m in moveHistory" :key="m.round" class="ml-item"
          :class="{ 'ml-item--win': m.oDmg > m.pDmg, 'ml-item--lose': m.pDmg > m.oDmg }">
          <span class="ml-icon" :title="actionMeta[m.opponent]?.name">{{ actionMeta[m.opponent]?.icon }}</span>
          <span class="ml-icon" :title="actionMeta[m.player]?.name">{{ actionMeta[m.player]?.icon }}</span>
          <span class="ml-round">R{{ m.round }}</span>
        </div>
      </div>

      <!-- 对手血条 -->
      <div class="hud-bar">
        <HealthBar :name="opponentName" :hp="oHP" :charged="oCharged" />
      </div>

      <!-- 3D/2D 战斗区（一期：BattleArena 2D-CSS） -->
      <div class="arena-slot">
        <BattleArena :result="lastResult" :player-charged="pCharged" :opponent-charged="oCharged"
          :opponent-emoji="opponentEmoji" />
      </div>

      <!-- 玩家血条 -->
      <div class="hud-bar">
        <HealthBar name="你" :hp="pHP" :charged="pCharged" align="right" />
      </div>

      <!-- 战斗信息 -->
      <div class="hud-info">{{ infoText }}</div>

      <!-- 操作区 / 等待 / 结算 -->
      <div class="hud-action">
        <template v-if="phase === 'deciding' && !myAction">
          <button v-for="a in actionList" :key="a.key" class="act-btn"
            :class="'act-btn--' + a.key" @click="onAction(a.key)">
            <span class="act-icon">{{ a.icon }}</span>
            <span class="act-name">{{ a.name }}</span>
            <span class="act-hint">{{ a.hint }}</span>
          </button>
        </template>

        <div v-else-if="phase === 'locked' || (phase === 'deciding' && myAction)" class="wait-box">
          <div>已选择：<b>{{ actionMeta[myAction]?.name }}</b></div>
          <div class="text-caption text-grey-5 q-mt-xs">等待对手决策…</div>
        </div>

        <div v-else-if="phase === 'resolving' || (phase === 'waiting_confirm' && !showPanel)" class="wait-box">
          <q-spinner-puff color="purple" size="32px" />
          <div class="text-caption text-grey-5 q-mt-xs">结算中…</div>
        </div>

        <div v-else-if="phase === 'waiting_confirm' && showPanel" class="result-panel">
          <div class="rp-line">{{ resolveSummary }}</div>
          <q-btn flat color="purple" dense label="立即继续 ›" class="q-mt-xs" @click="nextRound" />
        </div>
      </div>
    </div>

    <!-- ── 结果 ─────────────────────────────────────────── -->
    <div v-else-if="view === 'result'" class="flex flex-center column full-h q-gutter-lg q-pa-xl">
      <div style="font-size: 72px">{{ resultEmoji }}</div>
      <div class="text-h4 text-bold">{{ resultText }}</div>
      <div v-if="resultSub" class="text-caption text-grey-5">{{ resultSub }}</div>
      <q-btn color="purple" label="返回大厅" unelevated @click="backToLobby" />
    </div>
  </q-page>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from 'src/stores/game'
import { friendApi } from 'src/services/api'
import HealthBar from './components/HealthBar.vue'
import BattleArena from './components/BattleArena.vue'
import { IronFistGame } from './game/IronFistGame.js'
import { GameNet } from './game/GameNet.js'
import {
  ACTION_META, ACTIONS, ROUND_SECONDS, INITIAL_HP,
} from './game/GameConstants.js'

defineOptions({ name: 'IronFistPage' })

// 结算面板自动进入下一回合的停留时长（ms）。展示摘要后即自动推进。
const AUTO_NEXT_MS = 1500

const route = useRoute()
const router = useRouter()
const gameStore = useGameStore()

const actionMeta = ACTION_META
const actionList = ACTIONS.map((k) => ({ key: k, ...ACTION_META[k] }))

const view = ref('lobby')
const mode = ref('pve')
const showFriends = ref(false)
const loadingFriends = ref(true)
const onlineFriends = ref([])

// 对战状态镜像
const round = ref(0)
const phase = ref('round_start')
const countdown = ref(ROUND_SECONDS)
const pHP = ref(INITIAL_HP)
const oHP = ref(INITIAL_HP)
const pCharged = ref(false)
const oCharged = ref(false)
const myAction = ref(null)
const lastResult = ref(null)
const showPanel = ref(false)
const moveHistory = ref([])   // 每回合出招记录 { round, player, opponent, pDmg, oDmg }
const moveLogRef = ref(null)
const opponentName = ref('对手')
const opponentEmoji = ref('🤖')

const resultType = ref('')

let engine = null
let net = null
let countdownTimer = null
let confirmTimer = null
let panelTimer = null

// ── 计算属性 ──────────────────────────────────────────────
const infoText = computed(() => {
  if (!lastResult.value) return phase.value === 'deciding' ? '选择你的动作' : ''
  return resolveSummary.value
})

const resolveSummary = computed(() => {
  const r = lastResult.value
  if (!r) return ''
  const my = ACTION_META[r.playerAction]?.name
  const opp = ACTION_META[r.opponentAction]?.name
  const parts = [`你 ${my} / 对手 ${opp}`]
  if (r.opponentDmg > 0) parts.push(`对手 -${r.opponentDmg}`)
  if (r.playerDmg > 0) parts.push(`你 -${r.playerDmg}`)
  if (r.envDmg > 0) parts.push(`环境 -${r.envDmg}`)
  if (r.playerDmg === 0 && r.opponentDmg === 0 && r.envDmg === 0) parts.push('无人受伤')
  return parts.join(' · ')
})

const RESULT_MAP = {
  win: ['🏆', '胜利！'],
  lose: ['💀', '失败…'],
  draw: ['🤝', '平局'],
  doubleLose: ['💥', '双双力竭'],
  aborted: ['📡', '对战中断'],
}
const resultEmoji = computed(() => (RESULT_MAP[resultType.value] || ['🎮', ''])[0])
const resultText = computed(() => (RESULT_MAP[resultType.value] || ['', '游戏结束'])[1])
const resultSub = computed(() => (resultType.value === 'aborted' ? '对手长时间未响应，可能已掉线' : ''))

// ── 生命周期 ──────────────────────────────────────────────
onMounted(() => {
  const role = route.query.role
  if (role === 'host' || role === 'guest') {
    startPvp()
  } else {
    loadFriends()
  }
})

onUnmounted(() => teardown())

watch(() => gameStore.state, (s) => {
  if (s === 'idle' && view.value === 'inviting') view.value = 'lobby'
})

// 已在本页（大厅或邀请中）时被接受/接收到对方接受而进入对战：
// 同路径仅 query 变化不会重新挂载组件，onMounted 不会再次触发，需手动开战。
watch(() => route.query.role, (role) => {
  if ((role === 'host' || role === 'guest') && view.value !== 'playing') {
    startPvp()
  }
})

// ── 大厅 ─────────────────────────────────────────────────
async function loadFriends() {
  loadingFriends.value = true
  try {
    const { data } = await friendApi.getFriends()
    onlineFriends.value = data.filter((f) => f.online)
  } catch {
    onlineFriends.value = []
  } finally {
    loadingFriends.value = false
  }
}

function startInvite(friend) {
  gameStore.invite(friend.chat_id, friend.nickname || friend.chat_id, 'ironfist')
  view.value = 'inviting'
}

// ── 启动对战 ──────────────────────────────────────────────
function startPve() {
  mode.value = 'pve'
  opponentName.value = '电脑'
  opponentEmoji.value = '🤖'
  engine = new IronFistGame({ mode: 'pve' })
  beginBattle()
}

async function startPvp() {
  mode.value = 'pvp'
  opponentName.value = gameStore.opponentNickname || '对手'
  opponentEmoji.value = '🥷'
  await nextTick()
  net = new GameNet(route.query.opponent, route.query.room)
  engine = new IronFistGame({ mode: 'pvp', net })
  beginBattle()
}

function beginBattle() {
  view.value = 'playing'
  pHP.value = INITIAL_HP
  oHP.value = INITIAL_HP
  pCharged.value = oCharged.value = false
  lastResult.value = null
  moveHistory.value = []

  engine.on('round-start', ({ round: r, state }) => {
    round.value = r
    pHP.value = state.playerHP
    oHP.value = state.opponentHP
    pCharged.value = state.playerCharged
    oCharged.value = state.opponentCharged
    myAction.value = null
    showPanel.value = false
    lastResult.value = null // 清除上回合结算，避免新回合决策时信息栏显示旧摘要
    startCountdown()
  })
  engine.on('phase', (p) => { phase.value = p })
  engine.on('locked', ({ side, action }) => {
    if (side === 'player') { myAction.value = action; stopCountdown() }
  })
  engine.on('resolved', (r) => {
    stopCountdown()
    lastResult.value = r
    // 记录本回合双方出招
    moveHistory.value.push({
      round: round.value, player: r.playerAction, opponent: r.opponentAction,
      pDmg: r.playerDmg, oDmg: r.opponentDmg,
    })
    nextTick(() => {
      const el = moveLogRef.value
      if (el) el.scrollLeft = el.scrollWidth
    })
    // 血条/蓄力随动画落定
    pHP.value = r.playerHP
    oHP.value = r.opponentHP
    pCharged.value = r.playerCharged
    oCharged.value = r.opponentCharged
    // 等动画播完再处理：终局直接进结果页（不出现"下一回合"），否则显示结算面板
    showPanel.value = false
    clearTimeout(panelTimer)
    panelTimer = setTimeout(() => {
      if (r.gameResult) {
        engine?.confirmNextRound() // 终局：跳过确认 barrier，直接 → result 视图（返回大厅）
      } else {
        showPanel.value = true
        startConfirmTimer()
      }
    }, 1150)
  })
  engine.on('gameover', (res) => {
    resultType.value = res
    teardownTimers()
    if (mode.value === 'pvp') gameStore.reset()
    view.value = 'result'
  })

  engine.start()
}

// ── 操作 ─────────────────────────────────────────────────
function onAction(action) {
  engine?.selectAction(action)
}

function nextRound() {
  clearTimeout(confirmTimer)
  engine?.confirmNextRound()
}

// ── 计时器 ────────────────────────────────────────────────
function startCountdown() {
  stopCountdown()
  countdown.value = ROUND_SECONDS
  countdownTimer = setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) {
      stopCountdown()
      if (!myAction.value) engine?.selectAction('defend') // 超时默认防御
    }
  }, 1000)
}
function stopCountdown() { clearInterval(countdownTimer); countdownTimer = null }

// 结算后短暂展示本回合摘要，随即自动进入下一回合（无需手动点击）。
// 玩家可点「立即继续」提前跳过这段等待。
function startConfirmTimer() {
  clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => engine?.confirmNextRound(), AUTO_NEXT_MS)
}

function teardownTimers() {
  stopCountdown()
  clearTimeout(confirmTimer)
  clearTimeout(panelTimer)
}

function teardown() {
  teardownTimers()
  engine?.dispose()
  net?.destroy()
  engine = null
  net = null
}

// ── 导航 ─────────────────────────────────────────────────
function backToLobby() {
  teardown()
  router.replace('/games/ironfist')
  view.value = 'lobby'
  showFriends.value = false
  loadFriends()
}

function goHome() { router.push('/games') }
</script>

<style scoped>
.ironfist-page {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  background: #0f0f1a;
  color: #fff;
}
.full-h { min-height: 60vh; }

/* 大厅模式卡片 */
.mode-card {
  display: flex; align-items: center; gap: 14px;
  padding: 16px; border-radius: 16px; cursor: pointer;
  margin-bottom: 12px;
  transition: transform 0.12s;
}
.mode-card:active { transform: scale(0.98); }
.mode-card--pve { background: linear-gradient(135deg, #3a2f6e, #5b3fa0); }
.mode-card--pvp { background: linear-gradient(135deg, #2f5a6e, #3f80a0); }
.mode-emoji { font-size: 38px; }
.friend-list { background: rgba(255, 255, 255, 0.04); }

.rules { margin-top: 18px; }
.rule-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.rule-item {
  display: flex; align-items: center; gap: 6px;
  background: rgba(255, 255, 255, 0.05); border-radius: 10px; padding: 8px 10px;
}
.rule-icon { font-size: 20px; }
.rule-name { font-weight: 700; font-size: 13px; }
.rule-hint { font-size: 11px; color: #9e9e9e; margin-left: auto; }

/* 对战布局 */
.battle {
  display: flex; flex-direction: column;
  height: 100dvh; padding: 8px 12px;
  gap: 6px;
}
.hud-top {
  display: flex; align-items: center;
  font-weight: 700; font-size: 14px;
  padding: 2px 4px;
}
.countdown { color: #b39ddb; }
.countdown.urgent { color: #ff5252; animation: blink 0.6s infinite; }
.hud-bar { padding: 0 4px; }

/* 出招记录条 */
.move-log {
  display: flex; gap: 6px; overflow-x: auto; padding: 2px 4px;
  scrollbar-width: none;
}
.move-log::-webkit-scrollbar { display: none; }
.ml-item {
  flex: 0 0 auto;
  display: flex; flex-direction: column; align-items: center;
  padding: 3px 6px; border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid transparent;
}
.ml-item--win  { border-color: rgba(76, 175, 80, 0.5); }
.ml-item--lose { border-color: rgba(255, 82, 82, 0.5); }
.ml-icon { font-size: 16px; line-height: 1.15; }
.ml-round { font-size: 9px; color: #8a82a6; margin-top: 1px; }
.arena-slot { flex: 1; min-height: 200px; }
.hud-info {
  text-align: center; font-size: 13px; color: #cfc8e6;
  min-height: 20px;
}
.hud-action { min-height: 140px; }

/* 动作按钮 2×2（template v-for 透明，按钮直接成为 grid 子项） */
.hud-action {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.hud-action > .wait-box,
.hud-action > .result-panel { grid-column: 1 / -1; }

.act-btn {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; padding: 12px 4px; border: none; border-radius: 14px;
  color: #fff; cursor: pointer;
  box-shadow: 0 3px 0 rgba(0, 0, 0, 0.3);
  transition: transform 0.1s, box-shadow 0.1s;
}
.act-btn:active { transform: translateY(2px); box-shadow: 0 1px 0 rgba(0, 0, 0, 0.3); }
.act-btn--attack  { background: linear-gradient(135deg, #ff6b6b, #c0392b); }
.act-btn--defend  { background: linear-gradient(135deg, #4da3ff, #2c6fb0); }
.act-btn--charge  { background: linear-gradient(135deg, #ffb347, #e8890c); }
.act-btn--counter { background: linear-gradient(135deg, #a78bfa, #7c3aed); }
.act-icon { font-size: 26px; }
.act-name { font-weight: 800; font-size: 15px; }
.act-hint { font-size: 11px; opacity: 0.85; }

.wait-box {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 20px;
  background: rgba(255, 255, 255, 0.04); border-radius: 14px;
}
.result-panel {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 16px;
  background: rgba(124, 58, 237, 0.12); border: 1px solid rgba(124, 58, 237, 0.4);
  border-radius: 14px;
}
.rp-line { font-size: 14px; font-weight: 600; }

@keyframes blink { 50% { opacity: 0.3; } }
</style>
