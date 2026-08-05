<template>
  <div ref="container" class="sugar-pop-canvas" />
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import Phaser from 'phaser'
import { createSugarPopGame } from './game/createSugarPopGame.js'

const container = ref(null)
let game

onMounted(() => {
  game = createSugarPopGame(container.value, { phaser: Phaser })
})

onUnmounted(() => {
  game?.destroy(true)
})
</script>

<style scoped>
.sugar-pop-canvas {
  width: 100vw;
  height: 100dvh;
  overflow: hidden;
}

.sugar-pop-canvas :deep(canvas) {
  display: block;
}
</style>
