// 铁拳 - 二期 战斗场景（Phaser）
// 渲染无关引擎(IronFistGame)不变；本场景只消费每回合结算结果 + 蓄力态，
// 通过 playRound(result) / setCharge() 驱动表现。
// 见 docs/ironfist.md 第十三/二十二节（逻辑与渲染解耦 + 动画演进）。

import Phaser from 'phaser'
import { Fighter, ensureFighterTextures, PAL_ME, PAL_OPP } from '../Fighter.js'

// 与一期 BattleArena 一致的姿态映射
function poseFor(action, dmgTaken, dealtDmg) {
  if (action === 'attack') return 'attack'
  if (action === 'charge') return dmgTaken > 0 ? 'stagger' : 'charge'
  if (action === 'counter') return dealtDmg > 0 ? 'dodge' : 'miss'
  return 'guard'
}

const CRIT_THRESHOLD = 18

export default class BattleScene extends Phaser.Scene {
  constructor() { super('BattleScene') }

  init(data) { this.opts = data || {} }

  create() {
    ensureFighterTextures(this)
    this.stage = this.add.graphics()

    this.opp = new Fighter(this, 'opp', PAL_OPP, +1, true)
    this.me = new Fighter(this, 'me', PAL_ME, -1, false)

    this.sparks = this.add.particles(0, 0, 'if_spark', {
      speed: { min: 90, max: 250 }, lifespan: 420, scale: { start: 1, end: 0 },
      tint: 0xffe082, blendMode: 'ADD', emitting: false,
    })

    this.layout()
    this.scale.on('resize', this.layout, this)

    this.setCharge(this.opts.playerCharged, this.opts.opponentCharged)
    this.game.events.emit('battle-ready')
  }

  layout() {
    const w = this.scale.width, h = this.scale.height
    this.drawStage(w, h)
    this.opp.moveHome(w * 0.5, h * 0.30)
    this.me.moveHome(w * 0.5, h * 0.74)
  }

  drawStage(w, h) {
    const g = this.stage
    g.clear()
    g.fillGradientStyle(0x322764, 0x322764, 0x0e0a1e, 0x0e0a1e, 1)
    g.fillRect(0, 0, w, h)
    g.fillStyle(0x6a4fd0, 0.22); g.fillEllipse(w * 0.5, h * 0.84, w * 1.15, h * 0.55)  // 地面光盘
    g.fillStyle(0xb6a8ff, 0.5); g.fillRect(w * 0.08, h * 0.52, w * 0.84, 2)             // 中线
  }

  setCharge(playerCharged, opponentCharged) {
    this.me.setCharged(!!playerCharged)
    this.opp.setCharged(!!opponentCharged)
  }

  playRound(r) {
    if (!r) return
    this.me.pose(poseFor(r.playerAction, r.playerDmg, r.opponentDmg))
    this.opp.pose(poseFor(r.opponentAction, r.opponentDmg, r.playerDmg))

    this.time.delayedCall(240, () => {
      if (r.playerDmg > 0) this._hit(this.me, r.playerDmg)
      if (r.opponentDmg > 0) this._hit(this.opp, r.opponentDmg)
      if (r.playerDmg > 0 || r.opponentDmg > 0) this.cameras.main.shake(220, 0.012)
      if (r.playerDmg > 0 && r.opponentDmg > 0) this._clash()
    })

    if (r.envDmg > 0) this.time.delayedCall(150, () => this._envWarn(r.envDmg))

    this.time.delayedCall(1000, () => { this.me.resetPose(); this.opp.resetPose() })
  }

  _hit(fighter, dmg) {
    const crit = dmg >= CRIT_THRESHOLD
    fighter.reactHit()
    const { x, y } = fighter.hitPoint()
    this.sparks.explode(crit ? 22 : 13, x, y)
    this._dmgText(x, y, dmg, crit)

    const ring = this.add.image(x, y, 'if_glow')
      .setTint(crit ? 0xff7a3c : 0xffffff).setScale(0.2).setBlendMode(Phaser.BlendModes.ADD).setDepth(40)
    this.tweens.add({ targets: ring, scale: crit ? 1.5 : 1.05, alpha: 0, duration: 380, ease: 'Cubic.out', onComplete: () => ring.destroy() })
  }

  _dmgText(x, y, dmg, crit) {
    const t = this.add.text(x, y - 18, (crit ? 'CRIT\n' : '') + '-' + dmg, {
      fontFamily: 'Arial, sans-serif', fontSize: crit ? '32px' : '24px', fontStyle: 'bold',
      color: crit ? '#ffd34d' : '#ff6060', stroke: '#000000', strokeThickness: 4, align: 'center',
    }).setOrigin(0.5).setDepth(50)
    this.tweens.add({ targets: t, y: y - 64, alpha: 0, duration: 850, ease: 'Cubic.out', onComplete: () => t.destroy() })
    if (crit) this.tweens.add({ targets: t, scale: { from: 0.4, to: 1.15 }, duration: 320, ease: 'Back.out' })
  }

  _clash() {
    const w = this.scale.width, h = this.scale.height
    const f = this.add.image(w * 0.5, h * 0.5, 'if_glow')
      .setTint(0xffffff).setScale(0.4).setBlendMode(Phaser.BlendModes.ADD).setDepth(45)
    this.tweens.add({ targets: f, scale: 2.4, alpha: 0, duration: 320, ease: 'Cubic.out', onComplete: () => f.destroy() })
  }

  _envWarn(dmg) {
    const w = this.scale.width, h = this.scale.height
    const t = this.add.text(w * 0.5, h * 0.5, '⚠ 环境 -' + dmg, {
      fontFamily: 'Arial, sans-serif', fontSize: '18px', fontStyle: 'bold',
      color: '#ff7a7a', stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(50)
    this.tweens.add({ targets: t, alpha: 0, duration: 1100, ease: 'Cubic.in', onComplete: () => t.destroy() })
  }
}
