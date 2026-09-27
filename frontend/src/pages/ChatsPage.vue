<template>
    <q-page class="conversation-page">
      <div class="conversation-shell">
        <div class="section-heading"><span>{{ t("chats.recent") }}</span><span class="section-count">{{ recentChats.length }}</span></div>
        <div v-if="recentChats.length === 0" class="empty-state">
            <div class="empty-icon"><q-icon name="chat_bubble_outline" size="34px" /></div>
            <div class="empty-title">{{ t("chats.empty") }}</div>
            <div class="empty-hint">{{ t("chats.emptyHint") }}</div>
            <q-btn flat color="primary" no-caps :label="t('nav.friends')" @click="router.push('/friends')" />
        </div>

        <q-list v-else separator class="conversation-list">
            <q-item
                v-for="chat in recentChats"
                :key="chat.chatId"
                clickable
                class="conversation-item"
                :class="{ 'has-unread': chat.unread > 0 }"
                @click="openChat(chat)"
            >
                <q-item-section avatar>
                    <div class="avatar-wrap">
                        <deterministic-avatar :seed="chat.chatId" :size="44" />
                        <span v-if="chat.online" class="online-dot" />
                    </div>
                </q-item-section>
                <q-item-section>
                    <div class="name-line">
                        <span class="conversation-name">{{ chat.nickname }}</span>
                        <span v-if="chat.deregistered" class="account-status">{{ t('chats.loggedOut') }}</span>
                    </div>
                    <div class="message-preview">{{ chat.lastMessage }}</div>
                </q-item-section>
                <q-item-section side top class="conversation-meta">
                    <span class="conversation-time">{{ formatTime(chat.ts) }}</span>
                    <span v-if="chat.unread > 0" class="unread-badge">{{ chat.unread > 99 ? '99+' : chat.unread }}</span>
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
        </q-list>
      </div>
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
        identity.cacheFriendPubKey(f.chat_id, f.public_key);
    }
    await chatStore.recoverOfflineUploads(data);
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
.conversation-page { min-height: 100%; background: #f5f7fa; color: #182536; }
.conversation-shell { max-width: 760px; margin: 0 auto; padding: 22px 16px 40px; }
.section-heading { display: flex; align-items: center; gap: 8px; margin: 0 3px 13px; font-size: 18px; font-weight: 700; }
.section-count { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: #e9f2fc; color: #1976d2; font-size: 11px; }
.conversation-list { overflow: hidden; border: 1px solid #e6edf4; border-radius: 15px; background: #fff; box-shadow: 0 3px 12px rgba(26, 52, 82, .025); }
.conversation-item { min-height: 77px; padding: 13px 15px; }
.conversation-list :deep(.q-separator) { margin-left: 74px; background: #eef1f5; }
.conversation-item :deep(.q-item__section--avatar) { min-width: 58px; padding-right: 13px; }
.avatar-wrap { position: relative; width: 44px; height: 44px; border-radius: 12px; overflow: visible; }
.avatar-wrap :deep(img) { border-radius: 12px; }
.online-dot { position: absolute; right: -3px; bottom: -3px; width: 12px; height: 12px; border: 2px solid #fff; border-radius: 50%; background: #30b66c; }
.name-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
.conversation-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; }
.has-unread .conversation-name { font-weight: 700; }
.account-status { flex: none; padding: 2px 5px; border-radius: 5px; background: #eff1f3; color: #7f8c99; font-size: 10px; }
.message-preview { overflow: hidden; margin-top: 6px; color: #8594a4; font-size: 12px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.has-unread .message-preview { color: #5d7084; }
.conversation-meta { align-items: flex-end; gap: 7px; min-width: 49px; padding-left: 8px; }
.conversation-time { color: #9aa7b4; font-size: 11px; white-space: nowrap; }
.unread-badge { display: inline-flex; min-width: 20px; height: 20px; align-items: center; justify-content: center; padding: 0 5px; border-radius: 10px; background: #1976d2; color: #fff; font-size: 11px; font-weight: 700; }
.empty-state { display: flex; min-height: 280px; flex-direction: column; align-items: center; justify-content: center; gap: 9px; text-align: center; }
.empty-icon { display: grid; width: 64px; height: 64px; place-items: center; border-radius: 20px; background: #e9f2fc; color: #1976d2; }
.empty-title { margin-top: 5px; font-size: 15px; font-weight: 700; }
.empty-hint { max-width: 270px; color: #8393a3; font-size: 12px; line-height: 1.6; }
@media (min-width: 640px) { .conversation-shell { padding: 28px 28px 52px; } }
</style>
