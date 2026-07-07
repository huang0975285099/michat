<template>
    <q-page class="slg-page">
        <!-- 加载中遮罩 -->
        <div v-if="loading" class="slg-loading">
            <q-spinner-dots size="48px" color="primary" />
            <div class="slg-loading-text">{{ loadingText }}</div>
        </div>
        <!-- 世界已满提示（无法进入，等待管理员重置） -->
        <div v-else-if="worldFull" class="slg-loading">
            <div style="font-size: 56px">🗺️</div>
            <div class="slg-full-title">地图人员已满</div>
            <div class="slg-loading-text">当前世界已达 5 人上限，无法进入</div>
            <div class="slg-loading-text">请等待管理员重置世界</div>
            <div class="slg-full-actions">
                <q-btn v-if="identityStore.isAdmin" color="negative" label="管理员重置世界" @click="doReset" :loading="resetting" />
                <q-btn color="primary" outline label="返回游戏大厅" @click="onExit" />
            </div>
        </div>
        <!-- 游戏整体（大世界 + 全部 UI）均由 Phaser 渲染，本组件仅负责挂载与路由 -->
        <div v-else class="map-wrapper" ref="gameContainerRef" />
    </q-page>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
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
const worldFull = ref(false)
const resetting = ref(false)
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

        // 4. 应用服务端领地（含 AI 领地 + 其他玩家领地）
        if (territories) {
            state.applyServerTerritories(territories)
        }

        // 提前结束 loading，让 v-else 分支挂载 gameContainerRef 对应的容器 div，
        // 再等一次 tick 确保 Vue 已完成 DOM patch——否则 gameContainerRef.value 仍是
        // null，Phaser 的 Scale.RESIZE 量不出父容器尺寸，会以 0 尺寸初始化 WebGL，
        // 触发 "Framebuffer status: Incomplete Attachment" 且画面全黑。
        loading.value = false
        await nextTick()

        // 5. 创建 Phaser 游戏
        phaserGame = createSlgGame(gameContainerRef.value, state, { isAdmin: identityStore.isAdmin })
        phaserGame.events.on('slg-exit', onExit)
        phaserGame.events.on('slg-admin-reset-world', doReset)

        // 6. 初始化网络层（WS 订阅）
        gameNet = new SlgGameNet()
        gameNet.onTerritoryUpdate((ev) => {
            state?.applyTerritoryUpdate(ev)
        })
        // AI 扩张事件（服务端权威 AI，所有玩家共享同一份）
        gameNet.onAIExpansion((ev) => {
            state?.applyAIExpansion(ev)
        })
        // 新玩家上线时重新拉取领地列表，确保看到新玩家的已有领地
        gameNet.onPresence((ev) => {
            if (ev.online) refetchTerritories()
        })
        // WS 断线重连后借机做一次全量重新同步，避免断线期间错过的领地/上下线广播
        // 导致长期看不到别人主城附近正确的地形/守军（须手动刷新页面才恢复）
        gameNet.onReconnect(refetchTerritories)
        gameNet.joinWorld()

        // 7. 监听本地领地变更，同步到服务器
        territoryUnsub = state.on('territory', async (ev) => {
            // AI 势力领地变更由服务端权威驱动，客户端不回传服务器
            if (ev.owner === 'ai1' || ev.owner === 'ai2') return
            if (ev.owner === 'player') {
                // 玩家占领新地块
                try {
                    await slgApi.updateTerritory({
                        x: ev.x, y: ev.y, is_city: false, action: 'claim',
                    })
                } catch (e) { /* 同步失败不阻塞游戏 */ }
            } else {
                // owner 为 null（玩家放弃）：发 abandon
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
    } catch (e) {
        // 世界已满：显示提示，不进入游戏
        if (e.response?.status === 403 && e.response?.data?.error === 'world_full') {
            loading.value = false
            worldFull.value = true
            return
        }
        console.error('[slg] join failed:', e)
        loadingText.value = '加入世界失败，正在进入单机模式...'
        // 降级为单机模式
        state = GameState.load() || new GameState((Math.random() * 2 ** 31) | 0)
        loading.value = false
        await nextTick()
        phaserGame = createSlgGame(gameContainerRef.value, state)
        phaserGame.events.on('slg-exit', onExit)
        window.addEventListener('beforeunload', saveNow)
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

// 拉取全量世界快照并重新应用（新玩家上线广播 / WS 重连后补同步 均走这里）
async function refetchTerritories() {
    if (!state?.online) return
    try {
        const { data } = await slgApi.getWorld()
        if (data.territories) {
            state.applyServerTerritories(data.territories)
        }
    } catch (e) { /* 忽略 */ }
}

async function doReset() {
    resetting.value = true
    try {
        await slgApi.resetWorld()
        // 重置成功后刷新页面，重新加入新世界
        window.location.reload()
    } catch (e) {
        alert(e.response?.data?.error === 'not admin' ? '无管理员权限' : '重置失败')
    } finally {
        resetting.value = false
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
.slg-full-title {
    font-size: 22px;
    font-weight: bold;
    color: #ffb300;
}
.slg-full-actions {
    display: flex;
    gap: 12px;
    margin-top: 12px;
}
</style>
