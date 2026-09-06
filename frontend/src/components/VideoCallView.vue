<template>
    <div
        v-if="visible"
        class="video-call"
        :class="{ 'is-minimized': minimized }"
        :role="minimized ? 'button' : undefined"
        :tabindex="minimized ? 0 : undefined"
        :aria-label="minimized ? t('call.restore') : undefined"
        @click="restoreIfMinimized"
        @keydown.enter.prevent="restoreIfMinimized"
        @keydown.space.prevent="restoreIfMinimized"
    >
        <!-- Remote screen (full) -->
        <video
            ref="remoteEl"
            class="remote-video"
            autoplay
            playsinline
        />

        <!-- Placeholder when calling/waiting for the other party’s screen -->
        <div v-if="showPlaceholder" class="placeholder column flex-center">
            <q-icon
                v-if="callStore.remoteVideoOn === false"
                name="videocam_off"
                color="white"
                size="40px"
            />
            <q-spinner-dots v-else color="white" size="40px" />
            <div class="text-white q-mt-md">{{ statusText }}</div>
        </div>

        <!-- Top information -->
        <div class="top-bar">
            <div class="text-white text-subtitle1">{{ peerName }}</div>
            <div v-if="callStore.state === 'active'" class="text-white text-caption">
                {{ formatDuration(duration) }}
            </div>
        </div>

        <q-btn
            v-if="!minimized"
            class="minimize-button"
            flat round dense
            icon="picture_in_picture_alt"
            color="white"
            :aria-label="t('call.minimize')"
            @click.stop="minimized = true"
        >
            <q-tooltip>{{ t("call.minimize") }}</q-tooltip>
        </q-btn>

        <!-- Local screen (small window) -->
        <div v-if="!minimized" class="local-preview">
            <video
                ref="localEl"
                class="local-video"
                autoplay
                playsinline
                muted
            />
            <div v-if="!callStore.localVideoOn" class="local-camera-off column flex-center">
                <q-icon name="videocam_off" color="white" size="24px" />
                <span>{{ t("call.voiceOnly") }}</span>
            </div>
        </div>

        <!-- bottom control bar -->
        <div v-if="!minimized" class="controls">
            <q-btn
                round size="lg"
                :icon="muted ? 'mic_off' : 'mic'"
                :color="muted ? 'grey-8' : 'white'"
                :text-color="muted ? 'white' : 'black'"
                @click="toggleMute"
            >
                <q-tooltip>{{ muted ? t("call.unmute") : t("call.mute") }}</q-tooltip>
            </q-btn>
            <q-btn
                round size="lg"
                :icon="callStore.localVideoOn ? 'videocam' : 'videocam_off'"
                :color="callStore.localVideoOn ? 'white' : 'grey-8'"
                :text-color="callStore.localVideoOn ? 'black' : 'white'"
                :loading="callStore.cameraStarting"
                :disable="callStore.cameraStarting"
                @click="toggleCamera"
            >
                <q-tooltip>{{ callStore.localVideoOn ? t("call.cameraOff") : t("call.cameraOn") }}</q-tooltip>
            </q-btn>
            <q-btn
                round size="lg" icon="flip_camera_ios" color="white" text-color="black"
                :disable="!callStore.localVideoOn || callStore.cameraStarting"
                @click="callStore.switchCamera()"
            >
                <q-tooltip>{{ t("call.switchCamera") }}</q-tooltip>
            </q-btn>
            <q-btn
                round size="lg" icon="call_end" color="negative"
                @click="callStore.hangup()"
            >
                <q-tooltip>{{ t("call.hangup") }}</q-tooltip>
            </q-btn>
        </div>
    </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted, nextTick } from "vue";
import { useCallStore } from "src/stores/call";
import { videoCallStatusText } from "./video-call-status.mjs";
import { useI18n } from "src/i18n";

const callStore = useCallStore();
const { t } = useI18n();
const remoteEl = ref(null);
const localEl = ref(null);
const muted = ref(false);
const duration = ref(0);
const minimized = ref(false);
let timer = null;

// Shown only for video calls and during a call/conversation (incoming calls are handled by IncomingCallDialog)
const visible = computed(
    () => callStore.media === "video" &&
        (callStore.state === "calling" || callStore.state === "active")
);

const peerName = computed(() => callStore.peerNickname || callStore.peerId);
const hasRemoteVideoTrack = computed(() => {
    return callStore.remoteStream?.getVideoTracks()
        .some(track => track.readyState !== "ended") === true;
});
const statusText = computed(() => videoCallStatusText({
    state: callStore.state,
    connectionStatus: callStore.connectionStatus,
    reconnectSeconds: callStore.reconnectSeconds,
    peerName: peerName.value,
    remoteVideoOn: callStore.remoteVideoOn,
    hasRemoteVideoTrack: hasRemoteVideoTrack.value,
    translate: t,
}));
const showPlaceholder = computed(() => statusText.value !== "");

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
        minimized.value = false;
        // Wait for the DOM to render the video element and then bind the existing stream.
        await nextTick();
        if (localEl.value) localEl.value.srcObject = callStore.localStream;
        if (remoteEl.value) remoteEl.value.srcObject = callStore.remoteStream;
    }
});

// The local <video> is removed while minimized. Rebind the same live stream
// after restoring the full view; this does not restart media capture.
watch(minimized, async (isMinimized) => {
    if (!isMinimized && visible.value) {
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

async function toggleCamera() {
    await callStore.setCameraEnabled(!callStore.localVideoOn);
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
.video-call {
    position: fixed;
    inset: 0;
    background: #000;
    z-index: 3000;
}
.video-call.is-minimized {
    inset: auto;
    top: max(12px, env(safe-area-inset-top));
    right: 12px;
    width: clamp(136px, 36vw, 200px);
    aspect-ratio: 4 / 3;
    border: 1px solid rgba(255, 255, 255, 0.45);
    border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.42);
    overflow: hidden;
    cursor: pointer;
}
.video-call.is-minimized:focus-visible {
    outline: 3px solid var(--q-primary);
    outline-offset: 2px;
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
.minimize-button {
    position: absolute;
    top: max(8px, env(safe-area-inset-top));
    right: 10px;
    z-index: 1;
    background: rgba(0, 0, 0, 0.28);
}
.is-minimized .top-bar {
    top: auto;
    bottom: 0;
    padding: 24px 8px 8px;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent);
    text-align: left;
}
.is-minimized .top-bar .text-subtitle1 {
    overflow: hidden;
    font-size: 13px;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.is-minimized .placeholder {
    padding: 8px;
    text-align: center;
}
.is-minimized .placeholder .q-mt-md {
    margin-top: 6px;
    font-size: 10px;
    line-height: 13px;
}
.local-preview {
    position: absolute;
    top: max(70px, calc(env(safe-area-inset-top) + 54px));
    right: 12px;
    width: 96px;
    height: 140px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: #222;
    overflow: hidden;
}
.local-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scaleX(-1); /* Local preview image, intuitive */
}
.local-camera-off {
    position: absolute;
    inset: 0;
    gap: 4px;
    background: rgba(0, 0, 0, 0.72);
    color: white;
    font-size: 12px;
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
