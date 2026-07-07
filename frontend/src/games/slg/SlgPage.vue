<template>
    <q-page class="slg-page">
        <!-- 加载中遮罩 -->
        <div v-if="loading" class="slg-loading">
            <q-spinner-dots size="48px" color="primary" />
            <div class="slg-loading-text">{{ loadingText }}</div>
        </div>
        <!-- 游戏整体（大世界 + 全部 UI）均由 Phaser 渲染，本组件仅负责挂载与路由 -->
        <div class="map-wrapper" ref="gameContainerRef" />
    </q-page>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useIdentityStore } from 'src/stores/identity'
import { GameState } from './game/core/GameState.js'
import { createSlgGame } from './game/SlgGame.js'
import { SlgGameNet } from './game/GameNet.js'
import { slgApi } from 'src/services/api'

defineOptions({ name: 'SlgPage' })

const router = useRouter()
const identityStore = useIdentityStore()
const gameContainerRef = ref(null)
const loading = ref(true)
const loadingText = ref('正在加入世界...')
let phaserGame = null
let state = null
let gameNet = null
let saveTimer = null
let territoryUnsub = null

onMounted(async () => {
    try {
        loadingText.value = '正在加入世界...'
        // 1. 通过 HTTP 加入世界
        const { data } = await slgApi.join()
        const { seed, spawn_x, spawn_y, is_new_player, state: savedState, territories } = data

        loadingText.value = '正在加载地图...'

        // 2. 创建 GameState，使用服务器分配的种子与出生点
        const chatId = identityStore.chatId
        state = new GameState(seed, {
            spawnOverride: { x: spawn_x, y: spawn_y },
            online: true,
            chatId,
        })

        // 3. 恢复存档（非新玩家）
        if (!is_new_player && savedState) {
            state.applyServerSave(savedState)
        }

        // 4. 应用其他玩家领地
        if (territories) {
            state.applyServerTerritories(territories)
        }

        // 5. 创建 Phaser 游戏
        phaserGame = createSlgGame(gameContainerRef.value, state)
        phaserGame.events.on('slg-exit', onExit)

        // 6. 初始化网络层（WS 订阅）
        gameNet = new SlgGameNet()
        gameNet.onTerritoryUpdate((ev) => {
            state?.applyTerritoryUpdate(ev)
        })
        gameNet.joinWorld()

        // 7. 监听本地领地变更，同步到服务器
        territoryUnsub = state.on('territory', async (ev) => {
            if (ev.owner === 'player') {
                // 玩家占领新地块
                try {
                    await slgApi.updateTerritory({
                        x: ev.x, y: ev.y, is_city: false, action: 'claim',
                    })
                } catch (e) { /* 同步失败不阻塞游戏 */ }
            } else {
                // owner 为 null（玩家放弃）或 AI 势力 ID（AI 攻占了玩家地块）：
                // 统一发 abandon。若玩家在服务器上并不持有该地块，DELETE 是 no-op，无副作用。
                try {
                    await slgApi.updateTerritory({
                        x: ev.x, y: ev.y, is_city: false, action: 'abandon',
                    })
                } catch (e) { /* 同步失败不阻塞游戏 */ }
            }
        })

        // 8. 定期保存到服务器（每 30 秒）
        saveTimer = setInterval(saveToServer, 30000)
        window.addEventListener('beforeunload', saveNow)

        loading.value = false
    } catch (e) {
        console.error('[slg] join failed:', e)
        loadingText.value = '加入世界失败，正在进入单机模式...'
        // 降级为单机模式
        state = GameState.load() || new GameState((Math.random() * 2 ** 31) | 0)
        phaserGame = createSlgGame(gameContainerRef.value, state)
        phaserGame.events.on('slg-exit', onExit)
        window.addEventListener('beforeunload', saveNow)
        loading.value = false
    }
})

onUnmounted(() => {
    window.removeEventListener('beforeunload', saveNow)
    saveNow()
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null }
    if (territoryUnsub) { territoryUnsub(); territoryUnsub = null }
    if (gameNet) { gameNet.leaveWorld(); gameNet = null }
    phaserGame?.destroy(true)
    phaserGame = null
    state = null
})

function saveNow() {
    state?.save()
    if (state?.online) saveToServer()
}

async function saveToServer() {
    if (!state?.online) return
    try {
        await slgApi.saveState(state.toServerState())
    } catch (e) {
        console.warn('[slg] save to server failed:', e)
    }
}

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
.slg-loading {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: #1a2419;
    color: #d4c8a8;
}
.slg-loading-text {
    font-size: 14px;
    opacity: 0.8;
}
</style>
