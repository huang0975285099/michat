<template>
  <!--
    2D-CSS 战斗表现层（一期）。
    渲染接口 = props.result（每次结算变化时播放对战动画）+ props.phase。
    后续二期可整体替换为 2.5D（billboard 精灵帧）或三期 3D（Babylon.js），
    只要保持同一组 props，上层逻辑/HUD 完全不动。见 docs 第十二节动画路线。
  -->
  <div class="arena" :class="{ 'arena--shake': shaking }">
    <div class="arena-bg" />

    <!-- 对手（远景，上方） -->
    <div class="fighter fighter--opponent" :class="oppClass">
      <div v-if="opponentCharged" class="charge-aura" />
      <div class="avatar">{{ opponentEmoji }}</div>
      <transition name="float">
        <div v-if="oppDmg" class="dmg-float dmg-float--opp">-{{ oppDmg }}</div>
      </transition>
    </div>

    <div class="arena-mid" />

    <!-- 玩家（近景，下方） -->
    <div class="fighter fighter--player" :class="playerClass">
      <div v-if="playerCharged" class="charge-aura" />
      <div class="avatar">{{ playerEmoji }}</div>
      <transition name="float">
        <div v-if="playerDmg" class="dmg-float dmg-float--player">-{{ playerDmg }}</div>
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

const playerClass = ref('')
const oppClass = ref('')
const playerDmg = ref(0)
const oppDmg = ref(0)
const shaking = ref(false)
const envFlash = ref(false)

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

  // 受击晃动 + 伤害数字
  setTimeout(() => {
    if (r.playerDmg > 0) { playerDmg.value = r.playerDmg; playerClass.value += ' is-hit' }
    if (r.opponentDmg > 0) { oppDmg.value = r.opponentDmg; oppClass.value += ' is-hit' }
    if (r.playerDmg > 0 || r.opponentDmg > 0) {
      shaking.value = true
      setTimeout(() => { shaking.value = false }, 320)
    }
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
  }, 1100)
})
</script>

<style scoped>
.arena {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 14px;
}
.arena--shake { animation: shake 0.32s; }
.arena-bg {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse at 50% 30%, rgba(120, 90, 200, 0.35), transparent 60%),
    linear-gradient(180deg, #2a2150 0%, #1a1530 55%, #120e22 100%);
}
.arena-mid {
  position: absolute; left: 8%; right: 8%; top: 50%;
  height: 3px; transform: translateY(-50%);
  background: linear-gradient(90deg, transparent, rgba(180, 160, 255, 0.55), transparent);
  box-shadow: 0 0 18px rgba(140, 110, 255, 0.6);
}
.fighter {
  position: absolute; left: 50%;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.22s ease;
}
.fighter--opponent { top: 13%; transform: translateX(-50%); }
.fighter--player   { bottom: 10%; transform: translateX(-50%); }
.avatar {
  font-size: 76px; line-height: 1;
  filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.5));
  user-select: none;
}
.fighter--opponent .avatar { transform: scale(0.82); }

/* 姿态动画 */
.pose-lunge.fighter--player   { transform: translateX(-50%) translateY(-46px) scale(1.08); }
.pose-lunge.fighter--opponent { transform: translateX(-50%) translateY(46px) scale(0.9); }
.pose-charge .avatar { animation: bob 0.5s ease-in-out infinite alternate; }
.pose-guard .avatar  { transform: scale(0.9); filter: drop-shadow(0 0 10px #6fcaff); }
.pose-dodge.fighter--player   { transform: translateX(-30%) rotate(-12deg); }
.pose-dodge.fighter--opponent { transform: translateX(-70%) rotate(12deg); }
.pose-miss .avatar   { animation: wobble 0.4s; }
.pose-stagger .avatar { animation: wobble 0.5s; filter: grayscale(0.6); }
.is-hit .avatar { animation: hitFlash 0.32s; }

.charge-aura {
  position: absolute; width: 96px; height: 96px; border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 213, 79, 0.55), transparent 70%);
  animation: pulse 0.9s ease-in-out infinite;
}
.dmg-float {
  position: absolute; font-weight: 800; font-size: 30px;
  color: #ff5252; text-shadow: 0 2px 6px rgba(0, 0, 0, 0.8);
  pointer-events: none;
}
.dmg-float--opp { top: -10px; }
.dmg-float--player { bottom: -10px; }
.env-warn {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  color: #ff6b6b; font-weight: 800; font-size: 18px;
  text-shadow: 0 0 12px rgba(255, 0, 0, 0.6);
}

.float-enter-active { transition: all 0.7s ease-out; }
.float-enter-from { opacity: 0; }
.float-leave-active { transition: opacity 0.3s; }
.float-leave-to { opacity: 0; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-7px); }
  75% { transform: translateX(7px); }
}
@keyframes bob { from { transform: translateY(0); } to { transform: translateY(-8px); } }
@keyframes wobble {
  0%, 100% { transform: rotate(0); } 25% { transform: rotate(-10deg); } 75% { transform: rotate(10deg); }
}
@keyframes hitFlash {
  0% { filter: brightness(3) saturate(0); } 100% { filter: brightness(1); }
}
@keyframes pulse { 0%, 100% { opacity: 0.5; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.1); } }
</style>
