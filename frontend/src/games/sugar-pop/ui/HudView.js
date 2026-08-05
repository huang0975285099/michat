const BOOSTERS = [
  { key: 'hammer', label: 'Hammer' },
  { key: 'shuffle', label: 'Shuffle' },
  { key: 'extraMoves', label: '+5 Moves' },
]

export function calculateHudLayout(width, height) {
  const edge = Math.max(16, Math.min(28, width * 0.045))
  const boosterY = height - Math.max(48, Math.min(64, height * 0.07))
  const usable = width - edge * 2
  return {
    targets: { x: edge, y: 18 },
    moves: { x: width - edge, y: 18 },
    score: { x: width / 2, y: 72 },
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
  if (typeof target.jelly === 'number') lines.push(`jelly: ${target.jelly}`)
  if (typeof target.frosting === 'number') lines.push(`frosting: ${target.frosting}`)
  return lines.length ? lines : ['Ready!']
}

export default class HudView {
  constructor(scene) {
    this.scene = scene
    this.layoutData = calculateHudLayout(scene.scale.gameSize.width, scene.scale.gameSize.height)
    this.background = scene.add.graphics()
    this.targets = scene.add.text(0, 0, '', { fontFamily: 'Arial, sans-serif', fontSize: '16px', color: '#4a2148', fontStyle: 'bold' })
      .setOrigin(0, 0)
    this.moves = scene.add.text(0, 0, '', { fontFamily: 'Arial, sans-serif', fontSize: '18px', color: '#4a2148', fontStyle: 'bold', align: 'right' })
      .setOrigin(1, 0)
    this.score = scene.add.text(0, 0, '', { fontFamily: 'Arial, sans-serif', fontSize: '16px', color: '#673064', fontStyle: 'bold' })
      .setOrigin(0.5, 0)
    this.boosterButtons = BOOSTERS.map((booster) => {
      const box = scene.add.rectangle(0, 0, 96, 48, 0xffffff, 0.75).setStrokeStyle(2, 0x9c5d98, 0.65)
      const text = scene.add.text(0, 0, booster.label, { fontFamily: 'Arial, sans-serif', fontSize: '13px', color: '#572c55', fontStyle: 'bold', align: 'center' }).setOrigin(0.5)
      return { ...booster, box, text }
    })
    this.setLayout(scene.scale.gameSize.width, scene.scale.gameSize.height)
  }

  setLayout(width, height) {
    this.layoutData = calculateHudLayout(width, height)
    const { targets, moves, score, boosters } = this.layoutData
    this.background.clear()
    this.background.fillStyle(0xfff6fc, 0.86)
    this.background.fillRoundedRect(8, 8, width - 16, 92, 20)
    this.targets.setPosition(targets.x, targets.y).setWordWrapWidth(Math.max(140, width * 0.48))
    this.moves.setPosition(moves.x, moves.y)
    this.score.setPosition(score.x, score.y)
    boosters.forEach((layout, index) => {
      const button = this.boosterButtons[index]
      button.box.setPosition(layout.x, layout.y).setDisplaySize(layout.width, 48)
      button.text.setPosition(layout.x, layout.y)
    })
  }

  update({ levelId, movesLeft, score, target, boosters = {} }) {
    this.targets.setText(`Level ${levelId}\n${targetLines(target).join('  •  ')}`)
    this.moves.setText(`Moves\n${movesLeft}`)
    this.score.setText(`Score ${score}`)
    this.boosterButtons.forEach((button) => {
      button.text.setText(`${button.label}\n×${boosters[button.key] || 0}`)
    })
  }

  destroy() {
    this.background.destroy()
    this.targets.destroy()
    this.moves.destroy()
    this.score.destroy()
    this.boosterButtons.forEach(({ box, text }) => {
      box.destroy()
      text.destroy()
    })
  }
}
