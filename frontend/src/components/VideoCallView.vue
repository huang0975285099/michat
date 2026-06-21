<template>
    <div v-if="visible" class="video-call">
        <!-- 远端画面（铺满） -->
        <video
            ref="remoteEl"
            class="remote-video"
            autoplay
            playsinline
        />

        <!-- 呼叫中 / 等待对方画面时的占位 -->
        <div v-if="showPlaceholder" class="placeholder column flex-center">
            <q-spinner-dots color="white" size="40px" />
            <div class="text-white q-mt-md">{{ statusText }}</div>
        </div>

        <!-- 顶部信息 -->
        <div class="top-bar">
            <div class="text-white text-subtitle1">{{ peerName }}</div>
            <div v-if="callStore.state === 'active'" class="text-white text-caption">
                {{ formatDuration(duration) }}
            </div>
        </div>

        <!-- 本地画面（小窗） -->
        <video
            ref="localEl"
            class="local-video"
            autoplay
            playsinline
            muted
        />

        <!-- 底部控制栏 -->
        <div class="controls">
            <q-btn
                round size="lg"
                :icon="muted ? 'mic_off' : 'mic'"
                :color="muted ? 'grey-8' : 'white'"
                :text-color="muted ? 'white' : 'black'"
                @click="toggleMute"
            >
                <q-tooltip>{{ muted ? '取消静音' : '静音' }}</q-tooltip>
            </q-btn>
            <q-btn
                round size="lg"
                :icon="callStore.cameraOn ? 'videocam' : 'videocam_off'"
                :color="callStore.cameraOn ? 'white' : 'grey-8'"
                :text-color="callStore.cameraOn ? 'black' : 'white'"
                @click="toggleCamera"
            >
                <q-tooltip>{{ callStore.cameraOn ? '关闭摄像头' : '开启摄像头' }}</q-tooltip>
            </q-btn>
            <q-btn
                round size="lg" icon="flip_camera_ios" color="white" text-color="black"
                @click="callStore.switchCamera()"
            >
                <q-tooltip>切换摄像头</q-tooltip>
            </q-btn>
            <q-btn
                round size="lg" icon="call_end" color="negative"
                @click="callStore.hangup()"
            >
                <q-tooltip>挂断</q-tooltip>
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

// 仅视频通话且处于呼叫/通话中时显示（来电由 IncomingCallDialog 处理）
const visible = computed(
    () => callStore.media === "video" &&
        (callStore.state === "calling" || callStore.state === "active")
);

const peerName = computed(() => callStore.peerNickname || callStore.peerId);
const showPlaceholder = computed(
    () => callStore.state === "calling" || !callStore.remoteStream
);
const statusText = computed(() =>
    callStore.state === "calling" ? `正在呼叫 ${peerName.value}...` : "等待对方画面..."
);

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

// 组件挂载/显示后绑定已有的流（srcObject 不能用模板绑定，需手动赋值）
watch(visible, async (v) => {
    if (v) {
        // 等 DOM 渲染出 video 元素后再绑定已有的流
        await nextTick();
        if (localEl.value) localEl.value.srcObject = callStore.localStream;
        if (remoteEl.value) remoteEl.value.srcObject = callStore.remoteStream;
    }
});

watch(
    () => callStore.state,
    (s) => {
        if (s === "active") {
            duration.value = 0;
            timer = setInterval(() => { duration.value++; }, 1000);
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
    transform: scaleX(-1); /* 本地预览镜像，符合直觉 */
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
