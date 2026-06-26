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
      <!--
        SVG 血条：viewBox 锁定 100x18，rect 永远画满宽度，
        通过 clip-path 裁剪右/左侧露出 pct% 区域。
        好处：渐变/高光保持稳定不变形，宽度变化只擦除不重绘。
      -->
      <svg class="hb-svg" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient :id="gradId" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" :stop-color="gradStart" />
            <stop offset="100%" :stop-color="gradEnd" />
          </linearGradient>
          <linearGradient :id="ghostId" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#ff7043" />
            <stop offset="100%" stop-color="#d84315" />
          </linearGradient>
          <!-- 内发光：血条边缘柔光 -->
          <filter :id="glowId" x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur stdDeviation="0.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <!-- 轨道 -->
        <rect x="0" y="0" width="100" height="18" rx="9" class="hb-track-rect" />

        <!-- 残血拖影（红，慢速延迟收缩） -->
        <rect
          x="0" y="0" width="100" height="18" rx="9"
          :fill="`url(#${ghostId})`"
          class="hb-ghost-rect"
          :style="{ 'clip-path': ghostClip }"
        />

        <!-- 主血条（快速收缩，盖在拖影上） -->
        <rect
          x="0" y="0" width="100" height="18" rx="9"
          :fill="`url(#${gradId})`"
          class="hb-fill-rect"
          :class="hpClass"
          :filter="`url(#${glowId})`"
          :style="{ 'clip-path': fillClip }"
        />

        <!-- 顶部高光条 -->
        <rect
          x="0" y="0" width="100" height="9" rx="9"
          fill="url(#shineGrad)"
          class="hb-shine-rect"
          :style="{ 'clip-path': fillClip }"
        />

        <!-- 受击白闪：命中瞬间血量区域闪一下再淡出（key 变化强制重放动画） -->
        <rect
          v-if="flash" :key="flashKey"
          x="0" y="0" width="100" height="18" rx="9"
          fill="#fff" class="hb-flash-rect"
          :style="{ 'clip-path': fillClip }"
        />
        <linearGradient id="shineGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.45)" />
          <stop offset="100%" stop-color="rgba(255,255,255,0)" />
        </linearGradient>
      </svg>
      <span class="hb-num" :class="{ 'hb-num--hit': hit }">{{ Math.max(0, Math.round(displayHp)) }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, useId, onUnmounted } from 'vue'

const props = defineProps({
  name: { type: String, default: '' },
  hp: { type: Number, default: 100 },
  maxHp: { type: Number, default: 100 },
  charged: { type: Boolean, default: false },
  align: { type: String, default: 'left' }, // left | right
  bare: { type: Boolean, default: false },  // 只渲染血条本体（名字行交由外部排布）
})

// 每实例唯一 id，避免同页面多 HealthBar 渐变冲突
const uid = useId()
const gradId = `hb-grad-${uid}`
const ghostId = `hb-ghost-${uid}`
const glowId = `hb-glow-${uid}`

const pct = computed(() => Math.max(0, Math.min(100, (props.hp / props.maxHp) * 100)))
// 三阶段血色：健康(绿) > 60，警告(橙黄) 30~60，危险(红) ≤ 30
const hpClass = computed(() => {
  if (props.hp <= 30) return 'hb-fill--critical'
  if (props.hp <= 60) return 'hb-fill--low'
  return ''
})
// 三阶段渐变 stop 色（覆盖默认绿色）
const gradStart = computed(() => {
  if (props.hp <= 30) return '#ff5b5b'
  if (props.hp <= 60) return '#ffce4d'
  return '#43e97b'
})
const gradEnd = computed(() => {
  if (props.hp <= 30) return '#d72638'
  if (props.hp <= 60) return '#ff9f43'
  return '#38f9d7'
})

// clip-path inset 裁剪：
//   我方（left）: 裁右侧 → inset(0 (100-pct)% 0 0)
//   对手（right）: 裁左侧 → inset(0 0 0 (100-pct)%)
// 主血条快速收缩，拖影慢速延迟追上
const rightCut = computed(() => Math.max(0, 100 - pct.value))
const fillClip = computed(() =>
  props.align === 'right'
    ? `inset(0 0 0 ${rightCut.value}%)`
    : `inset(0 ${rightCut.value}% 0 0)`
)
const ghostClip = computed(() =>
  props.align === 'right'
    ? `inset(0 0 0 ${rightCut.value}%)`
    : `inset(0 ${rightCut.value}% 0 0)`
)

// 受击反馈：抖动 + 白闪 + 数字滚动扣减
const hit = ref(false)
const flash = ref(false)
const flashKey = ref(0)
const displayHp = ref(props.hp)
let hitTimer = null, flashTimer = null, rafId = null

watch(() => props.hp, (now, prev) => {
  if (now < prev) {
    hit.value = true
    clearTimeout(hitTimer); hitTimer = setTimeout(() => { hit.value = false }, 360)
    flash.value = true; flashKey.value++
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { flash.value = false }, 300)
  }
  // 数字从旧值 ease-out 滚到新值，与血条收缩同步（而非瞬间跳变）
  cancelAnimationFrame(rafId)
  const from = displayHp.value, to = now, t0 = performance.now(), dur = 420
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / dur)
    displayHp.value = from + (to - from) * (1 - Math.pow(1 - k, 3))
    if (k < 1) rafId = requestAnimationFrame(step)
    else displayHp.value = to
  }
  rafId = requestAnimationFrame(step)
})

onUnmounted(() => { cancelAnimationFrame(rafId); clearTimeout(hitTimer); clearTimeout(flashTimer) })
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

.hb-svg {
  display: block; width: 100%; height: 100%;
  /* 防止 SVG 子像素描边抖动 */
  shape-rendering: geometricPrecision;
}
.hb-track-rect { fill: rgba(0, 0, 0, 0); }

/* 拖影层：clip-path 慢速延迟过渡（受击时先停在原位，再慢慢追上） */
.hb-ghost-rect {
  transition: clip-path 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.22s;
}
/* 主血条：clip-path 快速过渡 */
.hb-fill-rect {
  transition: clip-path 0.32s cubic-bezier(0.4, 0, 0.2, 1);
}
.hb-fill-rect.hb-fill--critical {
  animation: critPulse 0.7s ease-in-out infinite;
}
/* 高光条与主血条同步收缩 */
.hb-shine-rect {
  transition: clip-path 0.32s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}

/* 受击白闪层：盖在主血条上，0.3s 提亮后淡出（screen 混合让它读作"高光"而非纯白块） */
.hb-flash-rect {
  pointer-events: none;
  mix-blend-mode: screen;
  animation: hbFlash 0.3s ease-out forwards;
}

.hb-num {
  position: absolute; top: 50%; left: 8px; transform: translateY(-50%);
  font-size: 11px; font-weight: 800; color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  z-index: 1; pointer-events: none;
}
.hb-row--right .hb-num { left: auto; right: 8px; }
.hb-num--hit { animation: numPunch 0.3s ease-out; }

.charge-pop-enter-active { transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1); }
.charge-pop-enter-from { opacity: 0; transform: scale(0.4); }
.charge-pop-leave-active { transition: opacity 0.2s; }
.charge-pop-leave-to { opacity: 0; }

@keyframes glow {
  0%, 100% { opacity: 0.7; filter: drop-shadow(0 0 4px rgba(255, 193, 7, 0.6)); }
  50% { opacity: 1; filter: drop-shadow(0 0 10px rgba(255, 193, 7, 1)); }
}
@keyframes critPulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.4); } }
@keyframes hbFlash { 0% { opacity: 0.75; } 100% { opacity: 0; } }
@keyframes numPunch {
  0% { transform: translateY(-50%) scale(1.5); color: #fff5b0; }
  100% { transform: translateY(-50%) scale(1); color: #fff; }
}
@keyframes hbShake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-3px); } 75% { transform: translateX(3px); }
}
</style>
