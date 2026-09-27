<template>
    <q-page class="friends-page">
      <div class="friends-shell">
        <q-banner v-if="loadError" dense rounded class="q-mb-md bg-red-1 text-negative">
            {{ t('friends.loadFailed') }}
            <template #action>
                <q-btn flat dense :label="t('common.retry')" @click="loadData" />
            </template>
        </q-banner>
        <!-- search bar -->
        <q-input
            :model-value="searchId"
            borderless
            dense
            :placeholder="t('friends.searchPlaceholder')"
            class="friend-search"
            maxlength="9"
            @update:model-value="searchId = ($event || '').toUpperCase()"
            @keyup.enter="search"
        >
            <template #prepend><q-icon name="search" size="20px" /></template>
            <template #append>
                <q-btn
                    flat
                    dense
                    round
                    icon="arrow_forward"
                    color="primary"
                    :aria-label="t('friends.searchAction')"
                    :loading="searching"
                    @click="search"
                />
            </template>
        </q-input>

        <!-- Search results -->
        <q-card v-if="searchResult" flat class="friend-card search-result-card">
            <q-item class="friend-item">
                <q-item-section avatar>
                    <deterministic-avatar :seed="searchResult.chat_id" :size="44" />
                </q-item-section>
                <q-item-section>
                    <q-item-label class="friend-name">{{ searchResult.nickname }}</q-item-label>
                    <q-item-label caption>{{
                        searchResult.chat_id
                    }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                    <q-btn
                        unelevated
                        no-caps
                        size="sm"
                        color="primary"
                        :label="t('friends.add')"
                        :loading="sendingReq"
                        @click="sendRequest"
                    />
                </q-item-section>
            </q-item>
        </q-card>

        <!-- friend request -->
        <div v-if="requests.length > 0" class="friend-section">
            <div class="section-heading">
                {{ t("friends.pending", { count: requests.length }) }}
            </div>
            <q-card flat class="friend-card">
                <q-item v-for="req in requests" :key="req.id" class="friend-item request-item">
                    <q-item-section avatar>
                        <deterministic-avatar
                            :seed="req.from_chat_id"
                            :size="44"
                        />
                    </q-item-section>
                    <q-item-section>
                        <q-item-label class="friend-name">{{ req.from_nickname }}</q-item-label>
                        <q-item-label caption>{{
                            req.from_chat_id
                        }}</q-item-label>
                    </q-item-section>
                    <q-item-section side>
                        <div class="request-actions">
                            <q-btn
                                size="sm"
                                unelevated
                                no-caps
                                color="primary"
                                :label="t('common.accept')"
                                @click="handle(req.id, true)"
                            />
                            <q-btn
                                size="sm"
                                flat
                                no-caps
                                color="grey-7"
                                :label="t('common.reject')"
                                @click="handle(req.id, false)"
                            />
                        </div>
                    </q-item-section>
                </q-item>
            </q-card>
        </div>

        <!-- Application I sent -->
        <div v-if="outgoing.length > 0" class="friend-section">
            <div class="section-heading">
                {{ t("friends.applying", { count: outgoing.length }) }}
            </div>
            <q-card flat class="friend-card">
                <q-item v-for="req in outgoing" :key="req.id" class="friend-item">
                    <q-item-section avatar>
                        <deterministic-avatar
                            :seed="req.to_chat_id"
                            :size="44"
                        />
                    </q-item-section>
                    <q-item-section>
                        <q-item-label class="friend-name">{{ req.to_nickname }}</q-item-label>
                        <q-item-label caption>{{
                            req.to_chat_id
                        }}</q-item-label>
                    </q-item-section>
                    <q-item-section side>
                        <q-btn
                            v-if="req.status === 'pending'"
                            size="sm"
                            flat
                            dense
                            no-caps
                            color="negative"
                            :label="t('common.cancel')"
                            :loading="cancelingId === req.id"
                            @click="cancel(req.id)"
                        />
                        <q-badge
                            v-else
                            color="negative"
                            :label="t('friends.rejected')"
                        />
                    </q-item-section>
                </q-item>
            </q-card>
        </div>

        <!-- friends list -->
        <div class="section-heading friend-list-heading">
            {{ t("friends.list", { count: friends.length }) }}
        </div>
        <q-card v-if="friends.length > 0" flat class="friend-card">
            <q-item
                v-for="f in sortedFriends"
                :key="f.chat_id"
                clickable
                class="friend-item"
                @click="openChat(f)"
            >
                <q-item-section avatar>
                    <div class="avatar-wrap">
                        <deterministic-avatar :seed="f.chat_id" :size="44" />
                        <span v-if="f.online" class="online-dot" />
                    </div>
                </q-item-section>
                <q-item-section>
                    <q-item-label class="friend-name">{{ f.nickname }}</q-item-label>
                    <q-item-label caption>
                        {{ f.chat_id }}
                    </q-item-label>
                </q-item-section>
                <q-item-section side class="friend-status">
                    <span :class="{ online: f.online }">{{ formatLastSeen(f.last_seen, f.online) }}</span>
                </q-item-section>
            </q-item>
        </q-card>
        <div v-else class="empty-state">
            <div class="empty-icon"><q-icon name="people_outline" size="34px" /></div>
            <div class="empty-title">{{ t("friends.empty") }}</div>
        </div>
      </div>
    </q-page>
</template>

<script setup>
import { ref, computed, onActivated, onDeactivated } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useQuasar } from "quasar";
import { userApi, friendApi } from "src/services/api";
import { on, off } from "src/services/websocket";
import { useIdentityStore } from "src/stores/identity";
import DeterministicAvatar from "src/components/DeterministicAvatar.vue";
import { useI18n } from "src/i18n";

const $q = useQuasar();
const router = useRouter();
const route = useRoute();
const identityStore = useIdentityStore();
const { locale, t } = useI18n();

const searchId = ref("");
const searchResult = ref(null);
const searching = ref(false);
const sendingReq = ref(false);
const requests = ref([]);
const outgoing = ref([]);
const friends = ref([]);
const cancelingId = ref(null);
const loadError = ref(false);

// Sorted friends list: online first, then descending by last online time
const sortedFriends = computed(() => {
    return [...friends.value].sort((a, b) => {
        // Online ones come first
        if (a.online !== b.online) {
            return a.online ? -1 : 1;
        }
        // Sort by last online time descending (most recent first)
        const aTime = a.last_seen ? new Date(a.last_seen).getTime() : 0;
        const bTime = b.last_seen ? new Date(b.last_seen).getTime() : 0;
        return bTime - aTime;
    });
});

// Format last online time
function formatLastSeen(lastSeen, online) {
    if (online) return t("common.online");
    if (!lastSeen) return t("friends.neverOnline");
    const date = new Date(lastSeen);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return t("friends.justNow");
    if (diffMins < 60) return t("friends.minutesAgo", { count: diffMins });
    if (diffHours < 24) return t("friends.hoursAgo", { count: diffHours });
    if (diffDays < 7) return t("friends.daysAgo", { count: diffDays });
    return date.toLocaleDateString(locale.value);
}

async function loadData() {
    loadError.value = false;
    try {
        const [reqRes, outRes, friendRes] = await Promise.all([
            friendApi.getRequests(),
            friendApi.getOutgoing(),
            friendApi.getFriends(),
        ]);
        requests.value = reqRes.data || [];
        outgoing.value = outRes.data || [];
        friends.value = friendRes.data || [];
        identityStore.setPendingRequestCount(
            requests.value.filter((r) => r.status === "pending").length
        );
    } catch (error) {
        loadError.value = true;
        console.warn('[FriendsPage] failed to load friends', error);
    }
}

async function search() {
    if (searchId.value.length !== 9) {
        $q.notify({
            type: "warning",
            message: t("friends.invalidId"),
        });
        return;
    }
    searching.value = true;
    searchResult.value = null;
    try {
        const { data } = await userApi.search(searchId.value);
        searchResult.value = data;
    } catch {
        $q.notify({ type: "negative", message: t("friends.notFound") });
    } finally {
        searching.value = false;
    }
}

async function sendRequest() {
    sendingReq.value = true;
    try {
        await friendApi.sendRequest(searchResult.value.chat_id);
        $q.notify({ type: "positive", message: t("friends.requestSent") });
        searchResult.value = null;
        searchId.value = "";
        loadData(); //Refresh application list
    } catch (e) {
        const msg = e.response?.data?.error || t("friends.sendFailed");
        $q.notify({ type: "negative", message: msg });
    } finally {
        sendingReq.value = false;
    }
}

async function cancel(reqId) {
    cancelingId.value = reqId;
    try {
        await friendApi.cancelRequest(reqId);
        $q.notify({ type: "positive", message: t("friends.requestCanceled") });
        loadData();
    } catch {
        $q.notify({ type: "negative", message: t("friends.cancelFailed") });
    } finally {
        cancelingId.value = null;
    }
}

async function handle(reqId, accept) {
    await friendApi.handleRequest(reqId, accept);
    $q.notify({
        type: "positive",
        message: accept ? t("friends.requestAccepted") : t("friends.requestRejected"),
    });
    loadData();
}

function openChat(friend) {
    router.push({
        path: `/chat/${friend.chat_id}`,
    });
}

// Receive friend requests in real time
function onFriendRequest() {
    loadData();
    $q.notify({ type: "info", message: t("friends.newRequest") });
}

// Receive a friend request in real time and be accepted (the other party agrees)
function onFriendAccepted() {
    loadData();
    $q.notify({ type: "positive", message: t("friends.requestAccepted") });
}

// Receive a friend request that was rejected in real time
function onFriendRejected() {
    loadData();
    $q.notify({ type: "warning", message: t("friends.requestRejected") });
}

// Receive real-time changes in friends’ online status
function onStatus(payload) {
    const { chat_id, online } = payload;
    const friend = friends.value.find((f) => f.chat_id === chat_id);
    if (friend) {
        friend.online = online;
    }
}

onActivated(() => {
    loadData();
    on("friend_request", onFriendRequest);
    on("friend_accepted", onFriendAccepted);
    on("friend_rejected", onFriendRejected);
    on("status", onStatus);
});

onDeactivated(() => {
    off("friend_request", onFriendRequest);
    off("friend_accepted", onFriendAccepted);
    off("friend_rejected", onFriendRejected);
    off("status", onStatus);
});
</script>

<style scoped>
.friends-page { min-height: 100%; background: #f5f7fa; color: #182536; }
.friends-shell { max-width: 760px; margin: 0 auto; padding: 22px 16px 40px; }
.friend-search { height: 46px; margin-bottom: 24px; padding: 0 13px; border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; box-shadow: 0 2px 8px rgba(21, 43, 70, .03); }
.friend-search :deep(.q-field__control) { height: 44px; min-height: 44px; }
.friend-search :deep(.q-field__prepend) { color: #8997a8; }
.friend-search :deep(.q-field__append) { padding-left: 3px; }
.friend-section { margin-bottom: 24px; }
.section-heading { margin: 0 3px 11px; color: #647a90; font-size: 13px; font-weight: 700; }
.friend-list-heading { margin-top: 7px; }
.friend-card { overflow: hidden; border: 1px solid #e6edf4; border-radius: 15px; background: #fff; box-shadow: 0 3px 12px rgba(26, 52, 82, .025); }
.search-result-card { margin: -9px 0 24px; }
.friend-item { min-height: 74px; padding: 12px 15px; }
.friend-item + .friend-item { border-top: 1px solid #eef1f5; }
.friend-item :deep(.q-item__section--avatar) { min-width: 58px; padding-right: 13px; }
.friend-item :deep(.q-item__section--main) { min-width: 0; }
.friend-item :deep(.q-item__section--side) { padding-left: 8px; }
.friend-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #243448; font-size: 15px; font-weight: 600; }
.friend-item :deep(.q-item__label--caption) { margin-top: 5px; overflow: hidden; color: #8a9aaa; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.avatar-wrap { position: relative; width: 44px; height: 44px; }
.avatar-wrap :deep(img) { border-radius: 12px; }
.online-dot { position: absolute; right: -3px; bottom: -3px; width: 12px; height: 12px; border: 2px solid #fff; border-radius: 50%; background: #30b66c; }
.friend-status { max-width: 90px; color: #9aa7b4; font-size: 11px; text-align: right; white-space: nowrap; }
.friend-status .online { color: #2fa767; }
.request-actions { display: flex; gap: 3px; }
.request-actions :deep(.q-btn) { min-height: 30px; padding: 0 6px; font-size: 11px; }
.empty-state { display: flex; min-height: 250px; flex-direction: column; align-items: center; justify-content: center; gap: 13px; text-align: center; }
.empty-icon { display: grid; width: 64px; height: 64px; place-items: center; border-radius: 20px; background: #e9f2fc; color: #1976d2; }
.empty-title { max-width: 280px; color: #8292a2; font-size: 13px; line-height: 1.5; }
@media (min-width: 640px) { .friends-shell { padding: 28px 28px 52px; } }
</style>
