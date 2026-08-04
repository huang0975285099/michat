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
                    <q-tooltip>{{ t("header.lockNow") }}</q-tooltip>
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
                    <q-tooltip>{{ t("header.refresh") }}</q-tooltip>
                </q-btn>
            </q-toolbar>
            <div
                v-if="!wsConnected"
                class="row items-center justify-center q-py-xs bg-orange-8 text-white text-caption"
                style="letter-spacing: 0.5px"
            >
                <q-icon name="wifi_off" size="14px" class="q-mr-xs" />
                {{ t("header.disconnected") }}
            </div>
        </q-header>

        <q-page-container>
            <router-view v-slot="{ Component }">
                <keep-alive :include="['ChatsPage', 'FriendsPage', 'GamesPage', 'ProfilePage']">
                    <component :is="Component" :key="$route.path" />
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
                    :label="t('nav.chats')"
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
                    :label="t('nav.friends')"
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
                    :label="t('nav.games')"
                    @click="router.push('/games')"
                />
                <q-tab
                    name="profile"
                    icon="person"
                    :label="t('nav.profile')"
                    @click="router.push('/profile')"
                />
            </q-tabs>
        </q-footer>

        <!-- Security code lock interface -->
        <lock-screen />
        <!-- call component -->
        <call-bar />
        <video-call-view />
        <incoming-call-dialog />
        <!-- Game invitation pop-up window -->
        <incoming-game-dialog />

        <!-- Forced update: blocked when the current version is lower than min_supported -->
        <q-dialog v-model="forceUpdate" persistent no-esc-dismiss no-backdrop-dismiss>
            <q-card style="min-width: 300px; max-width: 360px">
                <q-card-section class="row items-center q-gutter-sm">
                    <q-icon name="system_update" color="primary" size="28px" />
                    <div class="text-h6">{{ t("update.required") }}</div>
                </q-card-section>
                <q-card-section class="text-body2 text-grey-8 q-pt-none">
                    {{ t("update.requiredMessage", { version: appVersion }) }}
                    <div v-if="forceUpdateNotes" class="text-caption text-grey q-mt-sm">
                        {{ forceUpdateNotes }}
                    </div>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn
                        unelevated
                        color="primary"
                        :label="t('update.updateNow')"
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
import { useI18n } from "src/i18n";

const { t } = useI18n();

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

// The home page and game battle page do not display the navigation bar (the battle page needs to be full screen)
const showNav = computed(() => {
    if (route.path === "/") return false;
    if (route.path.startsWith("/games/")) return false; ///games/bomberman and other battle pages are full screen
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

// Forced update: Block use when the current version is lower than the backend min_supported
const appVersion = APP_VERSION || "unknown";
const forceUpdate = ref(false);
const forceUpdateNotes = ref("");
let forceUpdateUrl = "";

const FORCE_UPDATE_TRIED_KEY = "force_update_tried";
async function checkForceUpdate() {
    if (!APP_VERSION) return; //The version is not forced when it is not injected (exception) to avoid accidental locking.
    try {
        const info = await fetchVersionInfo();
        forceUpdateUrl = info.url || "";
        forceUpdateNotes.value = info.notes || "";
        if (info.min_supported && cmpVersion(APP_VERSION, info.min_supported) < 0) {
            // Anti-dead loop: If this session has been forcibly refreshed but the version has not changed (the new version has not been deployed/is configured incorrectly),
            // It is no longer mandatory to avoid permanently locking the user.
            if (sessionStorage.getItem(FORCE_UPDATE_TRIED_KEY) === APP_VERSION) {
                console.warn(
                    "[version] Tried force update but version is still " + APP_VERSION +
                    "，lower than min_supported " + info.min_supported +
                    "：The new version may not be deployed yet，Force skipped to prevent infinite loop",
                );
                return;
            }
            forceUpdate.value = true;
        }
    } catch {
        // If the pull fails, it will not be forced to avoid accidentally locking the user due to network problems.
    }
}

const forceUpdating = ref(false);
async function doForceUpdate() {
    if (forceUpdating.value) return;
    forceUpdating.value = true;
    if (isNativeClient()) {
        // The native side (desktop/Android) can only download new installation package updates, and it is meaningless to refresh the old version packaged into the binary.
        if (forceUpdateUrl) window.open(forceUpdateUrl, "_blank");
        forceUpdating.value = false;
        return;
    }
    // Record the source version of this forced flash: if the version remains unchanged after the refresh, it will no longer be forced (see checkForceUpdate)
    try {
        sessionStorage.setItem(FORCE_UPDATE_TRIED_KEY, APP_VERSION);
    } catch {
        // Ignored when sessionStorage is unavailable
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
    // If it is already unlocked at startup, the ciphertext temporarily stored during the last lock period will be decrypted.
    if (!identity.isLocked) chatStore.processPendingMessages();
    // The scheduled deletion check is hung in the application-level life cycle to ensure that users leave the specific chat page after reading.
    // The countdown can still continue to advance and be deleted on time (the original ChatPage will be cleared when leaving)
    chatStore.startBurnTimer();
    chatStore.checkExpiredMessages();
});

// After unlocking (lock → unlock), the messages temporarily stored during the lock period will be decrypted.
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
        Notify.create({ type: "positive", message: t("header.reconnected"), timeout: 2000 });
    }
});

const canGoBack = computed(() => route.path.startsWith("/chat/"));

function doLockNow() {
    identity.lockNow();
    Notify.create({ type: "info", message: t("header.locked"), timeout: 2000 });
}

const refreshing = ref(false);
function doRefresh() {
    if (refreshing.value) return;
    refreshing.value = true;
    window.location.reload();
}

const pageTitle = computed(() => {
    if (route.path === "/") return t("header.app");
    if (route.path.startsWith("/chat/")) return route.query.nickname || t("header.chat");
    if (route.path === "/friends") return t("header.friends");
    if (route.path === "/games") return t("header.games");
    if (route.path === "/profile") return t("header.profile");
    return t("header.app");
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
