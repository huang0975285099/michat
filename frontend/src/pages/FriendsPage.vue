<template>
    <q-page class="q-pa-md">
        <!-- search bar -->
        <q-input
            :model-value="searchId"
            outlined
            dense
            placeholder="Enter the other party Chat ID（Such as 1234-ABCD）"
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
                        label="Add friends"
                        :loading="sendingReq"
                        @click="sendRequest"
                    />
                </q-item-section>
            </q-item>
        </q-card>

        <!-- friend request -->
        <div v-if="requests.length > 0" class="q-mb-md">
            <div class="text-subtitle2 q-mb-sm text-grey">
                Pending applications ({{ requests.length }})
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
                                label="accept"
                                @click="handle(req.id, true)"
                            />
                            <q-btn
                                size="sm"
                                unelevated
                                color="negative"
                                label="reject"
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
                Applying ({{ outgoing.length }})
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
                            label="Cancel"
                            :loading="cancelingId === req.id"
                            @click="cancel(req.id)"
                        />
                        <q-badge
                            v-else
                            color="negative"
                            label="Rejected"
                        />
                    </q-item-section>
                </q-item>
            </q-card>
        </div>

        <!-- friends list -->
        <div class="text-subtitle2 q-mb-sm text-grey">
            friends ({{ friends.length }})
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
            No friends yet，Search Chat ID add
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

const $q = useQuasar();
const router = useRouter();
const route = useRoute();
const identityStore = useIdentityStore();

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
    if (online) return "online";
    if (!lastSeen) return "never online";
    const date = new Date(lastSeen);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins} minutes ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString("zh-CN");
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
            message: "Chat ID must be 9 Bit（Such as 1234-ABCD）",
        });
        return;
    }
    searching.value = true;
    searchResult.value = null;
    try {
        const { data } = await userApi.search(searchId.value);
        searchResult.value = data;
    } catch {
        $q.notify({ type: "negative", message: "The user was not found" });
    } finally {
        searching.value = false;
    }
}

async function sendRequest() {
    sendingReq.value = true;
    try {
        await friendApi.sendRequest(searchResult.value.chat_id);
        $q.notify({ type: "positive", message: "Friend request has been sent" });
        searchResult.value = null;
        searchId.value = "";
        loadData(); //Refresh application list
    } catch (e) {
        const msg = e.response?.data?.error || "Sending failed";
        $q.notify({ type: "negative", message: msg });
    } finally {
        sendingReq.value = false;
    }
}

async function cancel(reqId) {
    cancelingId.value = reqId;
    try {
        await friendApi.cancelRequest(reqId);
        $q.notify({ type: "positive", message: "Friend request has been canceled" });
        loadData();
    } catch {
        $q.notify({ type: "negative", message: "Undo failed，Please try again" });
    } finally {
        cancelingId.value = null;
    }
}

async function handle(reqId, accept) {
    await friendApi.handleRequest(reqId, accept);
    $q.notify({
        type: "positive",
        message: accept ? "Friend request accepted" : "Rejected",
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
    $q.notify({ type: "info", message: "Received new friend request" });
}

// Receive a friend request in real time and be accepted (the other party agrees)
function onFriendAccepted() {
    loadData();
    $q.notify({ type: "positive", message: "Friend request has been accepted" });
}

// Receive a friend request that was rejected in real time
function onFriendRejected() {
    loadData();
    $q.notify({ type: "warning", message: "Friend request was rejected" });
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
