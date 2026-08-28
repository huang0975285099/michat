import { t } from '../../../i18n/index.js'

const BOOSTERS = [
  { key: 'hammer', labelKey: 'sugarPop.hammer' },
  { key: 'shuffle', labelKey: 'sugarPop.shuffle' },
  { key: 'extraMoves', labelKey: 'sugarPop.extraMoves' },
]

export function getHudControls(boosters = {}, { extraMovesUsed = false, hammerSelecting = false, disabled = false } = {}) {
  return BOOSTERS.map((booster) => ({
    ...booster,
    label: t(booster.labelKey),
    count: Math.max(0, Math.trunc(boosters[booster.key] || 0)),
    enabled: !disabled && (boosters[booster.key] || 0) > 0 && !(booster.key === 'extraMoves' && extraMovesUsed),
    active: booster.key === 'hammer' && hammerSelecting,
  }))
}

export function calculateHudLayout(width, height) {
  const edge = Math.max(16, Math.min(28, width * 0.045))
  const boosterY = height - Math.max(48, Math.min(64, height * 0.07))
  const usable = width - edge * 2
  const pauseWidth = 72
  return {
    targets: { x: edge, y: 18, width: Math.min(260, Math.max(130, width * 0.36)) },
    moves: { x: width - edge, y: 18 },
    score: { x: width / 2, y: 72 },
    pause: { x: width / 2, y: 30, width: pauseWidth },
    boosters: BOOSTERS.map((booster, index) => ({
      ...booster,
      x: edge + usable * ((index + 0.5) / BOOSTERS.length),
      y: boosterY,
      width: Math.min(118, usable / BOOSTERS.length - 8),
    })),
  }
}

function targetLines(target = {}) {
  const lines = Object.entries(target.candies || {}).map(([id, count]) => `${id}: ${count}`)
  if (typeof target.jelly === 'number') lines.push(`${t('sugarPop.jelly')}: ${target.jelly}`)
  if (typeof target.frosting === 'number') lines.push(`${t('sugarPop.frosting')}: ${target.frosting}`)
  return lines.length ? lines : [t('sugarPop.ready')]
}

export default class HudView {
  constructor(scene, { onBooster, onPause } = {}) {
    this.scene = scene
    this.onBooster = onBooster
    this.layoutData = calculateHudLayout(scene.scale.gameSize.width, scene.scale.gameSize.height)
    this.background = scene.add.graphics()
    this.targets = scene.add.text(0, 0, '', { fontFamily: 'Arial, sans-serif', fontSize: '16px', color: '#4a2148', fontStyle: 'bold' })
      .setOrigin(0, 0)
    this.moves = scene.add.text(0, 0, '', { fontFamily: 'Arial, sans-serif', fontSize: '18px', color: '#4a2148', fontStyle: 'bold', align: 'right' })
      .setOrigin(1, 0)
    this.score = scene.add.text(0, 0, '', { fontFamily: 'Arial, sans-serif', fontSize: '16px', color: '#673064', fontStyle: 'bold' })
      .setOrigin(0.5, 0)
    this.pause = scene.add.text(0, 0, t('sugarPop.pause'), { fontFamily: 'Arial, sans-serif', fontSize: '14px', color: '#673064', fontStyle: 'bold' })
      .setOrigin(0.5)
      .setPadding(12, 7, 12, 7)
      .setBackgroundColor('#ffffff')
      .setInteractive({ useHandCursor: true })
    this.pause.on('pointerup', () => onPause?.())
    this.boosterButtons = BOOSTERS.map((booster) => {
      const box = scene.add.rectangle(0, 0, 96, 48, 0xffffff, 0.75).setStrokeStyle(2, 0x9c5d98, 0.65)
        .setInteractive({ useHandCursor: true })
      const text = scene.add.text(0, 0, t(booster.labelKey), { fontFamily: 'Arial, sans-serif', fontSize: '13px', color: '#572c55', fontStyle: 'bold', align: 'center' }).setOrigin(0.5)
      box.on('pointerup', () => this.onBooster?.(booster.key))
      return { ...booster, box, text }
    })
    this.setLayout(scene.scale.gameSize.width, scene.scale.gameSize.height)
  }

  setLayout(width, height) {
    this.layoutData = calculateHudLayout(width, height)
    const { targets, moves, score, pause, boosters } = this.layoutData
    this.background.clear()
    this.background.fillStyle(0xfff6fc, 0.86)
    this.background.fillRoundedRect(8, 8, width - 16, 92, 20)
    this.targets.setPosition(targets.x, targets.y).setWordWrapWidth(targets.width)
    this.moves.setPosition(moves.x, moves.y)
    this.score.setPosition(score.x, score.y)
    this.pause.setPosition(pause.x, pause.y)
    boosters.forEach((layout, index) => {
      const button = this.boosterButtons[index]
      button.box.setPosition(layout.x, layout.y).setDisplaySize(layout.width, 48)
      button.text.setPosition(layout.x, layout.y)
    })
  }

  update({ levelId, movesLeft, score, target, boosters = {}, extraMovesUsed = false, hammerSelecting = false, disabled = false }) {
    this.targets.setText(`${t('sugarPop.level', { id: levelId })}\n${targetLines(target).join('  •  ')}`)
    this.moves.setText(`${t('sugarPop.moves')}\n${movesLeft}`)
    this.score.setText(t('sugarPop.score', { score }))
    const controls = getHudControls(boosters, { extraMovesUsed, hammerSelecting, disabled })
    this.boosterButtons.forEach((button, index) => {
      const control = controls[index]
      button.text.setText(`${t(button.labelKey)}\n×${control.count}`)
      button.box.setFillStyle(control.active ? 0xffb7d7 : 0xffffff, control.enabled ? 0.9 : 0.45)
      button.box.setStrokeStyle(control.active ? 4 : 2, control.active ? 0xff4c9a : 0x9c5d98, control.enabled ? 0.9 : 0.35)
      button.text.setAlpha(control.enabled ? 1 : 0.45)
      if (control.enabled) button.box.setInteractive({ useHandCursor: true })
      else button.box.disableInteractive()
    })
    if (disabled) this.pause.disableInteractive().setAlpha(0.5)
    else this.pause.setInteractive({ useHandCursor: true }).setAlpha(1)
  }

  destroy() {
    this.background.destroy()
    this.targets.destroy()
    this.moves.destroy()
    this.score.destroy()
    this.pause.destroy()
    this.boosterButtons.forEach(({ box, text }) => {
      box.destroy()
      text.destroy()
    })
  }
}
