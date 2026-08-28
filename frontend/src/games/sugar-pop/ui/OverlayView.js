import { t } from '../../../i18n/index.js'

const OVERLAY_KINDS = ['pause', 'win', 'lose', 'recover-save']

function rewardText(rewards = {}) {
  const labels = [
    ['hammer', t('sugarPop.hammer')],
    ['shuffle', t('sugarPop.shuffle')],
    ['extraMoves', t('sugarPop.extraMoves')],
  ]
  const earned = labels.filter(([key]) => rewards[key] > 0).map(([key, label]) => `${label} ×${rewards[key]}`)
  return earned.length ? t('sugarPop.rewards', { rewards: earned.join('  •  ') }) : t('sugarPop.noRewards')
}

export function createOverlayModel(kind, payload = {}) {
  if (!OVERLAY_KINDS.includes(kind)) throw new RangeError(`Unsupported Sugar Pop overlay: ${kind}`)
  if (kind === 'pause') {
    return {
      title: t('sugarPop.paused'),
      body: t('sugarPop.pausedBody'),
      actions: [
        { key: 'resume', label: t('sugarPop.resume'), primary: true },
        { key: 'retry', label: t('common.retry') },
        { key: 'map', label: t('sugarPop.map') },
      ],
    }
  }
  if (kind === 'win') {
    const actions = []
    if (payload.hasNextLevel) actions.push({ key: 'next', label: t('sugarPop.next'), primary: true })
    actions.push({ key: 'retry', label: t('sugarPop.playAgain'), primary: !payload.hasNextLevel })
    actions.push({ key: 'map', label: t('sugarPop.map') })
    return {
      title: t('sugarPop.win'),
      body: `${'★'.repeat(payload.stars || 0)}${'☆'.repeat(3 - (payload.stars || 0))}\n${t('sugarPop.score', { score: payload.score || 0 })}\n${rewardText(payload.rewards)}`,
      actions,
    }
  }
  if (kind === 'lose') {
    const actions = []
    if (payload.canUseExtraMoves) actions.push({ key: 'extraMoves', label: t('sugarPop.useExtraMoves'), primary: true })
    actions.push({ key: 'retry', label: t('common.retry'), primary: !payload.canUseExtraMoves })
    actions.push({ key: 'map', label: t('sugarPop.map') })
    return {
      title: t('sugarPop.outOfMoves'),
      body: t('sugarPop.targetsRemain'),
      actions,
    }
  }
  return {
    title: t('sugarPop.saveRecovered'),
    body: t('sugarPop.saveRecoveredBody'),
    actions: [{ key: 'recover', label: t('sugarPop.continue'), primary: true }],
  }
}

function fontSize(width, preferred, minimum) {
  return `${Math.max(minimum, Math.min(preferred, width * 0.065))}px`
}

export default class OverlayView {
  constructor(scene) {
    this.scene = scene
    this.root = scene.add.container(0, 0).setDepth(1000)
  }

  render({ kind, payload, onAction }) {
    this.root.removeAll(true)
    const model = createOverlayModel(kind, payload)
    const { width, height } = this.scene.scale.gameSize
    const panelWidth = Math.min(430, width - 32)
    const panelHeight = Math.min(460, Math.max(330, height - 72))
    const dimmer = this.scene.add.rectangle(width / 2, height / 2, width, height, 0x39152f, 0.72)
      .setInteractive()
    const panel = this.scene.add.rectangle(width / 2, height / 2, panelWidth, panelHeight, 0xfff7fc, 1)
      .setStrokeStyle(4, 0xff87bc, 1)
    const title = this.scene.add.text(width / 2, height / 2 - panelHeight * 0.34, model.title, {
      fontFamily: 'Arial, sans-serif',
      fontSize: fontSize(width, 34, 24),
      fontStyle: 'bold',
      color: '#7b356d',
      align: 'center',
    }).setOrigin(0.5)
    const body = this.scene.add.text(width / 2, height / 2 - panelHeight * 0.12, model.body, {
      fontFamily: 'Arial, sans-serif',
      fontSize: fontSize(width, 19, 15),
      color: '#5c3559',
      align: 'center',
      lineSpacing: 9,
      wordWrap: { width: panelWidth - 52 },
    }).setOrigin(0.5)
    this.root.add([dimmer, panel, title, body])

    const gap = 56
    const firstY = height / 2 + panelHeight * 0.1
    model.actions.forEach((action, index) => {
      const y = firstY + index * gap
      const box = this.scene.add.rectangle(width / 2, y, Math.min(270, panelWidth - 64), 44, action.primary ? 0xff69a8 : 0xffffff, 1)
        .setStrokeStyle(2, 0xa55491, 1)
        .setInteractive({ useHandCursor: true })
      const label = this.scene.add.text(width / 2, y, action.label, {
        fontFamily: 'Arial, sans-serif', fontSize: '16px', fontStyle: 'bold', color: action.primary ? '#ffffff' : '#6e3566',
      }).setOrigin(0.5)
      box.on('pointerup', () => onAction?.(action.key))
      this.root.add([box, label])
    })
    this.root.setVisible(true)
  }

  destroy() {
    this.root.destroy(true)
  }
}
