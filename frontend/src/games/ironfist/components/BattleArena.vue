<template>
  <!--
    2D-CSS 战斗表现层（一期）。
    渲染接口 = props.result（每次结算变化时播放对战动画）+ 蓄力态。
    后续二期可整体替换为 2.5D（billboard 精灵帧）或三期 3D（Babylon.js），
    只要保持同一组 props，上层逻辑/HUD 完全不动。见 docs 第十二节动画路线。
  -->
  <div class="arena" :class="{ 'arena--shake': shaking }">
    <div class="arena-bg" />
    <div class="arena-floor" />
    <div class="arena-spot" />

    <!-- 中线能量带 -->
    <div class="arena-mid" />

    <!-- 命中爆闪（双方都受伤时的正面对撞） -->
    <transition name="clash">
      <div v-if="clash" class="clash-burst" />
    </transition>

    <!-- 对手（远景，上方） -->
    <div class="fighter fighter--opponent" :class="oppClass">
      <div class="shadow" />
      <div v-if="opponentCharged" class="charge-aura">
        <div class="charge-ring" />
        <div class="charge-core" />
      </div>
      <div class="avatar">{{ opponentEmoji }}</div>
      <div v-if="oppHit" class="impact" :class="{ 'impact--crit': oppCrit }" />
      <transition name="float">
        <div v-if="oppDmg" class="dmg-float dmg-float--opp" :class="{ 'dmg-float--crit': oppCrit }">
          <span v-if="oppCrit" class="dmg-crit-tag">CRIT</span>-{{ oppDmg }}
        </div>
      </transition>
    </div>

    <!-- 玩家（近景，下方） -->
    <div class="fighter fighter--player" :class="playerClass">
      <div class="shadow" />
      <div v-if="playerCharged" class="charge-aura">
        <div class="charge-ring" />
        <div class="charge-core" />
      </div>
      <div class="avatar">{{ playerEmoji }}</div>
      <div v-if="playerHit" class="impact" :class="{ 'impact--crit': playerCrit }" />
      <transition name="float">
        <div v-if="playerDmg" class="dmg-float dmg-float--player" :class="{ 'dmg-float--crit': playerCrit }">
          <span v-if="playerCrit" class="dmg-crit-tag">CRIT</span>-{{ playerDmg }}
        </div>
      </transition>
    </div>

    <transition name="fade">
      <div v-if="envFlash" class="env-warn">⚠ 环境伤害</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  result: { type: Object, default: null },   // 最近一次结算结果
  playerCharged: { type: Boolean, default: false },
  opponentCharged: { type: Boolean, default: false },
  playerEmoji: { type: String, default: '🥊' },
  opponentEmoji: { type: String, default: '🤖' },
})

const CRIT_THRESHOLD = 18 // ≥ 此值视为暴击（蓄力/反击重击），放大表现

const playerClass = ref('')
const oppClass = ref('')
const playerDmg = ref(0)
const oppDmg = ref(0)
const playerHit = ref(false)
const oppHit = ref(false)
const playerCrit = ref(false)
const oppCrit = ref(false)
const shaking = ref(false)
const envFlash = ref(false)
const clash = ref(false)

// 根据本方动作 + 受伤情况选择姿态
function poseFor(action, dmgTaken, dealtDmg) {
  if (action === 'attack') return 'pose-lunge'
  if (action === 'charge') return dmgTaken > 0 ? 'pose-stagger' : 'pose-charge'
  if (action === 'counter') return dealtDmg > 0 ? 'pose-dodge' : 'pose-miss'
  return 'pose-guard' // defend
}

watch(() => props.result, (r) => {
  if (!r) return
  playerClass.value = poseFor(r.playerAction, r.playerDmg, r.opponentDmg)
  oppClass.value = poseFor(r.opponentAction, r.opponentDmg, r.playerDmg)

  // 受击晃动 + 伤害数字 + 命中火花
  setTimeout(() => {
    if (r.playerDmg > 0) {
      playerDmg.value = r.playerDmg
      playerCrit.value = r.playerDmg >= CRIT_THRESHOLD
      playerHit.value = true
      playerClass.value += ' is-hit'
    }
    if (r.opponentDmg > 0) {
      oppDmg.value = r.opponentDmg
      oppCrit.value = r.opponentDmg >= CRIT_THRESHOLD
      oppHit.value = true
      oppClass.value += ' is-hit'
    }
    if (r.playerDmg > 0 || r.opponentDmg > 0) {
      shaking.value = true
      setTimeout(() => { shaking.value = false }, 360)
    }
    // 双方都受伤 → 正面对撞爆闪
    if (r.playerDmg > 0 && r.opponentDmg > 0) {
      clash.value = true
      setTimeout(() => { clash.value = false }, 320)
    }
    // 火花单独存活短一些
    setTimeout(() => { playerHit.value = false; oppHit.value = false }, 420)
  }, 240)

  if (r.envDmg > 0) {
    envFlash.value = true
    setTimeout(() => { envFlash.value = false }, 1200)
  }

  // 复位
  setTimeout(() => {
    playerClass.value = ''
    oppClass.value = ''
    playerDmg.value = 0
    oppDmg.value = 0
    playerCrit.value = false
    oppCrit.value = false
  }, 1100)
})
</script>

<style scoped>
.arena {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 16px;
  box-shadow: inset 0 0 60px rgba(0, 0, 0, 0.6), 0 6px 24px rgba(0, 0, 0, 0.4);
}
.arena--shake { animation: shake 0.36s; }

/* 背景：纵深渐变 + 顶光晕 */
.arena-bg {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse at 50% 18%, rgba(150, 110, 245, 0.4), transparent 55%),
    linear-gradient(180deg, #322764 0%, #1d1740 50%, #0e0a1e 100%);
}
.arena-bg::after { /* 暗角 */
  content: ''; position: absolute; inset: 0;
  background: radial-gradient(ellipse at 50% 50%, transparent 45%, rgba(0, 0, 0, 0.55) 100%);
}

/* 地面：透视光盘 */
.arena-floor {
  position: absolute; left: 50%; bottom: 6%;
  width: 130%; height: 42%; transform: translateX(-50%);
  background: radial-gradient(ellipse at 50% 0%, rgba(120, 90, 220, 0.45), transparent 62%);
  border-top: 2px solid rgba(170, 140, 255, 0.35);
  border-radius: 50% 50% 0 0 / 100% 100% 0 0;
  filter: blur(0.5px);
}
/* 顶部聚光 */
.arena-spot {
  position: absolute; left: 50%; top: -28%;
  width: 70%; height: 90%; transform: translateX(-50%);
  background: conic-gradient(from 180deg at 50% 0%,
    transparent 42%, rgba(190, 165, 255, 0.16) 50%, transparent 58%);
  filter: blur(6px);
  pointer-events: none;
}
.arena-mid {
  position: absolute; left: 8%; right: 8%; top: 50%;
  height: 2px; transform: translateY(-50%);
  background: linear-gradient(90deg, transparent, rgba(190, 170, 255, 0.7), transparent);
  box-shadow: 0 0 20px rgba(150, 120, 255, 0.7);
}

/* 选手 */
.fighter {
  position: absolute; left: 50%;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.fighter--opponent { top: 12%; transform: translateX(-50%); }
.fighter--player   { bottom: 12%; transform: translateX(-50%); }
.avatar {
  font-size: 78px; line-height: 1;
  filter: drop-shadow(0 8px 12px rgba(0, 0, 0, 0.55));
  user-select: none;
  transition: filter 0.2s;
}
.fighter--opponent .avatar { transform: scale(0.8); }

/* 地面投影 */
.shadow {
  position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%);
  width: 64px; height: 14px; border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  filter: blur(4px);
  z-index: -1;
  transition: width 0.22s, opacity 0.22s;
}
.fighter--opponent .shadow { width: 52px; }

/* 姿态动画 */
.pose-lunge.fighter--player   { transform: translateX(-50%) translateY(-50px) scale(1.1); }
.pose-lunge.fighter--opponent { transform: translateX(-50%) translateY(50px) scale(0.92); }
.pose-lunge .shadow { width: 40px; opacity: 0.5; }
.pose-charge .avatar { animation: bob 0.5s ease-in-out infinite alternate; }
.pose-guard .avatar  { transform: scale(0.88); filter: drop-shadow(0 0 12px #6fcaff); }
.pose-dodge.fighter--player   { transform: translateX(-26%) rotate(-14deg); }
.pose-dodge.fighter--opponent { transform: translateX(-74%) rotate(14deg); }
.pose-miss .avatar   { animation: wobble 0.4s; }
.pose-stagger .avatar { animation: wobble 0.5s; filter: grayscale(0.6) brightness(0.8); }
.is-hit .avatar { animation: hitFlash 0.34s; }

/* 蓄力光环：旋转能量环 + 核心脉冲 */
.charge-aura {
  position: absolute; width: 104px; height: 104px;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.charge-ring {
  position: absolute; width: 100%; height: 100%; border-radius: 50%;
  background: conic-gradient(from 0deg,
    transparent, rgba(255, 213, 79, 0.9), transparent 40%,
    transparent 60%, rgba(255, 170, 40, 0.9), transparent);
  -webkit-mask: radial-gradient(circle, transparent 56%, #000 58%);
  mask: radial-gradient(circle, transparent 56%, #000 58%);
  animation: spin 1.4s linear infinite;
}
.charge-core {
  position: absolute; width: 92px; height: 92px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 213, 79, 0.45), transparent 68%);
  animation: pulse 0.9s ease-in-out infinite;
}

/* 命中火花迸发 */
.impact {
  position: absolute; width: 92px; height: 92px; border-radius: 50%;
  background:
    radial-gradient(circle, rgba(255, 255, 255, 0.95) 0%, rgba(255, 220, 120, 0.7) 30%, transparent 62%);
  animation: burst 0.42s ease-out forwards;
  pointer-events: none;
}
.impact::before, .impact::after { /* 星形迸射线 */
  content: ''; position: absolute; inset: 0;
  background:
    linear-gradient(0deg, transparent 46%, rgba(255, 255, 255, 0.9) 50%, transparent 54%),
    linear-gradient(90deg, transparent 46%, rgba(255, 255, 255, 0.9) 50%, transparent 54%);
  animation: burst 0.42s ease-out forwards;
}
.impact::after { transform: rotate(45deg); opacity: 0.7; }
.impact--crit {
  width: 120px; height: 120px;
  background:
    radial-gradient(circle, rgba(255, 255, 255, 1) 0%, rgba(255, 120, 60, 0.85) 32%, transparent 64%);
}

/* 伤害数字 */
.dmg-float {
  position: absolute; font-weight: 900; font-size: 32px;
  color: #ff5a5a; text-shadow: 0 2px 8px rgba(0, 0, 0, 0.9), 0 0 14px rgba(255, 60, 60, 0.5);
  pointer-events: none; white-space: nowrap;
}
.dmg-float--opp { top: -14px; }
.dmg-float--player { bottom: -14px; }
.dmg-float--crit {
  font-size: 44px;
  color: #ffd34d;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.9), 0 0 20px rgba(255, 160, 40, 0.8);
  animation: critPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.dmg-crit-tag {
  display: block; font-size: 12px; letter-spacing: 2px;
  color: #fff; text-align: center; margin-bottom: -2px;
}

/* 对撞爆闪 */
.clash-burst {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 160px; height: 160px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.95), rgba(255, 200, 120, 0.5) 35%, transparent 70%);
}
.env-warn {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  color: #ff6b6b; font-weight: 800; font-size: 18px;
  text-shadow: 0 0 12px rgba(255, 0, 0, 0.6);
}

/* 过渡 */
.float-enter-active { transition: all 0.7s ease-out; }
.float-enter-from { opacity: 0; transform: translateY(10px) scale(0.6); }
.float-leave-active { transition: opacity 0.3s; }
.float-leave-to { opacity: 0; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.clash-enter-active { transition: all 0.32s ease-out; }
.clash-enter-from { opacity: 0; transform: translate(-50%, -50%) scale(0.2); }
.clash-leave-active { transition: opacity 0.2s; }
.clash-leave-to { opacity: 0; }

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translate(-8px, 3px); }
  50% { transform: translate(7px, -3px); }
  80% { transform: translate(-4px, 2px); }
}
@keyframes bob { from { transform: translateY(0); } to { transform: translateY(-9px); } }
@keyframes wobble {
  0%, 100% { transform: rotate(0); } 25% { transform: rotate(-11deg); } 75% { transform: rotate(11deg); }
}
@keyframes hitFlash {
  0% { filter: brightness(3.2) saturate(0); transform: scale(1.12); }
  100% { filter: brightness(1); transform: scale(1); }
}
@keyframes pulse { 0%, 100% { opacity: 0.5; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.12); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes burst {
  0% { opacity: 1; transform: scale(0.3); }
  100% { opacity: 0; transform: scale(1.25); }
}
@keyframes critPop {
  0% { transform: scale(0.4); }
  60% { transform: scale(1.25); }
  100% { transform: scale(1); }
}
</style>
