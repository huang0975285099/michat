<template>
  <!--
    Phase II Combat presentation layer（Phaser Single canvas）。
    with the first issue BattleArena.vue keep the same group props（result / Charged state），Directly interchangeable。
    Render agnostic engine(IronFistGame)with HUD No changes required。see docs Chapter 22。
  -->
  <div ref="containerRef" class="arena-canvas" />
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { createBattleRenderer } from '../game/BattleRenderer.js'

const props = defineProps({
  result: { type: Object, default: null },   //Last settlement result
  playerCharged: { type: Boolean, default: false },
  opponentCharged: { type: Boolean, default: false },
  playerEmoji: { type: String, default: '🥊' },     //Compatible with the first phase interface (not used by Vector Fighter)
  opponentEmoji: { type: String, default: '🤖' },
})

const containerRef = ref(null)
let game = null
let scene = null
let pendingResult = null

onMounted(async () => {
  await nextTick()
  game = createBattleRenderer(containerRef.value, {
    playerCharged: props.playerCharged,
    opponentCharged: props.opponentCharged,
    onReady: (sc) => {
      scene = sc
      scene.setCharge(props.playerCharged, props.opponentCharged)
      if (pendingResult) { scene.playRound(pendingResult); pendingResult = null }
    },
  })
})

onUnmounted(() => {
  game?.destroy(true)
  game = null
  scene = null
})

// The settlement result will be played as soon as it arrives; if the scene is not ready, it will be temporarily saved and will be replayed when it is ready.
watch(() => props.result, (r) => {
  if (!r) return
  if (scene) scene.playRound(r)
  else pendingResult = r
})

watch(() => [props.playerCharged, props.opponentCharged], ([p, o]) => {
  if (scene) scene.setCharge(p, o)
})
</script>

<style scoped>
.arena-canvas {
  width: 100%;
  height: 100%;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: inset 0 0 60px rgba(0, 0, 0, 0.6), 0 6px 24px rgba(0, 0, 0, 0.4);
}
.arena-canvas :deep(canvas) {
  display: block;
  border-radius: 16px;
}
</style>
