<template>
    <q-page class="q-pa-md">
        <!-- search bar -->
        <q-input
            :model-value="searchId"
            outlined
            dense
            :placeholder="t('friends.searchPlaceholder')"
            class="q-mb-md"
            maxlength="9"
            @update:model-value="searchId = ($event || '').toUpperCase()"
            @keyup.enter="search"
        >
            <template #append>
                <q-btn
                    flat
                    dense
                    icon="search"
                    :loading="searching"
                    @click="search"
                />
            </template>
        </q-input>

        <!-- Search results -->
        <q-card v-if="searchResult" class="q-mb-md">
            <q-item>
                <q-item-section avatar>
                    <deterministic-avatar
                        :seed="searchResult.chat_id"
                        :size="40"
                    />
                </q-item-section>
                <q-item-section>
                    <q-item-label>{{ searchResult.nickname }}</q-item-label>
                    <q-item-label caption>{{
                        searchResult.chat_id
                    }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                    <q-btn
                        unelevated
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
        <div v-if="requests.length > 0" class="q-mb-md">
            <div class="text-subtitle2 q-mb-sm text-grey">
                {{ t("friends.pending", { count: requests.length }) }}
            </div>
            <q-card>
                <q-item v-for="req in requests" :key="req.id" class="q-py-sm">
                    <q-item-section avatar>
                        <deterministic-avatar
                            :seed="req.from_chat_id"
                            :size="40"
                        />
                    </q-item-section>
                    <q-item-section>
                        <q-item-label>{{ req.from_nickname }}</q-item-label>
                        <q-item-label caption>{{
                            req.from_chat_id
                        }}</q-item-label>
                    </q-item-section>
                    <q-item-section side>
                        <div class="row q-gutter-xs">
                            <q-btn
                                size="sm"
                                unelevated
                                color="positive"
                                :label="t('common.accept')"
                                @click="handle(req.id, true)"
                            />
                            <q-btn
                                size="sm"
                                unelevated
                                color="negative"
                                :label="t('common.reject')"
                                @click="handle(req.id, false)"
                            />
                        </div>
                    </q-item-section>
                </q-item>
            </q-card>
        </div>

        <!-- Application I sent -->
        <div v-if="outgoing.length > 0" class="q-mb-md">
            <div class="text-subtitle2 q-mb-sm text-grey">
                {{ t("friends.applying", { count: outgoing.length }) }}
            </div>
            <q-card>
                <q-item v-for="req in outgoing" :key="req.id" class="q-py-sm">
                    <q-item-section avatar>
                        <deterministic-avatar
                            :seed="req.to_chat_id"
                            :size="40"
                        />
                    </q-item-section>
                    <q-item-section>
                        <q-item-label>{{ req.to_nickname }}</q-item-label>
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
        <div class="text-subtitle2 q-mb-sm text-grey">
            {{ t("friends.list", { count: friends.length }) }}
        </div>
        <q-card v-if="friends.length > 0" bordered>
            <q-item
                v-for="(f, i) in sortedFriends"
                :key="f.chat_id"
                clickable
                class="chat-list-item"
                :class="{ 'border-top': i > 0 }"
                @click="openChat(f)"
            >
                <q-item-section avatar>
                    <deterministic-avatar :seed="f.chat_id" :size="40" />
                </q-item-section>
                <q-item-section>
                    <q-item-label>{{ f.nickname }}</q-item-label>
                    <q-item-label caption>
                        {{ f.chat_id }}
                        <span class="text-grey-6">· {{ formatLastSeen(f.last_seen, f.online) }}</span>
                    </q-item-label>
                </q-item-section>
                <q-item-section side>
                    <q-icon
                        name="circle"
                        :color="f.online ? 'positive' : 'grey-4'"
                        size="10px"
                    />
                </q-item-section>
            </q-item>
        </q-card>
        <div v-else class="text-center text-grey q-mt-lg">
            {{ t("friends.empty") }}
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
    const [reqRes, outRes, friendRes] = await Promise.all([
        friendApi.getRequests(),
        friendApi.getOutgoing(),
        friendApi.getFriends(),
    ]);
    requests.value = reqRes.data;
    outgoing.value = outRes.data;
    friends.value = friendRes.data;
    identityStore.setPendingRequestCount(
        requests.value.filter((r) => r.status === "pending").length
    );
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
.border-top {
    border-top: 1px solid rgba(0, 0, 0, 0.18);
}
</style>
