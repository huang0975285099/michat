// 门派 PK · 梦幻西游风 - 门派选择场景
// 承接 RaceSelectScene 选定的种族（registry: menpai-race），只渲染该族可选门派卡片，
// 选定后点击「开始战斗」取出（或新建）角色存档并开战。
//
// 布局：横屏最多 4 列；竖屏 2 列，卡片按可用宽度收缩。

import Phaser from 'phaser'
import { FACTIONS } from '../factions.js'
import { COLORS, RACES, getMetrics } from '../GameConstants.js'
import { characterFor } from '../save.js'
import { prepareBattle } from '../battleSetup.js'

const FONT = "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"

export class SelectScene extends Phaser.Scene {
  constructor() { super('Select') }

  create() {
    this.cameras.main.setBackgroundColor(COLORS.BG)
    this.selectedFaction = null

    // 种族在 RaceSelectScene 中选定并写入 registry；据此过滤本族可选门派
    const raceId = this.game.registry.get('menpai-race')
    this.raceId = raceId
    const race = RACES.find((r) => r.id === raceId)
    this.factionList = raceId ? FACTIONS.filter((f) => f.race === raceId) : FACTIONS

    this.titleText = this.add.text(0, 0, '选择你的门派', {
      fontFamily: FONT, fontSize: '36px', color: '#ffd700', fontStyle: 'bold',
    }).setOrigin(0.5, 0)

    this.subText = this.add.text(0, 0,
      race ? `${race.emoji} ${race.name}  ·  ${this.factionList.length} 门派可选` : '门派 PK · 梦幻西游风',
      { fontFamily: FONT, fontSize: '15px', color: '#bbbbbb' }
    ).setOrigin(0.5, 0)

    // 返回按钮（左上）：回到种族选择
    this.exitBtn = this._makeButton(0, 0, 92, 32, '← 返回', () => {
      this.scene.start('RaceSelect')
    })

    this.startBtn = this._makeButton(0, 0, 220, 54, '开始战斗', () => this._startBattle())
    this._setStartBtnEnabled(false)

    this.cards = []
    this._layout()

    this.scale.on('resize', this._onResize, this)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off('resize', this._onResize, this)
    })
  }

  _layout() {
    const m = getMetrics(this.scale.width, this.scale.height)
    const { width: w, height: h, portrait } = m

    this.titleText.setPosition(w / 2, portrait ? 24 : 40).setFontSize(portrait ? 26 : 36)
    this.subText.setPosition(w / 2, portrait ? 60 : 86).setFontSize(portrait ? 12 : 15)
    this.exitBtn.setPosition(12, 12)
    this.startBtn.setPosition(w / 2 - 110, h - (portrait ? 66 : 74))

    this.cards.forEach((c) => c.destroy())
    this.cards = []

    const startY = portrait ? 92 : 124
    const gapX = portrait ? 12 : 22
    const gapY = portrait ? 12 : 24
    const cols = portrait
      ? Math.min(2, this.factionList.length)
      : Math.min(4, this.factionList.length)
    // 竖屏按可用宽度收缩卡片，横屏用固定尺寸
    const cardW = portrait
      ? Math.min(168, (w - 24 - (cols - 1) * gapX) / cols)
      : 168
    const cardH = portrait ? Math.min(206, cardW * 1.22) : 206

    const totalW = cols * cardW + (cols - 1) * gapX
    const startX = (w - totalW) / 2
    this.factionList.forEach((f, i) => {
      const col = i % cols, row = Math.floor(i / cols)
      const x = startX + col * (cardW + gapX)
      const y = startY + row * (cardH + gapY)
      this.cards.push(this._makeCard(x, y, cardW, cardH, f))
    })
    if (this.selectedFaction) {
      const cur = this.cards.find((c) => c._faction === this.selectedFaction)
      if (cur) cur._redraw()
    }
  }

  _onResize() { this._layout() }

  _makeCard(x, y, w, h, faction) {
    const c = this.add.container(x, y)
    const g = this.add.graphics()
    c._hover = false
    // 悬停与选中视觉必须区分开，否则鼠标扫过别的卡片时会出现"两张都像选中"的焦点混乱
    const draw = () => {
      const selected = this.selectedFaction === faction
      g.clear()
      g.fillStyle(0x000000, 0.45)
      g.fillRoundedRect(3, 5, w, h, 14)
      g.fillStyle(faction.color, 0.92)
      g.fillRoundedRect(0, 0, w, h, 14)
      if (selected) g.lineStyle(4, COLORS.GOLD, 1)        // 选中：金色粗边 + ✓ 角标
      else if (c._hover) g.lineStyle(2, 0xffffff, 0.9)    // 悬停：白色细边
      else g.lineStyle(1.5, 0x000000, 0.35)
      g.strokeRoundedRect(0, 0, w, h, 14)
      badge.setVisible(selected)
    }
    // 卡片尺寸随屏幕收缩，内部元素按比例放置
    const emoji = this.add.text(w / 2, h * 0.28, faction.emoji, {
      fontFamily: FONT, fontSize: `${Math.round(h * 0.26)}px`,
    }).setOrigin(0.5)
    const name = this.add.text(w / 2, h * 0.56, faction.name, {
      fontFamily: FONT, fontSize: `${Math.max(14, Math.round(h * 0.097))}px`,
      color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)
    const race = this.add.text(w / 2, h * 0.70, `${faction.race}族`, {
      fontFamily: FONT, fontSize: `${Math.max(10, Math.round(h * 0.063))}px`, color: '#eeeeee',
    }).setOrigin(0.5)
    const role = this.add.text(w / 2, h * 0.81, faction.role, {
      fontFamily: FONT, fontSize: `${Math.max(10, Math.round(h * 0.063))}px`, color: '#ffd54f',
    }).setOrigin(0.5)
    const badge = this.add.text(w - 10, 6, '✓', {
      fontFamily: FONT, fontSize: '24px', color: '#ffd700', fontStyle: 'bold',
    }).setOrigin(1, 0).setStroke('#000000', 4).setVisible(false)

    c.add([g, emoji, name, race, role, badge])
    c.setSize(w, h)
    c.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains)
    c.on('pointerover', () => { c._hover = true; draw() })
    c.on('pointerout', () => { c._hover = false; draw() })
    c.on('pointerup', () => this._selectFaction(faction))
    c._redraw = draw
    c._faction = faction
    draw()
    return c
  }

  _selectFaction(faction) {
    if (this.selectedFaction === faction) return
    const prevFaction = this.selectedFaction
    this.selectedFaction = faction
    if (prevFaction) {
      const prev = this.cards.find((c) => c._faction === prevFaction)
      if (prev) prev._redraw()
    }
    const cur = this.cards.find((c) => c._faction === faction)
    if (cur) cur._redraw()
    this._setStartBtnEnabled(true)
  }

  _setStartBtnEnabled(enabled) {
    if (this.startBtn) this.startBtn.setEnabled(enabled)
  }

  _startBattle() {
    if (!this.selectedFaction) return
    const playerFaction = this.selectedFaction
    // 存档种族+门派与本次选择一致则沿用（保留等级经验），否则从 1 级新角色开始
    const character = characterFor(this.raceId, playerFaction.id)
    this.game.registry.set('menpai-character', character)
    prepareBattle(this.game, playerFaction)
    this.scene.start('Battle')   // BattleScene.create 会自行拉起 UIScene
  }

  _makeButton(x, y, w, h, label, onClick) {
    const c = this.add.container(x, y)
    const g = this.add.graphics()
    const txt = this.add.text(w / 2, h / 2, label, {
      fontFamily: FONT, fontSize: '16px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)
    let enabled = true, hover = false
    const draw = () => {
      g.clear()
      g.fillStyle(0x000000, 0.4)
      g.fillRoundedRect(2, 3, w, h, 8)
      if (!enabled) g.fillStyle(0x4a4a4a, 0.85)
      else if (hover) g.fillStyle(0xe74c3c, 0.97)
      else g.fillStyle(0xc0392b, 0.93)
      g.fillRoundedRect(0, 0, w, h, 8)
      g.lineStyle(hover && enabled ? 2 : 1.5, COLORS.GOLD, enabled ? 0.9 : 0.4)
      g.strokeRoundedRect(0, 0, w, h, 8)
    }
    draw()
    c.add([g, txt])
    c.setSize(w, h)
    c.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains)
    c.on('pointerover', () => { hover = true; draw() })
    c.on('pointerout', () => { hover = false; draw() })
    c.on('pointerup', () => { if (enabled) onClick() })
    c.setEnabled = (en) => { enabled = en; txt.setAlpha(enabled ? 1 : 0.55); draw() }
    return c
  }
}
