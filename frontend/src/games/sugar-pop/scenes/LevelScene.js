import Scene from 'phaser/src/scene/Scene.js'
import { createBoard, isAdjacent, trySwap } from '../game/board.js'
import { getLevel } from '../game/levels.js'
import { resolveTurn } from '../game/resolve.js'
import { loadSave } from '../game/save.js'
import BoardView from '../ui/BoardView.js'
import HudView from '../ui/HudView.js'

function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function cloneTarget(target) {
  return { ...target, candies: { ...(target.candies || {}) } }
}

function levelBoard(level) {
  const board = createBoard({ seed: level.seed, blocked: level.boardShape.blocked })
  for (const obstacle of level.obstacles.jelly) board[obstacle.row][obstacle.col].jelly = true
  for (const obstacle of level.obstacles.frosting) board[obstacle.row][obstacle.col].frosting = obstacle.layers || 1
  return board
}

export function isPlayableSwap(board, from, to) {
  if (!isAdjacent(from, to)) return false
  const first = board[from.row]?.[from.col]
  const second = board[to.row]?.[to.col]
  if (!first || !second) return false
  if ((first.special === 'color-bomb') !== (second.special === 'color-bomb')) return true
  return trySwap(board, from, to).accepted
}

export default class LevelScene extends Scene {
  constructor() {
    super({ key: 'LevelScene' })
  }

  create({ levelId = 1 } = {}) {
    this.cameras.main.setBackgroundColor('#ffeaf7')
    this.handleResize = this.handleResize.bind(this)
    this.scale.on('resize', this.handleResize)
    this.events.once('shutdown', this.shutdown, this)
    this.startLevel(levelId)
  }

  startLevel(levelId) {
    const level = getLevel(levelId)
    if (!level) {
      this.scene.start('MapScene')
      return
    }
    this.level = level
    this.save = loadSave(window.localStorage)
    this.rng = seededRandom(level.seed ^ 0x5A17)
    this.state = {
      board: levelBoard(level),
      movesLeft: level.moves,
      target: cloneTarget(level.targets),
      score: 0,
      status: 'playing',
    }
    this.resolving = false
    this.selected = null
    this.pendingResize = null
    this.boardView?.destroy()
    this.hudView?.destroy()
    this.boardView = new BoardView(this, {
      onSelect: (position) => this.selectCell(position),
      onSwap: (from, to) => this.attemptSwap(from, to),
    })
    this.hudView = new HudView(this)
    this.layoutViews()
    this.boardView.render(this.state.board)
    this.updateHud()
  }

  selectCell(position) {
    if (this.resolving || this.state.status !== 'playing') return
    if (!this.selected) {
      this.selected = { ...position }
      this.boardView.setSelected(this.selected)
      return
    }
    if (this.selected.row === position.row && this.selected.col === position.col) {
      this.selected = null
      this.boardView.setSelected(null)
      return
    }
    if (isAdjacent(this.selected, position)) {
      const from = this.selected
      this.selected = null
      this.boardView.setSelected(null)
      void this.attemptSwap(from, position)
      return
    }
    this.selected = { ...position }
    this.boardView.setSelected(this.selected)
  }

  async attemptSwap(from, to) {
    if (this.resolving || this.state.status !== 'playing' || !isAdjacent(from, to)) return
    this.resolving = true
    this.selected = null
    this.boardView.setSelected(null)
    this.boardView.setInputEnabled(false)
    try {
      if (!isPlayableSwap(this.state.board, from, to)) {
        await this.boardView.animateRejectedSwap(from, to)
        return
      }
      await this.boardView.animateSwap(from, to)
      this.state = resolveTurn({ ...this.state, swap: { from, to }, rng: this.rng })
      await this.boardView.animateResolution(this.state.waves, this.state.board)
      this.updateHud()
    } finally {
      this.resolving = false
      if (this.pendingResize) {
        this.layoutViews(this.pendingResize.width, this.pendingResize.height)
        this.pendingResize = null
      }
      if (this.state.status === 'playing') this.boardView.setInputEnabled(true)
    }
  }

  updateHud() {
    this.hudView.update({ ...this.state, levelId: this.level.id, boosters: this.save.boosters })
  }

  layoutViews(width = this.scale.gameSize.width, height = this.scale.gameSize.height) {
    this.boardView?.setLayout(width, height)
    this.hudView?.setLayout(width, height)
  }

  handleResize(gameSize) {
    const size = { width: gameSize.width, height: gameSize.height }
    this.hudView?.setLayout(size.width, size.height)
    if (this.resolving) this.pendingResize = size
    else this.boardView?.setLayout(size.width, size.height)
  }

  shutdown() {
    this.scale.off('resize', this.handleResize)
    this.boardView?.destroy()
    this.hudView?.destroy()
    this.boardView = null
    this.hudView = null
  }
}
