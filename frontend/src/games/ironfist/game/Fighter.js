// 铁拳 - 二期 程序化矢量斗士（Phaser）
// 用 Graphics 生成的零件纹理拼出一个 Q 版拳手，全部动画走 tween。
// 自包含：未来换精灵图（三期/素材就位后）只需替换本文件，BattleScene 不变。
// 见 docs/ironfist.md 第二十二节 动画演进路线。

import Phaser from 'phaser'

// 共享纹理（柔光 / 火花），整个 game 只生成一次
export function ensureFighterTextures(scene) {
  if (scene.textures.exists('if_glow')) return
  const g = scene.add.graphics()
  // 柔和径向光（用于光环 / 命中爆闪 / 阴影）
  for (let i = 26; i >= 0; i--) {
    g.fillStyle(0xffffff, (i / 26) * 0.05)
    g.fillCircle(64, 64, (i / 26) * 64)
  }
  g.generateTexture('if_glow', 128, 128)
  g.clear()
  // 火花粒子
  g.fillStyle(0xffffff, 1)
  g.fillCircle(5, 5, 5)
  g.generateTexture('if_spark', 10, 10)
  g.destroy()
}

// 为某一方生成零件纹理（按 side 命名，避免两方串色）
function makeParts(scene, side, pal, isRobot) {
  const key = (n) => `if_${side}_${n}`
  if (scene.textures.exists(key('head'))) return
  const g = scene.add.graphics()

  // 头
  if (isRobot) {
    g.fillStyle(pal.head, 1); g.lineStyle(3, pal.bodyDark, 1)
    g.fillRoundedRect(2, 4, 32, 30, 8); g.strokeRoundedRect(2, 4, 32, 30, 8)
    g.fillStyle(0x14223e, 1); g.fillRoundedRect(7, 15, 22, 9, 4)      // 护目镜
    g.fillStyle(pal.accent, 1); g.fillCircle(13, 19, 2.6); g.fillCircle(23, 19, 2.6)
    g.fillStyle(pal.bodyDark, 1); g.fillRect(16, 0, 4, 5)             // 天线
  } else {
    g.fillStyle(pal.head, 1); g.lineStyle(3, pal.bodyDark, 1)
    g.fillCircle(18, 18, 16); g.strokeCircle(18, 18, 16)
    g.fillStyle(0x232336, 1); g.fillCircle(12, 17, 2.6); g.fillCircle(24, 17, 2.6) // 眼
    g.lineStyle(2, 0x232336, 1); g.beginPath(); g.arc(18, 24, 5, 0.15, Math.PI - 0.15); g.strokePath() // 嘴
  }
  g.generateTexture(key('head'), 36, 36); g.clear()

  // 躯干（胶囊 + 腰带）
  g.fillStyle(pal.body, 1); g.lineStyle(3, pal.bodyDark, 1)
  g.fillRoundedRect(2, 2, 32, 40, 13); g.strokeRoundedRect(2, 2, 32, 40, 13)
  g.fillStyle(pal.accent, 1); g.fillRect(2, 28, 32, 5)               // 腰带
  g.generateTexture(key('torso'), 36, 44); g.clear()

  // 拳套
  g.fillStyle(pal.glove, 1); g.lineStyle(3, pal.gloveDark, 1)
  g.fillCircle(13, 13, 12); g.strokeCircle(13, 13, 12)
  g.fillStyle(pal.gloveDark, 1); g.fillRoundedRect(9, 22, 8, 5, 2)   // 腕带
  g.generateTexture(key('glove'), 26, 30); g.clear()

  // 腿
  g.fillStyle(pal.bodyDark, 1)
  g.fillRoundedRect(1, 1, 12, 18, 5)
  g.generateTexture(key('leg'), 14, 20); g.clear()

  g.destroy()
}

export class Fighter {
  /**
   * @param {Phaser.Scene} scene
   * @param {string} side  'me' | 'opp'（用于纹理键名与闪避方向）
   * @param {object} pal   配色
   * @param {number} dir   朝向对手的方向（me=-1 向上，opp=+1 向下）
   * @param {boolean} isRobot
   */
  constructor(scene, side, pal, dir, isRobot) {
    this.scene = scene
    this.side = side
    this.dir = dir
    makeParts(scene, side, pal, isRobot)

    this.home = { x: 0, y: 0 }
    this.shadow = scene.add.image(0, 0, 'if_glow').setTint(0x000000).setAlpha(0.45).setScale(0.5, 0.16)
    this.aura = scene.add.image(0, 0, 'if_glow').setTint(pal.aura).setBlendMode(Phaser.BlendModes.ADD).setScale(1.05).setVisible(false)
    this.container = scene.add.container(0, 0)

    const k = (n) => `if_${side}_${n}`
    this.legL = scene.add.image(-8, 18, k('leg'))
    this.legR = scene.add.image(8, 18, k('leg'))
    this.torso = scene.add.image(0, -2, k('torso'))
    this.gloveL = scene.add.image(-19, -4, k('glove'))
    this.gloveR = scene.add.image(19, -4, k('glove'))
    this.head = scene.add.image(0, -30, k('head'))
    this.container.add([this.aura, this.legL, this.legR, this.torso, this.gloveL, this.gloveR, this.head])

    this.parts = [this.legL, this.legR, this.torso, this.gloveL, this.gloveR, this.head]
    this.gHome = { L: { x: -19, y: -4 }, R: { x: 19, y: -4 } }
    this._auraTween = null
  }

  moveHome(x, y) {
    this.home = { x, y }
    this.container.setPosition(x, y)
    this.shadow.setPosition(x, y + 26)
  }

  hitPoint() { return { x: this.container.x, y: this.container.y - 18 } }

  setCharged(on) {
    if (on === this.aura.visible) return
    this.aura.setVisible(on)
    if (on) {
      this._auraTween = this.scene.tweens.add({
        targets: this.aura, alpha: { from: 0.5, to: 1 }, scale: { from: 0.95, to: 1.3 },
        duration: 700, yoyo: true, repeat: -1, ease: 'Sine.inOut',
      })
    } else if (this._auraTween) {
      this._auraTween.stop(); this._auraTween = null
      this.aura.setAlpha(1).setScale(1.05)
    }
  }

  // 出招姿态（假定回合开始时已归位）
  pose(name) {
    const s = this.scene, c = this.container, d = this.dir
    if (name === 'attack') {
      s.tweens.add({ targets: c, y: this.home.y + d * 30, duration: 130, yoyo: true, ease: 'Quad.out' })
      s.tweens.add({ targets: this.gloveR, y: this.gHome.R.y + d * 18, scaleX: 1.35, scaleY: 1.35, duration: 120, yoyo: true, ease: 'Quad.out' })
    } else if (name === 'guard') {
      s.tweens.add({ targets: c, scaleY: 0.9, duration: 140, ease: 'Quad.out' })
      s.tweens.add({ targets: this.gloveL, x: -8, y: this.gHome.L.y + d * 4 - 6, duration: 140 })
      s.tweens.add({ targets: this.gloveR, x: 8, y: this.gHome.R.y + d * 4 - 6, duration: 140 })
    } else if (name === 'charge') {
      s.tweens.add({ targets: c, scaleX: 1.08, scaleY: 1.08, duration: 300, yoyo: true, repeat: 1, ease: 'Sine.inOut' })
    } else if (name === 'dodge') {
      const dx = this.side === 'me' ? -24 : 24
      s.tweens.add({ targets: c, x: this.home.x + dx, angle: this.side === 'me' ? -14 : 14, duration: 160, yoyo: true, ease: 'Quad.out' })
    } else if (name === 'miss') {
      s.tweens.add({ targets: c, angle: { from: -8, to: 8 }, duration: 90, yoyo: true, repeat: 2, ease: 'Sine.inOut', onComplete: () => { c.angle = 0 } })
    } else if (name === 'stagger') {
      this.parts.forEach((p) => p.setTint(0x8a8a8a))
      s.tweens.add({ targets: c, angle: { from: -11, to: 11 }, duration: 90, yoyo: true, repeat: 2, onComplete: () => { c.angle = 0 } })
    }
  }

  // 受击反应：被推后 + 白闪
  reactHit() {
    const s = this.scene, c = this.container, d = this.dir
    s.tweens.add({ targets: c, y: this.home.y - d * 12, duration: 90, yoyo: true, ease: 'Quad.out' })
    this.parts.forEach((p) => p.setTintFill(0xffffff))
    s.time.delayedCall(110, () => this.parts.forEach((p) => p.clearTint()))
  }

  // 回合结束：动画归位 + 清除临时染色
  resetPose() {
    const s = this.scene
    this.parts.forEach((p) => p.clearTint())
    s.tweens.add({ targets: this.container, x: this.home.x, y: this.home.y, scaleX: 1, scaleY: 1, angle: 0, duration: 180, ease: 'Quad.out' })
    s.tweens.add({ targets: this.gloveL, x: this.gHome.L.x, y: this.gHome.L.y, scaleX: 1, scaleY: 1, duration: 180 })
    s.tweens.add({ targets: this.gloveR, x: this.gHome.R.x, y: this.gHome.R.y, scaleX: 1, scaleY: 1, duration: 180 })
  }
}

// 配色
export const PAL_ME = {
  body: 0x4da3ff, bodyDark: 0x2c6fb0, head: 0xbfe0ff,
  glove: 0xff5a5a, gloveDark: 0xb53030, accent: 0x6fcaff, aura: 0x6fb6ff,
}
export const PAL_OPP = {
  body: 0xff6b6b, bodyDark: 0xc0392b, head: 0xb6bccb,
  glove: 0x4da3ff, gloveDark: 0x2c6fb0, accent: 0xff9aa2, aura: 0xffd54f,
}
