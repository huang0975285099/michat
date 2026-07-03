// 九州征途 - HUD 场景（Phaser 全权实现，无 DOM 混合）
// 叠在 WorldScene 之上，固定屏幕坐标。所有面板/按钮/提示均为 Phaser GameObject。
// WorldScene 通过 hitTest(x,y) 询问指针是否落在 UI 上，避免点击穿透到地图。

import Phaser from 'phaser'
import {
  RESOURCES, TILE_TYPES, TIME_SCALE, BASE_YIELD_PER_LEVEL,
  expToLevel, cityUpgradeCost, RECRUIT_GRAIN_PER_TROOP, CITY_MAX_LEVEL,
  npcCityLootOf,
  BUILDINGS, BUILDING_MAX_LEVEL, buildingUpgradeCost,
  GRANARY_YIELD_PER_LEVEL, BARRACKS_CAP_PER_LEVEL, TRAINING_EXP_PER_LEVEL, FORGE_STAT_PER_LEVEL,
  STAMINA_MAX, MARCH_STAMINA_COST, STAMINA_REGEN_PER_HOUR,
  GENERAL_QUALITY, MAX_GENERALS, RECRUIT_COST_COIN, AWAKEN_ATK, AWAKEN_DEF, AWAKEN_INT, AWAKEN_SPD,
  TROOP_TYPES, counterMult, findGeneralTemplate, guardStat,
} from '../GameConstants.js'
import { GameState } from '../core/GameState.js'

const FONT = "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
const TOPBAR_H = 40
const DEPTH = { bar: 100, panel: 200, modal: 300, toast: 400 }
const COLOR = {
  panelBg: 0x20261e, panelLine: 0xffd700,
  btnRed: 0xc62828, btnAmber: 0xd4a017, btnGreen: 0x2e7d32,
  btnGrey: 0x455a64, rowBg: 0x2c352a,
  toastInfo: 0x37474f, toastWarn: 0xb26a00, toastWin: 0x2e7d32, toastLose: 0xc62828, toastDraw: 0x616161,
}

function fmt(n) {
  n = Math.floor(n || 0)
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return String(n)
}

function style(size, color = '#ffffff', bold = false) {
  return { fontFamily: FONT, fontSize: `${size}px`, color, fontStyle: bold ? 'bold' : 'normal' }
}

// 颜色调亮/调暗（factor<1 变暗，>1 变亮），用于按钮/面板渐变
function shadeColor(color, factor) {
  const r = Math.min(255, Math.max(0, Math.floor(((color >> 16) & 0xff) * factor)))
  const g = Math.min(255, Math.max(0, Math.floor(((color >> 8) & 0xff) * factor)))
  const b = Math.min(255, Math.max(0, Math.floor((color & 0xff) * factor)))
  return (r << 16) | (g << 8) | b
}

export class UIScene extends Phaser.Scene {
  constructor() { super('UI') }

  init(data) { this.state = data.state }

  create() {
    this.modal = null
    this.sel = null              // 当前选中地块 {x,y}
    this.tileC = null            // 地块面板容器
    this._tileRect = null
    this._btnRects = []
    this._marchRects = []
    this._uiTick = 999           // 立即刷新一次

    this._buildTopbar()
    this._buildBottombar()
    this.marchC = this.add.container(0, TOPBAR_H + 6).setDepth(DEPTH.bar)

    // ── 逻辑层事件 ──
    this._subs = [
      this.state.on('battle', ({ outcome, general }) => {
        const msg = outcome === 'win' ? `${general} 战斗胜利！`
          : outcome === 'draw' ? `${general} 未分胜负…` : `${general} 战败…`
        const color = outcome === 'win' ? COLOR.toastWin
          : outcome === 'draw' ? COLOR.toastDraw : COLOR.toastLose
        this._toast(msg, color)
      }),
      this.state.on('territory', () => this._refreshTilePanel()),
      this.state.on('city', () => this._refreshTilePanel()),
      this.state.on('generals', () => this._refreshTilePanel()),
      this.state.on('victory', () => this._openVictory()),
    ]
    this._onTileSelected = ({ x, y }) => this._showTilePanel(x, y)
    this.game.events.on('tile-selected', this._onTileSelected)

    // 通用滚动区域（战报、武将列表等复用）：滚轮 + 拖拽。同时只有一个模态，故单槽即可。
    this._scroll = null
    this._scrollDrag = null
    this.input.on('wheel', (p, _o, _dx, dy) => this._scrollBy(p, dy))
    this.input.on('pointerdown', (p) => {
      const s = this._scroll
      if (s && this._inRect(p, s)) this._scrollDrag = { startY: p.y, startScroll: s.scrollY }
    })
    this.input.on('pointermove', (p) => {
      if (!this._scrollDrag || !this._scroll) return
      this._scrollBy(p, 0, this._scrollDrag.startScroll + (this._scrollDrag.startY - p.y))
    })
    this.input.on('pointerup', () => { this._scrollDrag = null })

    this.scale.on('resize', this._onResize, this)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this._subs.forEach(off => off())
      this.game.events.off('tile-selected', this._onTileSelected)
      this.scale.off('resize', this._onResize, this)
    })

    // 新开局尚无武将：自动弹出招募面板，引导玩家用免费机会抽出第一名武将
    if (this.state.generals.length === 0) {
      this._recruitResult = null
      this._openRecruit()
    }
  }

  update(_, delta) {
    this._uiTick += delta
    if (this._uiTick < 250) return
    this._uiTick = 0
    this._refreshTopbar()
    this._rebuildMarchList()
  }

  // ── 供 WorldScene 询问：该屏幕坐标是否被 UI 占用 ─────────────────────────

  get modalOpen() { return !!this.modal }

  hitTest(x, y) {
    if (!this._btnRects) return false   // 场景尚未 create 完成
    if (this.modal) return true
    if (y <= TOPBAR_H) return true
    const inside = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
    if (this._btnRects.some(inside)) return true
    if (this._marchRects.some(inside)) return true
    if (this.tileC && this._tileRect && inside(this._tileRect)) return true
    return false
  }

  // ── 顶部资源栏 ────────────────────────────────────────────────────────────

  _buildTopbar() {
    const w = this.scale.width
    this.topbarBg = this.add.graphics().setDepth(DEPTH.bar)
    this._refreshTopbarBg(w)
    this.backBtn = this.add.text(10, TOPBAR_H / 2, '←', style(22, '#ffffff', true))
      .setOrigin(0, 0.5).setDepth(DEPTH.bar)
      .setInteractive({ useHandCursor: true })
      .on('pointerup', () => this.game.events.emit('slg-exit'))
    this.resText = this.add.text(36, TOPBAR_H / 2, '', style(13))
      .setOrigin(0, 0.5).setDepth(DEPTH.bar)
    this.dateText = this.add.text(w / 2, TOPBAR_H / 2, '', style(13, '#ffd54f', true))
      .setOrigin(1, 0.5).setDepth(DEPTH.bar)
    this.statusText = this.add.text(w - 8, TOPBAR_H / 2, '', style(13, '#ffd54f'))
      .setOrigin(1, 0.5).setDepth(DEPTH.bar)
  }

  _refreshTopbarBg(w) {
    const g = this.topbarBg
    g.clear()
    // 渐变底（上亮下暗）
    g.fillGradientStyle(0x1a1f16, 0x1a1f16, 0x0a0d08, 0x0a0d08, 0.92)
    g.fillRect(0, 0, w, TOPBAR_H)
    // 底部双金线分隔
    g.lineStyle(1, 0xc8a045, 0.85)
    g.lineBetween(0, TOPBAR_H - 0.5, w, TOPBAR_H - 0.5)
    g.lineStyle(1, 0xffd700, 0.25)
    g.lineBetween(0, TOPBAR_H - 2.5, w, TOPBAR_H - 2.5)
  }

  _refreshTopbar() {
    const s = this.state
    this.resText.setText(
      Object.entries(RESOURCES).map(([k, d]) => `${d.icon}${fmt(s.res[k])}`).join('  '))
    const d = s.gameDate()
    this.dateText.setText(`📅公元${d.year}年${d.month}月${d.day}日`)
    this.statusText.setText(`🚩${s.territoryCount()}/${s.territoryCapNow()}  ⚡${s.power()}`)
    this.dateText.setX(this.statusText.x - this.statusText.width - 12)
  }

  // ── 底部按钮 ──────────────────────────────────────────────────────────────

  _buildBottombar() {
    this.bottomBtns = [
      this._circleBtn('🏠', () => this.game.events.emit('center-on', this.state.spawn)),
      this._circleBtn('👥', () => this._openGenerals()),
      this._circleBtn('📜', () => this._openLog()),
      this._circleBtn('⚙️', () => this._openSettings()),
    ]
    this._layoutBottombar()
  }

  _circleBtn(icon, onClick) {
    const r = 22
    const c = this.add.container(0, 0).setDepth(DEPTH.bar)
    const g = this.add.graphics()
    // 投影底
    g.fillStyle(0x000000, 0.4)
    g.fillCircle(0, 1.5, r)
    // 渐变主体（上亮下暗）
    g.fillGradientStyle(0x3a4434, 0x3a4434, 0x161a12, 0x161a12, 0.95)
    g.fillCircle(0, 0, r)
    // 顶部高光弧
    g.lineStyle(2, 0xffffff, 0.25)
    g.beginPath()
    g.arc(0, 0, r - 2.5, Math.PI * 1.15, Math.PI * 1.85)
    g.strokePath()
    // 金色描边
    g.lineStyle(1.5, 0xc8a045, 0.9)
    g.strokeCircle(0, 0, r)
    const t = this.add.text(0, 0, icon, style(20)).setOrigin(0.5)
    c.add([g, t])
    c.setInteractive(new Phaser.Geom.Circle(0, 0, r), Phaser.Geom.Circle.Contains)
      .on('pointerup', onClick)
    c.radius = r
    return c
  }

  _layoutBottombar() {
    const h = this.scale.height
    this._btnRects = []
    this.bottomBtns.forEach((c, i) => {
      const x = 34 + i * 56
      const y = h - 40
      c.setPosition(x, y)
      this._btnRects.push({ x: x - c.radius, y: y - c.radius, w: c.radius * 2, h: c.radius * 2 })
    })
  }

  // ── 行军队列（右上）──────────────────────────────────────────────────────

  _rebuildMarchList() {
    this.marchC.removeAll(true)
    this._marchRects = []
    const w = 132, rowH = 24
    const x0 = this.scale.width - w - 8
    this.state.marches.forEach((m, i) => {
      const g = this.state.general(m.generalIds[0])
      const extra = m.generalIds.length > 1 ? `+${m.generalIds.length - 1}` : ''
      const remain = Math.max(0, (m.arriveAt - this.state.now) / TIME_SCALE)
      const eta = `${Math.floor(remain / 60)}:${String(Math.floor(remain % 60)).padStart(2, '0')}`
      const y0 = i * (rowH + 4)
      const bg = this.add.rectangle(x0, y0, w, rowH, 0x000000, 0.55)
        .setOrigin(0).setStrokeStyle(1, 0xffffff, 0.15)
        .setInteractive({ useHandCursor: true })
        .on('pointerup', () => this.game.events.emit('center-on', m.to))
      const label = this.add.text(x0 + 6, y0 + rowH / 2,
        `${m.phase === 'out' ? '⚔️' : '🏠'} ${g?.name || '?'}${extra}`, style(12))
        .setOrigin(0, 0.5)
      const etaT = this.add.text(x0 + w - 6, y0 + rowH / 2, eta, style(12, '#ffd54f'))
        .setOrigin(1, 0.5)
      this.marchC.add([bg, label, etaT])
      this._marchRects.push({ x: x0, y: this.marchC.y + y0, w, h: rowH })
    })
  }

  // ── 地块面板（底部居中，非模态）──────────────────────────────────────────

  _showTilePanel(x, y) {
    this.sel = { x, y }
    this._buildTilePanel()
  }

  _refreshTilePanel() {
    if (this.sel) this._buildTilePanel()
  }

  _closeTilePanel() {
    this.sel = null
    this.tileC?.destroy()
    this.tileC = null
    this._tileRect = null
    this.game.events.emit('clear-selection')
  }

  _buildTilePanel() {
    this.tileC?.destroy()
    this.tileC = null
    this._tileRect = null
    if (!this.sel) return
    const t = this.state.tileAt(this.sel.x, this.sel.y)
    if (!t) { this.sel = null; return }
    const def = TILE_TYPES[t.type]

    const sw = this.scale.width, sh = this.scale.height
    const w = Math.min(sw - 16, 400)
    // 主城两行按钮（升级 + 建筑）加高；守将/NPC 城池面板按队伍数动态加高
    let h = 108
    if (t.isCity) h = 148
    else if (t.type === 'npcCity' && t.owner !== 'player') h = 172
    else if (t.owner !== 'player' && def.passable) {
      const teams = (t.guards || []).length || 1
      h = 112 + (teams - 1) * 24
      if (teams > 1) h += 18
    }
    const cx = sw / 2, cy = sh - h / 2 - 76
    const c = this.add.container(cx, cy).setDepth(DEPTH.panel)

    const bg = this.add.graphics()
    bg.fillStyle(COLOR.panelBg, 0.94)
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 12)
    bg.lineStyle(1, COLOR.panelLine, 0.3)
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 12)
    c.add(bg)

    // 标题 + 坐标 + 关闭
    c.add(this.add.text(-w / 2 + 12, -h / 2 + 10,
      `${def.name} Lv.${t.level}`, style(15, '#ffd54f', true)).setOrigin(0, 0))
    c.add(this.add.text(-w / 2 + 12 + 90, -h / 2 + 13,
      `(${t.x},${t.y})`, style(12, '#9e9e9e')).setOrigin(0, 0))
    const close = this.add.text(w / 2 - 14, -h / 2 + 14, '✕', style(15, '#bbbbbb'))
      .setOrigin(0.5).setInteractive({ useHandCursor: true })
      .on('pointerup', () => this._closeTilePanel())
    c.add(close)

    // 信息行
    let info, yieldText = ''
    if (def.res === 'all') yieldText = `各类资源 +${t.level * BASE_YIELD_PER_LEVEL / 2}/小时`
    else if (def.res) yieldText = `${RESOURCES[def.res].name} +${t.level * BASE_YIELD_PER_LEVEL}/小时`
    const adjacent = this.state.isAdjacentToTerritory(t.x, t.y)
    let isDefenderPanel = false
    if (t.isCity) {
      info = `🏯 我方主城（Lv.${this.state.cityLv}）· 领地上限 ${this.state.territoryCapNow()}`
    } else if (t.owner === 'player') {
      info = `🚩 我方领地 · 产量 ${yieldText}`
    } else if (!def.passable) {
      info = '🌊 不可通行'
    } else {
      isDefenderPanel = true
    }

    if (!isDefenderPanel) {
      c.add(this.add.text(-w / 2 + 12, -h / 2 + 38, info, style(12, '#dddddd')).setOrigin(0, 0))
    } else {
      // 守将面板：每队一行（基础信息 + 武/防/速/智），末尾一行收益与相邻提示
      const teams = t.guards || []
      const rowH = 20
      const startY = -h / 2 + 36
      if (teams.length === 0) {
        c.add(this.add.text(-w / 2 + 12, startY, '守将 空虚', style(12, '#dddddd')).setOrigin(0, 0))
      } else {
        teams.forEach((gd, i) => {
          const y = startY + i * rowH
          const tpl = findGeneralTemplate(gd.id)
          if (!tpl) {
            c.add(this.add.text(-w / 2 + 12, y, `守军 ${fmt(gd.troops)}`, style(12, '#dddddd')).setOrigin(0, 0))
          } else {
            const icon = TROOP_TYPES[tpl.troopType]?.icon || ''
            const q = tpl.quality
            const atk = Math.round(guardStat(tpl.atk, gd.lv, q))
            const def = Math.round(guardStat(tpl.def, gd.lv, q))
            const spd = Math.round(guardStat(tpl.spd, gd.lv, q))
            const int = Math.round(guardStat(tpl.int, gd.lv, q))
            c.add(this.add.text(-w / 2 + 12, y,
              `守将 ${icon}${tpl.name} Lv.${gd.lv} ×${fmt(gd.troops)}（武${atk} · 防${def} · 速${spd} · 智${int}）`,
              style(12, '#dddddd')).setOrigin(0, 0))
          }
        })
      }
      const yieldY = startY + Math.max(1, teams.length) * rowH + 4
      const yieldLine = `占领后 ${yieldText}` + (adjacent ? '' : ' · 需与领地相邻')
      c.add(this.add.text(-w / 2 + 12, yieldY, yieldLine, style(12, '#a5d6a7')).setOrigin(0, 0))

      let extraY = yieldY + 18
      if (teams.length > 1) {
        c.add(this.add.text(-w / 2 + 12, extraY,
          '⚠️ 两队守军须一次远征连续击破，否则守军重整回满',
          style(11, '#ffcc80')).setOrigin(0, 0))
        extraY += 18
      }
      if (t.type === 'npcCity') {
        const cityLoot = npcCityLootOf(t.level)
        const loot = `💰 攻克掠夺：铜${cityLoot.coin} 粮${cityLoot.grain} 木${cityLoot.wood} 铁${cityLoot.iron} 石${cityLoot.stone}`
        c.add(this.add.text(-w / 2 + 12, extraY, loot, style(11, '#ffe082')).setOrigin(0, 0))
      }
    }

    // 操作按钮
    const by = h / 2 - 24
    if (t.isCity) {
      const maxed = this.state.cityLv >= CITY_MAX_LEVEL
      let label = '主城已满级'
      if (!maxed) {
        const cost = cityUpgradeCost(this.state.cityLv + 1)
        label = `升级主城（${RESOURCES.coin.icon}${cost.coin} ${RESOURCES.wood.icon}${cost.wood} ${RESOURCES.stone.icon}${cost.stone}）`
      }
      // 上行：升级主城；下行：建筑管理
      c.add(this._button(0, by - 38, Math.min(w - 40, 300), 32, label, COLOR.btnAmber, !maxed, () => {
        const err = this.state.upgradeCity()
        if (err) this._toast(err, COLOR.toastWarn)
      }))
      c.add(this._button(0, by, 180, 32, '🏛️ 建筑管理', COLOR.btnGreen, true,
        () => this._openBuildings()))
    } else if (t.owner === 'player') {
      c.add(this._button(0, by, 130, 32, '放弃领地', COLOR.btnGrey, true, () => {
        const err = this.state.abandon(t.x, t.y)
        if (err) this._toast(err, COLOR.toastWarn)
        else this._refreshTilePanel()
      }))
    } else if (def.passable) {
      c.add(this._button(0, by, 130, 32, '⚔️ 出征', COLOR.btnRed, adjacent,
        () => this._openMarchSelect()))
    }

    this.tileC = c
    this._tileRect = { x: cx - w / 2, y: cy - h / 2, w, h }
  }

  // ── 模态弹窗框架 ──────────────────────────────────────────────────────────

  _openModal(w, h, build) {
    this._closeModal()
    const sw = this.scale.width, sh = this.scale.height
    const root = this.add.container(0, 0).setDepth(DEPTH.modal)
    const dim = this.add.rectangle(0, 0, sw, sh, 0x000000, 0.55).setOrigin(0)
      .setInteractive().on('pointerup', () => this._closeModal())
    const panel = this.add.container(sw / 2, sh / 2)
    const bg = this.add.graphics()
    // 深色渐变底（上亮下暗）
    bg.fillGradientStyle(0x2a3124, 0x2a3124, 0x161a12, 0x161a12)
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 12)
    // 木纹横线纹理
    bg.lineStyle(1, 0x3a4434, 0.12)
    for (let y = -h / 2 + 10; y < h / 2 - 4; y += 6) {
      bg.lineBetween(-w / 2 + 6, y, w / 2 - 6, y)
    }
    // 外金线
    bg.lineStyle(2, 0xc8a045, 0.9)
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 12)
    // 内金线
    bg.lineStyle(1, 0xffd700, 0.35)
    bg.strokeRoundedRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 8)
    // 四角金色角饰（L 形）
    const m = 7, L = 11
    bg.lineStyle(2.5, 0xffd700, 0.95)
    const corner = (cx, cy, sx, sy) => {
      bg.lineBetween(cx, cy, cx + sx * L, cy)
      bg.lineBetween(cx, cy, cx, cy + sy * L)
    }
    corner(-w / 2 + m, -h / 2 + m, 1, 1)
    corner(w / 2 - m, -h / 2 + m, -1, 1)
    corner(-w / 2 + m, h / 2 - m, 1, -1)
    corner(w / 2 - m, h / 2 - m, -1, -1)
    panel.add(bg)
    // 面板本体拦截点击（不透传给遮罩关闭）
    panel.setInteractive(new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h),
      Phaser.Geom.Rectangle.Contains)
    root.add([dim, panel])
    this.modal = root
    build(panel, w, h)
  }

  _closeModal() {
    this.modal?.destroy()
    this.modal = null
    this._scroll?.maskG.destroy()
    this._scroll = null
    this._scrollDrag = null
  }

  _inRect(p, r) { return p.x >= r.vx && p.x <= r.vx + r.vw && p.y >= r.vy && p.y <= r.vy + r.vh }

  /** 滚动内容中某行（局部中心 cy）当前是否在可视视口内（用于拦截滚出区域的按钮点击） */
  _rowVisibleInScroll(cy) {
    const s = this._scroll
    if (!s) return true
    const sy = s.content.y + cy
    return sy >= s.vy - 2 && sy <= s.vy + s.vh + 2
  }

  /** 滚动当前滚动区域；absScroll 传入则设为绝对值，否则按 dy 累加 */
  _scrollBy(p, dy, absScroll) {
    const s = this._scroll
    if (!s || s.maxScroll <= 0) return
    if (absScroll === undefined && !this._inRect(p, s)) return
    s.scrollY = Phaser.Math.Clamp(absScroll !== undefined ? absScroll : s.scrollY + dy, 0, s.maxScroll)
    s.content.y = s.vy - s.scrollY
    if (s.thumb) {
      s.thumb.y = s.vy + (s.scrollY / s.maxScroll) * (s.vh - s.thumbH) + s.thumbH / 2
    }
  }

  /**
   * 在当前模态内创建一个可滚动内容区，返回 content 容器；
   * 调用方把子对象按绝对 y ∈ [0, contentHeight) 加入 content（左上角为原点）。
   */
  _makeScrollRegion(vx, vy, vw, vh, contentHeight) {
    const content = this.add.container(vx, vy)
    const maskG = this.make.graphics({ add: false })
    maskG.fillStyle(0xffffff)
    maskG.fillRect(vx, vy, vw, vh)
    content.setMask(maskG.createGeometryMask())
    this.modal.add(content)

    const maxScroll = Math.max(0, contentHeight - vh)
    this._scroll = { content, vx, vy, vw, vh, maxScroll, scrollY: 0, maskG }
    if (maxScroll > 0) {
      const thumbH = Math.max(20, vh * vh / contentHeight)
      const thumb = this.add.rectangle(vx + vw - 3, vy + thumbH / 2, 4, thumbH, 0xffd700, 0.6)
        .setOrigin(0.5)
      this.modal.add(thumb)
      this._scroll.thumb = thumb
      this._scroll.thumbH = thumbH
    }
    return content
  }

  // ── 弹窗：选择出征武将（可多选合击）──────────────────────────────────────

  _openMarchSelect(keepPick = false) {
    if (!keepPick) this._marchPick = new Set()
    const pick = this._marchPick
    const gens = this.state.generals
    const rowH = 52
    const w = Math.min(this.scale.width - 24, 380)
    const h = 52 + gens.length * rowH + 74
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 14, '选择出征武将（可多选合击）',
        style(15, '#ffffff', true)).setOrigin(0.5, 0))

      gens.forEach((g, i) => {
        const y = -h / 2 + 52 + i * rowH + (rowH - 8) / 2
        const st = g.stamina ?? STAMINA_MAX
        const lowStamina = st < MARCH_STAMINA_COST
        const enabled = g.state === 'idle' && g.troops > 0 && !lowStamina
        const picked = pick.has(g.id)
        const row = this._row(panel, y, w - 24, rowH - 8, enabled, () => {
          if (picked) pick.delete(g.id)
          else pick.add(g.id)
          this._openMarchSelect(true)   // 重建刷新勾选态
        })
        if (picked) {
          const hl = this.add.graphics()
          hl.lineStyle(2, COLOR.panelLine, 0.9)
          hl.strokeRoundedRect(-(w - 24) / 2, -(rowH - 8) / 2, w - 24, rowH - 8, 8)
          row.add(hl)
        }
        const gt = TROOP_TYPES[g.troopType]
        row.add(this.add.text(-(w - 24) / 2 + 10, -9,
          `${gt ? gt.icon : ''}${g.name}  Lv.${g.lv}`,
          style(14, enabled ? '#ffffff' : '#888888', true)).setOrigin(0, 0.5))
        // 对本目标守军的克制关系（以第一支有兵守将队伍的兵种为准）
        const selTile = this.state.tileAt(this.sel.x, this.sel.y)
        const aliveGuard = selTile?.guards?.find(gd => gd.troops > 0) || selTile?.guards?.[0]
        const defType = aliveGuard ? findGeneralTemplate(aliveGuard.id)?.troopType : selTile?.garrisonType
        const mult = counterMult(g.troopType, defType)
        const counter = mult > 1 ? '克制' : (mult < 1 ? '被克' : '')
        row.add(this.add.text(-(w - 24) / 2 + 10, 10,
          `兵力 ${g.troops} · 体力 ${Math.floor(st)}/${STAMINA_MAX}`,
          style(11, lowStamina ? '#ef5350' : '#9e9e9e')).setOrigin(0, 0.5))
        if (counter) {
          row.add(this.add.text((w - 24) / 2 - 10, 12, counter,
            style(11, mult > 1 ? '#66bb6a' : '#ef5350', true)).setOrigin(1, 0.5))
        }
        // 状态：优先说明不可选原因
        let status = picked ? '✓' : '待命'
        if (!picked) {
          if (g.state !== 'idle') status = '行军中'
          else if (g.troops <= 0) status = '无兵'
          else if (lowStamina) status = '体力不足'
        }
        row.add(this.add.text((w - 24) / 2 - 10, -9, status,
          style(picked ? 16 : 12,
            picked ? '#ffd54f' : (enabled ? '#66bb6a' : '#ffa726'), picked)).setOrigin(1, 0.5))
      })

      // 汇总 + 出征按钮
      const picked = gens.filter(g => pick.has(g.id))
      const total = picked.reduce((s, g) => s + g.troops, 0)
      let summary = '未选择武将'
      if (picked.length && this.sel) {
        const est = this.state.estimateMarch(picked.map(g => g.id), this.sel.x, this.sel.y)
        const eta = est.gameSeconds / TIME_SCALE   // 真实秒
        summary = `已选 ${picked.length} 队 · 共 ${total} 兵 · ${est.steps} 格 · 单程约 ${Math.floor(eta / 60)}:${String(Math.floor(eta % 60)).padStart(2, '0')}`
      }
      panel.add(this.add.text(0, h / 2 - 58, summary, style(12, '#bbbbbb')).setOrigin(0.5))
      panel.add(this._button(0, h / 2 - 26, 150, 32, '⚔️ 出征', COLOR.btnRed,
        picked.length > 0, () => {
          const err = this.state.march([...pick], this.sel.x, this.sel.y)
          if (err) this._toast(err, COLOR.toastWarn)
          else { this._closeModal(); this._refreshTilePanel() }
        }))
    })
  }

  // ── 弹窗：武将 ───────────────────────────────────────────────────────────

  _openGenerals() {
    const gens = this.state.sortedGenerals()
    const rowH = 92
    const sw = this.scale.width, sh = this.scale.height
    const w = Math.min(sw - 24, 440)
    const headerH = 46, footerH = 28
    const listVH = Math.min(gens.length * rowH, (sh - 100) - headerH - footerH)
    const h = headerH + listVH + footerH
    const rw = w - 20            // 行宽（留出滚动条空间）
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(-w / 2 + 14, -h / 2 + 14, '武将', style(15, '#ffffff', true)).setOrigin(0, 0))
      panel.add(this.add.text(-w / 2 + 60, -h / 2 + 16,
        `${gens.length}/${MAX_GENERALS}`, style(11, '#9e9e9e')).setOrigin(0, 0))
      // 招募入口
      panel.add(this._button(w / 2 - 58, -h / 2 + 23, 96, 28, '🎲 招募', COLOR.btnAmber, true,
        () => { this._recruitResult = null; this._openRecruit() }))

      const content = this._makeScrollRegion(
        sw / 2 - w / 2 + 10, sh / 2 - h / 2 + headerH, w - 20, listVH, gens.length * rowH)
      gens.forEach((g, i) => {
        const cy = i * rowH + rowH / 2
        const cap = this.state.troopCap(g)
        const half = rowH - 10
        const row = this.add.container(rw / 2 + 2, cy)
        const bg = this.add.graphics()
        bg.fillStyle(COLOR.rowBg, 0.95)
        bg.fillRoundedRect(-rw / 2, -half / 2, rw, half, 8)
        row.add(bg)
        content.add(row)

        const qColor = (GENERAL_QUALITY[g.quality] || GENERAL_QUALITY.common).color
        const qName = (GENERAL_QUALITY[g.quality] || GENERAL_QUALITY.common).name
        const awaken = g.awaken ? `✦${g.awaken} ` : ''
        const gt = TROOP_TYPES[g.troopType]

        // 布局分区：左头像 + 中间信息 + 右按钮列
        const btnW = 62, btnGap = 8
        const avatarSize = half - 12
        const avatarX = -rw / 2 + 8
        const infoLeft = avatarX + avatarSize + 10
        const infoRight = rw / 2 - btnW - btnGap - 2
        const infoW = infoRight - infoLeft

        // ── 左侧头像 + 品质底框 ──
        bg.lineStyle(2, qColor, 0.9)
        bg.strokeRoundedRect(avatarX, -half / 2 + 6, avatarSize, avatarSize, 4)
        bg.fillStyle(shadeColor(qColor, 0.35), 1)
        bg.fillRoundedRect(avatarX + 1, -half / 2 + 7, avatarSize - 2, avatarSize - 2, 3)
        row.add(this.add.text(avatarX + avatarSize / 2, -half / 2 + 6 + avatarSize / 2,
          g.name[0], style(20, '#ffffff', true)).setOrigin(0.5))
        if (gt) {
          row.add(this.add.text(avatarX + avatarSize - 2, -half / 2 + 8, gt.icon,
            style(11)).setOrigin(1, 0))
        }

        // ── 右上：名字 + 等级 + 品质标签 ──
        row.add(this.add.text(infoLeft, -half / 2 + 12,
          `${awaken}${g.name}`, style(15, qColor, true)).setOrigin(0, 0.5))
        row.add(this.add.text(infoLeft + 70, -half / 2 + 12,
          `Lv.${g.lv}`, style(12, '#ffd700', true)).setOrigin(0, 0.5))
        const qtag = this.add.graphics()
        qtag.fillStyle(qColor, 0.2)
        qtag.fillRoundedRect(0, -9, 36, 18, 9)
        qtag.lineStyle(1, qColor, 0.7)
        qtag.strokeRoundedRect(0, -9, 36, 18, 9)
        qtag.x = infoLeft + 118; qtag.y = -half / 2 + 12
        row.add(qtag)
        row.add(this.add.text(infoLeft + 136, -half / 2 + 12,
          qName, style(10, qColor, true)).setOrigin(0.5, 0.5))

        // ── 中上：五维属性（武/防/智/速 + 兵力）──
        const statY = -half / 2 + 32
        row.add(this.add.text(infoLeft, statY,
          `武${Math.round(g.atk)}  防${Math.round(g.def)}  智${Math.round(g.int)}  速${Math.round(g.spd)}`,
          style(11, '#e8e8e8')).setOrigin(0, 0.5))
        row.add(this.add.text(infoLeft + infoW, statY,
          `兵力 ${g.troops}/${cap}`, style(10, '#cccccc', true)).setOrigin(1, 0.5))

        // ── 下方：经验条（数值叠在条内右侧）──
        const expRatio = g.exp / expToLevel(g.lv)
        row.add(this._bar(infoLeft, -half / 2 + 46, infoW, 5, expRatio, 0x4fc3f7))
        row.add(this.add.text(infoLeft + infoW - 4, -half / 2 + 44,
          `经验 ${Math.floor(g.exp)}/${expToLevel(g.lv)}`,
          style(9, expRatio > 0.6 ? '#ffffff' : '#8ab4c8', true)).setOrigin(1, 0))

        // ── 体力条（数值叠在条内右侧）──
        const st = g.stamina ?? STAMINA_MAX
        const stRatio = st / STAMINA_MAX
        const stColor = st >= MARCH_STAMINA_COST ? 0x66bb6a : 0xef5350
        row.add(this._bar(infoLeft, -half / 2 + 58, infoW, 5, stRatio, stColor))
        row.add(this.add.text(infoLeft + infoW - 4, -half / 2 + 56,
          `体力 ${Math.floor(st)}/${STAMINA_MAX}`,
          style(9, stRatio > 0.6 ? '#ffffff' : '#a0e0a0', true)).setOrigin(1, 0))

        // ── 右侧按钮列：补兵 + 销毁 ──
        const btnX = rw / 2 - btnW / 2 - 2
        const canRecruit = g.state === 'idle' && g.troops < cap
        row.add(this._button(btnX, -14, btnW, 24, '补满兵',
          COLOR.btnGreen, canRecruit, () => {
            if (!this._rowVisibleInScroll(cy)) return
            const err = this.state.recruit(g.id, cap - g.troops)
            if (err) this._toast(err, COLOR.toastWarn)
            else this._openGenerals()
          }))
        row.add(this._button(btnX, 16, btnW, 24, '销毁',
          COLOR.btnGrey, true, () => {
            if (!this._rowVisibleInScroll(cy)) return
            this._openConfirm(`确定销毁 ${g.name}？\n等级与觉醒将一并清除且不可恢复`, () => {
              const res = this.state.dismissGeneral(g.id)
              if (res.error) this._toast(res.error, COLOR.toastWarn)
              else this._openGenerals()
            })
          }))
      })
      panel.add(this.add.text(0, h / 2 - 16,
        `征兵 ${RECRUIT_GRAIN_PER_TROOP} 粮/兵 · 出征耗 ${MARCH_STAMINA_COST} 体力（每分钟回 ${STAMINA_REGEN_PER_HOUR}）`,
        style(10, '#9e9e9e')).setOrigin(0.5))
    })
  }

  // ── 弹窗：招募（抽卡）────────────────────────────────────────────────────

  _openRecruit() {
    const w = Math.min(this.scale.width - 24, 360), h = 250
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 16, '🎲 招募武将', style(16, '#ffffff', true)).setOrigin(0.5, 0))

      // 概率表（basic 为守将专用档，rate=0 不展示）
      const rates = Object.values(GENERAL_QUALITY)
        .filter(q => q.rate > 0)
        .map(q => `${q.name} ${q.rate}%`).join('    ')
      panel.add(this.add.text(0, -h / 2 + 46, rates, style(11, '#9e9e9e')).setOrigin(0.5, 0))

      // 结果显示区
      const res = this._recruitResult
      const resY = -6
      const free = this.state.freeRecruits > 0
      if (res) {
        const q = GENERAL_QUALITY[res.quality] || GENERAL_QUALITY.common
        panel.add(this.add.text(0, resY - 18,
          res.type === 'new' ? '获得新武将！' : '武将觉醒！', style(13, '#dddddd')).setOrigin(0.5))
        panel.add(this.add.text(0, resY + 8,
          `${q.name} · ${res.name}`, style(20, q.color, true)).setOrigin(0.5))
      } else if (free) {
        panel.add(this.add.text(0, resY,
          `剩余 ${this.state.freeRecruits} 次免费招募机会\n重复武将转为觉醒（武+${AWAKEN_ATK} 防+${AWAKEN_DEF} 智+${AWAKEN_INT} 速+${AWAKEN_SPD} ×品质成长）`,
          { ...style(12, '#ffd54f'), align: 'center' }).setOrigin(0.5))
      } else {
        panel.add(this.add.text(0, resY,
          `消耗 ${RESOURCES.coin.icon}${RECRUIT_COST_COIN} 招募一名武将\n重复武将转为觉醒（武+${AWAKEN_ATK} 防+${AWAKEN_DEF} 智+${AWAKEN_INT} 速+${AWAKEN_SPD} ×品质成长）`,
          { ...style(12, '#9e9e9e'), align: 'center' }).setOrigin(0.5))
      }

      // 招募按钮
      const canAfford = free || this.state.res.coin >= RECRUIT_COST_COIN
      panel.add(this._button(0, h / 2 - 58, 200, 36,
        free ? '免费招募' : `招募（${RESOURCES.coin.icon}${RECRUIT_COST_COIN}）`, COLOR.btnAmber, canAfford, () => {
          const r = this.state.recruitGeneral()
          if (r.error) { this._toast(r.error, COLOR.toastWarn); return }
          this._recruitResult = r
          this._openRecruit()   // 重建以显示结果
        }))
      panel.add(this._button(0, h / 2 - 20, 120, 28, '返回武将', COLOR.btnGrey, true, () => {
        this._recruitResult = null
        this._openGenerals()
      }))
    })
  }

  // ── 弹窗：建筑管理 ────────────────────────────────────────────────────────

  _openBuildings() {
    const types = Object.keys(BUILDINGS)
    const rowH = 60
    const w = Math.min(this.scale.width - 24, 420)
    const h = 52 + types.length * rowH + 30
    const rw = w - 24
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 14, '🏛️ 建筑管理', style(15, '#ffffff', true)).setOrigin(0.5, 0))
      types.forEach((type, i) => {
        const b = BUILDINGS[type]
        const lv = this.state.buildings[type]
        const y = -h / 2 + 52 + i * rowH + (rowH - 8) / 2
        const half = rowH - 8
        const row = this._row(panel, y, rw, half, false, null)
        row.add(this.add.text(-rw / 2 + 10, -half / 2 + 9,
          `${b.icon} ${b.name}  Lv.${lv}`, style(14, '#ffffff', true)).setOrigin(0, 0.5))
        row.add(this.add.text(-rw / 2 + 10, half / 2 - 10,
          this._buildingEffect(type, lv), style(11, '#9ccc9c')).setOrigin(0, 0.5))

        // 升级按钮 + 花费/条件
        const maxed = lv >= BUILDING_MAX_LEVEL
        const cityBlocked = !maxed && lv >= this.state.cityLv
        let sub = ''
        if (maxed) sub = '已满级'
        else if (cityBlocked) sub = `需主城 Lv.${lv + 1}`
        else {
          const cost = buildingUpgradeCost(type, lv + 1)
          sub = Object.entries(cost)
            .map(([k, v]) => `${RESOURCES[k].icon}${v}`).join(' ')
        }
        row.add(this.add.text(rw / 2 - 92, half / 2 - 10, sub,
          style(10, cityBlocked ? '#ef9a9a' : '#9e9e9e')).setOrigin(1, 0.5))
        row.add(this._button(rw / 2 - 48, -half / 2 + 14, 76, 24,
          maxed ? '满级' : '升级', COLOR.btnAmber, !maxed && !cityBlocked, () => {
            const err = this.state.upgradeBuilding(type)
            if (err) this._toast(err, COLOR.toastWarn)
            else this._openBuildings()   // 重建刷新
          }))
      })
      panel.add(this.add.text(0, h / 2 - 18,
        '建筑等级不可超过主城等级', style(11, '#9e9e9e')).setOrigin(0.5))
    })
  }

  /** 建筑当前等级的效果描述 */
  _buildingEffect(type, lv) {
    switch (type) {
      case 'granary':  return `全资源产出 +${Math.round(GRANARY_YIELD_PER_LEVEL * lv * 100)}%`
      case 'barracks': return `带兵上限 +${BARRACKS_CAP_PER_LEVEL * lv}`
      case 'training': return `在城武将练级 +${TRAINING_EXP_PER_LEVEL * lv} 经验/小时`
      case 'forge':    return `全军全属性 +${FORGE_STAT_PER_LEVEL * lv}`
      default: return ''
    }
  }

  // ── 弹窗：战报 ───────────────────────────────────────────────────────────

  _openLog() {
    const lines = this.state.log
    const sw = this.scale.width, sh = this.scale.height
    const w = Math.min(sw - 24, 400)
    const h = Math.min(sh - 120, Math.max(200, 60 + lines.length * 22))
    const rowH = 22
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 14, '战报', style(15, '#ffffff', true)).setOrigin(0.5, 0))
      if (!lines.length) { panel.add(this.add.text(0, 8, '暂无战报', style(12, '#888888')).setOrigin(0.5)); return }
      const content = this._makeScrollRegion(
        sw / 2 - w / 2 + 16, sh / 2 - h / 2 + 46, w - 32, h - 46 - 14, lines.length * rowH)
      lines.forEach((l, i) => {
        const clickable = !!l.report
        const t = this.add.text(0, i * rowH, clickable ? `${l.text}  ›` : l.text,
          style(12, clickable ? '#ffd54f' : '#dddddd')).setOrigin(0, 0)
        if (clickable) {
          t.setInteractive({ useHandCursor: true }).on('pointerup', () => this._openBattleReport(l.report))
        }
        content.add(t)
      })
    })
  }

  // ── 弹窗：战报详情（按守将队伍分段，逐回合）───────────────────────────────

  /** 生成一个单行文本，超过 maxW 时用省略号截断（尾部保留完整信息不丢，仅裁中/尾） */
  _ellipsisText(str, styleObj, maxW) {
    const t = this.add.text(0, 0, str, styleObj)
    if (t.width <= maxW) return t
    let s = str
    while (s.length > 1) {
      s = s.slice(0, -1)
      t.setText(s + '…')
      if (t.width <= maxW) break
    }
    return t
  }

  /** 按 battles 数据算出每一行文字（含位置），返回 { rows, height }。
   *  同一份 rows 既用来提前测量滚动区域高度，也用来实际渲染——避免两处公式各写一遍、
   *  算法一走样就互相对不上（此前就因两处高度公式不同步，导致完整模式最后一回合被裁掉看不见）。 */
  _layoutBattleRows(battles, mode) {
    const rows = []
    let y = 0
    battles.forEach((b, bi) => {
      const q = GENERAL_QUALITY[b.enemy.quality] || GENERAL_QUALITY.common
      const ti = TROOP_TYPES[b.enemy.troopType]
      const oc = { win: '✓胜', draw: '平', lose: '✗败' }[b.outcome]
      const troopName = ti ? `${ti.icon} ` : ''
      // 敌将卡：第一行 名称+兵种+等级（品质色）+ 先手/胜负；第二行 武/防/速/智（含等级加成）
      rows.push({ x: 0, y: y + 2,
        text: `第${bi + 1}阵  ${troopName}${b.enemy.name} Lv.${b.enemy.lv}`,
        size: 12, color: q.color, bold: true, origin: 0 })
      rows.push({ right: true, y: y + 2, text: `${b.first === 'atk' ? '我方先手' : '敌方先手'} · ${oc}`,
        size: 10, color: '#9e9e9e', origin: 1 })
      rows.push({ x: 10, y: y + 20,
        text: `武${b.enemy.atk ?? '?'} · 防${b.enemy.def ?? '?'} · 速${b.enemy.spd ?? '?'} · 智${b.enemy.int ?? '?'}`,
        size: 10, color: '#9e9e9e', origin: 0 })
      y += 40
      // 准备回合：双方「属性（基础/卡面口径）」→「实战（叠加等级/铁匠坊/克制/骑兵先手后）」+ 先手判定
      const ac = b.atkCounter ?? 1, dc = b.defCounter ?? 1
      if (b.prep) {
        const p = b.prep
        const sv = (base, eff) => base === eff ? `${base}` : `${base}→${eff}`
        rows.push({ x: 10, y, text: '【准备回合】', size: 11, color: '#ffd54f', bold: true, origin: 0 })
        y += 15
        rows.push({ x: 16, y, text: `我方  武${sv(p.our.atk, p.our.atkEff)} 防${sv(p.our.def, p.our.defEff)} 速${sv(p.our.spd, p.our.spdEff)} · 兵${p.our.troops}`,
          size: 10, color: '#a5d6a7', origin: 0 })
        y += 15
        rows.push({ x: 16, y, text: `守军  武${sv(p.foe.atk, p.foe.atkEff)} 防${sv(p.foe.def, p.foe.defEff)} 速${sv(p.foe.spd, p.foe.spdEff)} · 兵${p.foe.troops}`,
          size: 10, color: '#ef9a9a', origin: 0 })
        y += 15
        rows.push({ x: 16, y,
          text: `先手  我方速${p.our.spdEff} vs 守军速${p.foe.spdEff} → ${b.first === 'atk' ? '我方先手' : '敌方先手'}`,
          size: 10, color: '#90caf9', origin: 0 })
        y += 15
        // 完整模式：额外点明兵种克制倍率（属性→实战里已体现，此处给出精确倍数）
        if (mode === 'full' && (Math.abs(ac - 1) > 0.001 || Math.abs(dc - 1) > 0.001)) {
          rows.push({ x: 16, y, text: `兵种克制  我方攻击×${ac.toFixed(2)} · 守军攻击×${dc.toFixed(2)}`,
            size: 10, color: '#ffab91', origin: 0 })
          y += 15
        }
        y += 4
      }
      b.rounds.forEach((r) => {
        if (mode === 'simple') {
          rows.push({ x: 10, y, text: `第${r.round}回合   我方 ${r.atkTroops}（-${r.atkLoss}）    守军 ${r.defTroops}（-${r.defLoss}）`,
            size: 11, color: '#dddddd', origin: 0 })
          y += 22
        } else {
          rows.push({ x: 10, y, text: `第${r.round}回合`, size: 11, color: '#ffd54f', bold: true, origin: 0 })
          y += 14
          // 旧存档日志里的战报可能没有 actions 明细，容错避免展开完整模式时崩溃
          ;(r.actions || []).forEach((a) => {
            const from = a.striker === 'atk' ? '我方' : '守军'
            const to = a.striker === 'atk' ? '守军' : '我方'
            rows.push({
              x: 16, y,
              text: `${from}→${to}  战力${Math.round(a.atkPow)} vs 防${Math.round(a.defPow)}  ×${a.ratio.toFixed(2)} → -${a.loss}`,
              size: 10, color: '#bbbbbb', origin: 0,
            })
            y += 18
          })
        }
      })
    })
    return { rows, height: y }
  }

  _openBattleReport(report) {
    const battles = report.battles || []
    const mode = this._reportMode || 'simple'   // 'simple' | 'full'
    const { rows, height: contentH } = this._layoutBattleRows(battles, mode)
    const sw = this.scale.width, sh = this.scale.height
    const w = Math.min(sw - 24, 380)
    const headerH = 78
    const listVH = Math.min(sh - 220, Math.max(88, contentH || 22))
    const h = Math.min(sh - 40, headerH + listVH + 46)
    const outcomeInfo = {
      win: { text: '胜利', color: '#66bb6a' },
      draw: { text: '平局', color: '#bdbdbd' },
      lose: { text: '战败', color: '#ef5350' },
    }[report.outcome]

    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(-w / 2 + 14, -h / 2 + 14, '战报详情', style(15, '#ffffff', true)).setOrigin(0, 0))
      // 简洁/完整 切换：紧跟标题右侧（完整模式额外展示每次攻防的战力换算与兵种克制，帮助理解战斗道理）
      const mkTab = (x, label, active, onClick) => this._button(x, -h / 2 + 22, 52, 20,
        label, active ? COLOR.btnAmber : COLOR.btnGrey, true, onClick)
      panel.add(mkTab(-w / 2 + 104, '简洁', mode === 'simple', () => { this._reportMode = 'simple'; this._openBattleReport(report) }))
      panel.add(mkTab(-w / 2 + 160, '完整', mode === 'full', () => { this._reportMode = 'full'; this._openBattleReport(report) }))
      panel.add(this.add.text(w / 2 - 14, -h / 2 + 16, outcomeInfo.text,
        style(14, outcomeInfo.color, true)).setOrigin(1, 0))
      // 头部对阵行：我方武将 vs 守将（兵种图标+名字+等级），末尾附地块信息。
      // 双传说地块 + 多将合击时该行可能超宽，用省略号截断保证不溢出面板（守将完整信息在下方敌将卡里）。
      const guardRoster = battles.length
        ? battles.map(b => `${TROOP_TYPES[b.enemy.troopType]?.icon || ''}${b.enemy.name}Lv.${b.enemy.lv}`).join('、')
        : '空虚守军'
      const rosterLine = `${report.names}  vs  ${guardRoster}  ·  ${report.tile.type}Lv.${report.tile.level}(${report.tile.x},${report.tile.y})`
      const rt = this._ellipsisText(rosterLine, style(11, '#9e9e9e'), w - 28)
      rt.setPosition(-w / 2 + 14, -h / 2 + 38).setOrigin(0, 0)
      panel.add(rt)
      panel.add(this.add.text(-w / 2 + 14, -h / 2 + 56,
        `我方 ${report.atkStart} → ${report.atkStart - report.atkLossTotal}（-${report.atkLossTotal}）    ` +
        `守军 ${report.defStart} → ${report.defStart - report.defLossTotal}（-${report.defLossTotal}）`,
        style(11, '#dddddd')).setOrigin(0, 0))

      if (!rows.length) {
        panel.add(this.add.text(0, 8, '守军空虚，未经交战直接占领', style(12, '#888888')).setOrigin(0.5))
      } else {
        const content = this._makeScrollRegion(
          sw / 2 - w / 2 + 16, sh / 2 - h / 2 + headerH, w - 32, listVH, contentH)
        rows.forEach((row) => {
          const x = row.right ? (w - 32 - 6) : row.x
          content.add(this.add.text(x, row.y, row.text,
            style(row.size, row.color, row.bold)).setOrigin(row.origin, 0))
        })
      }

      panel.add(this._button(0, h / 2 - 20, 120, 28, '返回日志', COLOR.btnGrey, true, () => this._openLog()))
    })
  }

  // ── 弹窗：设置 / 确认 ────────────────────────────────────────────────────

  _openSettings() {
    const w = Math.min(this.scale.width - 24, 360), h = 150
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 14, '设置', style(15, '#ffffff', true)).setOrigin(0.5, 0))
      panel.add(this.add.text(0, -8,
        `地图种子：${this.state.seed}\n进度每 10 秒自动保存`,
        { ...style(12, '#9e9e9e'), align: 'center' }).setOrigin(0.5))
      panel.add(this._button(0, h / 2 - 26, 180, 30, '重置存档（重新开局）',
        COLOR.btnRed, true, () => {
          this._openConfirm('将删除当前进度并重新开局，确定吗？', () => {
            // 先冻结，避免 reload 触发的 beforeunload/场景销毁自动保存把旧存档写回来
            this.state.freeze()
            GameState.clearSave()
            window.location.reload()
          })
        }))
    })
  }

  _openVictory() {
    const w = Math.min(this.scale.width - 24, 360), h = 170
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 18, '👑', style(36)).setOrigin(0.5, 0))
      panel.add(this.add.text(0, -h / 2 + 64, '天下一统！', style(20, '#ffd54f', true)).setOrigin(0.5, 0))
      panel.add(this.add.text(0, -h / 2 + 94, `${this.state.npcCities.length} 座城池尽入囊中，九州归一。`,
        style(13, '#dddddd')).setOrigin(0.5, 0))
      panel.add(this._button(0, h / 2 - 26, 130, 30, '继续经营', COLOR.btnAmber, true,
        () => this._closeModal()))
    })
  }

  _openConfirm(message, onOk) {
    const w = Math.min(this.scale.width - 24, 340), h = 130
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 20, message,
        { ...style(13), align: 'center', wordWrap: { width: w - 40 } }).setOrigin(0.5, 0))
      panel.add(this._button(-70, h / 2 - 26, 110, 30, '取消', COLOR.btnGrey, true,
        () => this._closeModal()))
      panel.add(this._button(70, h / 2 - 26, 110, 30, '确定', COLOR.btnRed, true, onOk))
    })
  }

  // ── 通用小部件 ───────────────────────────────────────────────────────────

  /** 圆角按钮（返回 Container，中心锚点） */
  _button(x, y, w, h, label, color, enabled, onClick) {
    const c = this.add.container(x, y)
    const g = this.add.graphics()
    if (enabled) {
      // 渐变填充（上亮下暗）
      const dark = shadeColor(color, 0.6)
      g.fillGradientStyle(color, color, dark, dark)
      g.fillRoundedRect(-w / 2, -h / 2, w, h, h * 0.3)
      // 顶部高光条
      g.fillStyle(0xffffff, 0.22)
      g.fillRoundedRect(-w / 2 + 2, -h / 2 + 1, w - 4, h * 0.38, h * 0.2)
      // 金色描边
      g.lineStyle(1, 0xc8a045, 0.85)
      g.strokeRoundedRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1, h * 0.3)
    } else {
      g.fillStyle(0x3a3a3a, 0.5)
      g.fillRoundedRect(-w / 2, -h / 2, w, h, h * 0.3)
      g.lineStyle(1, 0x555555, 0.4)
      g.strokeRoundedRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1, h * 0.3)
    }
    const t = this.add.text(0, 0, label, style(13, enabled ? '#ffffff' : '#888888', true))
      .setOrigin(0.5)
    c.add([g, t])
    if (enabled && onClick) {
      c.setInteractive(new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h),
        Phaser.Geom.Rectangle.Contains)
        .on('pointerup', onClick)
    }
    return c
  }

  /** 列表行背景（返回加入 parent 的 Container，中心锚点） */
  _row(parent, y, w, h, clickable, onClick) {
    const c = this.add.container(0, y)
    const bg = this.add.graphics()
    bg.fillStyle(COLOR.rowBg, clickable ? 1 : 0.6)
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 8)
    // 可点击行加左侧金色竖线点缀
    if (clickable) {
      bg.lineStyle(2, 0xc8a045, 0.6)
      bg.lineBetween(-w / 2 + 3, -h / 2 + 5, -w / 2 + 3, h / 2 - 5)
    }
    c.add(bg)
    if (clickable && onClick) {
      c.setInteractive(new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h),
        Phaser.Geom.Rectangle.Contains)
        .on('pointerup', onClick)
    }
    parent.add(c)
    return c
  }

  /** 细进度条（左对齐锚点 x,y 为左上角），返回 Container */
  _bar(x, y, w, h, ratio, color) {
    const c = this.add.container(x, y)
    const g = this.add.graphics()
    g.fillStyle(0x000000, 0.5)
    g.fillRoundedRect(0, 0, w, h, h / 2)
    g.fillStyle(color, 1)
    g.fillRoundedRect(0, 0, Math.max(h, w * Phaser.Math.Clamp(ratio, 0, 1)), h, h / 2)
    c.add(g)
    return c
  }

  /** 顶部下方浮动提示 */
  _toast(msg, color = COLOR.toastInfo) {
    const c = this.add.container(this.scale.width / 2, TOPBAR_H + 26).setDepth(DEPTH.toast)
    const t = this.add.text(0, 0, msg, style(13)).setOrigin(0.5)
    const bg = this.add.graphics()
    bg.fillStyle(color, 0.92)
    bg.fillRoundedRect(-t.width / 2 - 12, -t.height / 2 - 6, t.width + 24, t.height + 12, 14)
    c.add([bg, t])
    this.tweens.add({
      targets: c, y: '+=12', alpha: { from: 1, to: 0 },
      delay: 1400, duration: 400, onComplete: () => c.destroy(),
    })
  }

  // ── 自适应 ───────────────────────────────────────────────────────────────

  _onResize() {
    const w = this.scale.width
    this._refreshTopbarBg(w)
    this.statusText.setX(w - 8)
    this._layoutBottombar()
    this._rebuildMarchList()
    this._refreshTilePanel()
    this._closeModal()   // 弹窗直接关闭，避免错位
    this._refreshTopbar() // 立即根据 statusText 宽度重新定位日期
  }
}
