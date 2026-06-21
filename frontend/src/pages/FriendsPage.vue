<template>
    <q-page class="q-pa-md">
        <!-- 搜索栏 -->
        <q-input
            v-model="searchId"
            outlined
            dense
            placeholder="输入对方 Chat ID（如 1234-ABCD）"
            class="q-mb-md"
            maxlength="9"
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

        <!-- 搜索结果 -->
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
                        label="添加好友"
                        :loading="sendingReq"
                        @click="sendRequest"
                    />
                </q-item-section>
            </q-item>
        </q-card>

        <!-- 好友申请 -->
        <div v-if="requests.length > 0" class="q-mb-md">
            <div class="text-subtitle2 q-mb-sm text-grey">
                待处理申请 ({{ requests.length }})
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
                                label="接受"
                                @click="handle(req.id, true)"
                            />
                            <q-btn
                                size="sm"
                                unelevated
                                color="negative"
                                label="拒绝"
                                @click="handle(req.id, false)"
                            />
                        </div>
                    </q-item-section>
                </q-item>
            </q-card>
        </div>

        <!-- 我发出的申请 -->
        <div v-if="outgoing.length > 0" class="q-mb-md">
            <div class="text-subtitle2 q-mb-sm text-grey">
                申请中 ({{ outgoing.length }})
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
                            label="撤销"
                            :loading="cancelingId === req.id"
                            @click="cancel(req.id)"
                        />
                        <q-badge
                            v-else
                            color="negative"
                            label="已拒绝"
                        />
                    </q-item-section>
                </q-item>
            </q-card>
        </div>

        <!-- 好友列表 -->
        <div class="text-subtitle2 q-mb-sm text-grey">
            好友 ({{ friends.length }})
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
            暂无好友，搜索 Chat ID 添加
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

// 排序后的好友列表：在线优先，然后按最后在线时间降序
const sortedFriends = computed(() => {
    return [...friends.value].sort((a, b) => {
        // 在线的排在前面
        if (a.online !== b.online) {
            return a.online ? -1 : 1;
        }
        // 按最后在线时间降序（最近的在前）
        const aTime = a.last_seen ? new Date(a.last_seen).getTime() : 0;
        const bTime = b.last_seen ? new Date(b.last_seen).getTime() : 0;
        return bTime - aTime;
    });
});

// 格式化最后在线时间
function formatLastSeen(lastSeen, online) {
    if (online) return "在线";
    if (!lastSeen) return "从未在线";
    const date = new Date(lastSeen);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return "刚刚";
    if (diffMins < 60) return `${diffMins} 分钟前`;
    if (diffHours < 24) return `${diffHours} 小时前`;
    if (diffDays < 7) return `${diffDays} 天前`;
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
            message: "Chat ID 必须是 9 位（如 1234-ABCD）",
        });
        return;
    }
    searching.value = true;
    searchResult.value = null;
    try {
        const { data } = await userApi.search(searchId.value);
        searchResult.value = data;
    } catch {
        $q.notify({ type: "negative", message: "未找到该用户" });
    } finally {
        searching.value = false;
    }
}

async function sendRequest() {
    sendingReq.value = true;
    try {
        await friendApi.sendRequest(searchResult.value.chat_id);
        $q.notify({ type: "positive", message: "好友申请已发送" });
        searchResult.value = null;
        searchId.value = "";
        loadData(); // 刷新申请列表
    } catch (e) {
        const msg = e.response?.data?.error || "发送失败";
        $q.notify({ type: "negative", message: msg });
    } finally {
        sendingReq.value = false;
    }
}

async function cancel(reqId) {
    cancelingId.value = reqId;
    try {
        await friendApi.cancelRequest(reqId);
        $q.notify({ type: "positive", message: "已撤销好友申请" });
        loadData();
    } catch {
        $q.notify({ type: "negative", message: "撤销失败，请重试" });
    } finally {
        cancelingId.value = null;
    }
}

async function handle(reqId, accept) {
    await friendApi.handleRequest(reqId, accept);
    $q.notify({
        type: "positive",
        message: accept ? "已接受好友申请" : "已拒绝",
    });
    loadData();
}

function openChat(friend) {
    router.push({
        path: `/chat/${friend.chat_id}`,
    });
}

// 实时收到好友申请
function onFriendRequest() {
    loadData();
    $q.notify({ type: "info", message: "收到新的好友申请" });
}

// 实时收到好友申请被接受（对方同意了）
function onFriendAccepted() {
    loadData();
    $q.notify({ type: "positive", message: "好友申请已被接受" });
}

// 实时收到好友申请被拒绝
function onFriendRejected() {
    loadData();
    $q.notify({ type: "warning", message: "好友申请被拒绝" });
}

// 实时收到好友在线状态变更
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
