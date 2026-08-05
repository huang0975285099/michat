<template>
    <div class="q-pa-md">
        <div class="row items-center q-mb-md">
            <q-btn
                flat
                round
                dense
                icon="arrow_back"
                color="white"
                @click="$emit('home')"
            />
            <div style="font-size: 22px" class="q-ml-sm">🥊</div>
            <div class="text-h6 q-ml-xs">iron fist3D</div>
            <q-space />
            <!-- International token mode is disabled; only the Chinese points mode is available.
            <div
                v-if="region === 'intl'"
                class="text-caption text-grey-5 cursor-pointer rules-link"
                @click="$emit('open-fist')"
            >
                <q-icon name="info_outline" size="15px" />
                <span class="q-ml-xs">$fist</span>
            </div>
            -->
            <div
                class="text-caption text-grey-5 cursor-pointer rules-link  q-ml-xl"
                @click="showRules = true"
            >
                <q-icon name="help_outline" size="15px" />
                <span class="q-ml-xs">How to play</span>
            </div>
        </div>

        <div class="section-title">my information</div>
        <div class="mini-grid">
            <div class="mini-card mini-card--fist" @click="$emit('open-ledger')">
                <div class="mini-emoji">⚡</div>
                <div class="mini-name">
                    {{ fistStore.balance.toLocaleString() }}
                </div>
                <div class="mini-sub">{{ currency }} · Details</div>
            </div>
            <div class="mini-card" @click="$emit('open-records')">
                <div class="mini-emoji">📜</div>
                <div class="mini-name">Battle record</div>
                <div class="mini-sub">Record details</div>
            </div>
            <div class="mini-card" @click="$emit('open-achievements')">
                <div class="mini-emoji">🏅</div>
                <div class="mini-name">achievement</div>
                <div class="mini-sub">badge of honor</div>
            </div>
        </div>

        <div class="section-title">Select battle mode</div>

        <div class="mode-card mode-card--pve" @click="$emit('start-pve')">
            <div class="mode-emoji">🤖</div>
            <div class="mode-text">
                <div class="mode-name">
                    Man-machine battle
                    <span class="mode-tag mode-tag--earn">PVE</span>
                </div>
                <div class="mode-desc">Reward for every win 500 {{ currency }}，Maximum per day 10 field</div>
            <!-- Daily progress bar: additional 1000-point reward for 10 wins -->
                <div class="pve-progress">
                    <div class="pve-progress-bar">
                        <div
                            class="pve-progress-fill"
                            :style="{ width: pveProgressPct + '%' }"
                        ></div>
                    </div>
                    <div class="pve-progress-text">
                        <span
                            >today {{ fistStore.todayWins }}/{{
                                fistStore.todayMax
                            }}
                            field</span
                        >
                        <span
                            v-if="fistStore.todayWins >= fistStore.todayMax"
                            class="pve-progress-done"
                            >🎉 Full attendance +1000 ✓</span
                        >
                        <span v-else class="pve-progress-hint"
                            >full 10 field +1000 {{ currency }}</span
                        >
                    </div>
                </div>
            </div>
            <q-icon name="chevron_right" size="24px" class="q-ml-auto" />
        </div>

        <div class="mode-card" @click="$emit('start-practice')">
            <div class="mode-emoji">🎯</div>
            <div class="mode-text">
                <div class="mode-name">
                    Offline practice
                    <span class="mode-tag mode-tag--fun">No rewards</span>
                </div>
                <div class="mode-desc">Local training only · results never affect records or {{ currency }}</div>
            </div>
            <q-icon name="chevron_right" size="24px" class="q-ml-auto" />
        </div>

        <div class="mode-card mode-card--pvp" @click="$emit('open-pvp')">
            <div class="mode-emoji">⚔️</div>
            <div class="mode-text">
                <div class="mode-name">
                    Match play
                    <span class="mode-tag mode-tag--soon">Open later</span>
                </div>
                <div class="mode-desc">
                    gold 100 · platinum 1000 · diamond 10000 {{ currency }} Pledge Battle
                </div>
            </div>
            <q-icon name="chevron_right" size="24px" class="q-ml-auto" />
        </div>

        <div
            class="mode-card mode-card--friend"
            @click="showFriends = true"
        >
            <div class="mode-emoji">👥</div>
            <div class="mode-text">
                <div class="mode-name">
                    Friends vs. friends
                    <span class="mode-tag mode-tag--fun">entertainment</span>
                </div>
                <div class="mode-desc">real time 1v1 Invite online friends，Not consumed {{ currency }}</div>
            </div>
            <q-icon name="chevron_right" size="24px" class="q-ml-auto" />
        </div>

        <!-- Friends list pop-up window -->
        <q-dialog v-model="showFriends" position="bottom">
            <q-card class="friend-dialog">
                <q-card-section class="row items-center q-pb-none">
                    <div class="text-h6">online friends</div>
                    <q-space />
                    <q-btn icon="close" flat round dense v-close-popup />
                </q-card-section>
                <q-card-section>
                    <q-list v-if="loadingFriends">
                        <q-item>
                            <q-item-section class="text-center text-grey-5 q-py-md">
                                <q-spinner-dots color="primary" size="30px" />
                            </q-item-section>
                        </q-item>
                    </q-list>
                    <q-list v-else-if="onlineFriends.length" bordered separator rounded>
                        <q-item
                            v-for="f in onlineFriends"
                            :key="f.chat_id"
                            clickable
                            v-ripple
                            @click="$emit('invite', f)"
                        >
                            <q-item-section avatar>
                                <q-avatar color="purple" text-color="white" size="38px">
                                    {{
                                        (f.nickname || f.chat_id)
                                            .slice(0, 1)
                                            .toUpperCase()
                                    }}
                                </q-avatar>
                            </q-item-section>
                            <q-item-section>
                                <q-item-label>{{
                                    f.nickname || f.chat_id
                                }}</q-item-label>
                                <q-item-label caption class="text-positive"
                                    >online</q-item-label
                                >
                            </q-item-section>
                            <q-item-section side
                                ><q-icon name="chevron_right" color="grey-4"
                            /></q-item-section>
                        </q-item>
                    </q-list>
                    <div v-else class="text-center text-grey-5 q-py-lg">
                        No online friends yet
                    </div>
                </q-card-section>
            </q-card>
        </q-dialog>

        <!-- The international version and regional selection are temporarily disabled, and the current points mode is fixed to the Chinese version.
        <q-dialog v-model="showRegionDialog" persistent>
            <q-card class="region-dialog">
                <q-card-section class="text-center q-pt-lg">
                    <div class="region-title">🌏 Select version</div>
                    <div class="region-sub">Will be automatically remembered after first selection，Can be changed in settings</div>
                </q-card-section>
                <q-card-section class="region-options">
                    <button class="region-btn region-btn--cn" @click="selectRegion('cn')">
                        <span class="region-flag">🎮</span>
                        <span class="region-name">Mainland China version</span>
                        <span class="region-hint">Use “Points” Battles and rewards</span>
                    </button>
                    <button class="region-btn region-btn--intl" @click="selectRegion('intl')">
                        <span class="region-flag">🌐</span>
                        <span class="region-name">International version</span>
                        <span class="region-hint">Use points battles and rewards</span>
                    </button>
                </q-card-section>
            </q-card>
        </q-dialog>
        -->

        <!-- How to play pop-up window -->
        <q-dialog v-model="showRules" position="bottom">
            <q-card class="rules-dialog">
                <q-card-section class="row items-center q-pb-none">
                    <div class="text-h6">How to play · 4 action restraint relationship</div>
                    <q-space />
                    <q-btn icon="close" flat round dense v-close-popup />
                </q-card-section>
                <q-card-section>
                    <div class="rule-grid">
                        <div
                            v-for="a in actionList"
                            :key="a.key"
                            class="rule-item"
                        >
                            <span class="rule-icon">{{ a.icon }}</span>
                            <span class="rule-name">{{ a.name }}</span>
                            <span class="rule-hint">{{ a.hint }}</span>
                        </div>
                    </div>
                    <div class="text-caption text-grey-6 q-mt-md">
                        Attack overcomes charge · Defense against attack · counter attack ·
                        After charging, the damage of the next attack is doubled.（It takes effect only when hit）
                    </div>
                </q-card-section>
            </q-card>
        </q-dialog>
    </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useFistStore } from "src/stores/fist";
import { friendApi } from "src/services/api";
import { ACTIONS, ACTION_META } from "../game/GameConstants.js";
import { useRegion } from "../game/useRegion.js";

defineEmits([
    "home",
    "open-ledger",
    "open-records",
    "open-achievements",
    "start-pve",
    "start-practice",
    "open-pvp",
    "invite",
]);

const fistStore = useFistStore();

const { currency } = useRegion();

// International version region selection is temporarily disabled.
// const { region, currency, setRegion } = useRegion();
// const showRegionDialog = ref(false);
// function selectRegion(r) {
//     setRegion(r);
//     showRegionDialog.value = false;
// }

const showRules = ref(false);
const showFriends = ref(false);
const loadingFriends = ref(true);
const onlineFriends = ref([]);

const actionList = ACTIONS.map((k) => ({ key: k, ...ACTION_META[k] }));

// PVE daily progress percentage (0-100)
const pveProgressPct = computed(() => {
    const max = fistStore.todayMax || 10;
    return Math.min(100, Math.round((fistStore.todayWins / max) * 100));
});

async function loadFriends() {
    loadingFriends.value = true;
    try {
        const { data } = await friendApi.getFriends();
        onlineFriends.value = data.filter((f) => f.online);
    } catch {
        onlineFriends.value = [];
    } finally {
        loadingFriends.value = false;
    }
}

onMounted(() => {
    fistStore.fetchAccount();
    loadFriends();
    // The international version region selection is temporarily disabled, and the Chinese version points will be used permanently.
    // if (!region.value) showRegionDialog.value = true;
});
</script>

<style scoped>
.rules-link {
    transition: opacity 0.2s;
}
.rules-link:hover {
    opacity: 0.8;
}

/* Group title */
.section-title {
    font-size: 13px;
    font-weight: 700;
    color: #8a83a8;
    letter-spacing: 0.06em;
    margin: 18px 2px 10px;
}

/* Mine: Photocard grid (3 columns in one row) */
.mini-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
}
.mini-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 14px 6px;
    border-radius: 14px;
    cursor: pointer;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    transition: transform 0.12s;
}
.mini-card--fist {
    background: linear-gradient(135deg, #2a2140, #3a2b18);
    border-color: rgba(255, 179, 0, 0.35);
}
.mini-card:active {
    transform: scale(0.97);
}
.mini-emoji {
    font-size: 26px;
}
.mini-name {
    font-size: 15px;
    font-weight: 800;
    line-height: 1.1;
}
.mini-card--fist .mini-name {
    color: #ffce5a;
}
.mini-sub {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.5);
    text-align: center;
}

/* Lobby mode card */
.mode-card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px;
    border-radius: 16px;
    cursor: pointer;
    margin-bottom: 12px;
    transition: transform 0.12s;
}
.mode-card:active {
    transform: scale(0.98);
}
.mode-card--pve {
    background: linear-gradient(135deg, #3a2f6e, #5b3fa0);
}
.mode-card--pvp {
    background: linear-gradient(135deg, #2f5a6e, #3f80a0);
}
.mode-card--friend {
    background: linear-gradient(135deg, #5a3f6e, #8a3f6e);
}
.mode-emoji {
    font-size: 38px;
    flex: 0 0 auto;
}
.mode-text {
    flex: 1;
    min-width: 0;
}
.mode-name {
    font-size: 16px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 8px;
}
.mode-desc {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    margin-top: 2px;
}
.mode-tag {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 8px;
    letter-spacing: 0.04em;
}
.mode-tag--earn {
    background: rgba(255, 179, 0, 0.22);
    color: #ffce5a;
}
.mode-tag--soon {
    background: rgba(255, 255, 255, 0.18);
    color: #e7e0ff;
}
.mode-tag--fun {
    background: rgba(120, 230, 160, 0.2);
    color: #8ef0b0;
}
.friend-dialog {
    background: linear-gradient(180deg, #1a1f3e, #0c1024);
    color: #fff;
    border-radius: 16px 16px 0 0;
}

/* PVE daily progress bar */
.pve-progress {
    margin-top: 8px;
}
.pve-progress-bar {
    height: 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.35);
    overflow: hidden;
}
.pve-progress-fill {
    height: 100%;
    border-radius: 4px;
    background: linear-gradient(90deg, #ffce5a, #ff8a3d);
    transition: width 0.4s ease;
}
.pve-progress-text {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10px;
    margin-top: 4px;
    color: rgba(255, 255, 255, 0.7);
}
.pve-progress-hint {
    color: rgba(255, 206, 90, 0.9);
}
.pve-progress-done {
    color: #6ee7a0;
    font-weight: 700;
}

/* The international version region selection pop-up window is temporarily disabled.
.region-dialog {
    background: linear-gradient(160deg, #1a1635, #0e0c22);
    color: #fff;
    border-radius: 20px;
    width: min(340px, 92vw);
    border: 1px solid rgba(255, 255, 255, 0.1);
}
.region-title {
    font-size: 20px;
    font-weight: 900;
    letter-spacing: 0.04em;
}
.region-sub {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.45);
    margin-top: 6px;
}
.region-options {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 20px 24px;
}
.region-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 18px 12px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    cursor: pointer;
    color: #fff;
    transition: transform 0.12s, box-shadow 0.12s;
}
.region-btn:active {
    transform: scale(0.97);
}
.region-btn--cn {
    background: linear-gradient(135deg, #6e2f2f, #a03f3f);
    box-shadow: 0 4px 18px rgba(160, 63, 63, 0.35);
}
.region-btn--intl {
    background: linear-gradient(135deg, #2f4e6e, #3f6ea0);
    box-shadow: 0 4px 18px rgba(63, 110, 160, 0.35);
}
.region-flag {
    font-size: 32px;
    line-height: 1;
}
.region-name {
    font-size: 16px;
    font-weight: 800;
}
.region-hint {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.6);
}
*/

/* How to play pop-up window */
.rules-dialog {
    background: linear-gradient(180deg, #1a1f3e, #0c1024);
    color: #fff;
    border-radius: 16px 16px 0 0;
}
.rules-dialog :deep(.q-card-section) {
    padding: 20px;
}
.rule-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}
.rule-item {
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 10px;
    padding: 8px 10px;
}
.rule-icon {
    font-size: 20px;
}
.rule-name {
    font-weight: 700;
    font-size: 13px;
}
.rule-hint {
    font-size: 11px;
    color: #9e9e9e;
    margin-left: auto;
}
</style>
