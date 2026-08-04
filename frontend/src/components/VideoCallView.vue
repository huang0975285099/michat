<template>
    <div v-if="visible" class="video-call">
        <!-- Remote screen (full) -->
        <video
            ref="remoteEl"
            class="remote-video"
            autoplay
            playsinline
        />

        <!-- Placeholder when calling/waiting for the other party’s screen -->
        <div v-if="showPlaceholder" class="placeholder column flex-center">
            <q-spinner-dots color="white" size="40px" />
            <div class="text-white q-mt-md">{{ statusText }}</div>
        </div>

        <!-- Top information -->
        <div class="top-bar">
            <div class="text-white text-subtitle1">{{ peerName }}</div>
            <div v-if="callStore.state === 'active'" class="text-white text-caption">
                {{ formatDuration(duration) }}
            </div>
        </div>

        <!-- Local screen (small window) -->
        <video
            ref="localEl"
            class="local-video"
            autoplay
            playsinline
            muted
        />

        <!-- bottom control bar -->
        <div class="controls">
            <q-btn
                round size="lg"
                :icon="muted ? 'mic_off' : 'mic'"
                :color="muted ? 'grey-8' : 'white'"
                :text-color="muted ? 'white' : 'black'"
                @click="toggleMute"
            >
                <q-tooltip>{{ muted ? 'Unmute' : 'mute' }}</q-tooltip>
            </q-btn>
            <q-btn
                round size="lg"
                :icon="callStore.cameraOn ? 'videocam' : 'videocam_off'"
                :color="callStore.cameraOn ? 'white' : 'grey-8'"
                :text-color="callStore.cameraOn ? 'black' : 'white'"
                @click="toggleCamera"
            >
                <q-tooltip>{{ callStore.cameraOn ? 'Turn off camera' : 'Turn on camera' }}</q-tooltip>
            </q-btn>
            <q-btn
                round size="lg" icon="flip_camera_ios" color="white" text-color="black"
                @click="callStore.switchCamera()"
            >
                <q-tooltip>Switch camera</q-tooltip>
            </q-btn>
            <q-btn
                round size="lg" icon="call_end" color="negative"
                @click="callStore.hangup()"
            >
                <q-tooltip>Hang up</q-tooltip>
            </q-btn>
        </div>
    </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted, nextTick } from "vue";
import { useCallStore } from "src/stores/call";

const callStore = useCallStore();
const remoteEl = ref(null);
const localEl = ref(null);
const muted = ref(false);
const duration = ref(0);
let timer = null;

// Shown only for video calls and during a call/conversation (incoming calls are handled by IncomingCallDialog)
const visible = computed(
    () => callStore.media === "video" &&
        (callStore.state === "calling" || callStore.state === "active")
);

const peerName = computed(() => callStore.peerNickname || callStore.peerId);
const showPlaceholder = computed(
    () => callStore.state === "calling" ||
        callStore.connectionStatus !== "connected" ||
        !callStore.remoteStream
);
const statusText = computed(() => {
    if (callStore.connectionStatus === "reconnecting") {
        return `Network outage，Recovering（${callStore.reconnectSeconds}seconds）`;
    }
    if (callStore.state === "calling") return `Calling ${peerName.value}...`;
    if (callStore.connectionStatus === "connecting") return "Establishing secure connection...";
    return "Waiting for the other party screen...";
});

watch(
    () => callStore.remoteStream,
    (stream) => {
        if (remoteEl.value) remoteEl.value.srcObject = stream || null;
    }
);

watch(
    () => callStore.localStream,
    (stream) => {
        if (localEl.value) localEl.value.srcObject = stream || null;
    }
);

// Bind the existing stream after the component is mounted/displayed (srcObject cannot be bound using templates and needs to be assigned manually)
watch(visible, async (v) => {
    if (v) {
        // Wait for the DOM to render the video element and then bind the existing stream.
        await nextTick();
        if (localEl.value) localEl.value.srcObject = callStore.localStream;
        if (remoteEl.value) remoteEl.value.srcObject = callStore.remoteStream;
    }
});

watch(
    () => [callStore.state, callStore.connectionStatus],
    ([s, connection]) => {
        if (s === "active" && connection === "connected") {
            clearInterval(timer);
            timer = setInterval(() => { duration.value++; }, 1000);
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

function toggleCamera() {
    callStore.setCameraEnabled(!callStore.cameraOn);
}

function formatDuration(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
}
</script>

<style scoped>
.video-call {
    position: fixed;
    inset: 0;
    background: #000;
    z-index: 3000;
}
.remote-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: #000;
}
.placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}
.top-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    padding: 16px;
    padding-top: max(16px, env(safe-area-inset-top));
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.5), transparent);
    text-align: center;
}
.local-video {
    position: absolute;
    top: max(70px, calc(env(safe-area-inset-top) + 54px));
    right: 12px;
    width: 96px;
    height: 140px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: #222;
    transform: scaleX(-1); /* Local preview image, intuitive */
}
.controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 20px;
    padding-bottom: max(20px, env(safe-area-inset-bottom));
    display: flex;
    justify-content: center;
    gap: 20px;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.5), transparent);
}
</style>
