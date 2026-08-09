import Scene from 'phaser/src/scene/Scene.js'
import { LEVELS } from '../game/levels.js'
import { loadSave } from '../game/save.js'

export function canSelectLevel(levelId, save) {
  return Number.isInteger(levelId) && levelId >= 1 && levelId <= (save?.unlockedLevel || 1)
}

export function calculateMapNodePositions(width, height) {
  const top = 132
  const bottom = Math.max(top + 90, height - 72)
  const center = width / 2
  const amplitude = Math.min(width * 0.27, 250)
  return LEVELS.map((level, index) => {
    const progress = index / Math.max(1, LEVELS.length - 1)
    return {
      levelId: level.id,
      x: center + Math.sin(index * 1.23) * amplitude,
      y: bottom - progress * (bottom - top),
    }
  })
}

export function createMapScene(SceneBase) {
  return class MapScene extends SceneBase {
    constructor() {
      super({ key: 'MapScene' })
    }

  create() {
    this.save = loadSave(window.localStorage)
    this.cameras.main.setBackgroundColor('#ffd8ef')
    this.handleResize = this.handleResize.bind(this)
    this.handleNodeUp = this.handleNodeUp.bind(this)
    this.scale.on('resize', this.handleResize)
    this.input.on('gameobjectup', this.handleNodeUp)
    this.events.once('shutdown', this.shutdown, this)
    this.renderMap()
  }

  renderMap() {
    this.mapRoot?.destroy(true)
    const { width, height } = this.scale.gameSize
    const positions = calculateMapNodePositions(width, height)
    const root = this.add.container(0, 0)
    this.mapRoot = root

    const backdrop = this.add.graphics()
    backdrop.fillStyle(0xffd8ef, 1).fillRect(0, 0, width, height)
    backdrop.fillStyle(0xffffff, 0.35)
    for (let index = 0; index < 9; index += 1) {
      const radius = 18 + (index % 3) * 11
      backdrop.fillCircle((index * 173) % Math.max(width, 1), 76 + ((index * 137) % Math.max(height - 76, 1)), radius)
    }
    root.add(backdrop)

    const path = this.add.graphics()
    path.lineStyle(Math.max(9, Math.min(18, width * 0.026)), 0xffffff, 0.88)
    path.beginPath().moveTo(positions[0].x, positions[0].y)
    positions.slice(1).forEach(({ x, y }) => path.lineTo(x, y))
    path.strokePath()
    path.lineStyle(Math.max(3, Math.min(6, width * 0.008)), 0xf6a7d2, 0.9)
    path.beginPath().moveTo(positions[0].x, positions[0].y)
    positions.slice(1).forEach(({ x, y }) => path.lineTo(x, y))
    path.strokePath()
    root.add(path)

    root.add(this.add.text(width / 2, 28, 'SUGAR POP', {
      fontFamily: 'Arial, sans-serif',
      fontSize: `${Math.max(28, Math.min(48, width * 0.085))}px`,
      fontStyle: 'bold',
      color: '#8b3b78',
      stroke: '#ffffff',
      strokeThickness: 6,
    }).setOrigin(0.5, 0))
    root.add(this.add.text(width / 2, 86, 'Candy Town Trail', {
      fontFamily: 'Arial, sans-serif', fontSize: '18px', color: '#6e426b', fontStyle: 'bold',
    }).setOrigin(0.5))

    const radius = Math.max(22, Math.min(34, width * 0.068, height * 0.045))
    positions.forEach(({ levelId, x, y }) => {
      const unlocked = canSelectLevel(levelId, this.save)
      const result = this.save.results[levelId]
      const circle = this.add.circle(0, 0, radius, unlocked ? 0xff6fae : 0x9a8ca0, 1)
        .setStrokeStyle(4, 0xffffff, 1)
      const number = this.add.text(0, -2, unlocked ? String(levelId) : 'LOCK', {
        fontFamily: 'Arial, sans-serif',
        fontSize: unlocked ? `${Math.round(radius * 0.86)}px` : `${Math.round(radius * 0.42)}px`,
        fontStyle: 'bold',
        color: '#ffffff',
      }).setOrigin(0.5)
      const stars = this.add.text(0, radius + 12, `${'★'.repeat(result?.stars || 0)}${'☆'.repeat(3 - (result?.stars || 0))}`, {
        fontFamily: 'Arial, sans-serif', fontSize: `${Math.round(radius * 0.52)}px`, color: unlocked ? '#bd6a16' : '#786c7d',
      }).setOrigin(0.5)
      const node = this.add.container(x, y, [circle, number, stars])
      node.levelId = levelId
      node.setSize(radius * 2, radius * 2)
      node.setInteractive({ useHandCursor: unlocked })
      root.add(node)
    })
  }

  handleNodeUp(_pointer, node) {
    if (canSelectLevel(node.levelId, this.save)) this.scene.start('LevelScene', { levelId: node.levelId })
  }

  handleResize() {
    this.renderMap()
  }

    shutdown() {
      this.scale.off('resize', this.handleResize)
      this.input.off('gameobjectup', this.handleNodeUp)
      this.mapRoot?.destroy(true)
      this.mapRoot = null
    }
  }
}

export default createMapScene(Scene)
