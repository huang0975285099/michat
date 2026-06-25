<template>
  <div class="hb-row" :class="{ 'hb-row--right': align === 'right' }">
    <div class="hb-info">
      <span class="hb-name">{{ name }}</span>
      <span v-if="charged" class="hb-charge" title="已蓄力">⚡</span>
    </div>
    <div class="hb-track">
      <div class="hb-fill" :class="hpClass" :style="{ width: pct + '%' }" />
      <span class="hb-num">{{ Math.max(0, hp) }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  name: { type: String, default: '' },
  hp: { type: Number, default: 100 },
  maxHp: { type: Number, default: 100 },
  charged: { type: Boolean, default: false },
  align: { type: String, default: 'left' }, // left | right
})

const pct = computed(() => Math.max(0, Math.min(100, (props.hp / props.maxHp) * 100)))
const hpClass = computed(() => {
  if (props.hp < 20) return 'hb-fill--critical'
  if (props.hp < 30) return 'hb-fill--low'
  return ''
})
</script>

<style scoped>
.hb-row { width: 100%; }
.hb-info {
  display: flex; align-items: center; gap: 4px;
  font-size: 13px; font-weight: 600; margin-bottom: 3px;
}
.hb-row--right .hb-info { flex-direction: row-reverse; }
.hb-charge { color: #ffd54f; animation: pulse 1s infinite; }
.hb-track {
  position: relative; height: 16px; border-radius: 8px;
  background: rgba(0, 0, 0, 0.35); overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.15);
}
.hb-fill {
  height: 100%; border-radius: 8px;
  background: linear-gradient(90deg, #43e97b, #38f9d7);
  transition: width 0.45s cubic-bezier(0.4, 0, 0.2, 1);
}
.hb-row--right .hb-fill { margin-left: auto; }
.hb-fill--low { background: linear-gradient(90deg, #f6d365, #fda085); }
.hb-fill--critical { background: linear-gradient(90deg, #f85032, #e73827); }
.hb-num {
  position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
  font-size: 11px; font-weight: 700; color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
.hb-row--right .hb-num { right: auto; left: 8px; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
