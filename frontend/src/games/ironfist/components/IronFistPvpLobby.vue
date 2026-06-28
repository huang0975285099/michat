<template>
    <div class="q-pa-md">
        <div class="row items-center q-mb-md">
            <q-btn
                flat
                round
                dense
                icon="arrow_back"
                color="white"
                @click="$emit('back')"
            />
            <div class="text-h6 q-ml-sm">匹配对战</div>
            <q-space />
            <q-chip dense color="amber-9" text-color="white" class="fist-chip">
                ⚡ {{ fistStore.balance.toLocaleString() }} $FIST
            </q-chip>
        </div>

        <div class="pvp-banner">
            <q-icon name="schedule" size="22px" class="pvp-banner-ic" />
            <div>
                <div class="pvp-banner-title">链上质押对战 · 后续开放</div>
                <div class="pvp-banner-sub">
                    双方质押等额 $FIST，胜者通吃；5% 手续费 50% 销毁、50%
                    入金库。敬请期待。
                </div>
            </div>
        </div>

        <div class="section-title">选择房间档位</div>
        <div
            v-for="t in PVP_TIERS"
            :key="t.key"
            class="tier-card"
            :class="`tier-card--${t.key}`"
            @click="startMatch(t)"
        >
            <div class="tier-icon">{{ t.icon }}</div>
            <div class="tier-text">
                <div class="tier-name">{{ t.name }}</div>
                <div class="tier-desc">{{ t.desc }}</div>
            </div>
            <div class="tier-stake">
                <div class="tier-stake-amount">
                    {{ t.stake.toLocaleString() }}
                </div>
                <div class="tier-stake-unit">$FIST / 局</div>
            </div>
        </div>

        <!-- 匹配遮罩：模拟匹配 → 提示后续开放 -->
        <transition name="result-fade">
            <div v-if="matchState !== 'idle'" class="match-overlay">
                <div class="match-card">
                    <template v-if="matchState === 'searching'">
                        <q-spinner-dots color="amber" size="56px" />
                        <div class="match-title">正在寻找对手…</div>
                        <div class="match-sub">
                            {{ matchTier?.name }} · 质押
                            {{ matchTier?.stake.toLocaleString() }} $FIST
                        </div>
                        <q-btn
                            flat
                            color="grey-5"
                            label="取消匹配"
                            @click="cancelMatch"
                        />
                    </template>
                    <template v-else>
                        <div class="match-soon-emoji">🚧</div>
                        <div class="match-title">敬请期待</div>
                        <div class="match-sub">
                            PVP 链上对战即将开放，先在人机模式中练手吧
                        </div>
                        <q-btn
                            unelevated
                            color="amber-8"
                            text-color="dark"
                            label="知道了"
                            @click="cancelMatch"
                        />
                    </template>
                </div>
            </div>
        </transition>
    </div>
</template>

<script setup>
import { ref, onUnmounted } from "vue";
import { useFistStore } from "src/stores/fist";
import { PVP_TIERS } from "../game/ironfistMeta";

defineEmits(["back"]);

const fistStore = useFistStore();

const matchState = ref("idle"); // idle | searching | soon
const matchTier = ref(null);
let matchTimer = null;

// 选择档位后进入匹配：模拟寻找对手 → 提示后续开放
function startMatch(tier) {
    matchTier.value = tier;
    matchState.value = "searching";
    clearTimeout(matchTimer);
    matchTimer = setTimeout(() => {
        matchState.value = "soon";
    }, 1800);
}
function cancelMatch() {
    clearTimeout(matchTimer);
    matchTimer = null;
    matchState.value = "idle";
    matchTier.value = null;
}

onUnmounted(() => clearTimeout(matchTimer));
</script>

<style scoped>
.fist-chip {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
}
.section-title {
    font-size: 13px;
    font-weight: 700;
    color: #8a83a8;
    letter-spacing: 0.06em;
    margin: 18px 2px 10px;
}

.pvp-banner {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 14px;
    background: rgba(255, 179, 0, 0.1);
    border: 1px solid rgba(255, 179, 0, 0.3);
    margin-bottom: 6px;
}
.pvp-banner-ic {
    color: #ffce5a;
    flex: 0 0 auto;
    margin-top: 1px;
}
.pvp-banner-title {
    font-size: 13px;
    font-weight: 700;
    color: #ffce5a;
}
.pvp-banner-sub {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.6);
    margin-top: 2px;
    line-height: 1.4;
}
.tier-card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px;
    border-radius: 16px;
    cursor: pointer;
    margin-bottom: 12px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    transition: transform 0.12s;
}
.tier-card:active {
    transform: scale(0.98);
}
.tier-card--gold {
    background: linear-gradient(135deg, #5a4a1e, #8a6a22);
}
.tier-card--platinum {
    background: linear-gradient(135deg, #1e4a5a, #2f6e80);
}
.tier-card--diamond {
    background: linear-gradient(135deg, #3a2b6e, #6a3f9a);
}
.tier-icon {
    font-size: 36px;
    flex: 0 0 auto;
}
.tier-text {
    min-width: 0;
    flex: 1;
}
.tier-name {
    font-size: 16px;
    font-weight: 800;
}
.tier-desc {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    margin-top: 2px;
}
.tier-stake {
    text-align: right;
    flex: 0 0 auto;
}
.tier-stake-amount {
    font-size: 20px;
    font-weight: 900;
    color: #ffce5a;
    line-height: 1.1;
}
.tier-stake-unit {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.5);
}

/* 匹配遮罩 */
.match-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(8, 6, 16, 0.82);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
}
.match-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 32px 36px;
    border-radius: 20px;
    text-align: center;
    max-width: 320px;
    background: rgba(24, 18, 36, 0.95);
    border: 1px solid rgba(255, 179, 0, 0.28);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
}
.match-soon-emoji {
    font-size: 56px;
    line-height: 1;
}
.match-title {
    font-size: 22px;
    font-weight: 800;
    color: #fff;
}
.match-sub {
    font-size: 13px;
    color: #9e9aae;
    line-height: 1.5;
}

/* 匹配遮罩淡入淡出 */
.result-fade-enter-active {
    transition: opacity 0.45s ease;
}
.result-fade-leave-active {
    transition: opacity 0.25s ease;
}
.result-fade-enter-from,
.result-fade-leave-to {
    opacity: 0;
}
</style>
