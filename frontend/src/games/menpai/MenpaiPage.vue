<template>
  <q-page class="menpai-page">
    <div class="game-wrapper" ref="gameContainerRef" />
  </q-page>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { createMenpaiGame } from './game/MenpaiGame.js'

defineOptions({ name: 'MenpaiPage' })

const router = useRouter()
const gameContainerRef = ref(null)
let phaserGame = null

onMounted(() => {
  phaserGame = createMenpaiGame(gameContainerRef.value)
  // 场景通过 game.events emit 'menpai-exit' 请求返回游戏大厅
  phaserGame.events.on('menpai-exit', () => router.push('/games'))
})

onUnmounted(() => {
  phaserGame?.destroy(true)
  phaserGame = null
})
</script>

<style scoped>
.menpai-page {
  width: 100%;
  /* 移动端浏览器地址栏会盖住 100vh 底部，dvh 跟随可视区收缩；vh 作为老浏览器兜底 */
  height: 100vh;
  height: 100dvh;
  padding: 0;
  overflow: hidden;
  /* 竖屏下禁掉双指缩放/下拉刷新，避免误触打断战斗操作 */
  touch-action: none;
  overscroll-behavior: none;
}
.game-wrapper {
  width: 100%;
  height: 100%;
}
.game-wrapper :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
</style>
