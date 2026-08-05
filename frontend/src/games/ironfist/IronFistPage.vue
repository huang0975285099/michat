<template>
    <q-page class="ironfist-page">
        <!-- ── Lobby and subviews (menu has been split into independent components) ──────────── -->
        <!-- The @open-fist portal for the international version of $FIST is temporarily disabled. -->
        <IronFistLobby
            v-if="view === 'lobby'"
            @home="goHome"
            @open-ledger="view = 'ledger'"
            @open-records="view = 'records'"
            @open-achievements="view = 'achievements'"
            @start-pve="startPve"
            @start-practice="startPractice"
            @open-pvp="view = 'pvp'"
            @invite="startInvite"
        />
        <!-- The international $FIST introduction page is temporarily disabled.
        <IronFistFist v-else-if="view === 'fist'" @back="view = 'lobby'" />
        -->
        <IronFistLedger v-else-if="view === 'ledger'" @back="view = 'lobby'" />
        <IronFistRecords v-else-if="view === 'records'" @back="view = 'lobby'" />
        <IronFistAchievements
            v-else-if="view === 'achievements'"
            @back="view = 'lobby'"
        />
        <IronFistPvpLobby
            v-else-if="view === 'pvp'"
            @back="view = 'lobby'"
            @matched="onPVPMatched"
        />

        <!-- ── Inviting ───────────────────────────────────── -->
        <div
            v-else-if="view === 'inviting'"
            class="flex flex-center column full-h q-gutter-md q-pa-xl"
        >
            <q-spinner-dots color="purple" size="64px" />
            <div class="text-h6">Wait for the other party to accept…</div>
            <div class="text-caption text-grey-5">
                {{ gameStore.opponentNickname }}
            </div>
            <q-btn
                flat
                color="negative"
                label="Cancel invitation"
                @click="gameStore.cancelInvite()"
            />
        </div>

        <!-- ── Reconnecting (re-entering after refreshing the page) ─────────────────────── -->
        <div
            v-else-if="view === 'reconnecting'"
            class="flex flex-center column full-h q-gutter-md q-pa-xl"
        >
            <q-spinner-dots color="deep-orange" size="64px" />
            <div class="text-h6">Reconnecting to match…</div>
            <div class="text-caption text-grey-5">Restore game progress from server</div>
        </div>

        <!-- ── Battle ──────────────────────────────────────── -->
        <div v-else-if="view === 'playing'" class="battle">
            <!-- ===== Top battle HUD: Our side | Round + ring countdown | Opponent ===== -->
            <div class="match-hud">
                <div class="mh-grid">
                    <!-- Our side -->
                    <div
                        class="mh-player mh-player--me"
                        :class="{ 'mh-player--hit': meHit }"
                    >
                        <div class="mh-head">
                            <div
                                class="mh-avatar mh-avatar--me"
                                :class="{ charged: pCharged }"
                            >
                                <DeterministicAvatar
                                    v-if="identityStore.chatId"
                                    :seed="identityStore.chatId"
                                    :size="46"
                                    class="mh-avatar-img"
                                />
                                <span v-else>{{ myEmoji }}</span>
                            </div>
                            <div class="mh-id">
                                <div class="mh-name">{{ myName }}</div>
                                <div class="mh-score">
                                    <span class="mh-score-ic">⚔</span
                                    >{{ myDamage }}
                                </div>
                            </div>
                        </div>
                        <div class="mh-hpbar">
                            <span class="mh-heart mh-heart--me">♥</span>
                            <HealthBar :hp="pHP" :charged="pCharged" bare />
                        </div>
                        <div class="mh-tally">
                            <span
                                v-for="t in myTally"
                                :key="t.key"
                                class="tally"
                            >
                                <span class="tally-ic">{{ t.icon }}</span
                                >{{ t.count }}
                            </span>
                        </div>
                    </div>

                    <!-- Center: Number of rounds + circular countdown (SVG stroke animation) -->
                    <div class="mh-center">
                        <div class="mh-round-bar">
                            <span
                                class="mh-round-tick mh-round-tick--me"
                            ></span>
                            <div class="mh-round">ROUND {{ round }}</div>
                            <span
                                class="mh-round-tick mh-round-tick--opp"
                            ></span>
                        </div>
                        <div
                            class="cd-ring"
                            :class="cdStage ? `cd-ring--${cdStage}` : ''"
                        >
                            <!--
              SVG ring：viewBox 64x64，r=28，perimeter ≈ 175.93。
              stroke-dashoffset According to the remaining proportion from 0 → perimeter Smooth shrinkage。
              Advantages：Smooth stroke transition possible、internal glow filter，Than conic-gradient more refined。
            -->
                            <svg
                                class="cd-svg"
                                viewBox="0 0 64 64"
                                aria-hidden="true"
                            >
                                <defs>
                                    <filter
                                        id="cdGlow"
                                        x="-30%"
                                        y="-30%"
                                        width="160%"
                                        height="160%"
                                    >
                                        <feGaussianBlur
                                            stdDeviation="1.4"
                                            result="b"
                                        />
                                        <feMerge>
                                            <feMergeNode in="b" />
                                            <feMergeNode in="SourceGraphic" />
                                        </feMerge>
                                    </filter>
                                </defs>
                                <!-- Background circle (light) -->
                                <circle
                                    cx="32"
                                    cy="32"
                                    r="28"
                                    class="cd-track-circle"
                                />
                                <!-- progress circle -->
                                <circle
                                    cx="32"
                                    cy="32"
                                    r="28"
                                    class="cd-progress-circle"
                                    :class="
                                        cdStage
                                            ? `cd-progress-circle--${cdStage}`
                                            : ''
                                    "
                                    :style="ringStrokeStyle"
                                    filter="url(#cdGlow)"
                                />
                            </svg>
                            <div class="cd-inner">
                                <template v-if="phase === 'deciding'">
                                    <span class="cd-num">{{ countdown }}</span>
                                    <!-- <span class="cd-unit">Seconds</span> -->
                                </template>
                                <span v-else class="cd-glyph">⚔</span>
                            </div>
                        </div>
                        <div class="mh-status-bar">
                            <span
                                class="mh-status-dot mh-status-dot--me"
                            ></span>
                            <div class="mh-status">{{ phaseLabel }}</div>
                            <span
                                class="mh-status-dot mh-status-dot--opp"
                            ></span>
                        </div>
                    </div>

                    <!-- opponent -->
                    <div
                        class="mh-player mh-player--opp"
                        :class="{ 'mh-player--hit': oppHit }"
                    >
                        <div class="mh-head">
                            <div
                                class="mh-avatar mh-avatar--opp"
                                :class="{ charged: oCharged }"
                            >
                                <DeterministicAvatar
                                    v-if="opponentChatId"
                                    :seed="opponentChatId"
                                    :size="46"
                                    class="mh-avatar-img"
                                />
                                <span v-else>{{ opponentEmoji }}</span>
                            </div>
                            <div class="mh-id mh-id--right">
                                <div class="mh-name">{{ opponentName }}</div>
                                <div class="mh-score">
                                    <span class="mh-score-ic">⚔</span
                                    >{{ oppDamage }}
                                </div>
                            </div>
                        </div>
                        <div class="mh-hpbar mh-hpbar--right">
                            <HealthBar
                                :hp="oHP"
                                :charged="oCharged"
                                align="right"
                                bare
                            />
                            <span class="mh-heart mh-heart--opp">♥</span>
                        </div>
                        <div class="mh-tally mh-tally--right">
                            <span
                                v-for="t in oppTally"
                                :key="t.key"
                                class="tally"
                            >
                                <span class="tally-ic">{{ t.icon }}</span
                                >{{ t.count }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 3D combat area (the move reveal row is stacked at the bottom as a floating layer, without occupying the layout or shaking) -->
            <div class="arena-slot">
                <BattleArena
                    :result="lastResult"
                    :player-charged="pCharged"
                    :opponent-charged="oCharged"
                    :opponent-emoji="opponentEmoji"
                    @impact="onArenaImpact"
                />
            </div>

            <transition name="reveal-fade">
                <div v-if="showReveal" class="reveal-wrap">
                    <div
                        v-if="resultPhase"
                        class="reveal-verdict"
                        :class="'rvv--' + roundVerdict.tone"
                    >
                        {{ roundVerdict.text }}
                    </div>
                    <div class="reveal">
                        <div class="rv-side rv-side--me">
                            <span class="rv-move">
                                <span class="rv-ic">{{
                                    actionMeta[revealMy]?.icon
                                }}</span
                                >{{ actionMeta[revealMy]?.name }}
                            </span>
                        </div>
                        <div class="rv-side rv-side--opp">
                            <span v-if="revealOpp" class="rv-move">
                                <span class="rv-ic">{{
                                    actionMeta[revealOpp]?.icon
                                }}</span
                                >{{ actionMeta[revealOpp]?.name }}
                            </span>
                            <span v-else class="rv-move rv-move--wait">？</span>
                        </div>
                    </div>
                </div>
            </transition>

            <!-- ===== Operation button (resident; disabled in non-decision-making state) ===== -->
            <div class="control-deck">
                <div class="hud-action">
                    <button
                        v-for="a in actionList"
                        :key="a.key"
                        class="act-btn"
                        :class="[
                            'act-btn--' + a.key,
                            {
                                selected: myAction === a.key,
                                dim:
                                    !canAct || (myAction && myAction !== a.key),
                            },
                        ]"
                        :disabled="!canAct"
                        @click="onActionBtn($event, a.key)"
                    >
                        <span class="act-frame"
                            ><span class="act-icon">{{ a.icon }}</span></span
                        >
                        <span class="act-name">{{ a.name }}</span>
                        <span class="act-hint">{{ a.hint }}</span>
                    </button>
                </div>
            </div>

            <!-- ===== Opponent disconnects and reconnects (60s wait, no giving up) ===== -->
            <div v-if="isWaitingReconnect" class="reconnect-overlay">
                <div class="reconnect-card">
                    <q-spinner-dots color="deep-orange" size="56px" />
                    <div class="text-h6 q-mt-md">Opponent network fluctuations</div>
                    <div class="text-caption text-grey-5 q-mt-xs">
                        Wait for opponent to reconnect · Remaining {{ reconnectCountdown }}s
                    </div>
                    <div class="text-caption text-grey-6 q-mt-md">
                        The match must be decided by a winner，please be patient
                    </div>
                </div>
            </div>

            <!-- ===== Result mask: transparently superimposed on the game interface, the background is still the battle screen ===== -->
            <transition name="result-fade">
                <div
                    v-if="resultType"
                    class="result-overlay"
                    :class="`result-overlay--${resultType}`"
                >
                    <div class="result-card">
                        <div class="result-emoji">{{ resultEmoji }}</div>
                        <div class="result-title">{{ resultText }}</div>
                        <div v-if="resultSub" class="result-sub">
                            {{ resultSub }}
                        </div>
                        <!-- PvE Victory $FIST Reward -->
                        <div v-if="pveReward" class="pve-reward-badge">
                            <span class="pve-reward-amount">+500 {{ currency }}</span>
                            <span class="pve-reward-progress">
                                today {{ pveReward.todayWins }} /
                                {{ pveReward.todayMax }} field
                            </span>
                        </div>
                        <!-- Additional rewards for reaching 10 games per day -->
                        <div
                            v-if="pveReward && pveReward.bonusAwarded"
                            class="pve-bonus-badge"
                        >
                            🎉 Daily attendance reward +{{
                                pveReward.bonusAmount.toLocaleString()
                            }}
                            {{ currency }}
                        </div>
                        <q-btn
                            color="purple"
                            label="Return to lobby"
                            unelevated
                            class="result-btn"
                            @click="backToLobby"
                        />
                    </div>
                </div>
            </transition>
        </div>
    </q-page>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Notify } from "quasar";
import { useGameStore } from "src/stores/game";
import { useIdentityStore } from "src/stores/identity";
import { useFistStore } from "src/stores/fist";
import IronFistLobby from "./components/IronFistLobby.vue";
import IronFistLedger from "./components/IronFistLedger.vue";
import IronFistRecords from "./components/IronFistRecords.vue";
import IronFistAchievements from "./components/IronFistAchievements.vue";
import IronFistPvpLobby from "./components/IronFistPvpLobby.vue";
import HealthBar from "./components/HealthBar.vue";
import DeterministicAvatar from "src/components/DeterministicAvatar.vue";
import { useRegion } from "./game/useRegion.js";
import BattleArena from "./components/BattleArena3D.vue";
import { IronFistGame } from "./game/IronFistGame.js";
import { AuthoritativeIronFistGame } from "./game/AuthoritativeIronFistGame.js";
import { requireAuthoritativeGameID } from "./game/mode-routing.mjs";
import {
    ACTION_META,
    ACTIONS,
    ROUND_SECONDS,
    INITIAL_HP,
    RECONNECT_WINDOW_MS,
} from "./game/GameConstants.js";

defineOptions({ name: "IronFistPage" });

// Duration of stay after settlement (ms): Automatically enter the next round/final result page after displaying the reveal line + damage.
const ROUND_HOLD_MS = 2200;
const END_HOLD_MS = 3200; //Determine a draw (both sides still have blood after the timeout, and it ends without falling to the ground): Leave enough time for the "Confrontation and Decision" performance (starting hand≈1.1s + TIME OVER banner≈1.9s)
const END_HOLD_KO_MS = 3900; //Falling to the ground ending: leave enough ko animation (contact point≈1.1s + ko≈2.6s) to finish

const route = useRoute();
const router = useRouter();
const gameStore = useGameStore();
const identityStore = useIdentityStore();
const fistStore = useFistStore();
const { currency } = useRegion();

// Our nickname (if there is no nickname, it will fall back to chatId, and then fall back to "you") + avatar
const myName = computed(
    () => identityStore.nickname || identityStore.chatId || "you",
);
const myEmoji = "🤖";

const actionMeta = ACTION_META;
const actionList = ACTIONS.map((k) => ({ key: k, ...ACTION_META[k] }));

const view = ref("lobby");
const mode = ref("pve");

// Battle status mirror
const round = ref(0);
const phase = ref("round_start");
const countdown = ref(ROUND_SECONDS);
const pHP = ref(INITIAL_HP);
const oHP = ref(INITIAL_HP);
const pCharged = ref(false);
const oCharged = ref(false);
const myAction = ref(null);
const lastResult = ref(null);
const moveHistory = ref([]); //Records of moves in each round { round, player, opponent, pDmg, oDmg }
// Red flash + jitter when hit (the corresponding HUD column will be highlighted for a short time after being hit)
const meHit = ref(false);
const oppHit = ref(false);
let meHitTimer = null;
let oppHitTimer = null;
const opponentName = ref("opponent");
const opponentEmoji = ref("🤖");
const opponentChatId = ref("");

const resultType = ref("");
const errorMsg = ref(""); //Specific prompt copy when resultType==="error"
const pveReward = ref(null);
const pvpRoomId = ref(null); //Real PVP matching room number (only populated when mode=pvp & query.matched=1)

// PvP reconnection related
const reconnectCountdown = ref(0); //Remaining waiting seconds for reconnection
let reconnectTicker = null;

let engine = null;
let net = null;
let countdownTimer = null;
let confirmTimer = null;
let pageDisposed = false;
let pvpStartEpoch = 0;

// ── Computed properties ────────────────────────────────────────────
// Round victory or defeat decision (clear conclusion from the player’s perspective + color matching)
const roundVerdict = computed(() => {
    const r = lastResult.value;
    if (!r) return { text: "", tone: "neutral" };
    const { playerDmg: p, opponentDmg: o } = r;
    if (p === 0 && o === 0)
        return { text: "evenly matched · no one injured", tone: "neutral" };
    if (o > 0 && p === 0) return { text: "✅ You overpowered your opponent", tone: "good" };
    if (p > 0 && o === 0) return { text: "⚠ You are overwhelmed by your opponent", tone: "bad" };
    if (o > p) return { text: "You have a slight advantage", tone: "good" };
    if (p > o) return { text: "you are at a disadvantage", tone: "bad" };
    return { text: "Lose-lose", tone: "neutral" };
});

// Move statistics (accumulated number of uses of each move, only used ones are displayed)
function buildTally(sideKey) {
    const c = { attack: 0, defend: 0, charge: 0, counter: 0 };
    for (const m of moveHistory.value) {
        if (c[m[sideKey]] !== undefined) c[m[sideKey]] += 1;
    }
    return ACTIONS.filter((a) => c[a] > 0).map((a) => ({
        key: a,
        icon: ACTION_META[a].icon,
        count: c[a],
    }));
}
const myTally = computed(() => buildTally("player"));
const oppTally = computed(() => buildTally("opponent"));

// Cumulative output (total damage caused in this round, corresponding to the ⚔ value next to the avatar in the reference picture)
const myDamage = computed(() =>
    moveHistory.value.reduce((s, m) => s + (m.oDmg || 0), 0),
);
const oppDamage = computed(() =>
    moveHistory.value.reduce((s, m) => s + (m.pDmg || 0), 0),
);

// Ring countdown (SVG stroke-dashoffset)
// Perimeter = 2πr ≈ 175.93 (r=28)
// Decision state: shrink from full circle to 0 according to the remaining proportion
// Non-decision state: maintain a complete circle of static display
const CD_CIRCUMFERENCE = 2 * Math.PI * 28;
const ringStrokeStyle = computed(() => {
    if (phase.value !== "deciding") {
        return {
            strokeDasharray: CD_CIRCUMFERENCE,
            strokeDashoffset: 0,
        };
    }
    const ratio = Math.max(0, Math.min(1, countdown.value / ROUND_SECONDS));
    return {
        strokeDasharray: CD_CIRCUMFERENCE,
        // ratio=1 (when full) offset=0; ratio=0 (exhausted) offset=circumference → the ring disappears
        strokeDashoffset: CD_CIRCUMFERENCE * (1 - ratio),
        // Color is controlled by cdStage class, here only geometry is controlled
    };
});
// Countdown color stage: strictly aligned with the three levels of blood color in the HealthBar (divided according to the remaining proportion)
// safe(green) ratio > 0.6 corresponds to blood volume > 60
// warn(orange) 0.3 < ratio ≤ 0.6 corresponding to blood volume 30~60
// danger (red) ratio ≤ 0.3 corresponds to blood volume ≤ 30
// Only decision-making states take effect; non-decision-making states return an empty string (no class, use the default stroke color)
const cdStage = computed(() => {
    if (phase.value !== "deciding") return "";
    const ratio = countdown.value / ROUND_SECONDS;
    if (ratio <= 0.3) return "danger";
    if (ratio <= 0.6) return "warn";
    return "safe";
});
const phaseLabel = computed(() => {
    switch (phase.value) {
        case "deciding":
            return myAction.value ? "Moved" : "Preparing for action";
        case "locked":
            return "waiting for opponent";
        case "resolving":
            return "Settling";
        case "waiting_confirm":
            return "round settlement";
        case "waiting_reconnect":
            return "Opponent reconnects";
        default:
            return "";
    }
});
// Whether the opponent is offline and waiting to reconnect, masked
const isWaitingReconnect = computed(() => phase.value === "waiting_reconnect");
const canAct = computed(() => phase.value === "deciding" && !myAction.value);

// Move reveal: During the decision-making/locking phase, our move + opponent's "?" will be revealed; during the settlement phase, both sides will reveal
const resultPhase = computed(
    () =>
        !!lastResult.value &&
        (phase.value === "resolving" || phase.value === "waiting_confirm"),
);
const revealMy = computed(() =>
    resultPhase.value ? lastResult.value.playerAction : myAction.value,
);
const revealOpp = computed(() =>
    resultPhase.value ? lastResult.value.opponentAction : null,
);
const showReveal = computed(() => !!revealMy.value);

const RESULT_MAP = {
    win: ["🏆", "victory！"],
    lose: ["💀", "failed…"],
    draw: ["🤝", "draw"],
    doubleLose: ["💥", "Both exhausted"],
    aborted: ["📡", "Battle interrupted"],
    error: ["⚠️", "An error occurred"],
};
const resultEmoji = computed(
    () => (RESULT_MAP[resultType.value] || ["🎮", ""])[0],
);
const resultText = computed(
    () => (RESULT_MAP[resultType.value] || ["", "game over"])[1],
);
const resultSub = computed(() => {
    if (resultType.value === "aborted") return "The opponent did not respond for a long time，May have been disconnected";
    if (resultType.value === "error") return errorMsg.value;
    return "";
});

// ── Life cycle ───────────────────────────────────────────
onMounted(() => {
    pageDisposed = false;
    window.addEventListener("beforeunload", handleBeforeUnload);
    const role = route.query.role;
    const matched = route.query.matched;
    // Enter through friend invitation (host/guest) or real PVP matching is successful (matched=1) and start the battle directly;
    // Otherwise, it stops in the lobby, and the IronFistLobby component pulls the balance and friend list by itself.
    if (role === "host" || role === "guest" || matched === "1") {
        startPvp();
    }
});

onUnmounted(() => {
    pageDisposed = true;
    pvpStartEpoch += 1;
    window.removeEventListener("beforeunload", handleBeforeUnload);
    teardown();
});

watch(
    () => gameStore.state,
    (s) => {
        if (s === "idle" && view.value === "inviting") view.value = "lobby";
    },
);

// Already accepted/received by the opponent while on this page (lobby or invitation) and entered the match:
// If only the query changes in the same path, the component will not be remounted, and onMounted will not be triggered again, and the battle needs to be started manually.
watch(
    () => [route.query.role, route.query.matched],
    ([role, matched]) => {
        if (view.value === "playing") return;
        if (role === "host" || role === "guest" || matched === "1") {
            startPvp();
        }
    },
);

// ── Friend invitation (triggered by lobby component @invite) ──────────────────────
function startInvite(friend) {
    gameStore.invite(
        friend.chat_id,
        friend.nickname || friend.chat_id,
        "ironfist",
    );
    view.value = "inviting";
}

// Real PVP matching successful (IronFistPvpLobby @matched trigger):
// Switching query triggers startPvp to be re-executed, carrying room_id / opponent information.
function onPVPMatched({ roomId, gameId, opponent, tier, stake }) {
    const query = {
        matched: "1",
        room_id: String(roomId),
        game_id: gameId,
        opponent: opponent?.chat_id,
        opponent_name: opponent?.nickname || opponent?.chat_id || "opponent",
        tier,
        stake: String(stake ?? 0),
    };
    router.replace({ query });
    // View switching is driven by the watcher of query.matched; startPvp can also be triggered directly here.
    // Router.replace with the same path will not be remounted, and will still be captured and started by query watcher.
}

// ──Start the battle───────────────────────────────────────────
async function startPve() {
    mode.value = "pve";
    opponentName.value = "computer";
    opponentEmoji.value = "🤖";
    opponentChatId.value = "";
    resultType.value = ""; //Clear the result status of the previous round
    pveReward.value = null;
    engine = new AuthoritativeIronFistGame();
    setupEngineListeners();
    view.value = "reconnecting";
    try {
        await engine.startPVE(false);
    } catch (error) {
        teardown();
        view.value = "lobby";
        Notify.create({ type: "negative", message: error?.response?.data?.error || "Unable to start server-authoritative PvE" });
    }
}

function startPractice() {
    mode.value = "practice";
    opponentName.value = "practice bot";
    opponentEmoji.value = "🎯";
    opponentChatId.value = "";
    resultType.value = "";
    engine = new IronFistGame({ mode: "pve" });
    beginBattle();
}

async function startPvp() {
    const startEpoch = ++pvpStartEpoch;
    // Anyone who enters through friend invitation (URL contains role=host/guest) is an entertainment friend game;
    // Those who enter through real PVP matching (query.matched=1) are pledged PVP and need to bring room_id when reporting to trigger settlement.
    const isFriend =
        route.query.role === "host" || route.query.role === "guest";
    const isRealPVP = route.query.matched === "1";
    mode.value = isFriend ? "friend" : "pvp";
    // The room_id of the real PVP (used for reporting and settlement); the friend room remains null
    // URL query is a string, but the backend RoomID *uint64 requires numbers, so it is converted and verified.
    const parsedRoomId = isRealPVP ? Number(route.query.room_id) : null;
    pvpRoomId.value = Number.isFinite(parsedRoomId) && parsedRoomId > 0
        ? parsedRoomId
        : null;
    if (isRealPVP && pvpRoomId.value == null) {
        // matched=1 but room_id is missing/illegal: cannot be settled, and should be blocked from entering the game instead of silently reporting a null value.
        // At this time, the playing view has not been entered, and the result mask is not visible, so use Notify to explicitly prompt and return to the lobby.
        // (Pledged rooms will be refunded as a draw if matched by the backend overtime).
        Notify.create({
            message: "Matching information exception（room_id Missing），Please return to the lobby and try again",
            color: "negative",
            textColor: "white",
            position: "top",
            timeout: 3500,
        });
        mode.value = "pve"; //Reset to avoid residual pvp status affecting subsequent
        pvpRoomId.value = null;
        view.value = "lobby";
        return;
    }
    opponentName.value =
        route.query.opponent_name ||
        gameStore.opponentNickname ||
        "opponent";
    opponentEmoji.value = "🥷";
    opponentChatId.value = route.query.opponent || gameStore.opponentId || "";
    resultType.value = ""; //Clear the result status of the previous round
    await nextTick();

    let gameId;
    try {
        gameId = requireAuthoritativeGameID(mode.value, route.query.game_id);
    } catch (error) {
        Notify.create({ type: "negative", message: error.message });
        view.value = "lobby";
        return;
    }
    if (pageDisposed || startEpoch !== pvpStartEpoch) return;
    engine = new AuthoritativeIronFistGame({ gameId });
    view.value = "reconnecting";
    pHP.value = INITIAL_HP;
    oHP.value = INITIAL_HP;
    pCharged.value = oCharged.value = false;
    lastResult.value = null;
    moveHistory.value = [];
    setupEngineListeners();
    try {
        await engine.resume(gameId);
    } catch (error) {
        teardown();
        view.value = "lobby";
        Notify.create({ type: "negative", message: error?.response?.data?.error || "Unable to restore authoritative match" });
    }
}

function setupEngineListeners() {
    engine.on("round-start", ({ round: r, state, startedAt }) => {
        round.value = r;
        pHP.value = state.playerHP;
        oHP.value = state.opponentHP;
        pCharged.value = state.playerCharged;
        oCharged.value = state.opponentCharged;
        myAction.value = null;
        lastResult.value = null; //Clear the settlement of the previous round to avoid revealing old tricks in the new round.
        view.value = "playing";
        startCountdown(startedAt);
    });
    engine.on("phase", (p) => {
        phase.value = p;
    });
    engine.on("locked", ({ side, action }) => {
        if (side === "player") {
            myAction.value = action;
            stopCountdown();
            // After reconnection is restored, it may fall into the locked branch (the opponent has already made a move this round).
            // You need to switch to playing and stop the reconnection countdown, otherwise the view will be stuck in reconnecting.
            if (view.value === "reconnecting") view.value = "playing";
            stopReconnectTicker();
        }
    });
    // Reconnect and replay: Use the server-side action stream to reconstruct the moveHistory of the settled round (including move statistics/accumulated damage/record details)
    engine.on("replay-history", (history) => {
        moveHistory.value = history.map((h) => ({
            round: h.round,
            player: h.playerAction,
            opponent: h.opponentAction,
            pDmg: h.playerDmg,
            oDmg: h.opponentDmg,
        }));
    });
    engine.on("resolved", (r) => {
        stopCountdown();
        // If the other party directly settles after reconnecting (_myAction exists), the reconnection countdown needs to be stopped;
        // Even if you fall on the resolved branch after reconnection and recovery, you need to switch to playing.
        stopReconnectTicker();
        if (view.value === "reconnecting") view.value = "playing";
        lastResult.value = r;
        moveHistory.value.push({
            round: round.value,
            player: r.playerAction,
            opponent: r.opponentAction,
            pDmg: r.playerDmg,
            oDmg: r.opponentDmg,
        });
        pCharged.value = r.playerCharged;
        oCharged.value = r.opponentCharged;
        // The blood deduction + avatar shake is extended to "the moment when the 3D fist hits the ground" and is triggered by the @impact callback in the combat area (onArenaImpact).
        // It is presented in the same frame as the hit special effects/floating words; there will be no impact in the round when no one loses blood, and the HP can be synchronized directly without any change.
        if (r.playerDmg <= 0 && r.opponentDmg <= 0) {
            pHP.value = r.playerHP;
            oHP.value = r.opponentHP;
        }
        clearTimeout(confirmTimer);
        // If someone falls to the ground (including a draw where both people are empty of blood), they will stay for a long time and leave enough space for the falling animation.
        const koEnd =
            !!r.gameResult &&
            (r.gameResult === "win" ||
                r.gameResult === "lose" ||
                r.gameResult === "doubleLose" ||
                r.playerHP <= 0 ||
                r.opponentHP <= 0);
        const holdMs = r.gameResult
            ? koEnd
                ? END_HOLD_KO_MS
                : END_HOLD_MS
            : ROUND_HOLD_MS;
        confirmTimer = setTimeout(() => engine?.confirmNextRound(), holdMs);
    });
    engine.on("gameover", (res) => {
        resultType.value = res;
        teardownTimers();
        stopReconnectTicker();
        if (mode.value === "pvp" || mode.value === "friend") gameStore.reset();
        // Records, achievements, rewards and wager settlement are committed by
        // the server in the same transaction as the authoritative outcome.
        fistStore.fetchAccount?.().catch(() => {});
        // Do not switch views: keep the playing view as the result mask background, and the player can see the final state of the battle
    });
    // The opponent disconnects and enters 60s to reconnect and wait for masking
    engine.on("opponent-disconnected", ({ timeoutMs }) => {
        startReconnectTicker(timeoutMs);
    });
    // After the opponent reconnects/the opponent makes the move first, the decision-making process of this round resumes. Carry startedAt to continue the countdown (not reset to 30s).
    engine.on("round-resume", ({ round: r, startedAt }) => {
        stopReconnectTicker();
        round.value = r;
        startCountdown(startedAt);
    });
}

function beginBattle() {
    view.value = "playing";
    pHP.value = INITIAL_HP;
    oHP.value = INITIAL_HP;
    pCharged.value = oCharged.value = false;
    lastResult.value = null;
    moveHistory.value = [];
    setupEngineListeners();
    engine.start();
}

// ── Operation ─────────────────────────────────────────────
function onAction(action) {
    engine?.selectAction(action);
}

// Move button: Trigger action after generating ripples at the pressed position
// Ripples are only generated when moves can be made (disabled state does not respond)
function onActionBtn(e, action) {
    const btn = e.currentTarget;
    if (btn && !btn.disabled) spawnRipple(btn, e);
    onAction(action);
}

// Ripple: Pass the click coordinates to the ::after pseudo-element through CSS custom properties to trigger the animation.
// Do not insert DOM dynamically to avoid the internal layout quirk of <button> form-control from raising the button.
function spawnRipple(btn, e) {
    const rect = btn.getBoundingClientRect();
    const x = (e.clientX ?? rect.left + rect.width / 2) - rect.left;
    const y = (e.clientY ?? rect.top + rect.height / 2) - rect.top;
    btn.style.setProperty("--ripple-x", x + "px");
    btn.style.setProperty("--ripple-y", y + "px");
    // Reset animation: remove class → force reflow → add again so that continuous clicks can be retriggered
    btn.classList.remove("rippling");
    void btn.offsetWidth;
    btn.classList.add("rippling");
    // Clean up the class after the animation ends (only hang it once to avoid accumulating listeners)
    btn.addEventListener(
        "animationend",
        () => btn.classList.remove("rippling"),
        {
            once: true,
        },
    );
}

// ── Timer ─────────────────────────────────────────────
// startedAt: DECIDING starting timestamp of this round (given by the engine, local clock). Based on this, the calculation will be continued based on the actual elapsed time.
// So that the reconnected side/opponent who moves first will not get the new 30s. By default (such as PvE), it starts after 30 seconds.
function startCountdown(startedAt) {
    stopCountdown();
    const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    countdown.value = Math.max(1, Math.ceil(ROUND_SECONDS - elapsed));
    countdownTimer = setInterval(() => {
        countdown.value -= 1;
        if (countdown.value <= 0) {
            stopCountdown();
            if (!myAction.value) engine?.selectAction("defend"); //Timeout default defense
        }
    }, 1000);
}
function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
}

// 60s reconnection waiting countdown UI (no abandonment allowed, must wait until the window is full or the other party reconnects)
function startReconnectTicker(timeoutMs = RECONNECT_WINDOW_MS) {
    stopReconnectTicker();
    reconnectCountdown.value = Math.ceil(timeoutMs / 1000);
    reconnectTicker = setInterval(() => {
        reconnectCountdown.value -= 1;
        if (reconnectCountdown.value <= 0) stopReconnectTicker();
    }, 1000);
}
function stopReconnectTicker() {
    clearInterval(reconnectTicker);
    reconnectTicker = null;
}

function teardownTimers() {
    stopCountdown();
    clearTimeout(confirmTimer);
    stopReconnectTicker();
    clearTimeout(meHitTimer);
    clearTimeout(oppHitTimer);
}

// HUD feedback when hit: If either player/opponent loses blood this round, a short jitter + red flash will be triggered.
// meHit: Our side is hit (playerDmg > 0)
// oppHit: The opponent is hit (opponentDmg > 0)
function triggerHitFeedback(meHurt, oppHurt) {
    if (meHurt) {
        meHit.value = true;
        clearTimeout(meHitTimer);
        meHitTimer = setTimeout(() => {
            meHit.value = false;
        }, 460);
    }
    if (oppHurt) {
        oppHit.value = true;
        clearTimeout(oppHitTimer);
        oppHitTimer = setTimeout(() => {
            oppHit.value = false;
        }, 460);
    }
}

// The moment when the 3D fist hits the ground is called back by @impact in the combat zone: the blood is deducted only at this moment + the avatar shakes,
// Let the HUD feedback be in the same frame as the 3D hit effects/floating characters, and no longer be in front of the punch.
function onArenaImpact(r) {
    if (!r) return;
    pHP.value = r.playerHP;
    oHP.value = r.opponentHP;
    triggerHitFeedback(r.playerDmg > 0, r.opponentDmg > 0);
}

// ── beforeunload: Do not issue game_resign when refreshing/closing the page ────────────────────────
// Under plan B, the refresh should take the reconnection path instead of admitting defeat directly:
// 1) WS disconnects → the other party grace times out → WAITING_RECONNECT (60s)
// 2) The player reopens the page → detects localStorage pending → requestReconnect → loadReplay recovery
// 3) If the connection is not reconnected within 60s → the disconnected party loses (the game must have a result)
// If resign is issued here, the Redis action log + localStorage will be cleared, resulting in the inability to reconnect, which conflicts with the design.
function handleBeforeUnload() {
    // Deliberately left blank: do not admit defeat and give the 60s reconnection window to ensure the outcome of the game.
}

function teardown() {
    teardownTimers();
    engine?.dispose();
    net?.destroy();
    engine = null;
    net = null;
}

// ──Navigation─────────────────────────────────────────────
function backToLobby() {
    teardown();
    router.replace("/games/ironfist");
    resultType.value = "";
    pveReward.value = null;
    view.value = "lobby"; //Remounting IronFistLobby will automatically refresh the balance and friends
}

function goHome() {
    router.push("/games");
}
</script>

<style scoped>
.ironfist-page {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    background: #0f0f1a;
    color: #fff;
    overflow: hidden;
}
.full-h {
    min-height: 60vh;
}

/* Opponent disconnects and reconnects to mask */
.reconnect-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
}
.reconnect-card {
    background: rgba(30, 22, 40, 0.95);
    border: 1px solid rgba(255, 160, 80, 0.35);
    border-radius: 16px;
    padding: 32px 40px;
    text-align: center;
    max-width: 320px;
}

/* Result mask: semi-transparent overlay, blurring the background but keeping the battle footage visible */
.result-overlay {
    position: absolute;
    inset: 0;
    z-index: 1500; /* Above the HUD and action bar, but below the reconnection mask */
    display: flex;
    align-items: center;
    justify-content: center;
    /* Key: background translucency + blur, players can still see the final state of the battle through it */
    background: radial-gradient(
        circle at 50% 45%,
        rgba(20, 14, 32, 0.55) 0%,
        rgba(8, 6, 16, 0.78) 70%,
        rgba(0, 0, 0, 0.88) 100%
    );
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
}
/* Add a layer of color to the mask according to the victory or defeat (victory is more golden, failure is redder, and draw is more purple) */
.result-overlay--win {
    background: radial-gradient(
        circle at 50% 45%,
        rgba(255, 200, 60, 0.18),
        rgba(0, 0, 0, 0.85)
    );
}
.result-overlay--lose {
    background: radial-gradient(
        circle at 50% 45%,
        rgba(255, 60, 60, 0.22),
        rgba(0, 0, 0, 0.88)
    );
}
.result-overlay--draw {
    background: radial-gradient(
        circle at 50% 45%,
        rgba(150, 120, 255, 0.18),
        rgba(0, 0, 0, 0.85)
    );
}
.result-overlay--doubleLose {
    background: radial-gradient(
        circle at 50% 45%,
        rgba(255, 120, 60, 0.22),
        rgba(0, 0, 0, 0.88)
    );
}
.result-overlay--aborted {
    background: radial-gradient(
        circle at 50% 45%,
        rgba(120, 120, 120, 0.18),
        rgba(0, 0, 0, 0.85)
    );
}

/* Centered card: no strong background, rely on emoji + large characters + buttons to let the background image shine through */
.result-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 28px 36px;
    text-align: center;
    /* The card itself is light and transparent + stroked to avoid blurring with the background */
    background: rgba(20, 16, 32, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 20px;
    box-shadow:
        0 12px 40px rgba(0, 0, 0, 0.5),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(2px);
    max-width: 90vw;
}
.result-emoji {
    font-size: 88px;
    line-height: 1;
    filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.6));
    animation: resultEmojiPop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.result-title {
    font-size: 34px;
    font-weight: 900;
    letter-spacing: 2px;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
    animation: resultTitleIn 0.5s 0.1s both cubic-bezier(0.4, 0, 0.2, 1);
}
.result-overlay--win .result-title {
    color: #ffd76a;
}
.result-overlay--lose .result-title {
    color: #ff7a7a;
}
.result-overlay--draw .result-title {
    color: #c5b3ff;
}
.result-overlay--doubleLose .result-title {
    color: #ff9a52;
}
.result-overlay--aborted .result-title {
    color: #b6b6b6;
}
.result-sub {
    font-size: 13px;
    color: #9e9aae;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    animation: resultTitleIn 0.5s 0.18s both;
}
.result-btn {
    animation: resultTitleIn 0.5s 0.26s both;
}

/* PvE victory reward tips (inside the results card) */
.pve-reward-badge {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    margin: 10px 0 14px;
    padding: 8px 20px;
    border-radius: 10px;
    background: rgba(255, 160, 0, 0.15);
    border: 1px solid rgba(255, 160, 0, 0.4);
    animation: resultTitleIn 0.4s 0.1s both;
}
.pve-reward-amount {
    font-size: 20px;
    font-weight: 800;
    color: #ffb300;
    letter-spacing: 0.04em;
}
.pve-reward-progress {
    font-size: 11px;
    color: rgba(255, 179, 0, 0.7);
}
/* Daily attendance extra reward badge */
.pve-bonus-badge {
    margin: -6px 0 14px;
    padding: 7px 18px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 800;
    color: #fff;
    background: linear-gradient(135deg, #ff8a3d, #ff4d8d);
    box-shadow: 0 4px 16px rgba(255, 77, 141, 0.45);
    animation: resultEmojiPop 0.55s 0.2s both;
}

/* Entry: fade in + slight rise */
.result-fade-enter-active {
    transition:
        opacity 0.45s ease,
        backdrop-filter 0.45s ease;
}
.result-fade-leave-active {
    transition: opacity 0.25s ease;
}
.result-fade-enter-from {
    opacity: 0;
}
.result-fade-leave-to {
    opacity: 0;
}

@keyframes resultEmojiPop {
    0% {
        transform: scale(0.2) rotate(-12deg);
        opacity: 0;
    }
    60% {
        transform: scale(1.15) rotate(4deg);
    }
    100% {
        transform: scale(1) rotate(0);
        opacity: 1;
    }
}
@keyframes resultTitleIn {
    0% {
        transform: translateY(14px);
        opacity: 0;
    }
    100% {
        transform: translateY(0);
        opacity: 1;
    }
}

/* Battle layout */
.battle {
    position: relative; /* Result mask/reconnect mask positioning reference */
    display: flex;
    flex-direction: column;
    height: 100dvh;
    padding: 8px 10px 10px;
    gap: 8px;
}

/* ===== Top Battle HUD ===== */
/* Outer layer = glowing gradient stroke (blue → purple → red), exposed with 2px padding as the border;
   Cut corners clip-path Cornered panels that create a sense of technology in the design draft。 */
.match-hud {
    padding: 2px;
    border-radius: 16px;
    background: linear-gradient(
        110deg,
        #4d8cff 0%,
        #6a4fc0 42%,
        #8a3f9a 58%,
        #ff5a5a 100%
    );
    /* clip-path will cut off the box-shadow, so use drop-shadow (fit the corner outline and render outside the clipping) to emit light. */
    filter: drop-shadow(0 0 9px rgba(77, 140, 255, 0.4))
        drop-shadow(0 0 9px rgba(255, 90, 90, 0.35))
        drop-shadow(0 5px 12px rgba(0, 0, 0, 0.5));
    clip-path: polygon(
        16px 0,
        calc(100% - 16px) 0,
        100% 16px,
        100% calc(100% - 14px),
        calc(100% - 16px) 100%,
        16px 100%,
        0 calc(100% - 14px),
        0 16px
    );
}
/* Inner layer = dark panel + dot matrix texture + left and right blue/red cool and warm glow, slightly retracted corners in the same direction */
.mh-grid {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: start;
    gap: 12px;
    padding: 12px 14px 10px;
    border-radius: 14px;
    background:
        radial-gradient(
            130% 100% at 0% 0%,
            rgba(60, 110, 255, 0.2),
            transparent 52%
        ),
        radial-gradient(
            130% 100% at 100% 0%,
            rgba(255, 70, 70, 0.18),
            transparent 52%
        ),
        radial-gradient(rgba(255, 255, 255, 0.045) 1px, transparent 1.6px) 0 0 /
            14px 14px,
        linear-gradient(180deg, rgba(22, 19, 44, 0.97), rgba(10, 8, 22, 0.97));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    clip-path: polygon(
        15px 0,
        calc(100% - 15px) 0,
        100% 15px,
        100% calc(100% - 13px),
        calc(100% - 15px) 100%,
        15px 100%,
        0 calc(100% - 13px),
        0 15px
    );
}
/* Each side: avatar + name line → full width health bar → move statistics */
.mh-player {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    position: relative;
    border-radius: 12px;
    padding: 2px;
    transition: box-shadow 0.18s;
}
/* Hit feedback: dither + red stroke halo (does not change layout size, avoid dithering other columns) */
.mh-player--hit {
    animation: mhHitShake 0.44s cubic-bezier(0.36, 0.07, 0.19, 0.97);
    box-shadow:
        0 0 0 1.5px rgba(255, 82, 82, 0.9),
        0 0 18px rgba(255, 60, 60, 0.55),
        inset 0 0 24px rgba(255, 40, 40, 0.35);
}
@keyframes mhHitShake {
    0%,
    100% {
        transform: translate3d(0, 0, 0);
    }
    15% {
        transform: translate3d(-5px, 1px, 0);
    }
    30% {
        transform: translate3d(5px, -1px, 0);
    }
    45% {
        transform: translate3d(-4px, 0, 0);
    }
    60% {
        transform: translate3d(3px, 1px, 0);
    }
    75% {
        transform: translate3d(-2px, 0, 0);
    }
    90% {
        transform: translate3d(1px, 0, 0);
    }
}
.mh-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.mh-player--opp .mh-head {
    flex-direction: row-reverse;
}
.mh-id {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
}
.mh-id--right {
    align-items: flex-end;
}

/* avatar */
.mh-avatar-img {
    border-radius: 50%;
    object-fit: cover;
    pointer-events: none;
}
.mh-avatar {
    position: relative;
    flex: 0 0 auto;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 30px;
    line-height: 1;
    background: radial-gradient(
        circle at 50% 32%,
        rgba(255, 255, 255, 0.16),
        rgba(0, 0, 0, 0.35)
    );
}
/* The outer technology dotted line ring (the stroked circle outside the avatar of the design draft) */
.mh-avatar::before {
    content: "";
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    border: 1px dashed rgba(255, 255, 255, 0.28);
    pointer-events: none;
}
/* The upper and lower solid arcs echo the highlighted gap on the design draft ring. */
.mh-avatar::after {
    content: "";
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    border: 2px solid transparent;
    pointer-events: none;
}
.mh-avatar--me {
    border: 3px solid #5b8cff;
    box-shadow:
        0 0 12px rgba(91, 140, 255, 0.7),
        inset 0 0 8px rgba(91, 140, 255, 0.35);
}
.mh-avatar--opp {
    border: 3px solid #ff5a5a;
    box-shadow:
        0 0 12px rgba(255, 90, 90, 0.7),
        inset 0 0 8px rgba(255, 90, 90, 0.35);
}
.mh-avatar--me::before {
    border-color: rgba(91, 140, 255, 0.55);
}
.mh-avatar--opp::before {
    border-color: rgba(255, 90, 90, 0.55);
}
.mh-avatar--me::after {
    border-top-color: #7aa8ff;
    border-bottom-color: #7aa8ff;
    filter: drop-shadow(0 0 4px rgba(91, 140, 255, 0.8));
}
.mh-avatar--opp::after {
    border-top-color: #ff8a8a;
    border-bottom-color: #ff8a8a;
    filter: drop-shadow(0 0 4px rgba(255, 90, 90, 0.8));
}
/* Full circle highlight pulse when charging */
.mh-avatar.charged::after {
    animation: blink 1.1s ease-in-out infinite;
}

.mh-name {
    font-size: 13px;
    font-weight: 800;
    line-height: 1.15;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
.mh-id--right .mh-name {
    text-align: right;
    width: 100%;
}
.mh-score {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 12px;
    font-weight: 800;
    color: #ffd76a;
}
.mh-score-ic {
    font-size: 12px;
}

/* Health bar row: heart icon + health bar (mirror on opponent's side) */
.mh-hpbar {
    display: flex;
    align-items: center;
    gap: 7px;
}
.mh-hpbar :deep(.hb-row) {
    flex: 1;
    min-width: 0;
}
.mh-heart {
    flex: 0 0 auto;
    font-size: 15px;
    line-height: 1;
}
.mh-heart--me {
    color: #5b8cff;
    filter: drop-shadow(0 0 5px rgba(91, 140, 255, 0.85));
}
.mh-heart--opp {
    color: #ff5a5a;
    filter: drop-shadow(0 0 5px rgba(255, 90, 90, 0.85));
}

.mh-tally {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}
.mh-tally--right {
    justify-content: flex-end;
}
.tally {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    font-size: 10px;
    font-weight: 700;
    color: #cfc8e6;
    background: rgba(255, 255, 255, 0.07);
    border-radius: 6px;
    padding: 0 4px;
}
.tally-ic {
    font-size: 11px;
}

/* Center: Round + Ring Countdown */
.mh-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 0 2px;
}
/* ROUND logo: hexagonal cutaway + blue/red accents on both sides (top sign of design draft) */
.mh-round-bar {
    display: flex;
    align-items: center;
    gap: 7px;
}
.mh-round {
    font-size: 12px;
    font-weight: 900;
    letter-spacing: 1px;
    white-space: nowrap;
    color: #eaf0ff;
    padding: 3px 13px;
    background: linear-gradient(
        180deg,
        rgba(42, 48, 92, 0.92),
        rgba(20, 22, 48, 0.92)
    );
    border: 1px solid rgba(140, 160, 255, 0.4);
    clip-path: polygon(
        9px 0,
        calc(100% - 9px) 0,
        100% 50%,
        calc(100% - 9px) 100%,
        9px 100%,
        0 50%
    );
    text-shadow: 0 0 8px rgba(120, 150, 255, 0.6);
}
.mh-round-tick {
    position: relative;
    width: 16px;
    height: 2px;
    border-radius: 2px;
    flex: 0 0 auto;
}
.mh-round-tick--me {
    background: linear-gradient(90deg, transparent, #4d8cff);
}
.mh-round-tick--opp {
    background: linear-gradient(90deg, #ff5a5a, transparent);
}
.mh-round-tick::after {
    content: "";
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 3px;
    border-radius: 50%;
}
.mh-round-tick--me::after {
    right: -6px;
    background: #4d8cff;
    box-shadow: 0 0 5px #4d8cff;
}
.mh-round-tick--opp::after {
    left: -6px;
    background: #ff5a5a;
    box-shadow: 0 0 5px #ff5a5a;
}

.cd-ring {
    position: relative;
    width: 78px;
    height: 78px;
    display: grid;
    place-items: center;
    border-radius: 50%;
}
/* Scale outside the ring: fine dotted circle, mask into a thin ring (tick scale outside the design draft ring) */
.cd-ring::before {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    background: repeating-conic-gradient(
        rgba(170, 190, 255, 0.22) 0deg 1.2deg,
        transparent 1.2deg 6deg
    );
    -webkit-mask: radial-gradient(transparent 60%, #000 61%);
    mask: radial-gradient(transparent 60%, #000 61%);
    pointer-events: none;
}
.cd-ring--danger {
    animation: blink 0.7s infinite;
}
.cd-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /* Rotate -90deg so that the stroke start point is at the top 12 o'clock position */
    transform: rotate(-90deg);
}
.cd-track-circle {
    fill: none;
    stroke: rgba(150, 120, 255, 0.18);
    stroke-width: 4;
}
.cd-progress-circle {
    fill: none;
    stroke: #e7e0ff;
    stroke-width: 4;
    stroke-linecap: round;
    /* Smooth stroke transition */
    transition:
        stroke-dashoffset 0.95s linear,
        stroke 0.2s;
}
/* The three-stage stroke color of the countdown: strictly aligned with the three-stage blood color of the HealthBar (take the starting color of the gradient of the health bar) */
.cd-progress-circle--safe {
    stroke: #43e97b;
} /* Health (green) > 60% */
.cd-progress-circle--warn {
    stroke: #ffce4d;
} /* Warning (orange) 30~60% */
.cd-progress-circle--danger {
    stroke: #ff5b5b;
} /* Danger (red) ≤ 30% */
.cd-inner {
    position: relative;
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 35%, #1c1730, #0c0918);
    box-shadow:
        inset 0 0 12px rgba(0, 0, 0, 0.7),
        inset 0 0 0 1px rgba(255, 255, 255, 0.06);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0;
    z-index: 1;
}
.cd-num {
    font-size: 30px;
    font-weight: 900;
    line-height: 1;
    letter-spacing: -1px;
    text-shadow: 0 0 10px rgba(120, 150, 255, 0.4);
}
.cd-unit {
    font-size: 10px;
    font-weight: 700;
    color: #b39ddb;
    line-height: 1;
    margin-top: 2px;
}
.cd-glyph {
    font-size: 26px;
}

/* Status bar: capsule + blue/red breathing points on both sides ("Preparing to move" at the bottom of the design draft) */
.mh-status-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 2px 10px;
    border-radius: 11px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
}
.mh-status {
    font-size: 10px;
    color: #9a92b8;
    white-space: nowrap;
}
.mh-status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex: 0 0 auto;
}
.mh-status-dot--me {
    background: #4d8cff;
    box-shadow: 0 0 6px #4d8cff;
    animation: blink 1.4s infinite;
}
.mh-status-dot--opp {
    background: #ff5a5a;
    box-shadow: 0 0 6px #ff5a5a;
    animation: blink 1.4s infinite 0.7s;
}

.arena-slot {
    position: relative;
    flex: 1;
    min-height: 180px;
}

/* ===== Move reveal line (floating layer: absolutely positioned at the bottom of the combat area, does not occupy the layout/does not jitter) ===== */
.reveal-wrap {
    position: absolute;
    left: 0px;
    right: 0px;
    bottom: 2px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    pointer-events: none;
}
.reveal {
    position: relative;
    width: 100%;
    max-width: 530px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    /* padding: 9px 14px; border-radius: 16px; */
    /* background: linear-gradient(180deg, #1a1f3e, #0c1024);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6); */
    background: url(./assets/result.png) no-repeat center/contain;
    height: 120px;
}
/* Blue→Red glowing gradient stroke (fits the design draft) */
/* .reveal::before {
  content: ''; position: absolute; inset: -2px; border-radius: 18px; z-index: -1;
  background: linear-gradient(90deg, #4d8cff 0%, #8a5cff 50%, #ff5a5a 100%);
  filter: blur(3px); opacity: 0.85;
} */
.rv-side {
    flex: 1;
    min-width: 0;
    text-align: center;
}
.rv-side--me {
    /* 60px at max-width(530px) ≈ 11.5%; narrow screen shrinks proportionally, minimum 8px */
    /* padding: 10px min(60px, 11.5%) 0 min(60px, 11.5%); */
        padding-right: 7%;
    padding-top: 8px;
}
.rv-side--opp {
    /* 60px at max-width(530px) ≈ 11.5%; narrow screen shrinks proportionally, minimum 8px */
    /* padding: 10px min(60px, 11.5%) 0 min(60px, 11.5%); */
        padding-left: 7%;
    padding-top: 8px;
}
.rv-move {
    /* Maximum 24px, narrow screen by pressing vw to reduce, minimum 13px */
    font-size: clamp(14px, 4.5vw, 26px);
    font-weight: 900;
    color: #fff;
    text-align: center;
    white-space: nowrap;
}
.rv-move--wait {
    background: rgba(255, 255, 255, 0.08) !important;
    color: #9a93b8 !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
    animation: blink 1s infinite;
}
.rv-ic {
    font-size: clamp(13px, 4.5vw, 24px);
    margin-right: clamp(4px, 2vw, 10px);
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
}
/* .rv-vs {
  font-size: 28px; font-weight: 900; font-style: italic; color: #fff;
  text-shadow: 0 0 8px rgba(90, 140, 255, 0.9), 0 0 16px rgba(255, 80, 80, 0.7), 0 2px 3px rgba(0, 0, 0, 0.6);
} */
.reveal-verdict {
    font-size: clamp(11px, 3.2vw, 13px);
    font-weight: 800;
    text-align: center;
    padding: 3px 14px;
    border-radius: 10px;
    background: rgba(12, 14, 30, 0.92);
    margin-bottom: -10px;
    white-space: nowrap;
}
.rvv--good {
    color: #6ee7a0;
    box-shadow: 0 0 0 1px rgba(76, 175, 80, 0.45);
}
.rvv--bad {
    color: #ff7a7a;
    box-shadow: 0 0 0 1px rgba(255, 82, 82, 0.45);
}
.rvv--neutral {
    color: #cfc8e6;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.15);
}

/* The floating layer fades in and out (floating slightly to avoid being abrupt) */
.reveal-fade-enter-active,
.reveal-fade-leave-active {
    transition:
        opacity 0.25s ease,
        transform 0.25s ease;
}
.reveal-fade-enter-from,
.reveal-fade-leave-to {
    opacity: 0;
    transform: translateY(12px);
}

/* ===== Action Buttons ===== */
.hud-action {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
}

/* The entire card is color gradient + three-dimensional highlight/bottom (consistent with the design draft) */
.act-btn {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 6px 4px;
    border: none;
    border-radius: 10px;
    color: #fff;
    cursor: pointer;
    /* Note: If you don’t add overflow:hidden to the button, the form-control internal layout quirk will be triggered to raise the button.
     ripple instead ::after Pseudo element + clip-path Limit range。 */
    --ripple-x: 50%;
    --ripple-y: 50%;
    box-shadow:
        inset 0 -2px 0 rgba(255, 255, 255, 0.4),
        inset 0 -3px 6px rgba(0, 0, 0, 0.28),
        0 4px 0 rgba(0, 0, 0, 0.35),
        0 6px 12px rgba(0, 0, 0, 0.4);
    transition:
        transform 0.1s,
        box-shadow 0.1s,
        filter 0.15s;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.28);
}
/* Ripple: Use pseudo elements to draw a white translucent circle that spreads from the click point and fades out.
   Pass clip-path Constrained to the button's rounded rectangle（substitute overflow:hidden）。 */
.act-btn::after {
    content: "";
    position: absolute;
    left: var(--ripple-x);
    top: var(--ripple-y);
    width: 12px;
    height: 12px;
    margin: -6px 0 0 -6px; /* Let left/top represent the center of the ripple circle */
    border-radius: 50%;
    background: radial-gradient(
        circle,
        rgba(255, 255, 255, 0.55) 0%,
        rgba(255, 255, 255, 0.15) 50%,
        rgba(255, 255, 255, 0) 70%
    );
    transform: scale(0);
    opacity: 0;
    pointer-events: none;
    clip-path: inset(0 round 10px);
    z-index: 0;
}
.act-btn.rippling::after {
    animation: actRipple 0.55s cubic-bezier(0.2, 0.6, 0.4, 1);
}
@keyframes actRipple {
    0% {
        transform: scale(0);
        opacity: 1;
    }
    60% {
        opacity: 0.55;
    }
    100% {
        transform: scale(40);
        opacity: 0;
    }
}
/* .act-btn--attack  { background: linear-gradient(180deg, #ff7d6e 0%, #d2382a 100%); }
.act-btn--defend  { background: linear-gradient(180deg, #5cb6ff 0%, #2867bd 100%); }
.act-btn--charge  { background: linear-gradient(180deg, #ffcb52 0%, #e07c0a 100%); }
.act-btn--counter { background: linear-gradient(180deg, #b692ff 0%, #7a32e0 100%); } */

.act-btn:not(:disabled):active {
    transform: translateY(3px);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.35),
        inset 0 -2px 4px rgba(0, 0, 0, 0.28),
        0 1px 0 rgba(0, 0, 0, 0.35),
        0 2px 6px rgba(0, 0, 0, 0.4);
}
.act-btn:disabled {
    cursor: default;
}
.act-btn.dim {
    filter: saturate(0.7) brightness(0.62);
    opacity: 0.85;
}
.act-btn.selected {
    filter: none;
    opacity: 1;
    box-shadow:
        0 0 0 3px #ffd54f,
        inset 0 1px 0 rgba(255, 255, 255, 0.4),
        0 4px 0 rgba(0, 0, 0, 0.35),
        0 6px 14px rgba(0, 0, 0, 0.55);
}

/* The icon is placed in a semi-transparent dark inline frame */
.act-frame {
    /* width: 52px; */
    /* height: 52px; */
    display: flex;
    align-items: center;
    justify-content: center;
}
.act-icon {
    font-size: 32px;
    line-height: 1;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
}
.act-name {
    font-weight: 900;
    font-size: 15px;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
}
.act-hint {
    font-size: 10px;
    opacity: 0.92;
    line-height: 1.1;
    text-align: center;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.4);
}

@keyframes blink {
    50% {
        opacity: 0.3;
    }
}
</style>
