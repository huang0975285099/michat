<template>
  <!--
    三期 3D 战斗表现层（Babylon.js，方案B）。
    与一/二期同一组 props（result / 蓄力态），可直接互换。
    glb 缺省时自动用占位低多边形斗士；丢入 public/games/ironfist/fighter.glb 即升级为骨骼动画。
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
  playerEmoji: { type: String, default: '🥊' },     // 兼容接口（3D 不使用）
  opponentEmoji: { type: String, default: '🤖' },
})

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
  })
  // 容器尺寸变化时重置引擎视口
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
