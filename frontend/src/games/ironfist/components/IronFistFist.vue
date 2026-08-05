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
            <div class="text-h6 q-ml-sm">$FIST Token</div>
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
            <div class="hero-sub">iron fist 3D Competitive Tokens</div>
            <div class="hero-desc">
                Deployed on <b>Solana</b> of SPL Token，Total hard cap
                <b>10 billion</b>，No additional issuance is allowed。Rewards come from opponents rather than printing money，Destroy every core behavior embedded in——
                <b>Extreme deflation、zero sum competition、Behavior driven destruction</b>。
            </div>
            <div class="hero-tags">
                <span class="htag">Solana</span>
                <span class="htag">SPL Token</span>
                <span class="htag">hard top 10 billion</span>
                <span class="htag">deflationary rigidity</span>
            </div>
        </div>

        <!-- ── Data dashboard ───────────────────────────────── -->
        <div class="section-title">On-chain data dashboard</div>
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
            Data basis $FIST economic model v1.0 Design draft。The real income and expenditure are based on Solana The account on the chain shall prevail.，TGE Can be found later
            Solscan Real-time query。
        </div>

        <!-- ── Total distribution ───────────────────────────────── -->
        <div class="section-title">Total allocation · 10 billion</div>
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
        <div class="section-title">PvE Reward mechanism</div>
        <div class="info-card">
            <div class="formula">
                Rewards for each win = Global reward pool for the day ÷ Total number of wins on all platforms for the day
            </div>
            <div class="info-desc">
                Fixed total pool distributed based on wins——The more people there are, the smaller the venue will be.，natural dilution、prevent inflation。
            </div>
            <div class="chip-row">
                <span class="pill">cold start period 50 million / day</span>
                <span class="pill">daily before 10 field count</span>
                <span class="pill pill--gold">Early players forever +20%</span>
            </div>
        </div>

        <!-- ── PvP three levels of pledge ─────────────────────────────── -->
        <div class="section-title">PvP Pledge Battle · zero sum</div>
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
                        Admission {{ t.stake.toLocaleString() }} · Winner gets it
                        {{ t.win.toLocaleString() }}
                    </div>
                </div>
                <div class="tier-burn">
                    <div class="tier-burn-num">🔥 {{ t.burn }}</div>
                    <div class="tier-burn-lb">destroy / bureau</div>
                </div>
            </div>
        </div>
        <div class="info-desc info-desc--pad">
            All prize pools come from both parties’ entries，The platform does not issue additional shares。5% Half of the handling fee will be permanently destroyed、Half goes to the treasury。
        </div>

        <!-- ── Deflationary destruction ────────────────────────────────── -->
        <div class="section-title">Deflation and destruction touchpoints</div>
        <div class="burn-grid">
            <div v-for="b in burns" :key="b.name" class="burn-card">
                <div class="burn-ic">{{ b.icon }}</div>
                <div class="burn-name">{{ b.name }}</div>
                <div class="burn-rule">{{ b.rule }}</div>
            </div>
        </div>

        <!-- ── Pledge veFIST ─────────────────────────────── -->
        <div class="section-title">pledge veFIST · income + governance</div>
        <div class="info-card">
            <div class="info-desc">
                pledge $FIST and choose a lock-in period to cast a non-transferable veFIST，Enjoy pledge dividends and DAO
                governance rights。The longer it is locked, the higher the magnification。
            </div>
            <div class="ve-list">
                <div v-for="v in veRates" :key="v.lock" class="ve-row">
                    <span class="ve-lock">{{ v.lock }}</span>
                    <span class="ve-rate">1 $FIST = {{ v.rate }} veFIST</span>
                </div>
            </div>
            <div class="chip-row">
                <span class="pill">fixed pool 5000 million · 36 monthly linear</span>
                <span class="pill">Treasury handling fee 40% dividend</span>
            </div>
        </div>

        <!-- ──Treasury───────────────────────────────────── -->
        <div class="section-title">DAO treasury</div>
        <div class="info-card treasury-card">
            <div class="treasury-top">
                <div class="treasury-amount">2.00 billion</div>
                <div class="treasury-lb">$FIST · Accounting for the total 20%</div>
            </div>
            <div class="info-desc">
                for operations、ecological cooperation、DAO Proposal Execution and Repurchase Reserve。Revenue comes from PvP
                Handling fee 50%、SOL casting NFT income, etc.。
            </div>
            <div class="chip-row">
                <span class="pill">Public address on the chain</span>
                <span class="pill">Large withdrawals require 3/5 Multiple signatures + 48h time lock</span>
                <span class="pill">≥100 million expenditures DAO approve</span>
            </div>
        </div>

        <!-- ── Roadmap ─────────────────────────────────── -->
        <div class="section-title">8–12 Monthly Sprint Roadmap</div>
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
            This page is based on《$FIST Game Token Economics Design Instructions v1.0》Organize，Design discussion paper，The final parameters are
            TGE The official release and on-chain contract shall prevail.，Does not constitute any investment advice。
        </div>
    </div>
</template>

<script setup>
import { computed } from "vue";
import { useFistStore } from "src/stores/fist";
import { PVP_TIERS } from "../game/ironfistMeta";

defineEmits(["back"]);

const fistStore = useFistStore();

// Data dashboard (static white paper data)
const statCards = [
    { label: "total supply", value: "10 billion", hint: "hard cap · No additional issuance is allowed", tone: "gold" },
    { label: "PvE daily emissions", value: "50 million", hint: "cold start period / day", tone: "purple" },
    { label: "DAO treasury", value: "2 billion", hint: "Accounting for the total 20%", tone: "blue" },
    { label: "Pledge dividend pool", value: "5000 million", hint: "36 monthly linear release", tone: "green" },
    { label: "PvP handling fee", value: "5%", hint: "Half are permanently destroyed", tone: "red" },
    { label: "Net circulation in the first year", value: "~38%", hint: "No. 12 month node", tone: "teal" },
];

// Total allocation
const allocation = [
    { name: "PvE Ecological reward pool", pct: 28, use: "Daily victory rewards，Decreasing release", color: "#a855f7" },
    { name: "DAO treasury", pct: 20, use: "Operation / cooperation / repurchase reserve", color: "#3b82f6" },
    { name: "team", pct: 15, use: "2 Annual lockup + 3 annual linear", color: "#64748b" },
    { name: "Invite / community growth", pct: 12, use: "Fission and airdrop during sprint period", color: "#ec4899" },
    { name: "initial liquidity", pct: 8, use: "DEX market making (Raydium/Orca)", color: "#14b8a6" },
    { name: "early investors", pct: 7, use: "6 Monthly lockup + 18 monthly linear", color: "#f97316" },
    { name: "Pledge dividend pool", pct: 5, use: "Special pledge rewards", color: "#22c55e" },
    { name: "NFT ecological reserve", pct: 5, use: "Season motivation / whitelist", color: "#eab308" },
];

// PvP three levels: reuse the level definitions in the App, supplement and destroy/obtain (5% handling fee, 50% of which is destroyed)
const tiers = computed(() =>
    PVP_TIERS.map((t) => {
        const fee = t.stake * 2 * 0.05;
        return {
            ...t,
            burn: fee / 2,
            win: t.stake * 2 - fee,
        };
    }),
);

// Destroy contact
const burns = [
    { icon: "⚔️", name: "PvP handling fee", rule: "Handling fee 50% permanently destroyed" },
    { icon: "🥊", name: "NFT casting", rule: "$FIST pay 100% destroy" },
    { icon: "🎨", name: "skin purchase", rule: "All quarterly skins are destroyed" },
    { icon: "💱", name: "Secondary royalties", rule: "5% Half of the royalties are destroyed" },
    { icon: "🏆", name: "Tournament Admission", rule: "Admission fee 15% destroy" },
    { icon: "🗳️", name: "DAO proposal", rule: "Can initiate destruction motion" },
];

// veFIST lock magnification
const veRates = [
    { lock: "Lock 1 months", rate: "0.25" },
    { lock: "Lock 6 months", rate: "0.5" },
    { lock: "Lock 1 year", rate: "1.0" },
    { lock: "Lock 4 year", rate: "4.0" },
];

// roadmap
const roadmap = [
    { stage: "cold start · 1–2 month", text: "TGE + Liquidity deployment + Invite fission to start" },
    { stage: "growth · 3–5 month", text: "NFT Genesis On sale + Weekly Championship is online" },
    { stage: "break out · 6–9 month", text: "PvP Ranking + DAO Go online + Pledge dividends" },
    { stage: "Transition · 10–12 month", text: "Community takes over operations，Project side reduces intervention" },
];
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
