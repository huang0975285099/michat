import { BOARD_SIZE } from '../game/constants.js'

const MIN_EDGE_GAP = 12
const TOP_CHROME = 112
const BOTTOM_CHROME = 154
const MAX_BOARD_SIZE = 680
const SWIPE_THRESHOLD = 18

function coordinateKey({ row, col }) {
  return `${row},${col}`
}

function onBoard({ row, col }) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE
}

export function calculateBoardLayout(width, height) {
  const availableWidth = Math.max(0, width - MIN_EDGE_GAP * 2)
  const availableHeight = Math.max(0, height - TOP_CHROME - BOTTOM_CHROME)
  const size = Math.max(0, Math.min(MAX_BOARD_SIZE, availableWidth, availableHeight))
  return {
    x: (width - size) / 2,
    y: TOP_CHROME + Math.max(0, (availableHeight - size) / 2),
    size,
    cellSize: size / BOARD_SIZE,
  }
}

export function adjacentPositionFromSwipe(from, deltaX, deltaY, threshold = SWIPE_THRESHOLD) {
  if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < threshold) return null
  const horizontal = Math.abs(deltaX) >= Math.abs(deltaY)
  const to = horizontal
    ? { row: from.row, col: from.col + Math.sign(deltaX) }
    : { row: from.row + Math.sign(deltaY), col: from.col }
  return onBoard(to) ? to : null
}

function displayTexture(cell) {
  if (cell.special === 'color-bomb') return 'special-color-bomb'
  return `candy-${cell.id}`
}

export default class BoardView {
  constructor(scene, { onSelect, onSwap } = {}) {
    this.scene = scene
    this.onSelect = onSelect
    this.onSwap = onSwap
    this.enabled = true
    this.board = null
    this.layout = calculateBoardLayout(scene.scale.gameSize.width, scene.scale.gameSize.height)
    this.cells = new Map()
    this.selected = null
    this.gesture = null

    this.background = scene.add.graphics()
    this.layer = scene.add.container(0, 0)
    this.handlePointerUp = this.handlePointerUp.bind(this)
    scene.input.on('pointerup', this.handlePointerUp)
    this.drawBackground()
  }

  setLayout(width, height) {
    this.layout = calculateBoardLayout(width, height)
    this.drawBackground()
    if (this.board) this.render(this.board)
  }

  drawBackground() {
    const { x, y, size, cellSize } = this.layout
    this.background.clear()
    this.background.fillStyle(0x7a3f78, 0.28)
    this.background.fillRoundedRect(x - 6, y - 6, size + 12, size + 12, Math.max(12, cellSize * 0.3))
    this.background.lineStyle(3, 0xffffff, 0.42)
    this.background.strokeRoundedRect(x - 6, y - 6, size + 12, size + 12, Math.max(12, cellSize * 0.3))
  }

  render(board) {
    this.board = board
    this.cells.clear()
    this.layer.removeAll(true)
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const cell = board[row]?.[col]
        if (!cell) continue
        const position = { row, col }
        const display = this.createCell(cell, position)
        this.cells.set(coordinateKey(position), display)
        this.layer.add(display)
      }
    }
    if (this.selected) this.setSelected(this.selected)
    this.setInputEnabled(this.enabled)
  }

  createCell(cell, position) {
    const { x, y, cellSize } = this.layout
    const centerX = x + (position.col + 0.5) * cellSize
    const centerY = y + (position.row + 0.5) * cellSize
    const children = []
    const selection = this.scene.add.rectangle(0, 0, cellSize * 0.88, cellSize * 0.88, 0xffffff, 0.12)
      .setStrokeStyle(Math.max(2, cellSize * 0.055), 0xffffff, 0.95)
      .setVisible(false)
    selection.name = 'selection'
    children.push(selection)

    if (cell.jelly) {
      children.push(this.scene.add.image(0, 0, 'obstacle-jelly').setDisplaySize(cellSize * 0.92, cellSize * 0.92))
    }
    children.push(this.scene.add.image(0, 0, displayTexture(cell)).setDisplaySize(cellSize * 0.82, cellSize * 0.82))
    if (cell.special && cell.special !== 'color-bomb') {
      const overlayKey = cell.special === 'wrapped' ? 'special-wrapped' : 'special-striped'
      const overlay = this.scene.add.image(0, 0, overlayKey).setDisplaySize(cellSize * 0.7, cellSize * 0.7)
      if (cell.special === 'striped-v') overlay.setAngle(90)
      children.push(overlay)
    }
    if (cell.frosting > 0) {
      const frosting = this.scene.add.image(0, 0, 'obstacle-frosting').setDisplaySize(cellSize * 0.9, cellSize * 0.9)
      frosting.setAlpha(cell.frosting > 1 ? 0.96 : 0.8)
      children.push(frosting)
    }

    const display = this.scene.add.container(centerX, centerY, children)
    display.boardPosition = { ...position }
    display.setSize(cellSize * 0.9, cellSize * 0.9)
    display.on('pointerdown', (pointer) => {
      if (!this.enabled) return
      this.gesture = { from: { ...position }, x: pointer.x, y: pointer.y, pointerId: pointer.id }
    })
    return display
  }

  handlePointerUp(pointer) {
    if (!this.enabled || !this.gesture || this.gesture.pointerId !== pointer.id) return
    const gesture = this.gesture
    this.gesture = null
    const to = adjacentPositionFromSwipe(gesture.from, pointer.x - gesture.x, pointer.y - gesture.y)
    if (to) this.onSwap?.(gesture.from, to)
    else this.onSelect?.(gesture.from)
  }

  setSelected(position) {
    this.selected = position ? { ...position } : null
    for (const display of this.cells.values()) {
      const marker = display.getByName('selection')
      marker?.setVisible(position != null && coordinateKey(display.boardPosition) === coordinateKey(position))
    }
  }

  setInputEnabled(enabled) {
    this.enabled = enabled
    if (!enabled) this.gesture = null
    for (const display of this.cells.values()) {
      if (enabled) display.setInteractive({ useHandCursor: true })
      else display.disableInteractive()
    }
  }

  cellCenter(position) {
    const { x, y, cellSize } = this.layout
    return { x: x + (position.col + 0.5) * cellSize, y: y + (position.row + 0.5) * cellSize }
  }

  animateSwap(from, to) {
    const first = this.cells.get(coordinateKey(from))
    const second = this.cells.get(coordinateKey(to))
    if (!first || !second) return Promise.resolve()
    const firstTarget = this.cellCenter(to)
    const secondTarget = this.cellCenter(from)
    return new Promise((resolve) => {
      this.scene.tweens.add({
        targets: [first, second],
        duration: 150,
        ease: 'Sine.Out',
        x: (target) => target === first ? firstTarget.x : secondTarget.x,
        y: (target) => target === first ? firstTarget.y : secondTarget.y,
        onComplete: () => {
          this.cells.set(coordinateKey(from), second)
          this.cells.set(coordinateKey(to), first)
          first.boardPosition = { ...to }
          second.boardPosition = { ...from }
          resolve()
        },
      })
    })
  }

  animateRejectedSwap(from, to) {
    const first = this.cells.get(coordinateKey(from))
    const second = this.cells.get(coordinateKey(to))
    if (!first || !second) return Promise.resolve()
    const firstTarget = this.cellCenter(to)
    const secondTarget = this.cellCenter(from)
    return new Promise((resolve) => {
      this.scene.tweens.add({
        targets: [first, second],
        duration: 95,
        ease: 'Sine.InOut',
        yoyo: true,
        x: (target) => target === first ? firstTarget.x : secondTarget.x,
        y: (target) => target === first ? firstTarget.y : secondTarget.y,
        onComplete: resolve,
      })
    })
  }

  async animateResolution(waves, settledBoard) {
    for (const wave of waves) {
      const removed = wave.removed.map((position) => this.cells.get(coordinateKey(position))).filter(Boolean)
      if (removed.length === 0) continue
      await new Promise((resolve) => {
        this.scene.tweens.add({
          targets: removed,
          alpha: 0,
          scale: 0.18,
          duration: 170,
          ease: 'Back.In',
          onComplete: resolve,
        })
      })
      for (const position of wave.removed) {
        const key = coordinateKey(position)
        this.cells.get(key)?.destroy()
        this.cells.delete(key)
      }
      const falling = [...this.cells.values()]
      if (falling.length > 0) {
        await new Promise((resolve) => {
          this.scene.tweens.add({
            targets: falling,
            y: `+=${Math.max(5, this.layout.cellSize * 0.16)}`,
            duration: 85,
            yoyo: true,
            ease: 'Sine.InOut',
            onComplete: resolve,
          })
        })
      }
    }
    if (settledBoard) {
      this.render(settledBoard)
      const refill = [...this.cells.values()]
      for (const display of refill) {
        display.y -= this.layout.cellSize * 0.8
        display.alpha = 0
      }
      if (refill.length > 0) {
        await new Promise((resolve) => {
          this.scene.tweens.add({
            targets: refill,
            y: `+=${this.layout.cellSize * 0.8}`,
            alpha: 1,
            duration: 190,
            ease: 'Bounce.Out',
            onComplete: resolve,
          })
        })
      }
    }
  }

  destroy() {
    this.scene.input.off('pointerup', this.handlePointerUp)
    this.layer.destroy(true)
    this.background.destroy()
    this.cells.clear()
  }
}
