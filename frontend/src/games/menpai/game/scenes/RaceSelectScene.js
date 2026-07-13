// 门派 PK · 梦幻西游风 - 种族选择场景
// 流程首站：选人/魔/仙三族之一，决定后续可选门派范围（人族→大唐/化生/方寸，
// 仙族→龙宫/普陀，魔族→魔王/狮驼），再进入 SelectScene 选门派。
// 若存在本地存档，顶部给一个「继续冒险」入口直接开战，跳过两步选择。
//
// 布局：横屏三卡并排；竖屏（手机）改为纵向堆叠的宽扁卡片。

import Phaser from 'phaser'
import { RACES, COLORS, getMetrics } from '../GameConstants.js'
import { FACTIONS, getFaction } from '../factions.js'
import { loadCharacter } from '../save.js'
import { prepareBattle } from '../battleSetup.js'

const FONT = "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"

export class RaceSelectScene extends Phaser.Scene {
  constructor() { super('RaceSelect') }

  create() {
    this.cameras.main.setBackgroundColor(COLORS.BG)
    this.selectedRace = null
    this.saved = loadCharacter()

    this.titleText = this.add.text(0, 0, '选择你的种族', {
      fontFamily: FONT, fontSize: '36px', color: '#ffd700', fontStyle: 'bold',
    }).setOrigin(0.5, 0)

    this.subText = this.add.text(0, 0, '门派 PK · 梦幻西游风  ·  人 / 魔 / 仙 三族任选其一', {
      fontFamily: FONT, fontSize: '15px', color: '#bbbbbb', align: 'center',
    }).setOrigin(0.5, 0)

    this.exitBtn = this._makeButton(0, 0, 92, 32, '← 返回', () => {
      this.game.events.emit('menpai-exit')
    })

    this.nextBtn = this._makeButton(0, 0, 220, 54, '下一步：选门派', () => this._goSelectFaction())
    this._setNextBtnEnabled(false)

    // 存档续玩入口
    this.continueBtn = null
    if (this.saved) {
      const f = getFaction(this.saved.factionId)
      this.continueBtn = this._makeButton(0, 0, 300, 44,
        `继续冒险：${f.emoji} ${f.name} Lv.${this.saved.level}`,
        () => this._continueSaved())
    }

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
    this._m = m

    this.titleText.setPosition(w / 2, portrait ? 24 : 40)
      .setFontSize(portrait ? 26 : 36)
    this.subText.setPosition(w / 2, portrait ? 60 : 86)
      .setFontSize(portrait ? 12 : 15)
      .setWordWrapWidth(w - 32)
    this.exitBtn.setPosition(12, 12)
    this.nextBtn.setPosition(w / 2 - 110, h - (portrait ? 66 : 74))

    let cardsTop = portrait ? 92 : 124
    if (this.continueBtn) {
      this.continueBtn.setPosition(w / 2 - 150, cardsTop)
      cardsTop += 60
    }

    this.cards.forEach((c) => c.destroy())
    this.cards = []
    if (portrait) {
      // 纵向堆叠：宽扁卡，emoji 在左，属性一行文字
      const cardW = Math.min(w - 24, 460)
      const bottomLimit = h - 84
      const gap = 10
      const cardH = Math.min(126, Math.max(84, (bottomLimit - cardsTop - gap * 2) / RACES.length))
      const x = (w - cardW) / 2
      RACES.forEach((race, i) => {
        const y = cardsTop + i * (cardH + gap)
        this.cards.push(this._makeCardWide(x, y, cardW, cardH, race))
      })
    } else {
      const cardW = 240, cardH = 320, gap = 28
      const totalW = RACES.length * cardW + (RACES.length - 1) * gap
      const startX = (w - totalW) / 2
      RACES.forEach((race, i) => {
        const x = startX + i * (cardW + gap)
        this.cards.push(this._makeCardTall(x, cardsTop, cardW, cardH, race))
      })
    }
    if (this.selectedRace) {
      const cur = this.cards.find((c) => c._race === this.selectedRace)
      if (cur) cur._redraw()
    }
  }

  _onResize() { this._layout() }

  _factionNamesFor(race) {
    return FACTIONS.filter((f) => f.race === race.id).map((f) => f.name).join(' / ')
  }

  /** 卡片背景绘制 + 选中/悬停描边，两种卡型共用 */
  _attachCardChrome(c, g, badge, w, h, radius, race) {
    const draw = () => {
      const selected = this.selectedRace === race
      g.clear()
      g.fillStyle(0x000000, 0.45)
      g.fillRoundedRect(3, 5, w, h, radius)
      g.fillStyle(race.color, 0.92)
      g.fillRoundedRect(0, 0, w, h, radius)
      if (selected) g.lineStyle(4, COLORS.GOLD, 1)
      else if (c._hover) g.lineStyle(2, 0xffffff, 0.9)
      else g.lineStyle(1.5, 0x000000, 0.35)
      g.strokeRoundedRect(0, 0, w, h, radius)
      badge.setVisible(selected)
    }
    c.setSize(w, h)
    c.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains)
    c.on('pointerover', () => { c._hover = true; draw() })
    c.on('pointerout', () => { c._hover = false; draw() })
    c.on('pointerup', () => this._selectRace(race))
    c._redraw = draw
    c._race = race
    draw()
  }

  /** 横屏卡：竖排，含五维属性条 */
  _makeCardTall(x, y, w, h, race) {
    const c = this.add.container(x, y)
    c._hover = false
    const g = this.add.graphics()
    const emoji = this.add.text(w / 2, 54, race.emoji, { fontFamily: FONT, fontSize: '54px' }).setOrigin(0.5)
    const name = this.add.text(w / 2, 110, race.name, {
      fontFamily: FONT, fontSize: '22px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)
    const tagline = this.add.text(w / 2, 140, race.tagline, {
      fontFamily: FONT, fontSize: '12px', color: '#eeeeee', align: 'center', wordWrap: { width: w - 24 },
    }).setOrigin(0.5, 0)

    const statObjs = []
    const maxVal = 12, barsTop = 190, barGap = 22
    Object.entries(race.stats).forEach(([k, val], i) => {
      const rowY = barsTop + i * barGap
      statObjs.push(this.add.text(20, rowY, k, {
        fontFamily: FONT, fontSize: '12px', color: '#ffffff',
      }).setOrigin(0, 0.5))
      const barX = 64, barW = w - barX - 34
      const bar = this.add.graphics()
      bar.fillStyle(0x000000, 0.35)
      bar.fillRoundedRect(barX, rowY - 6, barW, 12, 4)
      bar.fillStyle(0xffd700, 0.9)
      bar.fillRoundedRect(barX, rowY - 6, barW * Phaser.Math.Clamp(val / maxVal, 0, 1), 12, 4)
      statObjs.push(bar)
      statObjs.push(this.add.text(w - 18, rowY, String(val), {
        fontFamily: FONT, fontSize: '12px', color: '#ffffff',
      }).setOrigin(1, 0.5))
    })

    const factionNames = this.add.text(w / 2, h - 14, `可选门派：${this._factionNamesFor(race)}`, {
      fontFamily: FONT, fontSize: '11px', color: '#ffe9a8', align: 'center', wordWrap: { width: w - 20 },
    }).setOrigin(0.5, 1)
    const badge = this._makeBadge(w)

    c.add([g, emoji, name, tagline, ...statObjs, factionNames, badge])
    this._attachCardChrome(c, g, badge, w, h, 16, race)
    return c
  }

  /** 竖屏卡：宽扁，emoji 在左，五维压成一行文本 */
  _makeCardWide(x, y, w, h, race) {
    const c = this.add.container(x, y)
    c._hover = false
    const g = this.add.graphics()
    const emoji = this.add.text(44, h / 2, race.emoji, { fontFamily: FONT, fontSize: '40px' }).setOrigin(0.5)
    const textX = 84
    const name = this.add.text(textX, 12, race.name, {
      fontFamily: FONT, fontSize: '19px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0, 0)
    const statLine = Object.entries(race.stats).map(([k, v]) => `${k}${v}`).join('  ')
    const stats = this.add.text(textX, 40, statLine, {
      fontFamily: FONT, fontSize: '12px', color: '#ffd700', fontStyle: 'bold',
    }).setOrigin(0, 0)
    const tagline = this.add.text(textX, 60, race.tagline, {
      fontFamily: FONT, fontSize: '11px', color: '#eeeeee', wordWrap: { width: w - textX - 16 },
    }).setOrigin(0, 0)
    const factionNames = this.add.text(textX, h - 8, `可选门派：${this._factionNamesFor(race)}`, {
      fontFamily: FONT, fontSize: '10px', color: '#ffe9a8', wordWrap: { width: w - textX - 16 },
    }).setOrigin(0, 1)
    const badge = this._makeBadge(w)

    c.add([g, emoji, name, stats, tagline, factionNames, badge])
    this._attachCardChrome(c, g, badge, w, h, 14, race)
    return c
  }

  _makeBadge(w) {
    return this.add.text(w - 10, 6, '✓', {
      fontFamily: FONT, fontSize: '24px', color: '#ffd700', fontStyle: 'bold',
    }).setOrigin(1, 0).setStroke('#000000', 4).setVisible(false)
  }

  _selectRace(race) {
    if (this.selectedRace === race) return
    const prev = this.selectedRace
    this.selectedRace = race
    if (prev) {
      const prevCard = this.cards.find((c) => c._race === prev)
      if (prevCard) prevCard._redraw()
    }
    const cur = this.cards.find((c) => c._race === race)
    if (cur) cur._redraw()
    this._setNextBtnEnabled(true)
  }

  _setNextBtnEnabled(enabled) {
    if (this.nextBtn) this.nextBtn.setEnabled(enabled)
  }

  _goSelectFaction() {
    if (!this.selectedRace) return
    this.game.registry.set('menpai-race', this.selectedRace.id)
    this.scene.start('Select')
  }

  /** 直接用存档角色开战，跳过种族/门派选择 */
  _continueSaved() {
    const faction = getFaction(this.saved.factionId)
    if (!faction) return
    this.game.registry.set('menpai-race', this.saved.raceId)
    this.game.registry.set('menpai-character', { ...this.saved })
    prepareBattle(this.game, faction)
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
