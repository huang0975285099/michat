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
                <keep-alive :include="['ChatsPage', 'FriendsPage', 'ProfilePage']">
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

const route = useRoute();
const router = useRouter();
const identity = useIdentityStore();

function pathToTab(path) {
    if (path.startsWith("/chat/")) return "chats";
    if (path === "/friends") return "friends";
    if (path === "/profile") return "profile";
    return "chats";
}

// 首页不显示导航栏
const showNav = computed(() => {
    return route.path !== "/" && identity.isReady;
});

const chatStore = useChatStore();
const callStore = useCallStore();
let stopListening = null;
let stopCallListening = null;
function onFriendRequestGlobal() {
    identity.incPendingRequestCount();
    notifyNewMessage();
}

// 强制更新：当前版本低于后端 min_supported 时阻断使用
const appVersion = APP_VERSION || "未知";
const forceUpdate = ref(false);
const forceUpdateNotes = ref("");
let forceUpdateUrl = "";

async function checkForceUpdate() {
    if (!APP_VERSION) return; // 版本未注入（异常）时不强制，避免误锁
    try {
        const info = await fetchVersionInfo();
        forceUpdateUrl = info.url || "";
        forceUpdateNotes.value = info.notes || "";
        if (info.min_supported && cmpVersion(APP_VERSION, info.min_supported) < 0) {
            forceUpdate.value = true;
        }
    } catch {
        // 拉取失败则不强制，避免网络问题误锁用户
    }
}

function doForceUpdate() {
    if (isNativeClient()) {
        if (forceUpdateUrl) window.open(forceUpdateUrl, "_blank");
        return;
    }
    forceRefresh();
}

onMounted(() => {
    stopListening = chatStore.startListening();
    stopCallListening = callStore.startListening();
    on("friend_request", onFriendRequestGlobal);
    initNotifications();
    checkForceUpdate();
});
onUnmounted(() => {
    off("friend_request", onFriendRequestGlobal);
    stopListening && stopListening();
    stopCallListening && stopCallListening();
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
