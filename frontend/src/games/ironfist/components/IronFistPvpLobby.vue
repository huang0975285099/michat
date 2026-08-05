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
      <div class="text-h6 q-ml-sm">Match play</div>
      <q-space />
      <q-chip dense color="amber-9" text-color="white" class="fist-chip">
        ⚡ {{ fistStore.balance.toLocaleString() }} {{ currency }}
      </q-chip>
    </div>

    <div class="pvp-banner">
      <!-- <q-icon name="groups" size="22px" class="pvp-banner-ic" /> -->
      <div class="pvp-banner-main">
        <div class="pvp-banner-title">
          Number of people in the hall
          <span class="pvp-banner-count">{{ lobbyUsers.length }}</span>
        </div>

        <!-- Lobby online player avatar list -->
        <div v-if="lobbyUsers.length" class="lobby-users">
          <div
            v-for="u in lobbyUsers"
            :key="u.chat_id"
            class="lobby-user"
            :class="{ 'lobby-user--me': u.chat_id === myChatId }"
            @click="showProfile(u)"
          >
            <q-avatar
              :color="avatarColor(u.nickname || u.chat_id)"
              text-color="white"
              size="42px"
            >
              {{ avatarLetter(u.nickname || u.chat_id) }}
            </q-avatar>
            <div class="lobby-user-name">{{ u.nickname || u.chat_id }}</div>
            <div v-if="u.chat_id === myChatId" class="lobby-user-tag">me</div>
          </div>
        </div>
        <div v-else class="lobby-empty">
          <q-spinner-dots v-if="lobbyJoining" color="amber" size="22px" />
          <span class="q-ml-sm">{{
            lobbyJoining ? "Joining lobby…" : "There are currently no other players in the lobby"
          }}</span>
        </div>
      </div>
    </div>

    <!-- Player information pop-up window -->
    <q-dialog v-model="profileDialog">
      <q-card class="profile-card">
        <q-card-section class="row items-center q-pb-none">
          <q-avatar
            :color="avatarColor(profileData?.nickname || profileData?.chat_id)"
            text-color="white"
            size="46px"
            class="q-mr-sm"
          >
            {{ avatarLetter(profileData?.nickname || profileData?.chat_id) }}
          </q-avatar>
          <div class="profile-name">
            {{ profileData?.nickname || profileData?.chat_id }}
          </div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>
        <q-card-section class="profile-stats">
          <div class="profile-stat">
            <div class="profile-stat-num">
              {{ (profileData?.fist_balance || 0).toLocaleString() }}
            </div>
            <div class="profile-stat-label">{{ currency }} balance</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat-num">
              {{ profileData?.total_battles || 0 }}
            </div>
            <div class="profile-stat-label">Total number of battles</div>
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>

    <div class="section-title">Select room category</div>
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
        <div class="tier-stake-unit">{{ currency }} / bureau</div>
      </div>
    </div>

    <!-- Matching mask: adjust the real matching API, wait for WS push or match immediately -->
    <transition name="result-fade">
      <div v-if="matchState !== 'idle'" class="match-overlay">
        <div class="match-card">
          <template v-if="matchState === 'searching'">
            <q-spinner-dots color="amber" size="56px" />
            <div class="match-title">Looking for an opponent…</div>
            <div class="match-sub">
              {{ matchTier?.name }} · pledge
              {{ matchTier?.stake.toLocaleString() }} {{ currency }}
            </div>
            <q-btn
              flat
              color="grey-5"
              label="Unmatch"
              :disable="cancelling"
              @click="cancelMatch"
            />
          </template>
          <template v-else-if="matchState === 'error'">
            <div class="match-soon-emoji">⚠️</div>
            <div class="match-title">{{ matchError || "Match failed" }}</div>
            <q-btn
              unelevated
              color="amber-8"
              text-color="dark"
              label="Got it"
              @click="resetMatch"
            />
          </template>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { useFistStore } from "src/stores/fist";
import { useIdentityStore } from "src/stores/identity";
import { useRegion } from "../game/useRegion.js";
import {
  on as wsOn,
  off as wsOff,
  send as wsSend,
  connect as wsConnect,
} from "src/services/websocket.js";
import { ironfistApi } from "src/services/api.js";
import { PVP_TIERS } from "../game/ironfistMeta";

const emit = defineEmits(["back", "matched"]);

const fistStore = useFistStore();
const identityStore = useIdentityStore();
const { currency } = useRegion();

const matchState = ref("idle"); // idle | searching | error
const matchTier = ref(null);
const matchError = ref("");
const cancelling = ref(false);
let matchTimer = null;
let matchEpoch = 0; //Each time startMatch/cancelMatch is incremented, it is used to discard expired asynchronous responses.
let pollTimer = null; //Polling when WS notification is lost
let disposed = false;

// The match pushed by WS is received successfully (triggered only when serving as a waiting party; the B side will match immediately and use the joinPVPQueue return value)
function onPVPMatched(payload) {
  if (matchState.value !== "searching") return;
  if (!payload?.room_id) return;
  // payload: { room_id, opponent, tier, stake }
  emitMatched(payload);
}

// Unified exit: Bring the room number and opponent file to the parent router to switch to the battle page
function emitMatched({ room_id, game_id, opponent, tier, stake }) {
  clearTimeout(matchTimer);
  clearTimeout(pollTimer);
  // First temporarily store matchTier and then set it to null, otherwise the fallback below will always get null.
  const savedTier = matchTier.value;
  matchState.value = "idle";
  matchTier.value = null;
  emit("matched", {
    roomId: room_id,
    gameId: game_id,
    opponent,
    tier: tier || savedTier?.key,
    stake: stake ?? savedTier?.stake,
  });
}

// PVP lobby online player list
const lobbyUsers = ref([]); // [{chat_id, nickname, fist_balance, total_battles}]
const lobbyJoining = ref(true);
const myChatId = identityStore.chatId;
const profileDialog = ref(false);
const profileData = ref(null);

// Lobby list update processing (the server broadcasts when someone joins/leaves)
function onLobbyUpdate(payload) {
  // payload: { count, users: [{chat_id, nickname, fist_balance, total_battles}] }
  lobbyUsers.value = payload?.users ?? [];
  lobbyJoining.value = false;
}

// Enter the lobby: register to listen + send join
async function joinLobby() {
  wsOn("ironfist_lobby_update", onLobbyUpdate);
  wsOn("ironfist_pvp_matched", onPVPMatched);
  await wsConnect(); //Make sure the connection is established (IronFistPage is connected when entering, idempotent)
  if (disposed) return;
  wsSend("ironfist_lobby_join", {});
}

function leaveLobby() {
  wsSend("ironfist_lobby_leave", {});
  wsOff("ironfist_lobby_update", onLobbyUpdate);
  wsOff("ironfist_pvp_matched", onPVPMatched);
  lobbyUsers.value = [];
  // If you are still in the match when you leave the lobby, you need to release the pledge. But there is a competition: you may have been matched at the moment of leaving,
  // At this time, cancel is invalid for matched rooms (skipping silently), and directly idle will leave orphan matched rooms.
  // The pledge is locked until the backend matched times out and is refunded as a draw. Therefore, consistent with cancelMatch, check the queue status first:
  // - Matched → Enter the battle page instead (pledged cannot be lost, the parent is still mounted, and emit can be processed)
  // - Otherwise → normal cancellation and refund
  if (matchState.value === "searching") {
    matchEpoch++;
    clearTimeout(matchTimer);
    clearTimeout(pollTimer);
    matchState.value = "idle";
    matchTier.value = null;
    (async () => {
      try {
        const { data } = await ironfistApi.getPVPQueueStatus();
        if (data?.status === "matched" && data.room_id) {
          emit("matched", {
            roomId: data.room_id,
            gameId: data.game_id,
            opponent: data.opponent,
            tier: data.tier,
            stake: data.stake,
          });
          return;
        }
      } catch {
        // Review failed: Return to proactively canceling the cover
      }
      ironfistApi.cancelPVPQueue().catch(() => {});
    })();
  }
}

// Enter matching after selecting a gear: call the matching API.
// - status='queued': keep searching and wait for WS ironfist_pvp_matched push + polling for details
// - status='matched': The local caller is B, the opponent is already the A file, immediately switch to the battle page
async function startMatch(tier) {
  const epoch = ++matchEpoch;
  matchTier.value = tier;
  matchState.value = "searching";
  matchError.value = "";
  cancelling.value = false;
  try {
    const { data } = await ironfistApi.joinPVPQueue(tier.key);
    if (data?.status === "matched") {
      // Immediate matching: Even if the user clicks Cancel during the POST flight, they will enter directly——
      // Matched rooms cannot be canceled. Forcibly discarding them will only make the opponent wait for nothing and trigger a 15-minute timeout refund.
      emitMatched({
        room_id: data.room_id,
        game_id: data.game_id,
        opponent: data.opponent,
        tier: data.tier,
        stake: data.stake,
      });
      return;
    }
    // status === 'queued': Keep searching waiting for WS push
    // If the user has clicked Cancel during the POST flight (epoch has changed), the previous DELETE may not have hit this room. Please cancel once.
    if (epoch !== matchEpoch) {
      ironfistApi.cancelPVPQueue().catch(() => {});
      return;
    }
    // WS notification is lost: the queue status is polled every 5 seconds, and if matched is found, enter the battle page immediately
    startMatchPoll(epoch);
    // Backend timeout (10 minutes) to avoid backend push leakage + polling failure at the same time, causing users to get stuck.
    clearTimeout(matchTimer);
    matchTimer = setTimeout(() => {
      if (matchState.value === "searching") {
        matchError.value = "Match timeout，Please try again";
        matchState.value = "error";
        clearTimeout(pollTimer);
        ironfistApi.cancelPVPQueue().catch(() => {});
      }
    }, 10 * 60 * 1000);
  } catch (e) {
    if (epoch !== matchEpoch) return;
    const status = e?.response?.status;
    const msg = e?.response?.data?.error;
    if (status === 402) {
      matchError.value = `${currency.value} Insufficient balance，Unable to pledge`;
    } else if (status === 400) {
      matchError.value = msg || "Invalid gear";
    } else if (status === 409) {
      matchError.value = msg || "Already in a match，Please complete first or wait for settlement";
    } else {
      matchError.value = msg || "Match failed，Please try again later";
    }
    matchState.value = "error";
  }
}

// Polling queue status, WS notification is lost: if matched is found, switch to the battle page
function startMatchPoll(epoch) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (epoch !== matchEpoch || matchState.value !== "searching") return;
    try {
      const { data } = await ironfistApi.getPVPQueueStatus();
      if (epoch !== matchEpoch || matchState.value !== "searching") return;
      if (data?.status === "matched" && data.room_id) {
        emitMatched({
          room_id: data.room_id,
          game_id: data.game_id,
          opponent: data.opponent,
          tier: data.tier,
          stake: data.stake,
        });
        return;
      }
      // If it is still queued or idle, continue polling.
      startMatchPoll(epoch);
    } catch (e) {
      // Polling failure is not fatal and continues to the next round
      startMatchPoll(epoch);
    }
  }, 5000);
}

// The user actively cancels matching: adjust the backend to cancel the interface (refund) and reset the local status
async function cancelMatch() {
  if (cancelling.value) return;
  cancelling.value = true;
  matchEpoch++; //Invalidate a startMatch response in progress
  clearTimeout(matchTimer);
  clearTimeout(pollTimer);
  try {
    await ironfistApi.cancelPVPQueue();
  } catch (e) {
    // Cancellation failure cannot silently fall back to idle: the backend may still hold matching rooms.
    // Users may still be matched even though they think they have been cancelled. Keep the error status and prompt to try again.
    matchError.value = e?.response?.data?.error || "Cancellation failed，Please try again";
    matchState.value = "error";
    cancelling.value = false;
    return;
  }
  // Race status review: cancelPVPQueue can only cancel rooms with status='matching' and matched rooms
  // Will be silently skipped (returns ok=true). If there is no review, Player A will be canceled at the moment of being matched.
  // It was mistakenly thought that the cancellation was successful and idle was set, causing both WS push and polling to fail, forming an orphan matched room.
  // The stake is locked for 15 minutes before being refunded in a draw by SweepTimeoutPVPMatched.
  try {
    const { data } = await ironfistApi.getPVPQueueStatus();
    if (data?.status === "matched" && data.room_id) {
      // Actually matched: The matched room cannot be canceled. Go directly to the match page to avoid orphan rooms.
      emitMatched({
        room_id: data.room_id,
        opponent: data.opponent,
        tier: data.tier,
        stake: data.stake,
      });
      cancelling.value = false;
      return;
    }
  } catch (e) {
    // Failure to review will not affect the cancellation result and will still be processed as canceled (the worst case scenario will be covered by a 15-minute timeout)
  }
  cancelling.value = false;
  matchState.value = "idle";
  matchTier.value = null;
}

function resetMatch() {
  // Close the error pop-up window: clear the timer and invalidate the asynchronous response in progress.
  // And best-effort cleans up possible remaining matching rooms (such as cancelMatch failure scenarios).
  matchEpoch++;
  clearTimeout(matchTimer);
  clearTimeout(pollTimer);
  ironfistApi.cancelPVPQueue().catch(() => {});
  matchState.value = "idle";
  matchTier.value = null;
  matchError.value = "";
}

// Avatar lettering and color matching (consistent with friend list style)
const AVATAR_COLORS = [
  "purple",
  "deep-orange",
  "teal",
  "blue",
  "pink",
  "indigo",
  "cyan",
  "green",
];
function avatarLetter(s) {
  return (s || "").slice(0, 1).toUpperCase();
}
function avatarColor(s) {
  const sum = (s || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function showProfile(u) {
  profileData.value = u;
  profileDialog.value = true;
}

onMounted(() => {
  disposed = false;
  joinLobby();
});

onUnmounted(() => {
  disposed = true;
  leaveLobby();
  clearTimeout(matchTimer);
  clearTimeout(pollTimer);
});
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
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(255, 179, 0, 0.1);
  border: 1px solid rgba(255, 179, 0, 0.3);
}
.pvp-banner-ic {
  color: #ffce5a;
  flex: 0 0 auto;
  margin-top: 1px;
}
.pvp-banner-main {
  flex: 1;
  min-width: 0;
}
.pvp-banner-title {
  font-size: 13px;
  font-weight: 700;
  color: #ffce5a;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.pvp-banner-count {
  font-size: 20px;
  font-weight: 900;
  color: #fff;
  line-height: 1;
}
.pvp-banner-sub {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 2px;
  line-height: 1.4;
}

/* Lobby online player avatar list */
.lobby-users {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 12px 6px 0;
  scrollbar-width: thin;
}
.lobby-users::-webkit-scrollbar {
  height: 4px;
}
.lobby-users::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}
.lobby-user {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 56px;
  cursor: pointer;
  position: relative;
  transition: transform 0.12s;
}
.lobby-user:active {
  transform: scale(0.94);
}
.lobby-user-name {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.75);
  text-align: center;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lobby-user-tag {
  position: absolute;
  top: -4px;
  right: 6px;
  font-size: 9px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 6px;
  background: #ffce5a;
  color: #1a1f3e;
  line-height: 14px;
}
.lobby-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  color: rgba(255, 255, 255, 0.5);
  font-size: 12px;
  margin-bottom: 8px;
}

/* Player information pop-up window */
.profile-card {
  background: linear-gradient(180deg, #2a2140, #1a1f3e);
  color: #fff;
  border-radius: 16px;
  min-width: 280px;
}
.profile-name {
  font-size: 17px;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
.profile-stats {
  display: flex;
  gap: 12px;
  padding-top: 16px;
}
.profile-stat {
  flex: 1;
  text-align: center;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 14px 8px;
}
.profile-stat-num {
  font-size: 22px;
  font-weight: 900;
  color: #ffce5a;
  line-height: 1.1;
}
.profile-stat-label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 4px;
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

/* match mask */
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

/* Match mask fade */
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
