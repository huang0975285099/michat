<template>
    <q-dialog v-model="show" persistent>
        <q-card style="min-width: 280px">
            <q-card-section class="text-center q-pt-lg">
                <q-icon :name="isVideo ? 'videocam' : 'call'" color="positive" size="48px" class="q-mb-sm" />
                <div class="text-h6">{{ isVideo ? '视频通话' : '语音通话' }}</div>
                <div class="text-subtitle1 text-grey-8 q-mt-xs">
                    {{ callStore.peerNickname }}
                </div>
            </q-card-section>
            <q-card-actions align="around" class="q-pb-lg">
                <div class="column items-center q-gutter-xs">
                    <q-btn round color="negative" icon="call_end" size="lg" @click="callStore.rejectCall()" />
                    <div class="text-caption text-grey-6">拒绝</div>
                </div>
                <div class="column items-center q-gutter-xs">
                    <q-btn round color="positive" icon="call" size="lg" @click="callStore.answerCall()" />
                    <div class="text-caption text-grey-6">接听</div>
                </div>
            </q-card-actions>
        </q-card>
    </q-dialog>
</template>

<script setup>
import { computed } from "vue";
import { useCallStore } from "src/stores/call";

const callStore = useCallStore();
const show = computed(() => callStore.state === "ringing");
const isVideo = computed(() => callStore.media === "video");
</script>
