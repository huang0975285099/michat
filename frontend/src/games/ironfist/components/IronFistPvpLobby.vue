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
      <!-- <q-icon name="groups" size="22px" class="pvp-banner-ic" /> -->
      <div class="pvp-banner-main">
        <div class="pvp-banner-title">
          大厅人数
          <span class="pvp-banner-count">{{ lobbyUsers.length }}</span>
        </div>

        <!-- 大厅在线玩家头像列表 -->
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
            <div v-if="u.chat_id === myChatId" class="lobby-user-tag">我</div>
          </div>
        </div>
        <div v-else class="lobby-empty">
          <q-spinner-dots v-if="lobbyJoining" color="amber" size="22px" />
          <span class="q-ml-sm">{{
            lobbyJoining ? "正在加入大厅…" : "当前大厅暂无其他玩家"
          }}</span>
        </div>
      </div>
    </div>

    <!-- 玩家信息弹窗 -->
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
            <div class="profile-stat-label">$FIST 余额</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat-num">
              {{ profileData?.total_battles || 0 }}
            </div>
            <div class="profile-stat-label">累计对战场次</div>
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>

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
            <q-btn flat color="grey-5" label="取消匹配" @click="cancelMatch" />
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
import { ref, onMounted, onUnmounted } from "vue";
import { useFistStore } from "src/stores/fist";
import { useIdentityStore } from "src/stores/identity";
import {
  on as wsOn,
  off as wsOff,
  send as wsSend,
  connect as wsConnect,
} from "src/services/websocket.js";
import { PVP_TIERS } from "../game/ironfistMeta";

defineEmits(["back"]);

const fistStore = useFistStore();
const identityStore = useIdentityStore();

const matchState = ref("idle"); // idle | searching | soon
const matchTier = ref(null);
let matchTimer = null;

// PVP 大厅在线玩家列表
const lobbyUsers = ref([]); // [{chat_id, nickname, fist_balance, total_battles}]
const lobbyJoining = ref(true);
const myChatId = identityStore.chatId;
const profileDialog = ref(false);
const profileData = ref(null);

// 大厅列表更新处理（服务端在有人加入/离开时广播）
function onLobbyUpdate(payload) {
  // payload: { count, users: [{chat_id, nickname, fist_balance, total_battles}] }
  lobbyUsers.value = payload?.users ?? [];
  lobbyJoining.value = false;
}

// 进入大厅：注册监听 + 发送 join
async function joinLobby() {
  wsOn("ironfist_lobby_update", onLobbyUpdate);
  await wsConnect(); // 确保连接已建立（IronFistPage 进入时已连接，幂等）
  wsSend("ironfist_lobby_join", {});
}

function leaveLobby() {
  wsSend("ironfist_lobby_leave", {});
  wsOff("ironfist_lobby_update", onLobbyUpdate);
  lobbyUsers.value = [];
}

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

// 头像字母与配色（与好友列表风格一致）
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
  joinLobby();
});

onUnmounted(() => {
  leaveLobby();
  clearTimeout(matchTimer);
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

/* 大厅在线玩家头像列表 */
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

/* 玩家信息弹窗 */
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
