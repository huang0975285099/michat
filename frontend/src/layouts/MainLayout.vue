<template>
    <q-layout view="lHh Lpr lFf">
        <q-header elevated v-if="showNav">
            <q-toolbar>
                <q-btn
                    flat
                    dense
                    round
                    icon="arrow_back"
                    @click="router.back()"
                    v-if="canGoBack"
                />
                <q-toolbar-title>{{ pageTitle }}</q-toolbar-title>
                <q-btn
                    v-if="identity.hasCode"
                    flat
                    dense
                    round
                    icon="lock"
                    @click="doLockNow"
                >
                    <q-tooltip>立即锁定</q-tooltip>
                </q-btn>
                <q-btn
                    v-if="!wsConnected"
                    flat
                    dense
                    round
                    icon="refresh"
                    :class="{ 'spin-once': refreshing }"
                    :disable="refreshing"
                    @click="doRefresh"
                >
                    <q-tooltip>刷新连接</q-tooltip>
                </q-btn>
            </q-toolbar>
            <div
                v-if="!wsConnected"
                class="row items-center justify-center q-py-xs bg-orange-8 text-white text-caption"
                style="letter-spacing: 0.5px"
            >
                <q-icon name="wifi_off" size="14px" class="q-mr-xs" />
                网络已断开，正在重新连接...
            </div>
        </q-header>

        <q-page-container>
            <router-view v-slot="{ Component }">
                <keep-alive :include="['ChatsPage', 'FriendsPage', 'GamesPage', 'ProfilePage']">
                    <component :is="Component" />
                </keep-alive>
            </router-view>
        </q-page-container>

        <q-footer v-if="showNav">
            <q-tabs
                v-model="tab"
                dense
                align="justify"
                class="bg-primary text-white"
            >
                <q-tab
                    name="chats"
                    icon="chat"
                    label="聊天"
                    @click="router.push('/chats')"
                >
                    <q-badge
                        v-if="chatStore.totalUnread > 0"
                        color="red"
                        floating
                        rounded
                        :label="chatStore.totalUnread > 99 ? '99+' : chatStore.totalUnread"
                    />
                </q-tab>
                <q-tab
                    name="friends"
                    icon="people"
                    label="好友"
                    @click="router.push('/friends')"
                >
                    <q-badge
                        v-if="identity.pendingRequestCount > 0"
                        color="red"
                        floating
                        rounded
                        :label="identity.pendingRequestCount > 99 ? '99+' : identity.pendingRequestCount"
                    />
                </q-tab>
                <q-tab
                    name="games"
                    icon="sports_esports"
                    label="链游"
                    @click="router.push('/games')"
                />
                <q-tab
                    name="profile"
                    icon="person"
                    label="我"
                    @click="router.push('/profile')"
                />
            </q-tabs>
        </q-footer>

        <!-- 安全码锁定界面 -->
        <lock-screen />
        <!-- 通话组件 -->
        <call-bar />
        <video-call-view />
        <incoming-call-dialog />
        <!-- 游戏邀请弹窗 -->
        <incoming-game-dialog />

        <!-- 强制更新：当前版本低于 min_supported 时阻断使用 -->
        <q-dialog v-model="forceUpdate" persistent no-esc-dismiss no-backdrop-dismiss>
            <q-card style="min-width: 300px; max-width: 360px">
                <q-card-section class="row items-center q-gutter-sm">
                    <q-icon name="system_update" color="primary" size="28px" />
                    <div class="text-h6">需要更新</div>
                </q-card-section>
                <q-card-section class="text-body2 text-grey-8 q-pt-none">
                    当前版本（v{{ appVersion }}）过低，无法继续使用，请更新到最新版本。
                    <div v-if="forceUpdateNotes" class="text-caption text-grey q-mt-sm">
                        {{ forceUpdateNotes }}
                    </div>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn
                        unelevated
                        color="primary"
                        label="立即更新"
                        :loading="forceUpdating"
                        @click="doForceUpdate"
                    />
                </q-card-actions>
            </q-card>
        </q-dialog>
    </q-layout>
</template>

<script setup>
import { ref, watch, computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Notify } from "quasar";
import { useChatStore } from "src/stores/chat";
import { useIdentityStore } from "src/stores/identity";
import { useCallStore } from "src/stores/call";
import { wsConnected, on, off } from "src/services/websocket";
import { notifyNewMessage, initNotifications } from "src/services/notify";
import {
    APP_VERSION,
    cmpVersion,
    fetchVersionInfo,
    isNativeClient,
    forceRefresh,
} from "src/services/version";
import LockScreen from "src/components/LockScreen.vue";
import CallBar from "src/components/CallBar.vue";
import VideoCallView from "src/components/VideoCallView.vue";
import IncomingCallDialog from "src/components/IncomingCallDialog.vue";
import IncomingGameDialog from "src/components/IncomingGameDialog.vue";
import { useGameStore } from "src/stores/game";

const route = useRoute();
const router = useRouter();
const identity = useIdentityStore();

function pathToTab(path) {
    if (path.startsWith("/chat/")) return "chats";
    if (path === "/friends") return "friends";
    if (path === "/games") return "games";
    if (path === "/profile") return "profile";
    return "chats";
}

// 首页和游戏对战页不显示导航栏（对战页需全屏）
const showNav = computed(() => {
    if (route.path === "/") return false;
    if (route.path.startsWith("/games/")) return false; // /games/bomberman 等对战页全屏
    return identity.isReady;
});

const chatStore = useChatStore();
const callStore = useCallStore();
const gameStore = useGameStore();
gameStore.setRouter(router);
let stopListening = null;
let stopCallListening = null;
let stopGameListening = null;
function onFriendRequestGlobal() {
    identity.incPendingRequestCount();
    notifyNewMessage();
}

// 强制更新：当前版本低于后端 min_supported 时阻断使用
const appVersion = APP_VERSION || "未知";
const forceUpdate = ref(false);
const forceUpdateNotes = ref("");
let forceUpdateUrl = "";

const FORCE_UPDATE_TRIED_KEY = "force_update_tried";
async function checkForceUpdate() {
    if (!APP_VERSION) return; // 版本未注入（异常）时不强制，避免误锁
    try {
        const info = await fetchVersionInfo();
        forceUpdateUrl = info.url || "";
        forceUpdateNotes.value = info.notes || "";
        if (info.min_supported && cmpVersion(APP_VERSION, info.min_supported) < 0) {
            // 防死循环：若本会话已强刷过、但版本仍未变（新版本未部署 / 配置错误），
            // 则不再强制，避免把用户永久锁死
            if (sessionStorage.getItem(FORCE_UPDATE_TRIED_KEY) === APP_VERSION) {
                console.warn(
                    "[version] 已尝试强制更新但版本仍为 " + APP_VERSION +
                    "，低于 min_supported " + info.min_supported +
                    "：新版本可能尚未部署，已跳过强制以防死循环",
                );
                return;
            }
            forceUpdate.value = true;
        }
    } catch {
        // 拉取失败则不强制，避免网络问题误锁用户
    }
}

const forceUpdating = ref(false);
async function doForceUpdate() {
    if (forceUpdating.value) return;
    forceUpdating.value = true;
    if (isNativeClient()) {
        // 原生端（桌面/安卓）只能下载新安装包更新，刷新打包进二进制的旧版本无意义
        if (forceUpdateUrl) window.open(forceUpdateUrl, "_blank");
        forceUpdating.value = false;
        return;
    }
    // 记录本次强刷来源版本：刷新后若版本未变则不再强制（见 checkForceUpdate）
    try {
        sessionStorage.setItem(FORCE_UPDATE_TRIED_KEY, APP_VERSION);
    } catch {
        // sessionStorage 不可用时忽略
    }
    await forceRefresh();
}

onMounted(() => {
    stopListening = chatStore.startListening();
    stopCallListening = callStore.startListening();
    stopGameListening = gameStore.startListening();
    on("friend_request", onFriendRequestGlobal);
    initNotifications();
    checkForceUpdate();
    // 启动时若已是解锁态，补解密上次锁定期间暂存的密文
    if (!identity.isLocked) chatStore.processPendingMessages();
    // 阅后即焚定时删除检查挂在应用级生命周期，确保用户离开具体聊天页后
    // 倒计时仍能继续推进并按时删除（原挂在 ChatPage 会在离开时被清除）
    chatStore.startBurnTimer();
    chatStore.checkExpiredMessages();
});

// 解锁后（锁定 → 解锁）补解密锁定期间暂存的消息
watch(
    () => identity.isLocked,
    (locked, wasLocked) => {
        if (wasLocked && !locked) chatStore.processPendingMessages();
    },
);
onUnmounted(() => {
    off("friend_request", onFriendRequestGlobal);
    stopListening?.();
    stopCallListening?.();
    stopGameListening?.();
    chatStore.stopBurnTimer();
});

const tab = ref(pathToTab(route.path));
watch(
    () => route.path,
    (p) => {
        tab.value = pathToTab(p);
    },
);

let everDisconnected = false;
watch(wsConnected, (connected) => {
    if (!connected) {
        everDisconnected = true;
    } else if (everDisconnected) {
        Notify.create({ type: "positive", message: "已重新连接", timeout: 2000 });
    }
});

const canGoBack = computed(() => route.path.startsWith("/chat/"));

function doLockNow() {
    identity.lockNow();
    Notify.create({ type: "info", message: "已锁定", timeout: 2000 });
}

const refreshing = ref(false);
function doRefresh() {
    if (refreshing.value) return;
    refreshing.value = true;
    window.location.reload();
}

const pageTitle = computed(() => {
    if (route.path === "/") return "云密";
    if (route.path.startsWith("/chat/")) return route.query.nickname || "聊天";
    if (route.path === "/friends") return "好友";
    if (route.path === "/games") return "区块链游戏";
    if (route.path === "/profile") return "我的资料";
    return "云密";
});
</script>

<style scoped>
@keyframes spin-once {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
}
.spin-once .q-icon {
    animation: spin-once 0.6s linear;
}
</style>
