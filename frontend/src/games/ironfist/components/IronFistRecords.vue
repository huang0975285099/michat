<template>
    <div class="q-pa-md sub-view">
        <div class="row items-center q-mb-md">
            <q-btn
                flat
                round
                dense
                icon="arrow_back"
                color="white"
                @click="$emit('back')"
            />
            <div class="text-h6 q-ml-sm">Battle record</div>
        </div>

        <div v-if="statsLoading && !stats" class="text-center q-py-xl">
            <q-spinner-dots color="amber-8" size="38px" />
        </div>
        <template v-else-if="stats">
            <!-- Record overview -->
            <div class="rec-total">
                <div class="rec-total-num">{{ stats.total_battles }}</div>
                <div class="rec-total-label">Total number of battles🔥 </div>
                <div class="rec-streak">
                    current {{ stats.current_win_streak }} winning streak，highest {{ stats.max_win_streak }} winning streak
                </div>
            </div>

            <div class="rec-mode">
                <div class="rec-mode-title">🤖 Man-machine battle PvE</div>
                <div class="rec-wld">
                    <span class="rec-w">{{ stats.pve_wins }} win</span>
                    <span class="rec-l">{{ stats.pve_losses }} Negative</span>
                    <span class="rec-d">{{ stats.pve_draws }} flat</span>
                </div>
            </div>
            <div class="rec-mode">
                <div class="rec-mode-title">⚔️ Match play PvP</div>
                <div class="rec-wld">
                    <span class="rec-w">{{ stats.pvp_wins }} win</span>
                    <span class="rec-l">{{ stats.pvp_losses }} Negative</span>
                    <span class="rec-d">{{ stats.pvp_draws }} flat</span>
                </div>
            </div>
            <div class="rec-mode">
                <div class="rec-mode-title">👥 Friends vs. friends</div>
                <div class="rec-wld">
                    <span class="rec-w">{{ stats.friend_wins }} win</span>
                    <span class="rec-l">{{ stats.friend_losses }} Negative</span>
                    <span class="rec-d">{{ stats.friend_draws }} flat</span>
                </div>
            </div>

            <!-- Game-by-game details -->
            <div class="section-title">Game-by-game details</div>
            <div
                v-if="matchesLoading && !matches.length"
                class="text-center q-py-lg"
            >
                <q-spinner-dots color="amber-8" size="32px" />
            </div>
            <div v-else-if="!matches.length" class="empty-hint">
                No battle record yet，Let’s play in human-computer mode
            </div>
            <template v-else>
                <div v-for="m in matches" :key="m.id" class="ml-card">
                    <div class="ml-head" @click="toggle(m)">
                        <div
                            class="ml-result"
                            :class="`ml-result--${resultMeta(m).tone}`"
                        >
                            <span class="ml-result-ic">{{
                                resultMeta(m).icon
                            }}</span>
                            {{ resultMeta(m).text }}
                        </div>
                        <div class="ml-info">
                            <div class="ml-line1">
                                {{
                                    m.mode === "pve"
                                        ? "man-machine PvE"
                                        : m.mode === "friend"
                                          ? "Friends vs. friends"
                                          : "match PvP"
                                }}
                                · {{ m.opponent_name || "opponent" }}
                            </div>
                            <div class="ml-line2">
                                {{ m.rounds }} round · Finale HP {{ m.player_hp }} :
                                {{ m.opponent_hp }}
                            </div>
                        </div>
                        <div class="ml-tail">
                            <div class="ml-time">{{ fmtTime(m.created_at) }}</div>
                            <q-icon
                                v-if="m.detail && m.detail.length"
                                :name="
                                    expandedId === m.id
                                        ? 'expand_less'
                                        : 'expand_more'
                                "
                                size="20px"
                                color="grey-5"
                            />
                        </div>
                    </div>

                    <q-slide-transition>
                        <div
                            v-show="expandedId === m.id && m.detail"
                            class="ml-detail"
                        >
                            <div
                                v-for="r in m.detail"
                                :key="r.r"
                                class="ml-round"
                            >
                                <span class="ml-round-num">R{{ r.r }}</span>
                                <span class="ml-move">
                                    <span class="ml-move-ic">{{
                                        moveIcon(r.p)
                                    }}</span
                                    >{{ moveName(r.p) }}
                                </span>
                                <span class="ml-vs">vs</span>
                                <span class="ml-move ml-move--opp">
                                    <span class="ml-move-ic">{{
                                        moveIcon(r.o)
                                    }}</span
                                    >{{ moveName(r.o) }}
                                </span>
                                <span class="ml-dmg">
                                    <span class="ml-dmg-me">-{{ r.pd }}</span>
                                    /
                                    <span class="ml-dmg-opp">-{{ r.od }}</span>
                                </span>
                            </div>
                        </div>
                    </q-slide-transition>
                </div>

                <div class="row justify-center q-my-md">
                    <q-btn
                        v-if="matchesHasMore"
                        flat
                        dense
                        color="amber-7"
                        label="load more"
                        @click="loadMatches()"
                    />
                    <div v-else class="text-caption text-grey-6">no more</div>
                </div>
            </template>
        </template>
    </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { Notify } from "quasar";
import { ironfistApi } from "src/services/api";
import { MATCH_RESULT_META, fmtTime } from "../game/ironfistMeta";
import { ACTION_META } from "../game/GameConstants.js";

defineEmits(["back"]);

const PAGE = 20;
const stats = ref(null);
const statsLoading = ref(false);
const matches = ref([]);
const matchesLoading = ref(false);
const matchesHasMore = ref(true);
const expandedId = ref(null);

function resultMeta(m) {
    return MATCH_RESULT_META[m.result] || { text: m.result, icon: "🎮", tone: "draw" };
}
function moveIcon(k) {
    return ACTION_META[k]?.icon ?? "?";
}
function moveName(k) {
    return ACTION_META[k]?.name ?? k;
}
function toggle(m) {
    if (!m.detail || !m.detail.length) return;
    expandedId.value = expandedId.value === m.id ? null : m.id;
}

async function loadMatches(reset = false) {
    if (!reset && !matchesHasMore.value) return;
    const beforeId = reset ? undefined : matches.value.at(-1)?.id;
    matchesLoading.value = true;
    try {
        const { data } = await ironfistApi.listMatches(beforeId, PAGE);
        const list = data.matches ?? [];
        matches.value = reset ? list : [...matches.value, ...list];
        matchesHasMore.value = list.length === PAGE;
    } catch {
        // Silently fails
    } finally {
        matchesLoading.value = false;
    }
}

onMounted(async () => {
    statsLoading.value = true;
    try {
        const { data } = await ironfistApi.getStats();
        stats.value = data;
    } catch {
        Notify.create({
            message: "Failed to load performance data",
            color: "negative",
            textColor: "white",
            position: "top",
            timeout: 1600,
        });
    } finally {
        statsLoading.value = false;
    }
    loadMatches(true);
});
</script>

<style scoped>
.sub-view {
    min-height: 100dvh;
}
.section-title {
    font-size: 13px;
    font-weight: 700;
    color: #8a83a8;
    letter-spacing: 0.06em;
    margin: 20px 2px 10px;
}
.empty-hint {
    text-align: center;
    color: rgba(255, 255, 255, 0.45);
    font-size: 13px;
    padding: 32px 16px;
}

/* Record overview */
.rec-total {
    text-align: center;
    padding: 20px;
    border-radius: 16px;
    background: linear-gradient(135deg, #2a2140, #3a2b18);
    border: 1px solid rgba(255, 179, 0, 0.3);
    margin-bottom: 14px;
}
.rec-total-num {
    font-size: 40px;
    font-weight: 900;
    color: #ffce5a;
    line-height: 1.1;
}
.rec-total-label {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.6);
}
.rec-streak {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.75);
    margin-top: 6px;
}
.rec-mode {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 10px;
}
.rec-mode-title {
    font-size: 14px;
    font-weight: 700;
}
.rec-wld {
    display: flex;
    gap: 12px;
    font-size: 14px;
    font-weight: 700;
}
.rec-w {
    color: #6ee7a0;
}
.rec-l {
    color: #ff7a7a;
}
.rec-d {
    color: #c5b3ff;
}

/* Game-by-game detail cards */
.ml-card {
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 8px;
    overflow: hidden;
}
.ml-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    cursor: pointer;
}
.ml-result {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 13px;
    font-weight: 800;
    flex: 0 0 auto;
    min-width: 52px;
}
.ml-result-ic {
    font-size: 16px;
}
.ml-result--win {
    color: #ffd76a;
}
.ml-result--lose {
    color: #ff7a7a;
}
.ml-result--draw {
    color: #c5b3ff;
}
.ml-info {
    flex: 1;
    min-width: 0;
}
.ml-line1 {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.ml-line2 {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.45);
    margin-top: 2px;
}
.ml-tail {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    flex: 0 0 auto;
}
.ml-time {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
}

/* unfold round by round */
.ml-detail {
    padding: 4px 14px 10px;
    border-top: 1px dashed rgba(255, 255, 255, 0.08);
}
.ml-round {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    padding: 5px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.ml-round:last-child {
    border-bottom: none;
}
.ml-round-num {
    color: #8a83a8;
    font-weight: 700;
    width: 26px;
    flex: 0 0 auto;
}
.ml-move {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: #8fb6ff;
    font-weight: 600;
}
.ml-move--opp {
    color: #ff9a9a;
}
.ml-move-ic {
    font-size: 14px;
}
.ml-vs {
    color: #6a6580;
    font-size: 10px;
}
.ml-dmg {
    margin-left: auto;
    font-weight: 700;
    flex: 0 0 auto;
}
.ml-dmg-me {
    color: #ff7a7a;
}
.ml-dmg-opp {
    color: #6ee7a0;
}
</style>
