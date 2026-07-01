<template>
    <q-page class="ironfist-page">
        <!-- ── 大厅与子视图（菜单已拆分为独立组件） ──────────── -->
        <IronFistLobby
            v-if="view === 'lobby'"
            @home="goHome"
            @open-ledger="view = 'ledger'"
            @open-records="view = 'records'"
            @open-achievements="view = 'achievements'"
            @start-pve="startPve"
            @open-pvp="view = 'pvp'"
            @invite="startInvite"
        />
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

        <!-- ── 邀请中 ───────────────────────────────────────── -->
        <div
            v-else-if="view === 'inviting'"
            class="flex flex-center column full-h q-gutter-md q-pa-xl"
        >
            <q-spinner-dots color="purple" size="64px" />
            <div class="text-h6">等待对方接受…</div>
            <div class="text-caption text-grey-5">
                {{ gameStore.opponentNickname }}
            </div>
            <q-btn
                flat
                color="negative"
                label="取消邀请"
                @click="gameStore.cancelInvite()"
            />
        </div>

        <!-- ── 重连中（页面刷新后重入） ─────────────────────── -->
        <div
            v-else-if="view === 'reconnecting'"
            class="flex flex-center column full-h q-gutter-md q-pa-xl"
        >
            <q-spinner-dots color="deep-orange" size="64px" />
            <div class="text-h6">正在重连对局…</div>
            <div class="text-caption text-grey-5">正在从服务器恢复对局进度</div>
        </div>

        <!-- ── 对战 ─────────────────────────────────────────── -->
        <div v-else-if="view === 'playing'" class="battle">
            <!-- ===== 顶部对战 HUD：我方 | 回合+环形倒计时 | 对手 ===== -->
            <div class="match-hud">
                <div class="mh-grid">
                    <!-- 我方 -->
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

                    <!-- 中央：回合数 + 环形倒计时（SVG 描边动画） -->
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
              SVG 圆环：viewBox 64x64，r=28，周长 ≈ 175.93。
              stroke-dashoffset 按剩余比例从 0 → 周长 平滑收缩。
              优势：可做平滑描边过渡、内发光 filter，比 conic-gradient 更精致。
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
                                <!-- 背景圈（淡） -->
                                <circle
                                    cx="32"
                                    cy="32"
                                    r="28"
                                    class="cd-track-circle"
                                />
                                <!-- 进度圈 -->
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
                                    <!-- <span class="cd-unit">秒</span> -->
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

                    <!-- 对手 -->
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

            <!-- 3D 战斗区（出招揭示行作为浮层叠在底部，不占布局、不抖动） -->
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

            <!-- ===== 操作按钮（常驻；非决策态禁用） ===== -->
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

            <!-- ===== 对手掉线重连遮罩（60s 等待，不允许放弃） ===== -->
            <div v-if="isWaitingReconnect" class="reconnect-overlay">
                <div class="reconnect-card">
                    <q-spinner-dots color="deep-orange" size="56px" />
                    <div class="text-h6 q-mt-md">对手网络波动</div>
                    <div class="text-caption text-grey-5 q-mt-xs">
                        等待对手重连 · 剩余 {{ reconnectCountdown }}s
                    </div>
                    <div class="text-caption text-grey-6 q-mt-md">
                        对局必须分出胜负，请耐心等待
                    </div>
                </div>
            </div>

            <!-- ===== 结果遮罩：透明叠加在游戏界面上，背景仍是战斗画面 ===== -->
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
                        <!-- PvE 胜利 $FIST 奖励 -->
                        <div v-if="pveReward" class="pve-reward-badge">
                            <span class="pve-reward-amount">+500 {{ currency }}</span>
                            <span class="pve-reward-progress">
                                今日 {{ pveReward.todayWins }} /
                                {{ pveReward.todayMax }} 场
                            </span>
                        </div>
                        <!-- 每日满 10 场额外奖励 -->
                        <div
                            v-if="pveReward && pveReward.bonusAwarded"
                            class="pve-bonus-badge"
                        >
                            🎉 每日满勤奖励 +{{
                                pveReward.bonusAmount.toLocaleString()
                            }}
                            {{ currency }}
                        </div>
                        <q-btn
                            color="purple"
                            label="返回大厅"
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
import { ironfistApi } from "src/services/api";
import { ACHIEVEMENT_MAP } from "./game/ironfistMeta";
import IronFistLobby from "./components/IronFistLobby.vue";
import IronFistLedger from "./components/IronFistLedger.vue";
import IronFistRecords from "./components/IronFistRecords.vue";
import IronFistAchievements from "./components/IronFistAchievements.vue";
import IronFistPvpLobby from "./components/IronFistPvpLobby.vue";
import HealthBar from "./components/HealthBar.vue";
import DeterministicAvatar from "src/components/DeterministicAvatar.vue";
import { useRegion } from "./game/useRegion.js";
// 三期：Babylon.js 3D 渲染层（方案B）。props 接口与一/二期一致，可一行回退。
// 一期 BattleArena.vue(2D-CSS) / 二期 BattleArenaPhaser.vue 仍保留备用。
import BattleArena from "./components/BattleArena3D.vue";
import { IronFistGame } from "./game/IronFistGame.js";
import { GameNet } from "./game/GameNet.js";
import {
    ACTION_META,
    ACTIONS,
    ROUND_SECONDS,
    INITIAL_HP,
    LS_PENDING_KEY,
    RECONNECT_WINDOW_MS,
} from "./game/GameConstants.js";

defineOptions({ name: "IronFistPage" });

// 结算后停留时长（ms）：展示揭示行+伤害后自动进入下一回合 / 终局进结果页。
const ROUND_HOLD_MS = 2200;
const END_HOLD_MS = 3200; // 判定平局（超时双方仍有血、非倒地终局）：留足"对峙判和"演出(起手≈1.1s + TIME OVER 横幅≈1.9s)
const END_HOLD_KO_MS = 3900; // 倒地终局：留足 ko 动画(接触点≈1.1s + ko≈2.6s)播完

const route = useRoute();
const router = useRouter();
const gameStore = useGameStore();
const identityStore = useIdentityStore();
const fistStore = useFistStore();
const { currency } = useRegion();

// 我方昵称（无昵称时回退到 chatId，再回退到「你」）+ 头像
const myName = computed(
    () => identityStore.nickname || identityStore.chatId || "你",
);
const myEmoji = "🤖";

const actionMeta = ACTION_META;
const actionList = ACTIONS.map((k) => ({ key: k, ...ACTION_META[k] }));

const view = ref("lobby");
const mode = ref("pve");

// 对战状态镜像
const round = ref(0);
const phase = ref("round_start");
const countdown = ref(ROUND_SECONDS);
const pHP = ref(INITIAL_HP);
const oHP = ref(INITIAL_HP);
const pCharged = ref(false);
const oCharged = ref(false);
const myAction = ref(null);
const lastResult = ref(null);
const moveHistory = ref([]); // 每回合出招记录 { round, player, opponent, pDmg, oDmg }
// 受击瞬间红闪+抖动（受击后短时高亮对应 HUD 列）
const meHit = ref(false);
const oppHit = ref(false);
let meHitTimer = null;
let oppHitTimer = null;
const opponentName = ref("对手");
const opponentEmoji = ref("🤖");
const opponentChatId = ref("");

const resultType = ref("");
const errorMsg = ref(""); // resultType==="error" 时的具体提示文案
const pveReward = ref(null); // PvE 胜利时由 claimPvEReward 填充，结果页展示奖励
const pvpRoomId = ref(null); // 真实 PVP 撮合房间号（仅 mode=pvp & query.matched=1 时填充）

// PvP 重连相关
const reconnectCountdown = ref(0); // 剩余重连等待秒数
let reconnectTicker = null;

let engine = null;
let net = null;
let countdownTimer = null;
let confirmTimer = null;

// ── 计算属性 ──────────────────────────────────────────────
// 回合胜负判语（从玩家视角给出明确结论 + 配色）
const roundVerdict = computed(() => {
    const r = lastResult.value;
    if (!r) return { text: "", tone: "neutral" };
    const { playerDmg: p, opponentDmg: o } = r;
    if (p === 0 && o === 0)
        return { text: "势均力敌 · 无人受伤", tone: "neutral" };
    if (o > 0 && p === 0) return { text: "✅ 你压制了对手", tone: "good" };
    if (p > 0 && o === 0) return { text: "⚠ 你被对手压制", tone: "bad" };
    if (o > p) return { text: "你略占上风", tone: "good" };
    if (p > o) return { text: "你处于下风", tone: "bad" };
    return { text: "两败俱伤", tone: "neutral" };
});

// 出招统计（各动作累计使用次数，只显示用过的）
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

// 累计输出（本局造成的总伤害，对应参考图头像旁的 ⚔ 数值）
const myDamage = computed(() =>
    moveHistory.value.reduce((s, m) => s + (m.oDmg || 0), 0),
);
const oppDamage = computed(() =>
    moveHistory.value.reduce((s, m) => s + (m.pDmg || 0), 0),
);

// 环形倒计时（SVG stroke-dashoffset）
//   周长 = 2πr ≈ 175.93（r=28）
//   决策态：按剩余比例从满圈收缩到 0
//   非决策态：保持完整一圈静态显示
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
        // ratio=1（满时）offset=0；ratio=0（耗尽）offset=周长 → 圆环消失
        strokeDashoffset: CD_CIRCUMFERENCE * (1 - ratio),
        // 颜色由 cdStage class 控制，这里只控几何
    };
});
// 倒计时颜色阶段：与 HealthBar 三段血色严格对齐（按剩余比例划分）
//   safe(绿)  ratio > 0.6   对应血量 > 60
//   warn(橙)  0.3 < ratio ≤ 0.6  对应血量 30~60
//   danger(红) ratio ≤ 0.3   对应血量 ≤ 30
// 仅决策态生效；非决策态返回空串（无 class，使用默认描边色）
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
            return myAction.value ? "已出招" : "出招准备中";
        case "locked":
            return "等待对手";
        case "resolving":
            return "结算中";
        case "waiting_confirm":
            return "回合结算";
        case "waiting_reconnect":
            return "对手重连中";
        default:
            return "";
    }
});
// 是否处于对手掉线等待重连遮罩态
const isWaitingReconnect = computed(() => phase.value === "waiting_reconnect");
const canAct = computed(() => phase.value === "deciding" && !myAction.value);

// 出招揭示：决策/锁定阶段亮我方招 + 对手「？」；结算阶段双方亮明
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
    win: ["🏆", "胜利！"],
    lose: ["💀", "失败…"],
    draw: ["🤝", "平局"],
    doubleLose: ["💥", "双双力竭"],
    aborted: ["📡", "对战中断"],
    error: ["⚠️", "发生错误"],
};
const resultEmoji = computed(
    () => (RESULT_MAP[resultType.value] || ["🎮", ""])[0],
);
const resultText = computed(
    () => (RESULT_MAP[resultType.value] || ["", "游戏结束"])[1],
);
const resultSub = computed(() => {
    if (resultType.value === "aborted") return "对手长时间未响应，可能已掉线";
    if (resultType.value === "error") return errorMsg.value;
    return "";
});

// ── 生命周期 ──────────────────────────────────────────────
onMounted(() => {
    window.addEventListener("beforeunload", handleBeforeUnload);
    const role = route.query.role;
    const matched = route.query.matched;
    // 通过好友邀请进入（host/guest）或真实 PVP 撮合成功（matched=1）直接开战；
    // 否则停在大厅，由 IronFistLobby 组件自行拉取余额与好友列表。
    if (role === "host" || role === "guest" || matched === "1") {
        startPvp();
    }
});

onUnmounted(() => {
    window.removeEventListener("beforeunload", handleBeforeUnload);
    teardown();
});

watch(
    () => gameStore.state,
    (s) => {
        if (s === "idle" && view.value === "inviting") view.value = "lobby";
    },
);

// 已在本页（大厅或邀请中）时被接受/接收到对方接受而进入对战：
// 同路径仅 query 变化不会重新挂载组件，onMounted 不会再次触发，需手动开战。
watch(
    () => [route.query.role, route.query.matched],
    ([role, matched]) => {
        if (view.value === "playing") return;
        if (role === "host" || role === "guest" || matched === "1") {
            startPvp();
        }
    },
);

// ── 好友邀请（由大厅组件 @invite 触发） ──────────────────────
function startInvite(friend) {
    gameStore.invite(
        friend.chat_id,
        friend.nickname || friend.chat_id,
        "ironfist",
    );
    view.value = "inviting";
}

// 真实 PVP 撮合成功（IronFistPvpLobby @matched 触发）：
// 切换 query 触发 startPvp 重新执行，携带 room_id / 对手信息。
function onPVPMatched({ roomId, opponent, tier, stake }) {
    const query = {
        matched: "1",
        room_id: String(roomId),
        opponent: opponent?.chat_id,
        opponent_name: opponent?.nickname || opponent?.chat_id || "对手",
        tier,
        stake: String(stake ?? 0),
    };
    router.replace({ query });
    // view 切换由 query.matched 的 watcher 驱动；这里直接触发 startPvp 也可。
    // 同路径 router.replace 不会重新挂载，仍由 query watcher 捕获并开战。
}

// 对战结束后上报战绩与逐局明细。res 为 gameover 结果（win/lose/draw/doubleLose）
async function reportMatchResult(res) {
    try {
        const summary = engine?.getMatchSummary() ?? {
            playerHP: pHP.value,
            counterSuccesses: 0,
            rounds: 0,
        };
        // 好友/人机：未实际开打（0 回合，对手开局即离开导致超时判胜）不记录，
        // 避免出现"0 回合 · 胜利"这类无意义战绩。真实 PVP（带 room_id）必须照常上报，
        // 由后端结算与双上报仲裁兜底（双方都弃局会被仲裁为平局并退款）。
        if (!pvpRoomId.value && summary.rounds === 0) {
            return;
        }
        // 逐局明细：从 moveHistory 压成紧凑 JSON 数组
        const detail = moveHistory.value.map((m) => ({
            r: m.round,
            p: m.player,
            o: m.opponent,
            pd: m.pDmg,
            od: m.oDmg,
        }));
        const { data } = await ironfistApi.reportMatch({
            mode: mode.value,
            result: res,
            player_hp: summary.playerHP,
            opponent_hp: oHP.value,
            counter_successes: summary.counterSuccesses,
            rounds: summary.rounds,
            opponent_name: opponentName.value,
            detail,
            // 真实 PVP 携带 room_id，触发后端质押结算（幂等）
            room_id: pvpRoomId.value ?? undefined,
        });
        // 新解锁成就弹层提示
        const newly = data.new_achievements ?? [];
        newly.forEach((code) => {
            const meta = ACHIEVEMENT_MAP[code];
            Notify.create({
                message: `🏆 解锁成就：${meta?.name ?? code}`,
                caption: meta?.desc,
                color: "amber-9",
                textColor: "white",
                position: "top",
                timeout: 3000,
            });
        });
        // 真实 PVP 结算结果展示。双上报仲裁下，先上报方拿到的是 pending（无金额），
        // 后上报方才触发结算拿到金额。为让双方都看到一致的最终结果，pending 时轮询补齐。
        if (data.pvp_settle) {
            const s = data.pvp_settle;
            if (s.settled) {
                showPvpSettle(s, res);
            } else if (s.pending && pvpRoomId.value) {
                pollPvpSettle(pvpRoomId.value, res, 0);
            }
        }
    } catch {
        // 上报失败静默，不阻塞结果页展示
    }
}

// 渲染 PVP 结算提示并刷新余额。平局退款双方已对等，refund_a 即本方退款额。
function showPvpSettle(s, res) {
    let txt;
    if (res === "win") {
        txt = `🏆 胜者通吃 +${s.winner_amount} ${currency.value}`;
    } else if (res === "lose") {
        txt = `💫 本局失利，质押已扣除`;
    } else if (res === "draw") {
        txt = `🤝 平局退回 ${s.refund_a || 0} ${currency.value}`;
    } else {
        // doubleLose：双方力竭，各退回
        txt = `🤝 双方力竭，退回 ${s.refund_a || 0} ${currency.value}`;
    }
    Notify.create({
        message: txt,
        color: "deep-orange",
        textColor: "white",
        position: "top",
        timeout: 4000,
    });
    // 刷新 $FIST 余额（结算已落库）
    fistStore.fetchAccount?.().catch(() => {});
}

// 先上报方轮询结算结果：对手上报后房间结算，幂等再请求即可拿到最终金额。
// 最多 6 次（约 7s），仍未结算则提示稍后查看（兜底由后端超时 sweep 保证退款）。
async function pollPvpSettle(roomId, res, attempt) {
    if (attempt >= 6) {
        Notify.create({
            message: "结算中，请稍后在账本查看",
            color: "deep-orange",
            textColor: "white",
            position: "top",
            timeout: 3000,
        });
        fistStore.fetchAccount?.().catch(() => {});
        return;
    }
    await new Promise((r) => setTimeout(r, 1200));
    try {
        // 幂等再请求：mode=pvp + room_id，统计已去重不会重复计数
        const { data } = await ironfistApi.reportMatch({
            mode: "pvp",
            result: res,
            room_id: roomId,
            opponent_name: opponentName.value,
            detail: [],
            player_hp: 0,
            opponent_hp: 0,
            counter_successes: 0,
            rounds: 0,
        });
        if (data?.pvp_settle?.settled) {
            showPvpSettle(data.pvp_settle, res);
            return;
        }
    } catch {
        // 单次失败忽略，继续重试
    }
    pollPvpSettle(roomId, res, attempt + 1);
}

// ── 启动对战 ──────────────────────────────────────────────
function startPve() {
    mode.value = "pve";
    opponentName.value = "电脑";
    opponentEmoji.value = "🤖";
    opponentChatId.value = "";
    resultType.value = ""; // 清理上一局结果状态
    engine = new IronFistGame({ mode: "pve" });
    beginBattle();
}

async function startPvp() {
    // 通过好友邀请（URL 含 role=host/guest）进入的均为娱乐好友局；
    // 通过真实 PVP 撮合（query.matched=1）进入的为质押 PVP，需在上报时携带 room_id 触发结算。
    const isFriend =
        route.query.role === "host" || route.query.role === "guest";
    const isRealPVP = route.query.matched === "1";
    mode.value = isFriend ? "friend" : "pvp";
    // 真实 PVP 的 room_id（用于上报结算）；好友局保持 null
    // URL query 是字符串，但后端 RoomID *uint64 需要数字，故转换并校验
    const parsedRoomId = isRealPVP ? Number(route.query.room_id) : null;
    pvpRoomId.value = Number.isFinite(parsedRoomId) && parsedRoomId > 0
        ? parsedRoomId
        : null;
    if (isRealPVP && pvpRoomId.value == null) {
        // matched=1 但 room_id 缺失/非法：无法结算，应阻断进入对局而非静默上报空值。
        // 此时尚未进入 playing 视图，结果遮罩不可见，故用 Notify 明确提示并退回大厅
        // （已质押的房间由后端 matched 超时按平局退款兜底）。
        Notify.create({
            message: "匹配信息异常（room_id 缺失），请返回大厅重试",
            color: "negative",
            textColor: "white",
            position: "top",
            timeout: 3500,
        });
        mode.value = "pve"; // 复位，避免残留 pvp 态影响后续
        pvpRoomId.value = null;
        view.value = "lobby";
        return;
    }
    opponentName.value =
        route.query.opponent_name ||
        gameStore.opponentNickname ||
        "对手";
    opponentEmoji.value = "🥷";
    opponentChatId.value = route.query.opponent || gameStore.opponentId || "";
    resultType.value = ""; // 清理上一局结果状态
    await nextTick();

    // roomId 来源：真实 PVP 用 query.room_id；好友局用 query.room。
    // 两者都用作 GameNet 消息过滤、IronFistGame localStorage pending key、后端 redis key。
    const roomId = route.query.room_id || route.query.room;
    const myChatId = identityStore.chatId;
    net = new GameNet(route.query.opponent, roomId);
    engine = new IronFistGame({ mode: "pvp", net, roomId, myChatId });

    // 检测是否存在未完成对局（页面刷新重连场景，详见 docs 第十四节方案 B）
    const hasPending = (() => {
        try {
            return !!localStorage.getItem(LS_PENDING_KEY(roomId));
        } catch {
            return false;
        }
    })();

    if (hasPending) {
        // 刷新重连路径：先显示重连视图，等服务端返回 ironfist_replay 后再切到 playing
        view.value = "reconnecting";
        pHP.value = INITIAL_HP;
        oHP.value = INITIAL_HP;
        pCharged.value = oCharged.value = false;
        lastResult.value = null;
        moveHistory.value = [];
        setupEngineListeners();
        engine.requestReconnect();
    } else {
        beginBattle();
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
        lastResult.value = null; // 清除上回合结算，避免新回合揭示行残留旧招
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
            // 重连恢复后可能落在 locked 分支（本回合已出招等对方），
            // 需切到 playing 并停掉重连倒计时，否则视图卡在 reconnecting。
            if (view.value === "reconnecting") view.value = "playing";
            stopReconnectTicker();
        }
    });
    // 重连重放：用服务端 action 流重建已结算回合的 moveHistory（含出招统计/累计伤害/战绩明细）
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
        // 对方重连后若直接结算（_myAction 存在），需停掉重连倒计时；
        // 重连恢复后落在 resolved 分支也需切到 playing。
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
        // 扣血 + 头像抖动延到「3D 拳头打实那一刻」由战斗区 @impact 回调触发（onArenaImpact），
        // 与命中特效/飘字同帧呈现；无人掉血的回合不会有 impact，HP 无变化直接同步即可。
        if (r.playerDmg <= 0 && r.opponentDmg <= 0) {
            pHP.value = r.playerHP;
            oHP.value = r.opponentHP;
        }
        clearTimeout(confirmTimer);
        // 有人倒地（含双双空血的平局）就走长停留，留足倒地动画
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
    engine.on("gameover", async (res) => {
        resultType.value = res;
        teardownTimers();
        stopReconnectTicker();
        if (mode.value === "pvp" || mode.value === "friend") gameStore.reset();
        if (mode.value === "pve" && res === "win") {
            pveReward.value = await fistStore.claimPvEReward();
        }
        // 上报战绩与成就（静默，不阻塞结果页）
        reportMatchResult(res);
        // 不切换 view：保留 playing 视图作为结果遮罩背景，玩家可看到战斗末态
    });
    // 对手掉线，进入 60s 重连等待遮罩
    engine.on("opponent-disconnected", ({ timeoutMs }) => {
        startReconnectTicker(timeoutMs);
    });
    // 对手重连后/对手先出招，恢复到本回合决策。携带 startedAt 续算倒计时（不重置为 30s）。
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

// ── 操作 ─────────────────────────────────────────────────
function onAction(action) {
    engine?.selectAction(action);
}

// 出招按钮：在按下位置生成涟漪后触发动作
//   仅在能出招时生成涟漪（disabled 状态不响应）
function onActionBtn(e, action) {
    const btn = e.currentTarget;
    if (btn && !btn.disabled) spawnRipple(btn, e);
    onAction(action);
}

// 涟漪：通过 CSS 自定义属性把点击坐标传给 ::after 伪元素，触发动画。
//   不动态插入 DOM，避免 <button> form-control 的内部布局 quirk 把按钮撑高。
function spawnRipple(btn, e) {
    const rect = btn.getBoundingClientRect();
    const x = (e.clientX ?? rect.left + rect.width / 2) - rect.left;
    const y = (e.clientY ?? rect.top + rect.height / 2) - rect.top;
    btn.style.setProperty("--ripple-x", x + "px");
    btn.style.setProperty("--ripple-y", y + "px");
    // 重置动画：移除 class → 强制 reflow → 重新加上，让连续点击也能重新触发
    btn.classList.remove("rippling");
    void btn.offsetWidth;
    btn.classList.add("rippling");
    // 动画结束后清理 class（仅挂一次，避免累积监听器）
    btn.addEventListener(
        "animationend",
        () => btn.classList.remove("rippling"),
        {
            once: true,
        },
    );
}

// ── 计时器 ────────────────────────────────────────────────
// startedAt：本回合 DECIDING 起始时间戳（引擎给出，本端时钟）。据此按真实已耗时续算，
// 使刷新重连方/对手先出招方不会拿到全新 30s。缺省（如 PvE）则从满 30s 起算。
function startCountdown(startedAt) {
    stopCountdown();
    const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    countdown.value = Math.max(1, Math.ceil(ROUND_SECONDS - elapsed));
    countdownTimer = setInterval(() => {
        countdown.value -= 1;
        if (countdown.value <= 0) {
            stopCountdown();
            if (!myAction.value) engine?.selectAction("defend"); // 超时默认防御
        }
    }, 1000);
}
function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
}

// 60s 重连等待倒计时 UI（不允许放弃，必须等满窗口或对方重连）
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

// 受击 HUD 反馈：玩家/对手任一方本回合掉血则触发短时抖动+红闪
//   meHit: 我方受击（playerDmg > 0）
//   oppHit: 对手受击（opponentDmg > 0）
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

// 3D 拳头打实那一刻由战斗区 @impact 回调：此刻才扣血 + 头像抖动，
// 让 HUD 反馈与 3D 命中特效/飘字同帧，不再抢在出拳之前。
function onArenaImpact(r) {
    if (!r) return;
    pHP.value = r.playerHP;
    oHP.value = r.opponentHP;
    triggerHitFeedback(r.playerDmg > 0, r.opponentDmg > 0);
}

// ── beforeunload：刷新/关闭页面时不发 game_resign ───────────────────────
// 方案 B 下刷新应走重连路径，而非直接认输：
//  1) WS 断开 → 对方 grace 超时 → WAITING_RECONNECT（60s）
//  2) 玩家重开页面 → 检测 localStorage pending → requestReconnect → loadReplay 恢复
//  3) 60s 内未重连 → 判掉线方负（对局必有结果）
// 若此处发 resign 会清理 Redis action 日志 + localStorage，导致无法重连，与设计冲突。
function handleBeforeUnload() {
    // 故意留空：不认输，交给 60s 重连窗口保证对局结果
}

function teardown() {
    teardownTimers();
    engine?.dispose();
    net?.destroy();
    engine = null;
    net = null;
}

// ── 导航 ─────────────────────────────────────────────────
function backToLobby() {
    teardown();
    router.replace("/games/ironfist");
    resultType.value = "";
    pveReward.value = null;
    view.value = "lobby"; // 重新挂载 IronFistLobby，会自动刷新余额与好友
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

/* 对手掉线重连遮罩 */
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

/* 结果遮罩：半透明叠加，模糊背景但保留战斗画面可见 */
.result-overlay {
    position: absolute;
    inset: 0;
    z-index: 1500; /* 高于 HUD 与操作栏，但低于重连遮罩 */
    display: flex;
    align-items: center;
    justify-content: center;
    /* 关键：背景半透明 + 模糊，玩家依然能透过看到战斗末态 */
    background: radial-gradient(
        circle at 50% 45%,
        rgba(20, 14, 32, 0.55) 0%,
        rgba(8, 6, 16, 0.78) 70%,
        rgba(0, 0, 0, 0.88) 100%
    );
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
}
/* 按胜负给遮罩叠一层色调（胜利偏金、失败偏红、平局偏紫） */
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

/* 居中卡片：无强背景，靠 emoji + 大字 + 按钮，让背景画面透出 */
.result-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 28px 36px;
    text-align: center;
    /* 卡片自身轻透 + 描边，避免与背景糊成一片 */
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

/* PvE 胜利奖励提示（结果卡片内） */
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
/* 每日满勤额外奖励徽章 */
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

/* 入场：淡入 + 轻微上浮 */
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

/* 对战布局 */
.battle {
    position: relative; /* 结果遮罩 / 重连遮罩的定位基准 */
    display: flex;
    flex-direction: column;
    height: 100dvh;
    padding: 8px 10px 10px;
    gap: 8px;
}

/* ===== 顶部对战 HUD ===== */
/* 外层 = 发光渐变描边（蓝→紫→红），用 2px padding 露出作为边框；
   切角 clip-path 营造设计稿的科技感折角面板。 */
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
    /* clip-path 会裁掉 box-shadow，故用 drop-shadow（贴合切角轮廓、渲染在裁剪外）发光 */
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
/* 内层 = 深色面板 + 点阵纹理 + 左右蓝/红冷暖辉光，同向切角略微内收 */
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
/* 每侧：头像+名字一行 → 全宽血条 → 出招统计 */
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
/* 受击反馈：抖动 + 红色描边光晕（不改变布局尺寸，避免抖动其他列） */
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

/* 头像 */
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
/* 外层科技虚线环（设计稿头像外的描边圈） */
.mh-avatar::before {
    content: "";
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    border: 1px dashed rgba(255, 255, 255, 0.28);
    pointer-events: none;
}
/* 上下两段实弧，呼应设计稿环上的高亮缺口 */
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
/* 蓄力时整圈高亮脉冲 */
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

/* 血条行：心形图标 + 血条（对手侧镜像） */
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

/* 中央：回合 + 环形倒计时 */
.mh-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 0 2px;
}
/* ROUND 徽标：六边形切角 + 两侧蓝/红点缀（设计稿顶部标牌） */
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
/* 环外刻度：细密虚线圈，mask 成一圈薄环（设计稿环外的 tick 刻度） */
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
    /* 旋转 -90deg 让 stroke 起点位于顶部 12 点钟方向 */
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
    /* 描边过渡平滑 */
    transition:
        stroke-dashoffset 0.95s linear,
        stroke 0.2s;
}
/* 倒计时三阶段描边色：与 HealthBar 三段血色严格对齐（取血条渐变起点色） */
.cd-progress-circle--safe {
    stroke: #43e97b;
} /* 健康(绿) > 60% */
.cd-progress-circle--warn {
    stroke: #ffce4d;
} /* 警告(橙黄) 30~60% */
.cd-progress-circle--danger {
    stroke: #ff5b5b;
} /* 危险(红) ≤ 30% */
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

/* 状态条：胶囊 + 两侧蓝/红呼吸点（设计稿底部「出招准备中」） */
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

/* ===== 出招揭示行（浮层：绝对定位叠在战斗区底部，不占布局/不抖动） ===== */
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
/* 蓝→红 发光渐变描边（贴合设计稿） */
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
    /* 60px at max-width(530px) ≈ 11.5%；窄屏按比例收缩，最低 8px */
    /* padding: 10px min(60px, 11.5%) 0 min(60px, 11.5%); */
        padding-right: 7%;
    padding-top: 8px;
}
.rv-side--opp {
    /* 60px at max-width(530px) ≈ 11.5%；窄屏按比例收缩，最低 8px */
    /* padding: 10px min(60px, 11.5%) 0 min(60px, 11.5%); */
        padding-left: 7%;
    padding-top: 8px;
}
.rv-move {
    /* 最大 24px，窄屏按 vw 缩小，最小 13px */
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

/* 浮层淡入淡出（轻微上浮，避免突兀） */
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

/* ===== 操作按钮 ===== */
.hud-action {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
}

/* 整张卡为彩色渐变 + 立体高光/底影（与设计稿一致） */
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
    /* 注意：不给 button 加 overflow:hidden，会触发 form-control 内部布局 quirk 把按钮撑高。
     涟漪改用 ::after 伪元素 + clip-path 限制范围。 */
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
/* 涟漪：用伪元素绘制白色半透明圆，从点击点扩散后淡出。
   通过 clip-path 限制在按钮圆角矩形内（替代 overflow:hidden）。 */
.act-btn::after {
    content: "";
    position: absolute;
    left: var(--ripple-x);
    top: var(--ripple-y);
    width: 12px;
    height: 12px;
    margin: -6px 0 0 -6px; /* 让 left/top 表示涟漪圆心 */
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

/* 图标置于半透明深色内嵌框 */
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
