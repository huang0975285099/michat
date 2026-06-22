<template>
    <q-page class="bomberman-page">
        <!-- Lobby: pick a friend to challenge -->
        <div v-if="view === 'lobby'" class="q-pa-md">
            <div class="row items-center q-mb-md">
                <q-btn flat round dense icon="arrow_back" color="white" @click="goHome" />
                <q-icon name="sports_esports" color="primary" size="26px" class="q-ml-sm" />
                <div class="text-h6 q-ml-xs">炸弹人对战</div>
            </div>

            <q-banner rounded class="bg-primary text-white q-mb-md text-caption">
                电脑：WASD / 方向键移动，空格键放炸弹；手机：左侧摇杆移动，右下按钮放炸弹。
                炸毁软墙捡道具，消灭对手获胜！
            </q-banner>

            <div class="text-subtitle2 text-grey-7 q-mb-sm">道具说明</div>
            <div class="row q-col-gutter-sm q-mb-md">
                <div class="col-4" v-for="p in powerups" :key="p.name">
                    <div class="pu-card">
                        <div class="pu-icon">{{ p.icon }}</div>
                        <div class="text-caption text-bold">{{ p.name }}</div>
                        <div class="pu-desc">{{ p.desc }}</div>
                    </div>
                </div>
            </div>

            <div class="text-subtitle2 text-grey-7 q-mb-sm">选择在线好友开始对战</div>

            <q-list bordered separator rounded>
                <q-item v-if="loadingFriends">
                    <q-item-section class="text-center text-grey-5 q-py-md">
                        <q-spinner-dots color="primary" size="30px" />
                    </q-item-section>
                </q-item>

                <template v-else-if="onlineFriends.length">
                    <q-item v-for="f in onlineFriends" :key="f.chat_id"
                        clickable v-ripple @click="startInvite(f)">
                        <q-item-section avatar>
                            <q-avatar color="primary" text-color="white" size="40px">
                                {{ (f.nickname || f.chat_id).slice(0, 1).toUpperCase() }}
                            </q-avatar>
                        </q-item-section>
                        <q-item-section>
                            <q-item-label>{{ f.nickname || f.chat_id }}</q-item-label>
                            <q-item-label caption class="text-positive">在线</q-item-label>
                        </q-item-section>
                        <q-item-section side>
                            <q-icon name="chevron_right" color="grey-4" />
                        </q-item-section>
                    </q-item>
                </template>

                <q-item v-else>
                    <q-item-section class="text-center text-grey-5 q-py-lg">
                        暂无在线好友
                    </q-item-section>
                </q-item>
            </q-list>
        </div>

        <!-- Inviting: waiting for the other side -->
        <div v-else-if="view === 'inviting'"
            class="flex flex-center column full-height q-gutter-md q-pa-xl">
            <q-spinner-dots color="primary" size="64px" />
            <div class="text-h6">等待对方接受…</div>
            <div class="text-caption text-grey-6">{{ gameStore.opponentNickname }}</div>
            <q-btn flat color="negative" label="取消邀请" @click="gameStore.cancelInvite()" />
        </div>

        <!-- Playing: Phaser canvas -->
        <div v-else-if="view === 'playing'" class="game-wrapper">
            <div id="bomberman-container" ref="gameContainerRef" />

            <!-- 移动端虚拟摇杆 -->
            <div v-if="isTouch" class="vjoy-layer">
                <div class="vjoy-base" ref="joyBaseRef"
                    @pointerdown.prevent="joyStart"
                    @pointermove.prevent="joyMove"
                    @pointerup.prevent="joyEnd"
                    @pointercancel.prevent="joyEnd">
                    <div class="vjoy-knob"
                        :style="{ transform: `translate(${knob.x}px, ${knob.y}px)` }" />
                </div>
                <button class="vjoy-bomb" @pointerdown.prevent="fireBomb">💣</button>
            </div>
        </div>

        <!-- Result -->
        <div v-else-if="view === 'result'"
            class="flex flex-center column full-height q-gutter-lg q-pa-xl">
            <div style="font-size: 72px">{{ resultEmoji }}</div>
            <div class="text-h4 text-bold">{{ resultText }}</div>
            <q-btn color="primary" label="返回大厅" unelevated @click="backToLobby" />
        </div>
    </q-page>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from 'src/stores/game'
import { friendApi } from 'src/services/api'
import { GameNet } from './game/GameNet.js'
import { createBombermanGame } from './game/BombermanGame.js'

defineOptions({ name: 'BombermanPage' })

const route  = useRoute()
const router = useRouter()
const gameStore = useGameStore()

const powerups = [
    { icon: '🔥', name: '火焰', desc: '爆炸范围 +1（最高 6）' },
    { icon: '💣', name: '炸弹', desc: '可放炸弹数 +1（最高 5）' },
    { icon: '👟', name: '速度', desc: '移动速度提升' },
]

const view            = ref('lobby')
const loadingFriends  = ref(true)
const onlineFriends   = ref([])
const gameContainerRef = ref(null)
const resultEmoji     = ref('🎮')
const resultText      = ref('')

// 虚拟摇杆
const isTouch    = ref(false)
const joyBaseRef = ref(null)
const knob       = ref({ x: 0, y: 0 })
let joyActive = false
let joyCenter = { x: 0, y: 0 }
const JOY_RADIUS = 44

let phaserGame = null
let gameNet    = null

// ── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
    isTouch.value = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
    // Came here because someone accepted our invite OR we accepted theirs
    const role = route.query.role
    if (role === 'host' || role === 'guest') {
        await startGame(role === 'host')
        return
    }
    // Otherwise show the lobby
    loadFriends()
})

onUnmounted(() => {
    phaserGame?.destroy(true)
    gameNet?.destroy()
})

// Watch for the store transitioning to 'playing' while we're on this page
// (e.g. we sent the invite, opponent accepted, store routed us here)
watch(() => route.query.role, async (role) => {
    if ((role === 'host' || role === 'guest') && view.value !== 'playing') {
        await startGame(role === 'host')
    }
})

// ── Friends ────────────────────────────────────────────────────────────────

async function loadFriends() {
    loadingFriends.value = true
    try {
        const { data } = await friendApi.getFriends()
        onlineFriends.value = data.filter(f => f.online)
    } catch {
        onlineFriends.value = []
    } finally {
        loadingFriends.value = false
    }
}

// ── Invite flow ────────────────────────────────────────────────────────────

function startInvite(friend) {
    gameStore.invite(friend.chat_id, friend.nickname || friend.chat_id)
    view.value = 'inviting'
}

// Monitor store: if opponent rejected or timed out, go back to lobby
watch(() => gameStore.state, (s) => {
    if (s === 'idle' && view.value === 'inviting') {
        view.value = 'lobby'
    }
})

// ── Game launch ────────────────────────────────────────────────────────────

async function startGame(host) {
    view.value = 'playing'
    await nextTick()

    const opponentId = route.query.opponent
    const roomId     = route.query.room
    const seed       = Number(route.query.seed)

    gameNet = new GameNet(opponentId, roomId)

    phaserGame = createBombermanGame(gameContainerRef.value, {
        isHost: host,
        seed,
        gameNet,
        onGameEnd: handleGameEnd,
    })
}

function handleGameEnd(result) {
    phaserGame?.destroy(true)
    phaserGame = null
    gameStore.reset()

    const map = { win: ['🏆', '你赢了！'], lose: ['💀', '你输了…'], draw: ['🤝', '平局！'] }
    const [emoji, text] = map[result] || ['🎮', '游戏结束']
    resultEmoji.value = emoji
    resultText.value  = text
    view.value = 'result'
}

function backToLobby() {
    router.replace('/games/bomberman')
    view.value = 'lobby'
    loadFriends()
}

function goHome() {
    router.push('/games')
}

// ── 虚拟摇杆 ────────────────────────────────────────────────────────────────

function joyStart(e) {
    joyActive = true
    const rect = joyBaseRef.value.getBoundingClientRect()
    joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    joyBaseRef.value.setPointerCapture?.(e.pointerId)
    joyMove(e)
}

function joyMove(e) {
    if (!joyActive) return
    let dx = e.clientX - joyCenter.x
    let dy = e.clientY - joyCenter.y
    const dist = Math.hypot(dx, dy)
    if (dist > JOY_RADIUS) { dx = (dx / dist) * JOY_RADIUS; dy = (dy / dist) * JOY_RADIUS }
    knob.value = { x: dx, y: dy }
    phaserGame?.events.emit('vjoy-move', { x: dx, y: dy })
}

function joyEnd() {
    joyActive = false
    knob.value = { x: 0, y: 0 }
    phaserGame?.events.emit('vjoy-move', { x: 0, y: 0 })
}

function fireBomb() {
    phaserGame?.events.emit('vjoy-bomb')
}
</script>

<style scoped>
.bomberman-page {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    background: #0f0f1a;
    color: #fff;
}
.full-height { min-height: 60vh; }

/* 道具说明卡片 */
.pu-card {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 10px 6px;
    text-align: center;
    height: 100%;
}
.pu-icon {
    font-size: 28px;
    line-height: 1.2;
}
.pu-desc {
    font-size: 11px;
    color: #9e9e9e;
    margin-top: 2px;
}
.game-wrapper {
    display: flex;
    justify-content: center;
    align-items: flex-start;
    width: 100%;
    padding-top: 8px;
}
#bomberman-container canvas {
    display: block;
    max-width: 100vw;
}

/* 虚拟摇杆 */
.vjoy-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 1000;
}
.vjoy-base {
    position: fixed;
    left: 26px;
    bottom: calc(30px + env(safe-area-inset-bottom, 0px));
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.12);
    border: 2px solid rgba(255, 255, 255, 0.25);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    touch-action: none;
}
.vjoy-knob {
    width: 54px;
    height: 54px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.55);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    pointer-events: none;
}
.vjoy-bomb {
    position: fixed;
    right: 30px;
    bottom: calc(44px + env(safe-area-inset-bottom, 0px));
    width: 78px;
    height: 78px;
    border-radius: 50%;
    border: none;
    font-size: 36px;
    line-height: 1;
    color: #fff;
    background: rgba(255, 80, 80, 0.7);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
    pointer-events: auto;
    touch-action: none;
    user-select: none;
}
.vjoy-bomb:active {
    background: rgba(255, 80, 80, 1);
    transform: scale(0.94);
}
</style>
