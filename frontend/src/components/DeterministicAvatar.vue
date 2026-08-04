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
// Module-level cache: shared across all component instances (must be placed at the top level of a normal <script> block, <script setup>
// The code will be compiled into setup(), executed once for each instance, and cannot be shared).
// There are usually only 2 seeds in the session (self/other party). With this cache, SHA-256 + canvas drawing
// Execute exactly once for each (seed,size). The value is "generating Promise" or "completed dataURL".
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
    // This may be a completed dataURL or a Promise that is still being generated
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
  // Race protection: props.seed/size may have changed during await to avoid writing expired avatars
  if (`${props.seed}@${props.size}` === key) src.value = url
}

/**
 * Generate a deterministic avatar based on the seed and return the dataURL (off-screen drawing, without entering the DOM)
 * Algorithm:
 * 1. Use SHA-256 hash to convert seed into deterministic bytes
 * 2. Take the first 3 bytes as the main color (RGB)
 * 3. Take the 4th byte to determine the background color scheme
 * 4. Use the remaining bytes to generate a symmetrical geometric pattern (3×3 grid)
 */
async function generate(seed, size) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  // 1. Generate deterministic hash
  const encoder = new TextEncoder()
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(seed))
  const hash = new Uint8Array(hashBuf)

  // 2. Primary color (first 3 bytes → RGB)
  const r = hash[0], g = hash[1], b = hash[2]

  // 3. Background color (darken or lighten from main color)
  const bgVariant = hash[3] % 3
  const bgColor = bgVariant === 0
    ? `rgb(${Math.round(r * 0.15)}, ${Math.round(g * 0.15)}, ${Math.round(b * 0.15)})`
    : bgVariant === 1
    ? `rgb(${Math.round(r * 0.9)}, ${Math.round(g * 0.9)}, ${Math.round(b * 0.9)})`
    : '#ffffff'

  // 4. Draw the background
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, size, size)

  // 5. Draw symmetrical geometric patterns
  const gridSize = 3
  const cellSize = size / gridSize
  const patternBytes = hash.slice(4, 13) //9 bytes control 3×3 grid

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
        case 0: //round
          ctx.beginPath()
          ctx.arc(0, 0, sz, 0, Math.PI * 2)
          ctx.fill()
          break
        case 1: //square
          ctx.fillRect(-sz, -sz, sz * 2, sz * 2)
          break
        case 2: //rhombus
          ctx.beginPath()
          ctx.moveTo(0, -sz)
          ctx.lineTo(sz, 0)
          ctx.lineTo(0, sz)
          ctx.lineTo(-sz, 0)
          ctx.closePath()
          ctx.fill()
          break
        case 3: //triangle
          ctx.beginPath()
          ctx.moveTo(0, -sz)
          ctx.lineTo(sz, sz * 0.7)
          ctx.lineTo(-sz, sz * 0.7)
          ctx.closePath()
          ctx.fill()
          break
        case 4: { //cross
          const w = sz * 0.35
          ctx.fillRect(-w, -sz, w * 2, sz * 2)
          ctx.fillRect(-sz, -w, sz * 2, w * 2)
          break
        }
        case 5: //ring
          ctx.beginPath()
          ctx.arc(0, 0, sz, 0, Math.PI * 2)
          ctx.stroke()
          break
      }
      ctx.restore()
    }
  }

  // 6. Outer border (use hash bytes to determine color)
  ctx.strokeStyle = `rgb(${hash[13] % 128 + 64}, ${hash[14] % 128 + 64}, ${hash[15] % 128 + 64})`
  ctx.lineWidth = Math.max(2, size / 40)
  ctx.strokeRect(0, 0, size, size)

  // 7. Round corner cutting
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
