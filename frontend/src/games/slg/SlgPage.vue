<template>
    <q-page class="slg-page">
        <!-- 游戏整体（大世界 + 全部 UI）均由 Phaser 渲染，本组件仅负责挂载与路由 -->
        <div class="map-wrapper" ref="gameContainerRef" />
    </q-page>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { GameState } from './game/core/GameState.js'
import { createSlgGame } from './game/SlgGame.js'

defineOptions({ name: 'SlgPage' })

const router = useRouter()
const gameContainerRef = ref(null)
let phaserGame = null
let state = null

onMounted(() => {
    state = GameState.load() || new GameState((Math.random() * 2 ** 31) | 0)
    phaserGame = createSlgGame(gameContainerRef.value, state)
    phaserGame.events.on('slg-exit', onExit)
    window.addEventListener('beforeunload', saveNow)
})

onUnmounted(() => {
    window.removeEventListener('beforeunload', saveNow)
    saveNow()
    phaserGame?.destroy(true)
    phaserGame = null
    state = null
})

function saveNow() { state?.save() }

function onExit() { router.push('/games') }
</script>

<style scoped>
.slg-page {
    position: relative;
    min-height: 100dvh;
    background: #1a2419;
    overflow: hidden;
}
.map-wrapper {
    position: absolute;
    inset: 0;
}
.map-wrapper :deep(canvas) {
    display: block;
}
</style>
