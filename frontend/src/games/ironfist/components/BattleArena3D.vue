<template>
  <!--
    Phase III 3D Combat presentation layer（Babylon.js，PlanB）。
    with one/The same group in the second phase props（result / Charged state），Directly interchangeable。
    glb Automatically uses placeholder low polygon fighters by default；throw in public/games/ironfist/fighter.glb That is, upgrade to skeletal animation。
  -->
  <div ref="wrapRef" class="arena3d">
    <canvas ref="canvasRef" class="arena3d-canvas" />
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { createBattleRenderer3D } from '../game/babylon/BattleRenderer3D.js'

const props = defineProps({
  result: { type: Object, default: null },
  playerCharged: { type: Boolean, default: false },
  opponentCharged: { type: Boolean, default: false },
  playerEmoji: { type: String, default: '🥊' },     //Compatible interface (not used by 3D)
  opponentEmoji: { type: String, default: '🤖' },
})

// The moment the fist hits the ground, the renderer calls it back and turns it into an event, allowing the parent (IronFistPage) to simultaneously deduct blood/shake the avatar.
const emit = defineEmits(['impact'])

const wrapRef = ref(null)
const canvasRef = ref(null)
let ctrl = null
let ro = null
let pendingResult = null

onMounted(async () => {
  await nextTick()
  ctrl = createBattleRenderer3D(canvasRef.value, {
    playerCharged: props.playerCharged,
    opponentCharged: props.opponentCharged,
    onReady: (c) => {
      c.setCharge(props.playerCharged, props.opponentCharged)
      if (pendingResult) { c.playRound(pendingResult); pendingResult = null }
    },
    onImpact: (r) => emit('impact', r),
  })
  // Reset engine viewport when container size changes
  ro = new ResizeObserver(() => ctrl?.resize())
  ro.observe(wrapRef.value)
})

onUnmounted(() => {
  ro?.disconnect(); ro = null
  ctrl?.dispose(); ctrl = null
})

watch(() => props.result, (r) => {
  if (!r) return
  if (ctrl?.ready) ctrl.playRound(r)
  else pendingResult = r
})

watch(() => [props.playerCharged, props.opponentCharged], ([p, o]) => {
  if (ctrl?.ready) ctrl.setCharge(p, o)
})
</script>

<style scoped>
.arena3d {
  width: 100%;
  height: 100%;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: inset 0 0 60px rgba(0, 0, 0, 0.6), 0 6px 24px rgba(0, 0, 0, 0.4);
}
.arena3d-canvas {
  width: 100%;
  height: 100%;
  display: block;
  outline: none;
  touch-action: none;
}
</style>
