<template>
    <div
        v-if="visible"
        class="call-bar"
        :class="{ 'is-minimized': minimized }"
        :role="minimized ? 'button' : undefined"
        :tabindex="minimized ? 0 : undefined"
        :aria-label="minimized ? t('call.restore') : undefined"
        @click="restoreIfMinimized"
        @keydown.enter.prevent="restoreIfMinimized"
        @keydown.space.prevent="restoreIfMinimized"
    >
        <audio ref="audioEl" autoplay playsinline />
        <q-icon name="call" color="positive" size="20px" />
        <div class="call-details q-ml-sm">
            <div class="text-caption text-white">{{ statusText }}</div>
            <div v-if="callStore.state === 'active'" class="text-caption text-grey-4">
                {{ formatDuration(duration) }}
            </div>
        </div>
        <div class="col" />
        <q-btn
            v-if="!minimized && callStore.state === 'active'"
            flat round dense size="sm"
            :icon="muted ? 'mic_off' : 'mic'"
            :color="muted ? 'negative' : 'white'"
            @click="toggleMute"
        >
            <q-tooltip>{{ muted ? t("call.unmute") : t("call.mute") }}</q-tooltip>
        </q-btn>
        <q-btn
            v-if="!minimized"
            flat round dense size="sm"
            icon="picture_in_picture_alt" color="white"
            :aria-label="t('call.minimize')"
            @click.stop="minimized = true"
        >
            <q-tooltip>{{ t("call.minimize") }}</q-tooltip>
        </q-btn>
        <q-btn
            v-if="!minimized"
            flat round dense size="sm"
            icon="call_end" color="negative"
            @click="callStore.hangup()"
        >
            <q-tooltip>{{ t("call.hangup") }}</q-tooltip>
        </q-btn>
    </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from "vue";
import { useCallStore } from "src/stores/call";
import { useI18n } from "src/i18n";

const callStore = useCallStore();
const { t } = useI18n();
const audioEl = ref(null);
const muted = ref(false);
const duration = ref(0);
const minimized = ref(false);
let timer = null;

const visible = computed(() => callStore.state !== "idle" && callStore.media !== "video");

const statusText = computed(() => {
    const name = callStore.peerNickname || callStore.peerId;
    if (callStore.connectionStatus === "reconnecting") {
        return t("call.reconnecting", { seconds: callStore.reconnectSeconds });
    }
    switch (callStore.state) {
        case "calling": return t("call.calling", { name });
        case "ringing": return t("call.incoming", { name });
        case "active":  return callStore.connectionStatus === "connected" ? name : t("call.connecting");
        default:        return "";
    }
});

watch(
    () => callStore.remoteStream,
    (stream) => {
        if (audioEl.value) audioEl.value.srcObject = stream || null;
    }
);

watch(visible, (isVisible) => {
    if (isVisible) minimized.value = false;
});

watch(
    () => [callStore.state, callStore.connectionStatus],
    ([s, connection]) => {
        if (s === "active" && connection === "connected") {
            clearInterval(timer);
            timer = setInterval(() => { duration.value++ }, 1000);
        } else {
            clearInterval(timer);
            timer = null;
            if (s !== "active") {
                duration.value = 0;
                muted.value = false;
            }
        }
    }
);

onUnmounted(() => clearInterval(timer));

function toggleMute() {
    muted.value = !muted.value;
    callStore.setMuted(muted.value);
}

function restoreIfMinimized() {
    if (minimized.value) minimized.value = false;
}

function formatDuration(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
}
</script>

<style scoped>
.call-bar {
    position: fixed;
    top: 50px;
    left: 0;
    right: 0;
    height: 44px;
    background: #1b5e20;
    display: flex;
    align-items: center;
    padding: 0 12px;
    z-index: 2000;
    gap: 4px;
}
.call-bar.is-minimized {
    top: max(12px, env(safe-area-inset-top));
    left: auto;
    right: 12px;
    width: min(190px, calc(100vw - 24px));
    height: 54px;
    border-radius: 27px;
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.3);
    cursor: pointer;
}
.call-bar.is-minimized:focus-visible {
    outline: 3px solid var(--q-primary);
    outline-offset: 2px;
}
.call-details {
    min-width: 0;
}
.call-details > div {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
