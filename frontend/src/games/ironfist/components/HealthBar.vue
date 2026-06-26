<template>
  <div class="hb-row" :class="{ 'hb-row--right': align === 'right' }">
    <div v-if="!bare" class="hb-info">
      <span class="hb-name">{{ name }}</span>
      <transition name="charge-pop">
        <span v-if="charged" class="hb-charge" title="已蓄力">⚡</span>
      </transition>
      <!-- 出招记录等附加内容，与名字同行排布以节省纵向空间 -->
      <slot />
    </div>
    <div class="hb-track" :class="{ 'hb-track--shake': hit }">
      <!-- 残血拖影：受击后缓慢追上主血条，露出红色损失段 -->
      <div class="hb-ghost" :style="{ width: pct + '%' }" />
      <div class="hb-fill" :class="hpClass" :style="{ width: pct + '%' }" />
      <span class="hb-num">{{ Math.max(0, hp) }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  name: { type: String, default: '' },
  hp: { type: Number, default: 100 },
  maxHp: { type: Number, default: 100 },
  charged: { type: Boolean, default: false },
  align: { type: String, default: 'left' }, // left | right
  bare: { type: Boolean, default: false },  // 只渲染血条本体（名字行交由外部排布）
})

const pct = computed(() => Math.max(0, Math.min(100, (props.hp / props.maxHp) * 100)))
// 三阶段血色：健康(绿) > 60，警告(橙黄) 30~60，危险(红) ≤ 30
const hpClass = computed(() => {
  if (props.hp <= 30) return 'hb-fill--critical'
  if (props.hp <= 60) return 'hb-fill--low'
  return ''
})

// 受击瞬间抖动一下血条
const hit = ref(false)
watch(() => props.hp, (now, prev) => {
  if (now < prev) {
    hit.value = true
    setTimeout(() => { hit.value = false }, 360)
  }
})
</script>

<style scoped>
.hb-row { width: 100%; }
.hb-info {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 700; margin-bottom: 4px;
  min-height: 20px;
}
.hb-row--right .hb-info { flex-direction: row-reverse; }
.hb-name { flex: 0 0 auto; letter-spacing: 0.5px; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6); }
.hb-charge {
  flex: 0 0 auto;
  font-size: 13px; line-height: 1; color: #ffca28;
  filter: drop-shadow(0 0 6px rgba(255, 193, 7, 0.9));
  animation: glow 1.1s ease-in-out infinite;
}
.hb-track {
  position: relative; height: 18px; border-radius: 9px;
  background: rgba(0, 0, 0, 0.45); overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.5);
}
.hb-track--shake { animation: hbShake 0.34s; }
/* 镜像布局：我方填充锚定左（右侧收缩），对手填充锚定右（左侧收缩） */
.hb-row--right .hb-ghost,
.hb-row--right .hb-fill { left: auto; right: 0; }

/* 拖影层（红，慢速延迟收缩） */
.hb-ghost {
  position: absolute; top: 0; left: 0; height: 100%; border-radius: 9px;
  background: linear-gradient(90deg, #ff7043, #d84315);
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.22s;
}
/* 主血条（快速收缩，盖在拖影上） */
.hb-fill {
  position: absolute; top: 0; left: 0; height: 100%; border-radius: 9px;
  background: linear-gradient(90deg, #43e97b, #38f9d7);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.4);
  transition: width 0.32s cubic-bezier(0.4, 0, 0.2, 1);
}
.hb-fill::after { /* 高光条 */
  content: ''; position: absolute; inset: 0 0 50% 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.35), transparent);
  border-radius: 9px 9px 0 0;
}
/* 健康（默认绿）见 .hb-fill；以下为警告 / 危险两阶段 */
.hb-fill--low { background: linear-gradient(90deg, #ffce4d, #ff9f43); }   /* 警告：橙黄 */
.hb-fill--critical {
  background: linear-gradient(90deg, #ff5b5b, #d72638);                    /* 危险：红 */
  animation: critPulse 0.7s ease-in-out infinite;
}
.hb-num {
  position: absolute; top: 50%; left: 8px; transform: translateY(-50%);
  font-size: 11px; font-weight: 800; color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  z-index: 1;
}
.hb-row--right .hb-num { left: auto; right: 8px; }

.charge-pop-enter-active { transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1); }
.charge-pop-enter-from { opacity: 0; transform: scale(0.4); }
.charge-pop-leave-active { transition: opacity 0.2s; }
.charge-pop-leave-to { opacity: 0; }

@keyframes glow {
  0%, 100% { opacity: 0.7; filter: drop-shadow(0 0 4px rgba(255, 193, 7, 0.6)); }
  50% { opacity: 1; filter: drop-shadow(0 0 10px rgba(255, 193, 7, 1)); }
}
@keyframes critPulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.4); } }
@keyframes hbShake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-3px); } 75% { transform: translateX(3px); }
}
</style>
