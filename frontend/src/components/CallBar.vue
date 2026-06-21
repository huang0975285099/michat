<template>
    <div v-if="callStore.state !== 'idle' && callStore.media !== 'video'" class="call-bar">
        <audio ref="audioEl" autoplay playsinline />
        <q-icon name="call" color="positive" size="20px" />
        <div class="q-ml-sm">
            <div class="text-caption text-white">{{ statusText }}</div>
            <div v-if="callStore.state === 'active'" class="text-caption text-grey-4">
                {{ formatDuration(duration) }}
            </div>
        </div>
        <div class="col" />
        <q-btn
            v-if="callStore.state === 'active'"
            flat round dense size="sm"
            :icon="muted ? 'mic_off' : 'mic'"
            :color="muted ? 'negative' : 'white'"
            @click="toggleMute"
        >
            <q-tooltip>{{ muted ? '取消静音' : '静音' }}</q-tooltip>
        </q-btn>
        <q-btn
            flat round dense size="sm"
            icon="call_end" color="negative"
            @click="callStore.hangup()"
        >
            <q-tooltip>挂断</q-tooltip>
        </q-btn>
    </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from "vue";
import { useCallStore } from "src/stores/call";

const callStore = useCallStore();
const audioEl = ref(null);
const muted = ref(false);
const duration = ref(0);
let timer = null;

const statusText = computed(() => {
    const name = callStore.peerNickname || callStore.peerId;
    switch (callStore.state) {
        case "calling": return `正在呼叫 ${name}...`;
        case "ringing": return `来电：${name}`;
        case "active":  return name;
        default:        return "";
    }
});

watch(
    () => callStore.remoteStream,
    (stream) => {
        if (audioEl.value) audioEl.value.srcObject = stream || null;
    }
);

watch(
    () => callStore.state,
    (s) => {
        if (s === "active") {
            duration.value = 0;
            timer = setInterval(() => { duration.value++ }, 1000);
        } else {
            clearInterval(timer);
            timer = null;
            duration.value = 0;
            muted.value = false;
        }
    }
);

onUnmounted(() => clearInterval(timer));

function toggleMute() {
    muted.value = !muted.value;
    callStore.setMuted(muted.value);
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
</style>
