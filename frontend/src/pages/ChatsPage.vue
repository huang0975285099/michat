<template>
    <q-page class="q-pa-md">
        <div
            v-if="recentChats.length === 0"
            class="text-center text-grey q-mt-xl"
        >
            <q-icon name="chat_bubble_outline" size="60px" class="q-mb-md" />
            <div>{{ t("chats.empty") }}</div>
            <div class="text-caption">{{ t("chats.emptyHint") }}</div>
        </div>

        <q-card v-else bordered>
            <q-item
                v-for="(chat, i) in recentChats"
                :key="chat.chatId"
                clickable
                class="chat-list-item"
                :class="{ 'border-top': i > 0 }"
                @click="openChat(chat)"
            >
                <q-item-section avatar>
                    <deterministic-avatar :seed="chat.chatId" :size="40" />
                </q-item-section>
                <q-item-section>
                    <div class="row items-center q-gutter-xs">
                        <q-item-label>{{ chat.nickname }}</q-item-label>
                        <q-badge v-if="chat.deregistered" color="grey-5" :label="t('chats.loggedOut')" style="font-size:10px" />
                        <q-icon
                            v-if="chat.online"
                            name="circle"
                            color="positive"
                            size="8px"
                        />
                    </div>
                    <q-item-label caption lines="1">{{
                        chat.lastMessage
                    }}</q-item-label>
                </q-item-section>
                <q-item-section side top>
                    <div class="row column items-center q-gutter-xs">
                        <q-item-label caption>{{
                            formatTime(chat.ts)
                        }}</q-item-label>
                        <q-badge
                            v-if="chat.unread > 0"
                            color="primary"
                            :label="chat.unread"
                            class="unread-badge"
                        />
                    </div>
                </q-item-section>

                <q-menu context-menu @before-show="menuChat = chat">
                    <q-list dense style="min-width: 140px">
                        <q-item
                            clickable
                            v-close-popup
                            @click="deleteChat"
                            class="text-negative items-center q-gutter-xs"
                        >
                            <q-icon name="delete" size="sm" />
                            <span>{{ t("chats.delete") }}</span>
                        </q-item>
                    </q-list>
                </q-menu>
            </q-item>
        </q-card>
    </q-page>
</template>

<script setup>
import { computed, ref, onActivated, onDeactivated } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { useChatStore } from "src/stores/chat";
import { useIdentityStore } from "src/stores/identity";
import { friendApi } from "src/services/api";
import { on, off } from "src/services/websocket";
import DeterministicAvatar from "src/components/DeterministicAvatar.vue";
import { useI18n } from "src/i18n";

const $q = useQuasar();
const router = useRouter();
const chatStore = useChatStore();
const identity = useIdentityStore();
const { locale, t } = useI18n();
const friends = ref([]);
const friendMap = ref({}); //{ chatId: friend } for quick search
const onlineMap = ref({}); // { chatId: boolean }
// Whether getFriends of this page has been returned. Do not determine "logged out" before returning, use identity's startup cache instead
// Display the nickname to avoid the empty friendMap in the first frame causing the entire list to flash the chatID + logged out badge.
const friendsLoaded = ref(false);

const menuChat = ref(null);

onActivated(async () => {
    await chatStore.loadAllMessages();
    // After loading all messages, immediately clear the expired messages that will disappear after reading.
    // Avoid session list showing stale entries about to be deleted
    chatStore.checkExpiredMessages();
    const { data } = await friendApi.getFriends();
    friends.value = data;
    friendMap.value = {};
    for (const f of data) {
        friendMap.value[f.chat_id] = f;
        onlineMap.value[f.chat_id] = !!f.online;
    }
    friendsLoaded.value = true;
    on("status", handleStatus);
});

onDeactivated(() => {
    off("status", handleStatus);
});

function handleStatus(payload) {
    const { chat_id, online } = payload;
    onlineMap.value[chat_id] = online;
}

function deleteChat() {
    $q.dialog({
        title: t("chats.deleteTitle"),
        message: t("chats.deleteMessage", { name: menuChat.value.nickname }),
        cancel: true,
        persistent: true,
    }).onOk(async () => {
        const chatId = menuChat.value.chatId;
        await chatStore.clearChatMessages(chatId);
    });
}

const recentChats = computed(() => {
    // Collect all chatIds with messages
    const chatIds = new Set();
    for (const cid in chatStore.messages) {
        if (chatStore.messages[cid].length > 0) {
            chatIds.add(cid);
        }
    }

    const result = [];
    for (const chatId of chatIds) {
        const msgs = chatStore.getMessages(chatId);
        const last = msgs[msgs.length - 1];
        const friend = friendMap.value[chatId];
        const unreadCount = msgs.filter((m) => !m.mine && !m.read).length;

        result.push({
            chatId,
            // Priority is given to the latest friend data on this page; when it is not loaded, it falls back to the nickname/public key cached during the identity startup period.
            // Make the first frame display the correct nickname instead of the chatID.
            nickname: friend ? friend.nickname : identity.getFriendName(chatId),
            // Only determine "logged out" after getFriends returns on this page to avoid mislabeling during loading.
            deregistered: friendsLoaded.value && !friend,
            pubkey: friend ? friend.public_key : identity.getFriendPubKey(chatId) || "",
            lastMessage: last?.decryptionFailed || last?.text === "[Decryption failed]"
                ? t("chat.decryptionFailed")
                : last?.kind === "voice"
                    ? t("chats.voiceMessage")
                    : last?.type === "file"
                        ? t("chats.fileMessage", { name: last.filename || "" })
                        : last?.text || t("chats.startChatting"),
            ts: last?.ts || 0,
            unread: unreadCount,
            online: !!onlineMap.value[chatId],
        });
    }

    return result.sort((a, b) => b.ts - a.ts);
});

function openChat(chat) {
    router.push({
        path: `/chat/${chat.chatId}`,
        query: { nickname: chat.nickname, pubkey: chat.pubkey },
    });
}

function formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString(locale.value, {
            hour: "2-digit",
            minute: "2-digit",
        });
    }
    return d.toLocaleDateString(locale.value, { month: "numeric", day: "numeric" });
}
</script>

<style scoped>
.border-top {
    border-top: 1px solid rgba(0, 0, 0, 0.08);
}
.unread-badge {
    min-width: 18px;
    height: 18px;
    font-size: 11px;
    font-weight: 600;
}
</style>
