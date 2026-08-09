import Scene from 'phaser/src/scene/Scene.js'
import { createBoard, isAdjacent, trySwap } from '../game/board.js'
import { useBooster as applyBooster } from '../game/boosters.js'
import { getLevel, LEVELS } from '../game/levels.js'
import { resolveBonusMoves, resolveTurn } from '../game/resolve.js'
import { boosterRewardDelta, loadSaveState, recordLevelResult, saveProgress } from '../game/save.js'
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
  for (const obstacle of level.obstacles.frosting) {
    Object.assign(board[obstacle.row][obstacle.col], {
      id: null,
      special: null,
      frosting: obstacle.layers || 1,
    })
  }
  return board
}

export function createLevelResult(state, level) {
  const movesLeft = Math.max(0, Math.trunc(state.bonusMoves ?? state.movesLeft ?? 0))
  const bonusScore = Math.max(0, Math.trunc(state.bonusScore || 0))
  const score = Math.max(0, Math.trunc(state.score || 0))
  const stars = Math.max(1, Math.min(3, (level.starScores || []).filter((threshold) => score >= threshold).length))
  return { levelId: level.id, score, stars, movesLeft, bonusScore }
}

export function isPlayableSwap(board, from, to) {
  if (!isAdjacent(from, to)) return false
  const first = board[from.row]?.[from.col]
  const second = board[to.row]?.[to.col]
  if (!first?.id || !second?.id || first.frosting > 0 || second.frosting > 0) return false
  if ((first.special === 'color-bomb' && second.special != null)
    || (second.special === 'color-bomb' && first.special != null)) return false
  if ((first.special === 'color-bomb') !== (second.special === 'color-bomb')) {
    const counterpart = first.special === 'color-bomb' ? second : first
    return counterpart.special == null
  }
  return trySwap(board, from, to).accepted
}

export function createLevelScene(SceneBase) {
  return class LevelScene extends SceneBase {
    constructor() {
      super({ key: 'LevelScene' })
    }

  create({ levelId = 1 } = {}) {
    this.cameras.main.setBackgroundColor('#ffeaf7')
    this.storage = window.localStorage
    this.handleResize = this.handleResize.bind(this)
    this.handleLevelFinished = this.handleLevelFinished.bind(this)
    this.scale.on('resize', this.handleResize)
    this.events.on('level-finished', this.handleLevelFinished)
    this.events.once('shutdown', this.shutdown, this)
    if (!this.scene.isActive('OverlayScene')) this.scene.launch('OverlayScene')
    this.startLevel(levelId)
  }

  startLevel(levelId) {
    const level = getLevel(levelId)
    if (!level) {
      this.scene.start('MapScene')
      return
    }
    this.level = level
    const loaded = loadSaveState(this.storage)
    this.save = loaded.save
    this.rng = seededRandom(level.seed ^ 0x5A17)
    this.state = {
      board: levelBoard(level),
      movesLeft: level.moves,
      target: cloneTarget(level.targets),
      score: 0,
      status: 'playing',
    }
    this.resolving = false
    this.overlayOpen = false
    this.hammerSelecting = false
    this.extraMovesUsed = false
    this.finishingWin = false
    this.selected = null
    this.pendingResize = null
    this.boardView?.destroy()
    this.hudView?.destroy()
    this.boardView = new BoardView(this, {
      onSelect: (position) => this.selectCell(position),
      onSwap: (from, to) => this.attemptSwap(from, to),
    })
    this.hudView = new HudView(this, {
      onBooster: (kind) => { void this.useBooster(kind) },
      onPause: () => this.openOverlay('pause'),
    })
    this.layoutViews()
    this.boardView.render(this.state.board)
    this.updateHud()
    if (loaded.recovered) this.openOverlay('recover-save')
  }

  selectCell(position) {
    if (this.resolving || this.overlayOpen || this.state.status !== 'playing') return
    if (this.hammerSelecting) {
      void this.useBooster('hammer', position)
      return
    }
    if (this.state.board[position.row]?.[position.col]?.id == null) return
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
    if (this.resolving || this.overlayOpen || this.state.status !== 'playing') return
    if (this.hammerSelecting) {
      await this.useBooster('hammer', from)
      return
    }
    if (!isAdjacent(from, to)) return
    this.resolving = true
    this.updateHud()
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
      if (this.state.status !== 'playing') this.events.emit('level-finished', { status: this.state.status })
    } finally {
      this.resolving = false
      this.updateHud()
      if (this.pendingResize) {
        this.layoutViews(this.pendingResize.width, this.pendingResize.height)
        this.pendingResize = null
      }
      if (this.state.status === 'playing' && !this.overlayOpen) this.boardView.setInputEnabled(true)
    }
  }

  async useBooster(kind, cell) {
    if (kind === 'hammer' && !cell) {
      if (this.resolving || this.overlayOpen || this.state.status !== 'playing' || this.save.boosters.hammer <= 0) return false
      this.hammerSelecting = !this.hammerSelecting
      this.selected = null
      this.boardView.setSelected(null)
      this.updateHud()
      return false
    }
    const recoveringLoss = kind === 'extraMoves' && this.state.status === 'lost'
    if (this.resolving || (this.overlayOpen && !recoveringLoss)) return false
    this.resolving = true
    this.updateHud()
    this.boardView.setInputEnabled(false)
    try {
      const result = applyBooster({
        ...this.state,
        boosters: this.save.boosters,
        extraMovesUsed: this.extraMovesUsed,
      }, kind, cell, this.rng)
      if (!result.success) return false
      const { success: _success, wave, boosters, extraMovesUsed, ...nextState } = result
      this.state = nextState
      this.extraMovesUsed = extraMovesUsed
      this.hammerSelecting = false
      this.save = saveProgress(this.storage, { ...this.save, boosters })
      this.selected = null
      this.boardView.setSelected(null)
      if (wave) await this.boardView.animateResolution([wave], this.state.board)
      else if (kind === 'shuffle') this.boardView.render(this.state.board)
      this.updateHud()
      if (this.state.status === 'won') this.events.emit('level-finished', { status: 'won' })
      return true
    } finally {
      this.resolving = false
      this.updateHud()
      if (this.state.status === 'playing' && !this.overlayOpen) this.boardView.setInputEnabled(true)
    }
  }

  async handleLevelFinished({ status }) {
    if (status === 'lost') {
      this.openOverlay('lose', {
        canUseExtraMoves: this.save.boosters.extraMoves > 0 && !this.extraMovesUsed,
      })
      return
    }
    if (status !== 'won' || this.finishingWin) return
    this.finishingWin = true
    this.overlayOpen = true
    this.boardView.setInputEnabled(false)
    this.updateHud()
    const bonus = resolveBonusMoves({
      board: this.state.board,
      movesLeft: this.state.movesLeft,
      score: this.state.score,
      rng: this.rng,
    })
    await this.boardView.animateResolution(bonus.waves, bonus.board)
    this.state = { ...this.state, ...bonus, status: 'won' }
    this.updateHud()
    const result = createLevelResult(this.state, this.level)
    const previousSave = this.save
    this.save = recordLevelResult(this.save, result)
    const rewards = boosterRewardDelta(previousSave, this.save)
    this.save = saveProgress(this.storage, this.save)
    this.state.score = result.score
    this.updateHud()
    if (!this.scene.isActive('TransitionScene')) this.scene.launch('TransitionScene')
    await this.scene.get('TransitionScene').playBonusMoves(result)
    this.scene.stop('TransitionScene')
    this.openOverlay('win', {
      ...result,
      rewards,
      hasNextLevel: this.level.id < LEVELS.length,
    })
  }

  openOverlay(kind, payload = {}) {
    if (this.resolving && kind === 'pause') return false
    this.overlayOpen = true
    this.boardView?.setInputEnabled(false)
    this.updateHud()
    this.scene.get('OverlayScene').open({
      kind,
      payload,
      onAction: (action) => this.handleOverlayAction(action),
    })
    return true
  }

  closeOverlay({ stop = false } = {}) {
    this.scene.get('OverlayScene')?.close?.()
    if (stop) this.scene.stop('OverlayScene')
    this.overlayOpen = false
    this.updateHud()
    if (!this.resolving && this.state.status === 'playing') this.boardView?.setInputEnabled(true)
  }

  async handleOverlayAction(action) {
    if (action === 'resume') {
      this.closeOverlay()
      return false
    }
    if (action === 'recover') {
      this.save = saveProgress(this.storage, this.save)
      this.closeOverlay()
      return false
    }
    if (action === 'extraMoves') {
      const used = await this.useBooster('extraMoves')
      if (used) this.closeOverlay()
      return false
    }
    const levelId = this.level.id
    this.closeOverlay({ stop: true })
    if (action === 'retry') this.scene.restart({ levelId })
    else if (action === 'next' && levelId < LEVELS.length) this.scene.restart({ levelId: levelId + 1 })
    else this.scene.start('MapScene')
    return false
  }

  updateHud() {
    this.hudView.update({
      ...this.state,
      levelId: this.level.id,
      boosters: this.save.boosters,
      extraMovesUsed: this.extraMovesUsed,
      hammerSelecting: this.hammerSelecting,
      disabled: this.resolving || this.overlayOpen || this.state.status !== 'playing',
    })
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
      this.events.off('level-finished', this.handleLevelFinished)
      if (this.scene.isActive('OverlayScene')) this.scene.stop('OverlayScene')
      if (this.scene.isActive('TransitionScene')) this.scene.stop('TransitionScene')
      this.boardView?.destroy()
      this.hudView?.destroy()
      this.boardView = null
      this.hudView = null
    }
  }
}

export default createLevelScene(Scene)
