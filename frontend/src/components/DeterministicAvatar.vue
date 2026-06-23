<template>
  <img
    v-if="src"
    :src="src"
    :width="size"
    :height="size"
    :style="{ width: size + 'px', height: size + 'px', display: 'block' }"
    alt=""
    draggable="false"
  />
  <span
    v-else
    :style="{ width: size + 'px', height: size + 'px', display: 'inline-block', flexShrink: 0 }"
  />
</template>

<script>
// 模块级缓存：跨所有组件实例共享（必须放在普通 <script> 块，<script setup> 的顶层
// 代码会被编进 setup()，每个实例各执行一次，无法共享）。
// 会话内 seed 通常只有 2 个（自己/对方），配合此缓存，SHA-256 + canvas 绘制
// 对每个 (seed,size) 全程只执行一次。值为「生成中的 Promise」或「完成后的 dataURL」。
const avatarCache = new Map()
</script>

<script setup>
import { ref, onMounted, watch } from 'vue'

const props = defineProps({
  seed: { type: String, required: true },
  size: { type: Number, default: 80 }
})

const src = ref(null)

onMounted(load)
watch(() => `${props.seed}@${props.size}`, load)

async function load() {
  const key = `${props.seed}@${props.size}`
  let url
  const cached = avatarCache.get(key)
  if (cached) {
    // 可能是已完成的 dataURL，也可能是仍在生成中的 Promise
    url = await cached
  } else {
    const promise = generate(props.seed, props.size)
    avatarCache.set(key, promise)
    try {
      url = await promise
      avatarCache.set(key, url)
    } catch (e) {
      avatarCache.delete(key)
      console.warn('[DeterministicAvatar] generate failed:', e)
      return
    }
  }
  // 竞态保护：await 期间 props.seed/size 可能已变，避免写入过期头像
  if (`${props.seed}@${props.size}` === key) src.value = url
}

/**
 * 根据 seed 生成确定性头像，返回 dataURL（离屏绘制，不进 DOM）
 * 算法：
 * 1. 用 SHA-256 哈希将 seed 转为确定性字节
 * 2. 取前 3 字节作为主色（RGB）
 * 3. 取第 4 字节决定背景色方案
 * 4. 用剩余字节生成对称的几何图案（3×3 网格）
 */
async function generate(seed, size) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  // 1. 生成确定性哈希
  const encoder = new TextEncoder()
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(seed))
  const hash = new Uint8Array(hashBuf)

  // 2. 主色（前 3 字节 → RGB）
  const r = hash[0], g = hash[1], b = hash[2]

  // 3. 背景色（从主色调暗或调亮）
  const bgVariant = hash[3] % 3
  const bgColor = bgVariant === 0
    ? `rgb(${Math.round(r * 0.15)}, ${Math.round(g * 0.15)}, ${Math.round(b * 0.15)})`
    : bgVariant === 1
    ? `rgb(${Math.round(r * 0.9)}, ${Math.round(g * 0.9)}, ${Math.round(b * 0.9)})`
    : '#ffffff'

  // 4. 绘制背景
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, size, size)

  // 5. 绘制对称几何图案
  const gridSize = 3
  const cellSize = size / gridSize
  const patternBytes = hash.slice(4, 13) // 9 字节控制 3×3 网格

  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.6)`
  ctx.lineWidth = Math.max(1, size / 80)

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const idx = row * gridSize + col
      const byte = patternBytes[idx]
      const cx = (col + 0.5) * cellSize
      const cy = (row + 0.5) * cellSize
      const shapeType = byte % 6
      const sz = (cellSize * 0.3) + ((byte >> 4) / 255) * (cellSize * 0.35)

      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(((byte % 4) * Math.PI) / 4)

      switch (shapeType) {
        case 0: // 圆形
          ctx.beginPath()
          ctx.arc(0, 0, sz, 0, Math.PI * 2)
          ctx.fill()
          break
        case 1: // 方形
          ctx.fillRect(-sz, -sz, sz * 2, sz * 2)
          break
        case 2: // 菱形
          ctx.beginPath()
          ctx.moveTo(0, -sz)
          ctx.lineTo(sz, 0)
          ctx.lineTo(0, sz)
          ctx.lineTo(-sz, 0)
          ctx.closePath()
          ctx.fill()
          break
        case 3: // 三角形
          ctx.beginPath()
          ctx.moveTo(0, -sz)
          ctx.lineTo(sz, sz * 0.7)
          ctx.lineTo(-sz, sz * 0.7)
          ctx.closePath()
          ctx.fill()
          break
        case 4: { // 十字
          const w = sz * 0.35
          ctx.fillRect(-w, -sz, w * 2, sz * 2)
          ctx.fillRect(-sz, -w, sz * 2, w * 2)
          break
        }
        case 5: // 圆环
          ctx.beginPath()
          ctx.arc(0, 0, sz, 0, Math.PI * 2)
          ctx.stroke()
          break
      }
      ctx.restore()
    }
  }

  // 6. 外圈边框（用哈希字节决定颜色）
  ctx.strokeStyle = `rgb(${hash[13] % 128 + 64}, ${hash[14] % 128 + 64}, ${hash[15] % 128 + 64})`
  ctx.lineWidth = Math.max(2, size / 40)
  ctx.strokeRect(0, 0, size, size)

  // 7. 圆角裁剪
  roundCanvas(ctx, size)

  return canvas.toDataURL('image/png')
}

function roundCanvas(ctx, size) {
  const radius = size * 0.15
  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.beginPath()
  ctx.moveTo(radius, 0)
  ctx.arcTo(size, 0, size, radius, radius)
  ctx.arcTo(size, size, size - radius, size, radius)
  ctx.arcTo(0, size, 0, size - radius, radius)
  ctx.arcTo(0, 0, radius, 0, radius)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}
</script>
