<template>
  <!--
    二期 战斗表现层（Phaser 单 canvas）。
    与一期 BattleArena.vue 保持同一组 props（result / 蓄力态），可直接互换。
    渲染无关引擎(IronFistGame)与 HUD 不需改动。见 docs 第二十二节。
  -->
  <div ref="containerRef" class="arena-canvas" />
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { createBattleRenderer } from '../game/BattleRenderer.js'

const props = defineProps({
  result: { type: Object, default: null },   // 最近一次结算结果
  playerCharged: { type: Boolean, default: false },
  opponentCharged: { type: Boolean, default: false },
  playerEmoji: { type: String, default: '🥊' },     // 兼容一期接口（矢量斗士不使用）
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

// 结算结果到来即播放；场景未就绪则暂存，就绪后补播
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
