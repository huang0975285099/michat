<template>
  <div class="hb-row" :class="{ 'hb-row--right': align === 'right' }">
    <div v-if="!bare" class="hb-info">
      <span class="hb-name">{{ name }}</span>
      <transition name="charge-pop">
        <span v-if="charged" class="hb-charge" title="Already charged">⚡</span>
      </transition>
      <!-- Additional content such as records of moves are arranged together with the names to save vertical space. -->
      <slot />
    </div>
    <div class="hb-track" :class="{ 'hb-track--shake': hit }">
      <!--
        SVG health bar：viewBox Lock 100x18，rect Always draw full width（right rectangle），
        Pass clip-path crop right/Left side exposed pct% area。
        The outer contour fillet is determined by the parent container .hb-track of border-radius + overflow:hidden responsible，
        avoid preserveAspectRatio="none" time SVG rx Fillets are stretched and deformed non-uniformly。
        Benefits：Gradient/Highlights remain stable without deformation，Width changes only erase and do not redraw，The rounded corners are also perfect in widescreen mode。
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
          <!-- Inner glow: Soft light at the edge of the health bar -->
          <filter :id="glowId" x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur stdDeviation="0.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <!-- Residual blood smear (red, slow delayed contraction) -->
        <rect
          x="0" y="0" width="100" height="18" rx="0"
          :fill="`url(#${ghostId})`"
          class="hb-ghost-rect"
          :style="{ 'clip-path': ghostClip }"
        />

        <!-- Main health bar (quickly shrinks, covering the smear) -->
        <rect
          x="0" y="0" width="100" height="18" rx="0"
          :fill="`url(#${gradId})`"
          class="hb-fill-rect"
          :class="hpClass"
          :filter="`url(#${glowId})`"
          :style="{ 'clip-path': fillClip }"
        />

        <!-- Top highlight strip -->
        <rect
          x="0" y="0" width="100" height="9" rx="0"
          fill="url(#shineGrad)"
          class="hb-shine-rect"
          :style="{ 'clip-path': fillClip }"
        />

        <!-- White flash when hit: The health area flashes at the moment of hit and then fades out (key change forces replay animation) -->
        <rect
          v-if="flash" :key="flashKey"
          x="0" y="0" width="100" height="18" rx="0"
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
  bare: { type: Boolean, default: false },  //Only the health bar body is rendered (the name line is arranged externally)
})

// Unique id for each instance to avoid gradient conflicts among multiple HealthBars on the same page
const uid = useId()
const gradId = `hb-grad-${uid}`
const ghostId = `hb-ghost-${uid}`
const glowId = `hb-glow-${uid}`

const pct = computed(() => Math.max(0, Math.min(100, (props.hp / props.maxHp) * 100)))
// Three stages of blood color: Health (green) > 60, Warning (orange) 30~60, Danger (red) ≤ 30
const hpClass = computed(() => {
  if (props.hp <= 30) return 'hb-fill--critical'
  if (props.hp <= 60) return 'hb-fill--low'
  return ''
})
// Three-stage gradient stop color (overrides the default green)
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

// clip-path inset clipping:
// Our side (left): cut the right side → inset(0 (100-pct)% 0 0)
// Opponent (right): cut left → inset(0 0 0 (100-pct)%)
// The main health bar shrinks quickly, and the smear slowly catches up with delay.
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

// Hit feedback: jitter + white flash + digital scrolling deduction
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
  // The number rolls from the old value to the new value with ease-out, synchronized with the shrinkage of the health bar (rather than an instantaneous jump)
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
  /* Prevent SVG sprite sketch edges from shaking */
  shape-rendering: geometricPrecision;
}
.hb-track-rect { fill: rgba(0, 0, 0, 0); }

/* Drag layer: clip-path slow delayed transition (when hit, first stop in place, then slowly catch up) */
.hb-ghost-rect {
  transition: clip-path 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.22s;
}
/* Main health bar: clip-path quick transition */
.hb-fill-rect {
  transition: clip-path 0.32s cubic-bezier(0.4, 0, 0.2, 1);
}
.hb-fill-rect.hb-fill--critical {
  animation: critPulse 0.7s ease-in-out infinite;
}
/* The highlight bar shrinks synchronously with the main health bar */
.hb-shine-rect {
  transition: clip-path 0.32s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}

/* Hit white flash layer: covers the main health bar, brightens and then fades out in 0.3s (screen blending makes it read as "highlight" instead of pure white block) */
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
