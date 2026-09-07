<template>
  <q-page class="dt-page q-pa-md">
    <header class="row items-center q-mb-md">
      <q-btn flat round icon="arrow_back" :aria-label="dt('back')" @click="goBack" />
      <div class="text-h6 q-ml-sm">🐉 {{ dt('title') }}</div>
      <q-space />
      <span class="text-caption text-grey-5">{{ dt('round', { id: round.id || '—' }) }}</span>
    </header>

    <q-banner v-if="error" class="bg-negative text-white q-mb-md" rounded>
      {{ error }}
      <template #action><q-btn flat :label="dt('retry')" @click="refreshAll" /></template>
    </q-banner>

    <section class="dt-card hero" aria-live="polite">
      <div class="arena-stage">
        <BattleArena3D
          :result="arenaResult"
          :player-charged="dragonCharged"
          :opponent-charged="tigerCharged"
        />
        <div class="arena-phase">
          <div class="phase">{{ phaseText }} <strong>{{ countdown }}</strong></div>
          <div v-if="round.result" class="verdict" :class="round.result">{{ resultLabel(round.result) }}</div>
        </div>
        <div class="fighters">
          <div class="fighter fighter--dragon">
            <div class="fighter-name"><span>🐉</span><b>{{ dt('dragon') }}</b></div>
            <q-linear-progress rounded :value="dragonHp / 100" color="red-6" track-color="grey-9" />
            <small>{{ dragonHp }} HP · {{ dt('betAmount', { amount: formatPoints(totals.dragon) }) }}</small>
          </div>
          <div class="vs">VS<small>{{ dt('fairBattle') }}</small></div>
          <div class="fighter fighter--tiger">
            <div class="fighter-name"><span>🐅</span><b>{{ dt('tiger') }}</b></div>
            <q-linear-progress rounded :value="tigerHp / 100" color="blue-6" track-color="grey-9" />
            <small>{{ tigerHp }} HP · {{ dt('betAmount', { amount: formatPoints(totals.tiger) }) }}</small>
          </div>
        </div>
      </div>
      <div v-if="latestBattleRound" class="battle-line">
        {{ dt('battleRound', { round: latestBattleRound.round || visibleBattleRounds.length }) }}
        {{ dt('battleActions', { dragon: actionLabel(latestBattleRound.dragon_action), tiger: actionLabel(latestBattleRound.tiger_action) }) }}
      </div>
      <div class="fairness">
        {{ dt('drawPool', { amount: formatPoints(totals.draw) }) }}
        <span :title="round.seed_commitment">{{ shortCommitment }}</span>
      </div>
    </section>

    <section class="dt-card q-mt-md">
      <div class="row items-center">
        <div class="text-subtitle1">{{ dt('chooseAndBet') }}</div>
        <q-space />
        <span class="balance">{{ dt('balance', { amount: formatPoints(balance) }) }}</span>
      </div>
      <div class="choices q-mt-sm">
        <q-btn
          v-for="item in choices"
          :key="item.key"
          :label="item.label"
          :color="selection === item.key ? item.color : 'grey-8'"
          :disable="choiceDisabled(item.key)"
          unelevated
          @click="selection = item.key"
        />
      </div>
      <div class="stake-row q-mt-md">
        <q-input
          v-model.number="amount"
          type="number"
          outlined dense dark
          :label="dt('amountLabel')"
          min="20" step="20"
          :disable="round.status !== 'betting' || submitting"
        />
        <q-btn
          :label="lockedChoice ? dt('addBet') : dt('confirmBet')"
          color="deep-orange"
          :loading="submitting"
          :disable="!canBet"
          @click="submitBet"
        />
      </div>
      <div v-if="amountError" class="validation-error q-mt-xs">{{ amountError }}</div>
      <div v-if="myBet" class="my-bet q-mt-sm">
        {{ dt('betPlaced', { selection: selectionLabel(myBet.selection), amount: formatPoints(myBet.stake_amount) }) }}
        {{ dt('winningPayout', { amount: formatPoints(expectedPayout) }) }}
        <template v-if="myBet.payout_amount != null"> · {{ dt('actualPayout', { amount: formatPoints(myBet.payout_amount) }) }}</template>
      </div>
    </section>

    <section class="dt-card q-mt-md">
      <div class="row items-center">
        <div>
          <div class="text-subtitle1">{{ dt('history') }}</div>
          <div v-if="recentStreak" class="history-streak">
            <span>{{ dt('recent') }}</span>
            <b :class="recentStreak.result">{{ resultLabel(recentStreak.result) }}</b>
            <span>· {{ recentStreak.result === 'draw' ? dt('consecutive') : dt('winningStreak') }}</span>
            <strong>×{{ recentStreak.count }}{{ recentStreak.truncated ? '+' : '' }}</strong>
          </div>
        </div>
        <q-space />
        <q-btn flat dense :label="dt('refresh')" icon="refresh" :loading="historyLoading" @click="loadHistory(true)" />
      </div>
      <div
        v-for="item in history"
        :key="item.id"
        class="history-row history-row--clickable"
        role="button"
        tabindex="0"
        :aria-label="dt('viewReportAria', { id: item.id })"
        @click="openHistoryDetail(item)"
        @keydown.enter.prevent="openHistoryDetail(item)"
        @keydown.space.prevent="openHistoryDetail(item)"
      >
        <div class="history-public">
          <span>{{ dt('round', { id: item.id }) }}</span>
          <b :class="item.result">{{ resultLabel(item.result) }}</b>
          <span v-if="historyHasBets(item)">{{ dt('poolSummary', { dragon: formatPoints(item.dragon_bet_total), tiger: formatPoints(item.tiger_bet_total), draw: formatPoints(item.draw_bet_total) }) }}</span>
          <span v-else class="text-grey-6">{{ dt('noBets') }}</span>
        </div>
        <div v-if="item.my_bet" class="history-my-bet">
          <b>{{ dt('myBet') }}</b>
          <span>{{ dt('betSelection', { selection: selectionLabel(item.my_bet.selection), amount: formatPoints(item.my_bet.stake_amount) }) }}</span>
          <span v-if="item.my_bet.status === 'active'">{{ dt('pendingSettlement') }}</span>
          <span v-else-if="item.my_bet.status === 'refunded'">
            {{ dt('refundedNetZero', { amount: formatPoints(item.my_bet.payout_amount || item.my_bet.stake_amount) }) }}
          </span>
          <span v-else>
            {{ dt('payoutNetStart', { amount: formatPoints(item.my_bet.payout_amount) }) }}<strong :class="historyProfit(item.my_bet) >= 0 ? 'profit' : 'loss'">{{ formatSignedPoints(historyProfit(item.my_bet)) }}</strong>{{ dt('payoutNetEnd') }}
          </span>
        </div>
        <div class="history-detail-link">{{ dt('viewReport') }} <q-icon name="chevron_right" /></div>
      </div>
      <div v-if="!historyLoading && !history.length" class="text-grey-6 q-pa-md text-center">{{ dt('noSettledRounds') }}</div>
      <q-btn v-if="historyHasMore" flat class="full-width q-mt-sm" :label="dt('loadMore')" :loading="historyLoading" @click="loadHistory(false)" />
    </section>

    <q-dialog v-model="detailOpen">
      <q-card dark class="battle-report-card">
        <q-card-section class="row items-center">
          <div>
            <div class="text-h6">{{ dt('reportTitle', { id: detailRound?.id || '—' }) }}</div>
            <div v-if="detailRound" class="text-caption text-grey-5">
              {{ dt('reportSummary', { result: resultLabel(detailRound.result), dragon: detailFinalHp.dragon, tiger: detailFinalHp.tiger }) }}
            </div>
          </div>
          <q-space />
          <q-btn flat round dense icon="close" :aria-label="dt('closeReport')" v-close-popup />
        </q-card-section>

        <q-separator dark />
        <q-card-section v-if="detailLoading" class="text-center q-py-xl">
          <q-spinner-dots color="amber-7" size="40px" />
        </q-card-section>
        <q-card-section v-else-if="detailError">
          <q-banner class="bg-negative text-white" rounded>
            {{ detailError }}
            <template #action><q-btn flat :label="dt('retry')" @click="reloadHistoryDetail" /></template>
          </q-banner>
        </q-card-section>
        <template v-else-if="detailRound">
          <q-card-section v-if="detailMyBet" class="report-my-bet">
            <b>{{ dt('myBet') }}</b>
            <span>{{ dt('betSelection', { selection: selectionLabel(detailMyBet.selection), amount: formatPoints(detailMyBet.stake_amount) }) }}</span>
            <span v-if="detailMyBet.status === 'refunded'">{{ dt('refund', { amount: formatPoints(detailMyBet.payout_amount || detailMyBet.stake_amount) }) }}</span>
            <span v-else>
              {{ dt('payoutNetShortStart', { amount: formatPoints(detailMyBet.payout_amount) }) }}
              <strong :class="historyProfit(detailMyBet) >= 0 ? 'profit' : 'loss'">{{ formatSignedPoints(historyProfit(detailMyBet)) }}</strong>
            </span>
          </q-card-section>

          <q-card-section>
            <div class="report-section-title">{{ dt('roundRecords') }}</div>
            <div v-for="battleRound in detailBattleRounds" :key="battleRound.round" class="battle-round-row">
              <div class="battle-round-number">{{ dt('battleRound', { round: battleRound.round }) }}</div>
              <div>{{ dt('roundActions', { dragon: actionLabel(battleRound.dragon_action), tiger: actionLabel(battleRound.tiger_action) }) }}</div>
              <div class="battle-round-damage">
                {{ dt('damage', { dragon: battleRound.dragon_damage, tiger: battleRound.tiger_damage }) }}
                <template v-if="battleRound.environment_damage"> · {{ dt('environmentDamage', { damage: battleRound.environment_damage }) }}</template>
              </div>
              <div class="battle-round-hp">{{ dt('afterRound', { dragon: battleRound.dragon_hp, tiger: battleRound.tiger_hp }) }}</div>
            </div>
            <div v-if="!detailBattleRounds.length" class="text-grey-6 text-center q-py-md">{{ dt('noRoundRecords') }}</div>
          </q-card-section>

          <q-card-section class="fairness-report">
            <div class="report-section-title">{{ dt('fairnessVerification') }}</div>
            <div>{{ dt('rulesVersion', { version: detailRound.rules_version }) }}</div>
            <div>{{ dt('seedCommitment') }}</div>
            <code>{{ detailRound.seed_commitment || '—' }}</code>
            <div class="q-mt-sm">{{ dt('serverSeed') }}</div>
            <code>{{ detailRound.server_seed || '—' }}</code>
          </q-card-section>
        </template>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Notify } from 'quasar'
import { ironfistApi } from 'src/services/api'
import { useFistStore } from 'src/stores/fist'
import { useI18n } from 'src/i18n'
import { connect as wsConnect, off as wsOff, on as wsOn } from 'src/services/websocket'
import BattleArena3D from '../BattleArena3D.vue'
import {
  calculateDragonTigerPayout,
  calculateDragonTigerStreak,
  isValidDragonTigerAmount,
  phaseDeadline,
  shouldApplyDragonTigerEvent,
} from '../../game/dragon-tiger-core.mjs'

const emit = defineEmits(['back'])
const router = useRouter()
const route = useRoute()
const fistStore = useFistStore()
const { locale, t } = useI18n()
const dt = (key, params = {}) => t(`ironFist.dragonTiger.${key}`, params)

const choices = computed(() => [
  { key: 'dragon', label: dt('betDragon'), color: 'red-8' },
  { key: 'draw', label: dt('betDraw'), color: 'purple-7' },
  { key: 'tiger', label: dt('betTiger'), color: 'blue-8' },
])
const eventTypes = [
  'ironfist_dragon_tiger_round_opened',
  'ironfist_dragon_tiger_bet_totals_changed',
  'ironfist_dragon_tiger_locked',
  'ironfist_dragon_tiger_battle_started',
  'ironfist_dragon_tiger_round_revealed',
  'ironfist_dragon_tiger_settled',
  'ironfist_dragon_tiger_voided',
]

const round = ref({})
const totals = ref({ dragon: 0, tiger: 0, draw: 0 })
const myBet = ref(null)
const history = ref([])
const historyHasMore = ref(false)
const historyLoading = ref(false)
const detailOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const detailRound = ref(null)
const detailMyBet = ref(null)
const amount = ref(20)
const selection = ref(null)
const balance = ref(0)
const submitting = ref(false)
const error = ref('')
const arenaResult = ref(null)
const monotonicNow = ref(performance.now())
let serverClock = null
let currentLoading = null
let pollTimer = null
let tickTimer = null
let refreshTimer = null
let pendingCommand = null
let disposed = false
let detailRequestVersion = 0

const phaseText = computed(() => ({
  betting: dt('phaseBetting'), locked: dt('phaseLocked'), playing: dt('phasePlaying'), settling: dt('phaseSettling'),
  settled: dt('phaseSettled'), voided: dt('phaseVoided'),
}[round.value.status] || dt('phaseConnecting')))
const estimatedServerNow = computed(() => serverClock
  ? serverClock.epochMs + monotonicNow.value - serverClock.monotonicMs
  : Date.now())
const countdown = computed(() => {
  const deadline = phaseDeadline(round.value)
  if (!deadline) return '—'
  const seconds = Math.max(0, Math.ceil((Date.parse(deadline) - estimatedServerNow.value) / 1000))
  return dt('countdownSeconds', { seconds })
})
const lockedChoice = computed(() => Boolean(myBet.value))
const numericAmount = computed(() => Number(amount.value))
const totalAfterBet = computed(() => Number(myBet.value?.stake_amount || 0) + numericAmount.value)
const amountError = computed(() => {
  if (!isValidDragonTigerAmount(numericAmount.value)) return dt('amountInvalid')
  if (totalAfterBet.value > 10_000) return dt('roundLimit')
  if (numericAmount.value > balance.value) return dt('insufficientBalance')
  return ''
})
const canBet = computed(() => round.value.status === 'betting' && selection.value && !amountError.value && !submitting.value && (!lockedChoice.value || selection.value === myBet.value.selection))
const expectedPayout = computed(() => calculateDragonTigerPayout(Number(myBet.value?.stake_amount || 0), myBet.value?.selection))
const visibleBattleRounds = computed(() => {
  const value = round.value.revealed_rounds || round.value.battle?.rounds || round.value.battle_json?.rounds || []
  return Array.isArray(value) ? value : []
})
const latestBattleRound = computed(() => visibleBattleRounds.value.at(-1) || null)
const dragonHp = computed(() => Number(latestBattleRound.value?.dragon_hp ?? round.value.dragon_hp ?? 100))
const tigerHp = computed(() => Number(latestBattleRound.value?.tiger_hp ?? round.value.tiger_hp ?? 100))
const dragonCharged = computed(() => Boolean(latestBattleRound.value?.dragon_charged))
const tigerCharged = computed(() => Boolean(latestBattleRound.value?.tiger_charged))
const shortCommitment = computed(() => {
  const value = round.value.seed_commitment
  return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : dt('waiting')
})
const detailBattleRounds = computed(() => {
  const value = detailRound.value?.battle?.rounds || detailRound.value?.revealed_rounds || []
  return Array.isArray(value) ? [...value].reverse() : []
})
const detailFinalHp = computed(() => {
  const lastRound = detailBattleRounds.value[0]
  return {
    dragon: Number(detailRound.value?.battle?.dragon_hp ?? lastRound?.dragon_hp ?? 100),
    tiger: Number(detailRound.value?.battle?.tiger_hp ?? lastRound?.tiger_hp ?? 100),
  }
})
const recentStreak = computed(() => calculateDragonTigerStreak(history.value, historyHasMore.value))

let animatedBattleRoundKey = ''
watch(() => [round.value.id, latestBattleRound.value], ([roundId, battleRound]) => {
  if (!battleRound) {
    animatedBattleRoundKey = ''
    arenaResult.value = null
    return
  }
  const key = `${roundId || 'unknown'}:${battleRound.round || visibleBattleRounds.value.length}`
  if (key === animatedBattleRoundKey) return
  animatedBattleRoundKey = key
  const dragonHP = Number(battleRound.dragon_hp ?? 100)
  const tigerHP = Number(battleRound.tiger_hp ?? 100)
  const battleFinished = dragonHP <= 0 || tigerHP <= 0 || Number(battleRound.round) >= 10
  arenaResult.value = {
    playerAction: battleRound.dragon_action,
    opponentAction: battleRound.tiger_action,
    playerDmg: Number(battleRound.dragon_damage || 0),
    opponentDmg: Number(battleRound.tiger_damage || 0),
    envDmg: Number(battleRound.environment_damage || 0),
    playerHP: dragonHP,
    opponentHP: tigerHP,
    playerCharged: Boolean(battleRound.dragon_charged),
    opponentCharged: Boolean(battleRound.tiger_charged),
    gameResult: battleFinished
      ? (dragonHP > tigerHP ? 'win' : tigerHP > dragonHP ? 'lose' : 'draw')
      : null,
  }
})

function unwrap(response) {
  const body = response?.data ?? response ?? {}
  return body?.data ?? body
}
function normalizeTotals(data, activeRound) {
  const source = data.totals || activeRound.totals || activeRound
  return {
    dragon: Number(source.dragon ?? source.dragon_bet_total ?? 0),
    tiger: Number(source.tiger ?? source.tiger_bet_total ?? 0),
    draw: Number(source.draw ?? source.draw_bet_total ?? 0),
  }
}
function formatPoints(value) { return Number(value || 0).toLocaleString(locale.value) }
function historyHasBets(item) {
  return Number(item.dragon_bet_total || 0) + Number(item.tiger_bet_total || 0) + Number(item.draw_bet_total || 0) > 0
}
function historyProfit(bet) { return Number(bet.payout_amount || 0) - Number(bet.stake_amount || 0) }
function formatSignedPoints(value) {
  const amount = Number(value || 0)
  return `${amount > 0 ? '+' : ''}${formatPoints(amount)}`
}
function selectionLabel(value) { return ({ dragon: dt('dragon'), tiger: dt('tiger'), draw: dt('draw') }[value] || '—') }
function resultLabel(value) { return ({ dragon: dt('resultDragon'), tiger: dt('resultTiger'), draw: dt('resultDraw'), void: dt('resultVoid') }[value] || '—') }
function actionLabel(value) { return ({ attack: dt('actionAttack'), defend: dt('actionDefend'), charge: dt('actionCharge'), counter: dt('actionCounter') }[value] || dt('actionWaiting')) }
function choiceDisabled(value) { return round.value.status !== 'betting' || submitting.value || (lockedChoice.value && myBet.value.selection !== value) }
function errorCode(err) { return err?.response?.data?.code || err?.response?.data?.error || '' }
function errorMessage(err, fallback) { return err?.response?.data?.message || fallback }
function betErrorMessage(err, receivedResponse) {
  const messages = {
    invalid_request: 'invalidRequest',
    invalid_request_id: 'invalidRequest',
    invalid_selection: 'invalidSelection',
    invalid_amount: 'amountInvalid',
    insufficient_balance: 'insufficientBalance',
    betting_closed: 'bettingClosed',
    stale_round: 'staleRound',
    selection_locked: 'selectionLocked',
    round_limit_exceeded: 'roundLimit',
    idempotency_conflict: 'requestConflict',
    not_found: 'roundNotFound',
    internal_error: 'internalError',
  }
  const translatedKey = messages[errorCode(err)]
  return errorMessage(err, translatedKey ? dt(translatedKey) : (receivedResponse ? dt('betFailed') : dt('networkRetry')))
}
function createRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return [...bytes].map((byte, index) => `${index === 4 || index === 6 || index === 8 || index === 10 ? '-' : ''}${byte.toString(16).padStart(2, '0')}`).join('')
}

function applyCurrent(data) {
  const nextRound = data.round || data.current_round || data
  const previousId = round.value.id
  round.value = nextRound || {}
  totals.value = normalizeTotals(data, round.value)
  myBet.value = data.my_bet || data.bet || null
  balance.value = Number(data.balance ?? data.fist_balance ?? fistStore.balance ?? 0)
  if (previousId && previousId !== round.value.id) {
    selection.value = null
    pendingCommand = null
    amount.value = 20
  }
  if (myBet.value) selection.value = myBet.value.selection
}

async function loadCurrent() {
  if (currentLoading) return currentLoading
  currentLoading = (async () => {
    const startedMono = performance.now()
    try {
      const data = unwrap(await ironfistApi.dragonTigerCurrent())
      if (disposed) return
      const finishedMono = performance.now()
      const serverMs = Date.parse(data.server_time)
      if (Number.isFinite(serverMs)) serverClock = { epochMs: serverMs, monotonicMs: (startedMono + finishedMono) / 2 }
      applyCurrent(data)
      error.value = ''
    } catch (err) {
      if (!disposed) error.value = errorMessage(err, dt('serviceUnavailable'))
    } finally {
      currentLoading = null
    }
  })()
  return currentLoading
}

async function loadHistory(reset = false) {
  if (historyLoading.value) return
  historyLoading.value = true
  try {
    const beforeId = reset ? undefined : history.value.at(-1)?.id
    const data = unwrap(await ironfistApi.dragonTigerHistory(beforeId, 20))
    const list = Array.isArray(data) ? data : (data.rounds || data.items || [])
    history.value = reset ? list : [...history.value, ...list]
    historyHasMore.value = data.has_more ?? list.length === 20
  } catch (err) {
    Notify.create({ type: 'negative', message: errorMessage(err, dt('historyLoadFailed')) })
  } finally {
    historyLoading.value = false
  }
}

async function openHistoryDetail(item) {
  const requestVersion = ++detailRequestVersion
  detailOpen.value = true
  detailLoading.value = true
  detailError.value = ''
  detailRound.value = item
  detailMyBet.value = item.my_bet || null
  try {
    const data = unwrap(await ironfistApi.dragonTigerDetail(item.id))
    if (requestVersion !== detailRequestVersion) return
    detailRound.value = data.round || data
    detailMyBet.value = data.my_bet || null
  } catch (err) {
    if (requestVersion === detailRequestVersion) detailError.value = errorMessage(err, dt('reportLoadFailed'))
  } finally {
    if (requestVersion === detailRequestVersion) detailLoading.value = false
  }
}

function reloadHistoryDetail() {
  if (detailRound.value?.id) void openHistoryDetail(detailRound.value)
}

async function refreshAll() { await Promise.all([loadCurrent(), loadHistory(true)]) }

async function submitBet() {
  if (!canBet.value) return
  const params = { roundId: round.value.id, selection: selection.value, amount: numericAmount.value }
  const sameRetry = pendingCommand && pendingCommand.roundId === params.roundId && pendingCommand.selection === params.selection && pendingCommand.amount === params.amount
  if (!sameRetry) pendingCommand = { ...params, requestId: createRequestId() }
  submitting.value = true
  error.value = ''
  try {
    const data = unwrap(await ironfistApi.dragonTigerBet(params.roundId, {
      request_id: pendingCommand.requestId,
      selection: params.selection,
      amount: params.amount,
    }))
    pendingCommand = null
    myBet.value = data.bet || data.my_bet || data
    if (Number.isFinite(Number(data.balance))) {
      balance.value = Number(data.balance)
      fistStore.balance = balance.value
    }
    await loadCurrent()
    Notify.create({ type: 'positive', message: dt('betSuccess') })
  } catch (err) {
    const code = errorCode(err)
    const receivedResponse = Boolean(err?.response)
    if (receivedResponse) pendingCommand = null
    const message = betErrorMessage(err, receivedResponse)
    if (code === 'betting_closed' || code === 'stale_round') await loadCurrent()
    error.value = message
  } finally {
    submitting.value = false
  }
}

function onPublicEvent(payload) {
  if (!shouldApplyDragonTigerEvent(round.value, payload)) return
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(loadCurrent, 80)
}
function onVisibilityChange() { if (document.visibilityState === 'visible') void loadCurrent() }
function goBack() {
  if (route.path === '/games/ironfist/dragon-tiger') router.push('/games/ironfist')
  else emit('back')
}

onMounted(async () => {
  balance.value = fistStore.balance
  eventTypes.forEach(type => wsOn(type, onPublicEvent))
  await wsConnect()
  if (disposed) return
  await refreshAll()
  tickTimer = setInterval(() => { monotonicNow.value = performance.now() }, 250)
  pollTimer = setInterval(loadCurrent, 5000)
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onUnmounted(() => {
  disposed = true
  eventTypes.forEach(type => wsOff(type, onPublicEvent))
  clearInterval(tickTimer)
  clearInterval(pollTimer)
  clearTimeout(refreshTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<style scoped>
.dt-page { min-height: 100dvh; max-width: 720px; margin: auto; background: #0f0f1a; color: #fff; }
.dt-card { padding: 18px; border: 1px solid #3c3563; border-radius: 18px; background: linear-gradient(145deg, #17152d, #242044); }
.hero { padding: 0 0 14px; overflow: hidden; text-align: center; }
.arena-stage { position: relative; height: clamp(230px, 58vw, 330px); background: #080711; }
.arena-stage::after { position: absolute; inset: 0; z-index: 1; background: linear-gradient(180deg, rgb(5 5 13 / 30%) 0%, transparent 32%, transparent 56%, rgb(7 6 18 / 88%) 100%); content: ''; pointer-events: none; }
.arena-phase { position: absolute; top: 10px; right: 0; left: 0; z-index: 3; pointer-events: none; }
.phase { color: #ffcb6b; font-size: 16px; text-shadow: 0 2px 8px #000; }
.phase strong { margin-left: 12px; font-size: 28px; }
.verdict { margin-top: 2px; font-size: 24px; font-weight: 900; text-shadow: 0 2px 10px #000; }
.fighters { position: absolute; right: 14px; bottom: 10px; left: 14px; z-index: 3; display: flex; align-items: flex-end; justify-content: space-around; gap: 12px; margin: 0; }
.fighter { display: flex; flex: 1; flex-direction: column; gap: 6px; min-width: 0; padding: 8px 9px; border: 1px solid rgb(255 255 255 / 10%); border-radius: 10px; background: rgb(10 9 25 / 72%); backdrop-filter: blur(4px); }
.fighter-name { display: flex; align-items: center; justify-content: center; gap: 5px; font-size: 17px; }
.fighter-name span { font-size: 23px; line-height: 1; }
.fighter b { font-size: 18px; }
.fighter small, .fairness { overflow: hidden; color: #b8b0ce; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.fighter--dragon b, .dragon { color: #ff7373; }
.fighter--tiger b, .tiger { color: #72aaff; }
.draw { color: #d19cff; }
.void { color: #aaa; }
.vs { padding-bottom: 17px; color: #ffcb6b; font-weight: 900; text-shadow: 0 2px 8px #000; }
.vs small { display: block; color: #8f87aa; font-weight: 400; white-space: nowrap; }
.battle-line { margin: 12px 14px 8px; color: #ddd5ef; }
.fairness { margin: 0 14px; overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.balance { color: #ffcb6b; font-size: 13px; }
.choices { display: flex; gap: 8px; }
.choices .q-btn { flex: 1; padding-right: 8px; padding-left: 8px; font-size: 12px; }
.choices .q-btn :deep(.q-btn__content) { flex-wrap: nowrap; white-space: nowrap; }
.stake-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.validation-error { color: #ff8b8b; font-size: 12px; }
.my-bet { color: #bdb4d1; font-size: 12px; }
.history-row { padding: 11px 0; border-bottom: 1px solid #393454; color: #aaa; font-size: 12px; }
.history-streak { display: flex; align-items: center; gap: 4px; margin-top: 3px; color: #9e96b6; font-size: 12px; }
.history-streak strong { color: #ffcb6b; font-size: 13px; }
.history-row--clickable { cursor: pointer; }
.history-row--clickable:hover, .history-row--clickable:focus-visible { outline: none; background: rgb(255 255 255 / 4%); }
.history-public { display: grid; grid-template-columns: .9fr .7fr 3fr; gap: 8px; }
.history-public b { text-align: center; }
.history-my-bet { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: rgb(255 255 255 / 5%); color: #ddd5ef; }
.history-my-bet b { color: #ffcb6b; }
.history-detail-link { margin-top: 6px; color: #ffcb6b; text-align: right; }
.profit { color: #7ee2a8; }
.loss { color: #ff8b8b; }
.battle-report-card { width: min(680px, 94vw); max-height: 88vh; overflow: auto; border: 1px solid #3c3563; border-radius: 16px; background: #1b1833; }
.report-my-bet { display: flex; flex-wrap: wrap; gap: 8px 16px; background: rgb(255 203 107 / 8%); color: #ddd5ef; }
.report-my-bet b, .report-section-title { color: #ffcb6b; }
.report-section-title { margin-bottom: 8px; font-weight: 700; }
.battle-round-row { padding: 10px 0; border-bottom: 1px solid #393454; color: #ddd5ef; font-size: 13px; }
.battle-round-number { color: #ffcb6b; font-weight: 700; }
.battle-round-damage, .battle-round-hp { margin-top: 3px; color: #9e96b6; font-size: 12px; }
.fairness-report { color: #9e96b6; font-size: 12px; }
.fairness-report code { display: block; overflow-wrap: anywhere; color: #ddd5ef; user-select: text; }
@media (max-width: 420px) {
  .dt-page { padding: 12px; }
  .dt-card { padding: 14px; }
  .hero { padding: 0 0 12px; }
  .arena-stage { height: 230px; }
  .fighters { right: 8px; bottom: 8px; left: 8px; gap: 7px; }
  .fighter { padding: 7px 6px; }
  .fighter-name { font-size: 15px; }
  .fighter-name span { font-size: 20px; }
  .fighter b { font-size: 16px; }
  .vs { padding-bottom: 16px; font-size: 12px; }
  .vs small { font-size: 10px; }
  .history-row { font-size: 11px; }
  .history-public { grid-template-columns: .9fr .7fr 3fr; }
}
</style>
