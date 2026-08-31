<template>
  <q-dialog
    v-model="dialogOpen"
    maximized
    transition-show="fade"
    transition-hide="fade"
    @show="onDialogShow"
  >
    <q-card
      ref="dialogCardEl"
      class="image-gallery-card"
      tabindex="0"
      @keydown="onKeydown"
    >
      <header class="gallery-toolbar">
        <q-btn
          flat
          round
          dense
          icon="close"
          color="white"
          aria-label="Close image preview"
          @click="close"
        />

        <div class="gallery-counter" aria-live="polite">
          {{ counterText }}
        </div>

        <div class="gallery-zoom-controls">
          <q-btn
            flat
            round
            dense
            icon="download"
            color="white"
            :disable="!currentImage"
            aria-label="Download image"
            @click="emit('download', currentImage)"
          />
          <q-btn
            flat
            round
            dense
            icon="remove"
            color="white"
            :disable="zoom <= MIN_ZOOM"
            aria-label="Zoom out"
            @click="zoomBy(-ZOOM_STEP)"
          />
          <q-btn
            flat
            dense
            no-caps
            color="white"
            class="gallery-zoom-label"
            :label="zoomLabel"
            aria-label="Reset zoom"
            @click="setZoom(MIN_ZOOM)"
          />
          <q-btn
            flat
            round
            dense
            icon="add"
            color="white"
            :disable="zoom >= MAX_ZOOM"
            aria-label="Zoom in"
            @click="zoomBy(ZOOM_STEP)"
          />
        </div>
      </header>

      <main
        ref="stageEl"
        class="gallery-stage"
        :class="{
          'gallery-stage--zoomed': zoom > MIN_ZOOM,
          'gallery-stage--dragging': pointerActive,
        }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @wheel.prevent="onWheel"
        @dblclick="toggleZoom"
      >
        <img
          v-if="currentImage"
          :key="currentId"
          ref="imageEl"
          class="gallery-image"
          :class="{ 'gallery-image--dragging': pointerActive }"
          :src="currentImage.url"
          :alt="currentImage.name || `Image ${currentIndex + 1}`"
          :style="imageTransformStyle"
          draggable="false"
          @load="clampPan"
        />

        <q-btn
          v-if="imageCount > 1"
          class="gallery-nav gallery-nav--previous"
          round
          flat
          icon="chevron_left"
          color="white"
          :disable="!hasPrevious"
          aria-label="Previous image"
          @pointerdown.stop
          @dblclick.stop
          @click.stop="previousImage"
        />
        <q-btn
          v-if="imageCount > 1"
          class="gallery-nav gallery-nav--next"
          round
          flat
          icon="chevron_right"
          color="white"
          :disable="!hasNext"
          aria-label="Next image"
          @pointerdown.stop
          @dblclick.stop
          @click.stop="nextImage"
        />
      </main>

      <footer v-if="imageCount > 1" class="gallery-thumbnail-footer">
        <div ref="thumbnailStripEl" class="gallery-thumbnail-strip" role="list">
          <button
            v-for="(image, index) in usableImages"
            :key="image.id"
            type="button"
            class="gallery-thumbnail"
            :class="{ 'gallery-thumbnail--active': imageId(image) === currentId }"
            :aria-current="imageId(image) === currentId ? 'true' : undefined"
            :aria-label="`View image ${index + 1}`"
            role="listitem"
            @click="goToIndex(index)"
          >
            <img :src="image.url" :alt="image.name || ''" draggable="false" />
          </button>
        </div>
      </footer>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const ZOOM_STEP = 0.5
const SWIPE_MIN_DISTANCE = 52

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
  images: {
    type: Array,
    default: () => [],
  },
  startId: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['update:modelValue', 'download'])

const dialogCardEl = ref(null)
const stageEl = ref(null)
const imageEl = ref(null)
const thumbnailStripEl = ref(null)
const currentId = ref('')
const zoom = ref(MIN_ZOOM)
const panX = ref(0)
const panY = ref(0)
const pointerActive = ref(false)

const pointerGesture = {
  id: null,
  startX: 0,
  startY: 0,
  originPanX: 0,
  originPanY: 0,
}

const dialogOpen = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

const usableImages = computed(() => props.images.filter((image) => (
  image
  && image.id !== undefined
  && image.id !== null
  && String(image.id) !== ''
  && typeof image.url === 'string'
  && image.url.length > 0
)))

const imageIds = computed(() => usableImages.value.map(imageId))
const imageCount = computed(() => usableImages.value.length)
const currentIndex = computed(() => imageIds.value.indexOf(currentId.value))
const currentImage = computed(() => (
  currentIndex.value >= 0 ? usableImages.value[currentIndex.value] : null
))
const hasPrevious = computed(() => currentIndex.value > 0)
const hasNext = computed(() => currentIndex.value >= 0 && currentIndex.value < imageCount.value - 1)
const counterText = computed(() => (
  currentIndex.value >= 0 ? `${currentIndex.value + 1} / ${imageCount.value}` : `0 / ${imageCount.value}`
))
const zoomLabel = computed(() => `${Number.isInteger(zoom.value) ? zoom.value : zoom.value.toFixed(1)}x`)
const imageTransformStyle = computed(() => ({
  transform: `translate3d(${panX.value}px, ${panY.value}px, 0) scale(${zoom.value})`,
}))

function imageId(image) {
  return String(image?.id ?? '')
}

function close() {
  emit('update:modelValue', false)
}

function resetTransform() {
  zoom.value = MIN_ZOOM
  panX.value = 0
  panY.value = 0
  pointerActive.value = false
  pointerGesture.id = null
}

function selectInitialImage() {
  if (imageCount.value === 0) {
    currentId.value = ''
    if (props.modelValue) close()
    return
  }

  const requestedId = String(props.startId || '')
  if (requestedId && imageIds.value.includes(requestedId)) {
    currentId.value = requestedId
  } else if (!imageIds.value.includes(currentId.value)) {
    currentId.value = imageIds.value[0]
  }
  resetTransform()
}

function onDialogShow() {
  selectInitialImage()
  nextTick(() => dialogCardEl.value?.$el?.focus?.() || dialogCardEl.value?.focus?.())
}

function goToIndex(index) {
  if (index < 0 || index >= imageCount.value) return
  currentId.value = imageIds.value[index]
}

function previousImage() {
  if (hasPrevious.value) goToIndex(currentIndex.value - 1)
}

function nextImage() {
  if (hasNext.value) goToIndex(currentIndex.value + 1)
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function clampPan() {
  const stage = stageEl.value
  const image = imageEl.value
  if (!stage || !image || zoom.value <= MIN_ZOOM) {
    panX.value = 0
    panY.value = 0
    return
  }

  const maximumX = Math.max(0, ((image.clientWidth * zoom.value) - stage.clientWidth) / 2)
  const maximumY = Math.max(0, ((image.clientHeight * zoom.value) - stage.clientHeight) / 2)
  panX.value = clamp(panX.value, -maximumX, maximumX)
  panY.value = clamp(panY.value, -maximumY, maximumY)
}

function setZoom(value) {
  const nextZoom = clamp(Math.round(value * 2) / 2, MIN_ZOOM, MAX_ZOOM)
  zoom.value = nextZoom
  if (nextZoom === MIN_ZOOM) {
    panX.value = 0
    panY.value = 0
  } else {
    nextTick(clampPan)
  }
}

function zoomBy(amount) {
  setZoom(zoom.value + amount)
}

function toggleZoom() {
  setZoom(zoom.value === MIN_ZOOM ? 2 : MIN_ZOOM)
}

function onWheel(event) {
  if (!currentImage.value || event.deltaY === 0) return
  zoomBy(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
}

function onPointerDown(event) {
  if (!currentImage.value || (event.pointerType === 'mouse' && event.button !== 0)) return

  pointerActive.value = true
  pointerGesture.id = event.pointerId
  pointerGesture.startX = event.clientX
  pointerGesture.startY = event.clientY
  pointerGesture.originPanX = panX.value
  pointerGesture.originPanY = panY.value
  event.currentTarget?.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event) {
  if (!pointerActive.value || event.pointerId !== pointerGesture.id || zoom.value <= MIN_ZOOM) return

  const deltaX = event.clientX - pointerGesture.startX
  const deltaY = event.clientY - pointerGesture.startY
  panX.value = pointerGesture.originPanX + deltaX
  panY.value = pointerGesture.originPanY + deltaY
  clampPan()
}

function finishPointer(event, allowSwipe) {
  if (!pointerActive.value || event.pointerId !== pointerGesture.id) return

  const deltaX = event.clientX - pointerGesture.startX
  const deltaY = event.clientY - pointerGesture.startY
  if (
    allowSwipe
    && zoom.value === MIN_ZOOM
    && Math.abs(deltaX) >= SWIPE_MIN_DISTANCE
    && Math.abs(deltaX) > Math.abs(deltaY) * 1.2
  ) {
    if (deltaX < 0) nextImage()
    else previousImage()
  }

  event.currentTarget?.releasePointerCapture?.(event.pointerId)
  pointerActive.value = false
  pointerGesture.id = null
}

function onPointerUp(event) {
  finishPointer(event, true)
}

function onPointerCancel(event) {
  finishPointer(event, false)
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    previousImage()
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    nextImage()
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    zoomBy(ZOOM_STEP)
  } else if (event.key === '-') {
    event.preventDefault()
    zoomBy(-ZOOM_STEP)
  } else if (event.key === '0') {
    event.preventDefault()
    setZoom(MIN_ZOOM)
  }
}

function scrollCurrentThumbnailIntoView() {
  nextTick(() => {
    const activeThumbnail = thumbnailStripEl.value?.children?.[currentIndex.value]
    activeThumbnail?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  })
}

watch(currentId, () => {
  resetTransform()
  scrollCurrentThumbnailIntoView()
})

watch(imageIds, (nextIds, previousIds = []) => {
  if (nextIds.length === 0) {
    currentId.value = ''
    resetTransform()
    if (props.modelValue) close()
    return
  }

  if (nextIds.includes(currentId.value)) return

  const previousIndex = previousIds.indexOf(currentId.value)
  const fallbackIndex = previousIndex < 0 ? 0 : Math.min(previousIndex, nextIds.length - 1)
  currentId.value = nextIds[fallbackIndex]
}, { immediate: true })

watch(() => props.modelValue, (isOpen) => {
  if (isOpen) {
    selectInitialImage()
    nextTick(() => dialogCardEl.value?.$el?.focus?.() || dialogCardEl.value?.focus?.())
  } else {
    resetTransform()
  }
})

watch(() => props.startId, (startId) => {
  const requestedId = String(startId || '')
  if (props.modelValue && requestedId && imageIds.value.includes(requestedId)) {
    currentId.value = requestedId
  }
})

function handleViewportResize() {
  nextTick(clampPan)
}

onMounted(() => {
  window.addEventListener('resize', handleViewportResize)
  window.visualViewport?.addEventListener('resize', handleViewportResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleViewportResize)
  window.visualViewport?.removeEventListener('resize', handleViewportResize)
})
</script>

<style scoped>
.image-gallery-card {
  display: flex;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  flex-direction: column;
  overflow: hidden;
  color: #fff;
  background: #050505;
  outline: none;
  user-select: none;
}

.gallery-toolbar {
  position: relative;
  z-index: 3;
  display: grid;
  min-height: calc(52px + env(safe-area-inset-top));
  flex: 0 0 auto;
  grid-template-columns: minmax(112px, 1fr) auto minmax(112px, 1fr);
  align-items: end;
  padding: env(safe-area-inset-top) max(10px, env(safe-area-inset-right)) 8px max(10px, env(safe-area-inset-left));
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.18));
}

.gallery-toolbar > :first-child {
  justify-self: start;
}

.gallery-counter {
  min-width: 64px;
  align-self: center;
  justify-self: center;
  color: rgba(255, 255, 255, 0.94);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.gallery-zoom-controls {
  display: flex;
  align-items: center;
  justify-self: end;
}

.gallery-zoom-label {
  min-width: 43px;
  font-variant-numeric: tabular-nums;
}

.gallery-stage {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: zoom-in;
  touch-action: none;
}

.gallery-stage--zoomed {
  cursor: grab;
}

.gallery-stage--dragging {
  cursor: grabbing;
}

.gallery-image {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  pointer-events: none;
  transform-origin: center center;
  transition: transform 150ms ease-out;
  -webkit-user-drag: none;
}

.gallery-image--dragging {
  transition: none;
}

.gallery-nav {
  position: absolute;
  top: 50%;
  z-index: 2;
  width: 48px;
  height: 48px;
  background: rgba(0, 0, 0, 0.38);
  transform: translateY(-50%);
}

.gallery-nav--previous {
  left: max(10px, env(safe-area-inset-left));
}

.gallery-nav--next {
  right: max(10px, env(safe-area-inset-right));
}

.gallery-thumbnail-footer {
  position: relative;
  z-index: 3;
  min-height: calc(72px + env(safe-area-inset-bottom));
  flex: 0 0 auto;
  padding: 8px max(10px, env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.86), rgba(0, 0, 0, 0.28));
}

.gallery-thumbnail-strip {
  display: flex;
  max-width: 100%;
  gap: 8px;
  justify-content: safe center;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-color: rgba(255, 255, 255, 0.32) transparent;
  scrollbar-width: thin;
}

.gallery-thumbnail {
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  overflow: hidden;
  padding: 2px;
  border: 2px solid transparent;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  cursor: pointer;
  opacity: 0.62;
  transition: border-color 140ms ease, opacity 140ms ease, transform 140ms ease;
}

.gallery-thumbnail:hover,
.gallery-thumbnail:focus-visible {
  opacity: 0.9;
}

.gallery-thumbnail:focus-visible {
  outline: 2px solid #90caf9;
  outline-offset: 1px;
}

.gallery-thumbnail--active {
  border-color: #42a5f5;
  opacity: 1;
  transform: translateY(-1px);
}

.gallery-thumbnail img {
  width: 100%;
  height: 100%;
  border-radius: 4px;
  object-fit: cover;
  pointer-events: none;
  -webkit-user-drag: none;
}

@media (max-width: 600px) {
  .gallery-toolbar {
    min-height: calc(48px + env(safe-area-inset-top));
    grid-template-columns: 72px 1fr auto;
    padding-right: max(6px, env(safe-area-inset-right));
    padding-left: max(6px, env(safe-area-inset-left));
  }

  .gallery-zoom-controls :deep(.q-btn) {
    min-width: 34px;
    min-height: 34px;
  }

  .gallery-zoom-label {
    min-width: 38px;
    padding-right: 4px;
    padding-left: 4px;
  }

  .gallery-nav {
    width: 42px;
    height: 42px;
    background: rgba(0, 0, 0, 0.28);
  }

  .gallery-nav--previous {
    left: 2px;
  }

  .gallery-nav--next {
    right: 2px;
  }

  .gallery-thumbnail-footer {
    min-height: calc(66px + env(safe-area-inset-bottom));
    padding-top: 6px;
  }

  .gallery-thumbnail {
    width: 48px;
    height: 48px;
    flex-basis: 48px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gallery-image,
  .gallery-thumbnail {
    transition: none;
  }
}
</style>
