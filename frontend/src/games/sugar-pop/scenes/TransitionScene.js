import Scene from 'phaser/src/scene/Scene.js'

export default class TransitionScene extends Scene {
  constructor() {
    super({ key: 'TransitionScene' })
  }

  create() {
    this.handleResize = this.handleResize.bind(this)
    this.scale.on('resize', this.handleResize)
    this.events.once('shutdown', this.shutdown, this)
  }

  handleResize(gameSize) {
    if (!this.root) return
    const { width, height } = gameSize
    this.glow.setPosition(width / 2, height / 2).setDisplaySize(width, height)
    this.title.setPosition(width / 2, height / 2 - 34).setFontSize(Math.max(28, Math.min(48, width * 0.1)))
    this.counter.setPosition(width / 2, height / 2 + 34)
  }

  playBonusMoves({ movesLeft = 0, bonusScore = 0 } = {}) {
    this.root?.destroy(true)
    const { width, height } = this.scale.gameSize
    this.root = this.add.container(0, 0).setDepth(900)
    this.glow = this.add.rectangle(width / 2, height / 2, width, height, 0xffc4df, 0.35)
    this.title = this.add.text(width / 2, height / 2 - 34, 'Sweet Finish!', {
      fontFamily: 'Arial, sans-serif', fontSize: `${Math.max(28, Math.min(48, width * 0.1))}px`, fontStyle: 'bold', color: '#8a3978', stroke: '#ffffff', strokeThickness: 6,
    }).setOrigin(0.5)
    this.counter = this.add.text(width / 2, height / 2 + 34, `${movesLeft} moves  •  +0`, {
      fontFamily: 'Arial, sans-serif', fontSize: '20px', fontStyle: 'bold', color: '#66315d',
    }).setOrigin(0.5)
    this.root.add([this.glow, this.title, this.counter])
    const safeMoves = Math.max(0, Math.trunc(movesLeft))
    return new Promise((resolve) => {
      this.tweens.addCounter({
        from: 0,
        to: safeMoves,
        duration: Math.max(350, safeMoves * 110),
        ease: 'Sine.Out',
        onUpdate: (tween) => {
          const spent = Math.min(safeMoves, Math.round(tween.getValue()))
          const score = safeMoves === 0 ? bonusScore : Math.round((spent / safeMoves) * bonusScore)
          this.counter.setText(`${safeMoves - spent} moves  •  +${score}`)
        },
        onComplete: () => {
          this.counter.setText(`0 moves  •  +${bonusScore}`)
          this.time.delayedCall(220, () => {
            this.root?.destroy(true)
            this.root = null
            this.glow = null
            this.title = null
            this.counter = null
            resolve()
          })
        },
      })
    })
  }

  shutdown() {
    this.scale.off('resize', this.handleResize)
    this.root?.destroy(true)
    this.root = null
    this.glow = null
    this.title = null
    this.counter = null
  }
}
