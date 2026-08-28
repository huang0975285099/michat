<!-- LEGACY_DISABLED: historical international token page; not imported by the current route. -->
<template>
    <div class="q-pa-md fist-view">
        <!-- top bar -->
        <div class="row items-center q-mb-md">
            <q-btn
                flat
                round
                dense
                icon="arrow_back"
                color="white"
                @click="$emit('back')"
            />
            <div class="text-h6 q-ml-sm">{{ t("ironFist.tokenTitle") }}</div>
            <q-space />
            <q-chip dense color="amber-9" text-color="white" class="fist-chip">
                ⚡ {{ fistStore.balance.toLocaleString() }} $FIST
            </q-chip>
        </div>

        <!-- ── Hero: What is $FIST ─────────────────────────── -->
        <div class="hero">
            <div class="hero-glow"></div>
            <div class="hero-logo">⚡</div>
            <div class="hero-title">$FIST</div>
            <div class="hero-sub">{{ t("ironFist.tokenSubtitle") }}</div>
            <div class="hero-desc">{{ t("ironFist.tokenDescription") }}</div>
            <div class="hero-tags">
                <span class="htag">Solana</span>
                <span class="htag">SPL Token</span>
                <span class="htag">{{ t("ironFist.hardCapTag") }}</span>
                <span class="htag">{{ t("ironFist.deflationTag") }}</span>
            </div>
        </div>

        <!-- ── Data dashboard ───────────────────────────────── -->
        <div class="section-title">{{ t("ironFist.chainDashboard") }}</div>
        <div class="stat-grid">
            <div
                v-for="s in statCards"
                :key="s.label"
                class="stat-card"
                :class="`stat-card--${s.tone}`"
            >
                <div class="stat-value">{{ s.value }}</div>
                <div class="stat-label">{{ s.label }}</div>
                <div class="stat-hint">{{ s.hint }}</div>
            </div>
        </div>
        <div class="data-note">
            {{ t("ironFist.chainDataNote") }}
        </div>

        <!-- ── Total distribution ───────────────────────────────── -->
        <div class="section-title">{{ t("ironFist.totalAllocation") }}</div>
        <div class="alloc-list">
            <div v-for="a in allocation" :key="a.name" class="alloc-row">
                <div class="alloc-head">
                    <span class="alloc-dot" :style="{ background: a.color }"></span>
                    <span class="alloc-name">{{ a.name }}</span>
                    <span class="alloc-pct">{{ a.pct }}%</span>
                </div>
                <div class="alloc-bar">
                    <div
                        class="alloc-fill"
                        :style="{ width: a.pct + '%', background: a.color }"
                    ></div>
                </div>
                <div class="alloc-use">{{ a.use }}</div>
            </div>
        </div>

        <!-- ──PvE Reward Mechanism──────────────────────────── -->
        <div class="section-title">{{ t("ironFist.pveRewardMechanism") }}</div>
        <div class="info-card">
            <div class="formula">
                {{ t("ironFist.pveRewardFormula") }}
            </div>
            <div class="info-desc">
                {{ t("ironFist.pveRewardDesc") }}
            </div>
            <div class="chip-row">
                <span class="pill">{{ t("ironFist.coldStartReward") }}</span>
                <span class="pill">{{ t("ironFist.dailyFirstTen") }}</span>
                <span class="pill pill--gold">{{ t("ironFist.earlyPlayerBonus") }}</span>
            </div>
        </div>

        <!-- ── PvP three levels of pledge ─────────────────────────────── -->
        <div class="section-title">{{ t("ironFist.pvpStakeBattle") }}</div>
        <div class="tier-list">
            <div
                v-for="t in tiers"
                :key="t.key"
                class="tier-row"
                :class="`tier-row--${t.key}`"
            >
                <div class="tier-ic">{{ t.icon }}</div>
                <div class="tier-info">
                    <div class="tier-name">{{ t.name }}</div>
                    <div class="tier-sub">
                        {{ translate("ironFist.stakeAdmission", { stake: t.stake.toLocaleString(), win: t.win.toLocaleString() }) }}
                    </div>
                </div>
                <div class="tier-burn">
                    <div class="tier-burn-num">🔥 {{ t.burn }}</div>
                    <div class="tier-burn-lb">{{ translate("ironFist.burnPerMatch") }}</div>
                </div>
            </div>
        </div>
        <div class="info-desc info-desc--pad">
            {{ t("ironFist.pvpStakeDesc") }}
        </div>

        <!-- ── Deflationary destruction ────────────────────────────────── -->
        <div class="section-title">{{ t("ironFist.burnTouchpoints") }}</div>
        <div class="burn-grid">
            <div v-for="b in burns" :key="b.name" class="burn-card">
                <div class="burn-ic">{{ b.icon }}</div>
                <div class="burn-name">{{ b.name }}</div>
                <div class="burn-rule">{{ b.rule }}</div>
            </div>
        </div>

        <!-- ── Pledge veFIST ─────────────────────────────── -->
        <div class="section-title">{{ t("ironFist.veFistTitle") }}</div>
        <div class="info-card">
            <div class="info-desc">
                {{ t("ironFist.veFistDesc") }}
            </div>
            <div class="ve-list">
                <div v-for="v in veRates" :key="v.lock" class="ve-row">
                    <span class="ve-lock">{{ v.lock }}</span>
                    <span class="ve-rate">{{ t("ironFist.veRate", { rate: v.rate }) }}</span>
                </div>
            </div>
            <div class="chip-row">
                <span class="pill">{{ t("ironFist.vePool") }}</span>
                <span class="pill">{{ t("ironFist.treasuryDividend") }}</span>
            </div>
        </div>

        <!-- ──Treasury───────────────────────────────────── -->
        <div class="section-title">{{ t("ironFist.daoTreasury") }}</div>
        <div class="info-card treasury-card">
            <div class="treasury-top">
                <div class="treasury-amount">{{ t("ironFist.twoBillion") }}</div>
                <div class="treasury-lb">{{ t("ironFist.treasuryShare") }}</div>
            </div>
            <div class="info-desc">
                {{ t("ironFist.treasuryDesc") }}
            </div>
            <div class="chip-row">
                <span class="pill">{{ t("ironFist.publicAddress") }}</span>
                <span class="pill">{{ t("ironFist.multisig") }}</span>
                <span class="pill">{{ t("ironFist.largeExpense") }}</span>
            </div>
        </div>

        <!-- ── Roadmap ─────────────────────────────────── -->
        <div class="section-title">{{ t("ironFist.roadmapTitle") }}</div>
        <div class="road-list">
            <div v-for="(r, i) in roadmap" :key="r.stage" class="road-row">
                <div class="road-line">
                    <span class="road-node" :class="{ 'road-node--first': i === 0 }"></span>
                    <span v-if="i < roadmap.length - 1" class="road-bar"></span>
                </div>
                <div class="road-body">
                    <div class="road-stage">{{ r.stage }}</div>
                    <div class="road-text">{{ r.text }}</div>
                </div>
            </div>
        </div>

        <!-- Disclaimer -->
        <div class="disclaimer">
            {{ t("ironFist.tokenDisclaimer") }}
        </div>
    </div>
</template>

<script setup>
import { computed } from "vue";
import { useFistStore } from "src/stores/fist";
import { PVP_TIERS } from "../game/ironfistMeta";
import { useI18n } from "src/i18n";

defineEmits(["back"]);

const fistStore = useFistStore();
const { t } = useI18n();
const translate = t;

// Data dashboard (static white paper data)
const statCards = computed(() => [
    { label: t("ironFist.totalSupply"), value: t("ironFist.tenBillion"), hint: t("ironFist.noIssuance"), tone: "gold" },
    { label: t("ironFist.pveDailyEmission"), value: t("ironFist.fiftyMillion"), hint: t("ironFist.coldStartPerDay"), tone: "purple" },
    { label: t("ironFist.daoTreasury"), value: t("ironFist.twoBillionShort"), hint: t("ironFist.twentyPercent"), tone: "blue" },
    { label: t("ironFist.stakingPool"), value: t("ironFist.fiveHundredMillion"), hint: t("ironFist.thirtySixMonths"), tone: "green" },
    { label: t("ironFist.pvpFee"), value: "5%", hint: t("ironFist.halfBurned"), tone: "red" },
    { label: t("ironFist.firstYearCirculation"), value: "~38%", hint: t("ironFist.monthTwelve"), tone: "teal" },
]);

// Total allocation
const allocation = computed(() => [
    { name: t("ironFist.allocPve"), pct: 28, use: t("ironFist.allocPveUse"), color: "#a855f7" },
    { name: t("ironFist.daoTreasury"), pct: 20, use: t("ironFist.allocTreasuryUse"), color: "#3b82f6" },
    { name: t("ironFist.allocTeam"), pct: 15, use: t("ironFist.allocTeamUse"), color: "#64748b" },
    { name: t("ironFist.allocGrowth"), pct: 12, use: t("ironFist.allocGrowthUse"), color: "#ec4899" },
    { name: t("ironFist.allocLiquidity"), pct: 8, use: t("ironFist.allocLiquidityUse"), color: "#14b8a6" },
    { name: t("ironFist.allocInvestors"), pct: 7, use: t("ironFist.allocInvestorsUse"), color: "#f97316" },
    { name: t("ironFist.stakingPool"), pct: 5, use: t("ironFist.allocStakingUse"), color: "#22c55e" },
    { name: t("ironFist.allocNft"), pct: 5, use: t("ironFist.allocNftUse"), color: "#eab308" },
]);

// PvP three levels: reuse the level definitions in the App, supplement and destroy/obtain (5% handling fee, 50% of which is destroyed)
const tiers = computed(() =>
    PVP_TIERS.map((t) => {
        const fee = t.stake * 2 * 0.05;
        return {
            ...t,
            name: translate(`ironFist.tier${t.key[0].toUpperCase()}${t.key.slice(1)}`),
            burn: fee / 2,
            win: t.stake * 2 - fee,
        };
    }),
);

// Destroy contact
const burns = computed(() => [
    { icon: "⚔️", name: t("ironFist.burnPvp"), rule: t("ironFist.burnPvpRule") },
    { icon: "🥊", name: t("ironFist.burnNft"), rule: t("ironFist.burnNftRule") },
    { icon: "🎨", name: t("ironFist.burnSkin"), rule: t("ironFist.burnSkinRule") },
    { icon: "💱", name: t("ironFist.burnRoyalty"), rule: t("ironFist.burnRoyaltyRule") },
    { icon: "🏆", name: t("ironFist.burnTournament"), rule: t("ironFist.burnTournamentRule") },
    { icon: "🗳️", name: t("ironFist.burnDao"), rule: t("ironFist.burnDaoRule") },
]);

// veFIST lock magnification
const veRates = computed(() => [
    { lock: t("ironFist.lockOneMonth"), rate: "0.25" },
    { lock: t("ironFist.lockSixMonths"), rate: "0.5" },
    { lock: t("ironFist.lockOneYear"), rate: "1.0" },
    { lock: t("ironFist.lockFourYears"), rate: "4.0" },
]);

// roadmap
const roadmap = computed(() => [
    { stage: t("ironFist.roadCold"), text: t("ironFist.roadColdText") },
    { stage: t("ironFist.roadGrowth"), text: t("ironFist.roadGrowthText") },
    { stage: t("ironFist.roadBreakout"), text: t("ironFist.roadBreakoutText") },
    { stage: t("ironFist.roadTransition"), text: t("ironFist.roadTransitionText") },
]);
</script>

<style scoped>
.fist-view {
    min-height: 100dvh;
    padding-bottom: 40px;
}
.fist-chip {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
}

/* Hero */
.hero {
    position: relative;
    overflow: hidden;
    text-align: center;
    padding: 26px 18px 22px;
    border-radius: 20px;
    background: linear-gradient(160deg, #2a2140 0%, #3a2b18 100%);
    border: 1px solid rgba(255, 179, 0, 0.3);
}
.hero-glow {
    position: absolute;
    top: -60px;
    left: 50%;
    width: 220px;
    height: 220px;
    transform: translateX(-50%);
    background: radial-gradient(circle, rgba(255, 179, 0, 0.32), transparent 70%);
    pointer-events: none;
}
.hero-logo {
    position: relative;
    font-size: 52px;
    line-height: 1;
    filter: drop-shadow(0 4px 14px rgba(255, 179, 0, 0.6));
}
.hero-title {
    position: relative;
    font-size: 30px;
    font-weight: 900;
    letter-spacing: 0.06em;
    color: #ffce5a;
    margin-top: 4px;
}
.hero-sub {
    position: relative;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.55);
    letter-spacing: 0.1em;
    margin-top: 2px;
}
.hero-desc {
    position: relative;
    font-size: 13px;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.82);
    margin: 14px 4px 0;
}
.hero-desc b {
    color: #ffce5a;
}
.hero-tags {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
    margin-top: 14px;
}
.htag {
    font-size: 11px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 10px;
    color: #ffe6a8;
    background: rgba(255, 179, 0, 0.14);
    border: 1px solid rgba(255, 179, 0, 0.3);
}

/* Group title */
.section-title {
    font-size: 13px;
    font-weight: 700;
    color: #8a83a8;
    letter-spacing: 0.06em;
    margin: 22px 2px 12px;
}

/* Data dashboard */
.stat-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
}
.stat-card {
    padding: 12px 8px;
    border-radius: 14px;
    text-align: center;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
}
.stat-value {
    font-size: 20px;
    font-weight: 900;
    line-height: 1.1;
}
.stat-label {
    font-size: 11px;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.75);
    margin-top: 4px;
}
.stat-hint {
    font-size: 9px;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 2px;
}
.stat-card--gold {
    border-color: rgba(255, 179, 0, 0.35);
}
.stat-card--gold .stat-value {
    color: #ffce5a;
}
.stat-card--purple .stat-value {
    color: #c084fc;
}
.stat-card--blue .stat-value {
    color: #60a5fa;
}
.stat-card--green .stat-value {
    color: #4ade80;
}
.stat-card--red .stat-value {
    color: #f87171;
}
.stat-card--teal .stat-value {
    color: #2dd4bf;
}
.data-note {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.38);
    line-height: 1.6;
    margin: 10px 2px 0;
}

/* Total allocation */
.alloc-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.alloc-row {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 12px;
    padding: 10px 12px;
}
.alloc-head {
    display: flex;
    align-items: center;
    gap: 7px;
}
.alloc-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: 0 0 auto;
}
.alloc-name {
    font-size: 13px;
    font-weight: 700;
    flex: 1;
    min-width: 0;
}
.alloc-pct {
    font-size: 13px;
    font-weight: 800;
    color: #fff;
}
.alloc-bar {
    height: 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.35);
    overflow: hidden;
    margin: 7px 0 4px;
}
.alloc-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.5s ease;
}
.alloc-use {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
}

/* General information card */
.info-card {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    padding: 14px;
}
.formula {
    font-size: 13px;
    font-weight: 700;
    color: #ffce5a;
    text-align: center;
    padding: 10px;
    border-radius: 10px;
    background: rgba(255, 179, 0, 0.1);
    border: 1px dashed rgba(255, 179, 0, 0.3);
    line-height: 1.5;
}
.info-desc {
    font-size: 12px;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.72);
    margin-top: 10px;
}
.info-desc--pad {
    padding: 0 2px;
}
.chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
}
.pill {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 9px;
    color: rgba(255, 255, 255, 0.8);
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
}
.pill--gold {
    color: #ffce5a;
    background: rgba(255, 179, 0, 0.14);
    border-color: rgba(255, 179, 0, 0.3);
}

/* PvP Tier 3 */
.tier-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.tier-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
}
.tier-row--gold {
    background: linear-gradient(135deg, rgba(255, 179, 0, 0.14), rgba(255, 179, 0, 0.04));
    border-color: rgba(255, 179, 0, 0.3);
}
.tier-row--platinum {
    background: linear-gradient(135deg, rgba(120, 200, 255, 0.12), rgba(120, 200, 255, 0.03));
    border-color: rgba(120, 200, 255, 0.28);
}
.tier-row--diamond {
    background: linear-gradient(135deg, rgba(200, 140, 255, 0.14), rgba(200, 140, 255, 0.04));
    border-color: rgba(200, 140, 255, 0.3);
}
.tier-ic {
    font-size: 30px;
    flex: 0 0 auto;
}
.tier-info {
    flex: 1;
    min-width: 0;
}
.tier-name {
    font-size: 15px;
    font-weight: 800;
}
.tier-sub {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.6);
    margin-top: 2px;
}
.tier-burn {
    text-align: right;
    flex: 0 0 auto;
}
.tier-burn-num {
    font-size: 15px;
    font-weight: 800;
    color: #ff8a5a;
}
.tier-burn-lb {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
}

/* Destroy contact */
.burn-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
}
.burn-card {
    padding: 12px;
    border-radius: 12px;
    background: rgba(255, 90, 60, 0.06);
    border: 1px solid rgba(255, 90, 60, 0.18);
}
.burn-ic {
    font-size: 22px;
}
.burn-name {
    font-size: 13px;
    font-weight: 800;
    margin-top: 4px;
}
.burn-rule {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.55);
    margin-top: 2px;
    line-height: 1.5;
}

/* veFIST */
.ve-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
}
.ve-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
}
.ve-lock {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.75);
}
.ve-rate {
    font-size: 12px;
    font-weight: 700;
    color: #c084fc;
}

/* treasury */
.treasury-card {
    border-color: rgba(96, 165, 250, 0.3);
    background: linear-gradient(160deg, rgba(59, 130, 246, 0.1), rgba(255, 255, 255, 0.03));
}
.treasury-top {
    display: flex;
    align-items: baseline;
    gap: 10px;
}
.treasury-amount {
    font-size: 26px;
    font-weight: 900;
    color: #60a5fa;
}
.treasury-lb {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.55);
}

/* roadmap */
.road-list {
    display: flex;
    flex-direction: column;
}
.road-row {
    display: flex;
    gap: 12px;
}
.road-line {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 0 0 auto;
    width: 14px;
}
.road-node {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #5b3fa0;
    border: 2px solid #a855f7;
    margin-top: 4px;
    flex: 0 0 auto;
}
.road-node--first {
    background: #ffce5a;
    border-color: #ffce5a;
    box-shadow: 0 0 8px rgba(255, 206, 90, 0.7);
}
.road-bar {
    flex: 1;
    width: 2px;
    background: linear-gradient(180deg, #a855f7, rgba(168, 85, 247, 0.2));
    margin: 2px 0;
}
.road-body {
    padding-bottom: 16px;
}
.road-stage {
    font-size: 13px;
    font-weight: 800;
    color: #c4b5fd;
}
.road-text {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.65);
    margin-top: 2px;
    line-height: 1.5;
}

/* Disclaimer */
.disclaimer {
    font-size: 10px;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.32);
    margin-top: 20px;
    padding: 12px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
}
</style>
