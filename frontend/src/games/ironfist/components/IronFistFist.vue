<template>
    <div class="q-pa-md fist-view">
        <!-- 顶栏 -->
        <div class="row items-center q-mb-md">
            <q-btn
                flat
                round
                dense
                icon="arrow_back"
                color="white"
                @click="$emit('back')"
            />
            <div class="text-h6 q-ml-sm">$FIST 代币</div>
            <q-space />
            <q-chip dense color="amber-9" text-color="white" class="fist-chip">
                ⚡ {{ fistStore.balance.toLocaleString() }} $FIST
            </q-chip>
        </div>

        <!-- ── Hero：$FIST 是什么 ─────────────────────────── -->
        <div class="hero">
            <div class="hero-glow"></div>
            <div class="hero-logo">⚡</div>
            <div class="hero-title">$FIST</div>
            <div class="hero-sub">铁拳 3D 竞技代币</div>
            <div class="hero-desc">
                部署于 <b>Solana</b> 的 SPL 代币，总量硬顶
                <b>10 亿</b>，不可增发。奖励来自对手而非印钞，销毁嵌入每一次核心行为——
                <b>极致通缩、零和竞技、行为驱动销毁</b>。
            </div>
            <div class="hero-tags">
                <span class="htag">Solana</span>
                <span class="htag">SPL Token</span>
                <span class="htag">硬顶 10 亿</span>
                <span class="htag">通缩刚性</span>
            </div>
        </div>

        <!-- ── 数据看板 ─────────────────────────────────── -->
        <div class="section-title">链上数据看板</div>
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
            数据依据 $FIST 经济模型 v1.0 设计稿。真实收支以 Solana 链上账户为准，TGE 后可在
            Solscan 实时查询。
        </div>

        <!-- ── 总量分配 ─────────────────────────────────── -->
        <div class="section-title">总量分配 · 10 亿</div>
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

        <!-- ── PvE 奖励机制 ─────────────────────────────── -->
        <div class="section-title">PvE 奖励机制</div>
        <div class="info-card">
            <div class="formula">
                每场胜局奖励 = 当日全局奖励池 ÷ 当日全平台总胜场数
            </div>
            <div class="info-desc">
                固定总池按胜场分配——人越多单场越小，自然稀释、防止通胀。
            </div>
            <div class="chip-row">
                <span class="pill">冷启动期 50 万 / 天</span>
                <span class="pill">每日前 10 场计入</span>
                <span class="pill pill--gold">早期玩家永久 +20%</span>
            </div>
        </div>

        <!-- ── PvP 三档质押 ─────────────────────────────── -->
        <div class="section-title">PvP 质押对战 · 零和</div>
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
                        入场 {{ t.stake.toLocaleString() }} · 赢家到手
                        {{ t.win.toLocaleString() }}
                    </div>
                </div>
                <div class="tier-burn">
                    <div class="tier-burn-num">🔥 {{ t.burn }}</div>
                    <div class="tier-burn-lb">销毁 / 局</div>
                </div>
            </div>
        </div>
        <div class="info-desc info-desc--pad">
            奖池全部来自双方入场，平台不增发。5% 手续费中一半永久销毁、一半进国库。
        </div>

        <!-- ── 通缩销毁 ─────────────────────────────────── -->
        <div class="section-title">通缩与销毁触点</div>
        <div class="burn-grid">
            <div v-for="b in burns" :key="b.name" class="burn-card">
                <div class="burn-ic">{{ b.icon }}</div>
                <div class="burn-name">{{ b.name }}</div>
                <div class="burn-rule">{{ b.rule }}</div>
            </div>
        </div>

        <!-- ── 质押 veFIST ──────────────────────────────── -->
        <div class="section-title">质押 veFIST · 收益 + 治理</div>
        <div class="info-card">
            <div class="info-desc">
                质押 $FIST 并选择锁定期铸造不可转让的 veFIST，享质押分红与 DAO
                治理权。锁得越久倍率越高。
            </div>
            <div class="ve-list">
                <div v-for="v in veRates" :key="v.lock" class="ve-row">
                    <span class="ve-lock">{{ v.lock }}</span>
                    <span class="ve-rate">1 $FIST = {{ v.rate }} veFIST</span>
                </div>
            </div>
            <div class="chip-row">
                <span class="pill">固定池 5000 万 · 36 月线性</span>
                <span class="pill">国库手续费 40% 分红</span>
            </div>
        </div>

        <!-- ── 国库 ─────────────────────────────────────── -->
        <div class="section-title">DAO 国库</div>
        <div class="info-card treasury-card">
            <div class="treasury-top">
                <div class="treasury-amount">2.00 亿</div>
                <div class="treasury-lb">$FIST · 占总量 20%</div>
            </div>
            <div class="info-desc">
                用于运营、生态合作、DAO 提案执行与回购储备。收入来自 PvP
                手续费的 50%、SOL 铸造 NFT 的收益等。
            </div>
            <div class="chip-row">
                <span class="pill">链上地址公开</span>
                <span class="pill">大额提款需 3/5 多签 + 48h 时间锁</span>
                <span class="pill">≥100 万支出需 DAO 批准</span>
            </div>
        </div>

        <!-- ── 路线图 ───────────────────────────────────── -->
        <div class="section-title">8–12 月冲刺路线图</div>
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

        <!-- 免责声明 -->
        <div class="disclaimer">
            本页依据《$FIST 游戏代币经济学设计说明书 v1.0》整理，为设计讨论稿，最终参数以
            TGE 正式发布及链上合约为准，不构成任何投资建议。
        </div>
    </div>
</template>

<script setup>
import { computed } from "vue";
import { useFistStore } from "src/stores/fist";
import { PVP_TIERS } from "../game/ironfistMeta";

defineEmits(["back"]);

const fistStore = useFistStore();

// 数据看板（静态白皮书数据）
const statCards = [
    { label: "总供应量", value: "10 亿", hint: "硬上限 · 不可增发", tone: "gold" },
    { label: "PvE 日排放", value: "50 万", hint: "冷启动期 / 天", tone: "purple" },
    { label: "DAO 国库", value: "2 亿", hint: "占总量 20%", tone: "blue" },
    { label: "质押分红池", value: "5000 万", hint: "36 月线性释放", tone: "green" },
    { label: "PvP 手续费", value: "5%", hint: "半数永久销毁", tone: "red" },
    { label: "首年净流通", value: "~38%", hint: "第 12 个月节点", tone: "teal" },
];

// 总量分配
const allocation = [
    { name: "PvE 生态奖励池", pct: 28, use: "日常胜局奖励，递减释放", color: "#a855f7" },
    { name: "DAO 国库", pct: 20, use: "运营 / 合作 / 回购储备", color: "#3b82f6" },
    { name: "团队", pct: 15, use: "2 年锁仓 + 3 年线性", color: "#64748b" },
    { name: "邀请 / 社区增长", pct: 12, use: "冲刺期裂变与空投", color: "#ec4899" },
    { name: "初始流动性", pct: 8, use: "DEX 做市 (Raydium/Orca)", color: "#14b8a6" },
    { name: "早期投资人", pct: 7, use: "6 月锁仓 + 18 月线性", color: "#f97316" },
    { name: "质押分红池", pct: 5, use: "专项质押奖励", color: "#22c55e" },
    { name: "NFT 生态储备", pct: 5, use: "赛季激励 / 白名单", color: "#eab308" },
];

// PvP 三档：复用 App 内的档位定义，补充销毁/到手（手续费 5%，其中 50% 销毁）
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

// 销毁触点
const burns = [
    { icon: "⚔️", name: "PvP 手续费", rule: "手续费的 50% 永久销毁" },
    { icon: "🥊", name: "NFT 铸造", rule: "$FIST 支付 100% 销毁" },
    { icon: "🎨", name: "皮肤购买", rule: "季度皮肤全额销毁" },
    { icon: "💱", name: "二级版税", rule: "5% 版税半数销毁" },
    { icon: "🏆", name: "锦标赛入场", rule: "入场费 15% 销毁" },
    { icon: "🗳️", name: "DAO 提案", rule: "可发起销毁议案" },
];

// veFIST 锁定倍率
const veRates = [
    { lock: "锁定 1 个月", rate: "0.25" },
    { lock: "锁定 6 个月", rate: "0.5" },
    { lock: "锁定 1 年", rate: "1.0" },
    { lock: "锁定 4 年", rate: "4.0" },
];

// 路线图
const roadmap = [
    { stage: "冷启动 · 1–2 月", text: "TGE + 流动性部署 + 邀请裂变启动" },
    { stage: "增长 · 3–5 月", text: "NFT Genesis 发售 + 周锦标赛上线" },
    { stage: "爆发 · 6–9 月", text: "PvP 排位 + DAO 上线 + 质押分红" },
    { stage: "过渡 · 10–12 月", text: "社区接管运营，项目方降低干预" },
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

/* 分组标题 */
.section-title {
    font-size: 13px;
    font-weight: 700;
    color: #8a83a8;
    letter-spacing: 0.06em;
    margin: 22px 2px 12px;
}

/* 数据看板 */
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

/* 总量分配 */
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

/* 通用信息卡 */
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

/* PvP 三档 */
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

/* 销毁触点 */
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

/* 国库 */
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

/* 路线图 */
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

/* 免责声明 */
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
