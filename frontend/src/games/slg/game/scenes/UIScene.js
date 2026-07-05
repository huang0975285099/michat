// 九州征途 - HUD 场景（Phaser 全权实现，无 DOM 混合）
// 叠在 WorldScene 之上，固定屏幕坐标。所有面板/按钮/提示均为 Phaser GameObject。
// WorldScene 通过 hitTest(x,y) 询问指针是否落在 UI 上，避免点击穿透到地图。

import Phaser from 'phaser'
import {
  RESOURCES, TILE_TYPES, TIME_SCALE, BASE_YIELD_PER_LEVEL,
  expToLevel, cityUpgradeCost, RECRUIT_COST_PER_TROOP, CITY_MAX_LEVEL,
  npcCityLootOf,
  BUILDINGS, BUILDING_MAX_LEVEL, buildingUpgradeCost,
  GRANARY_YIELD_PER_LEVEL, BARRACKS_CAP_PER_LEVEL, TRAINING_EXP_PER_LEVEL, FORGE_STAT_PER_LEVEL,
  STAMINA_MAX, MARCH_STAMINA_COST, STAMINA_REGEN_PER_HOUR,
  GENERAL_QUALITY, MAX_GENERALS, RECRUIT_COST_COIN, AWAKEN_ATK, AWAKEN_DEF, AWAKEN_INT, AWAKEN_SPD,
  TROOP_TYPES, counterMult, findGeneralTemplate, guardStat, MAX_MARCH_PARTY,
  SKILL_MAX_LEVEL,
  EQUIP_TYPES, EQUIP_QUALITY, EQUIP_MAX_LEVEL, EQUIP_DRAW_COST, EQUIP_DISMISS_JADE,
} from '../GameConstants.js'
import { GameState } from '../core/GameState.js'
import { getSkill, BINDABLE_SKILLS, skillLevelAt, skillStatLine } from '../core/skills.js'
import {
  equipValue, equipUpgradeCost, equipMaxed, equipName, equipDesc,
} from '../core/equipment.js'

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
      this._circleBtn('🎒', () => this._openEquipWarehouse()),
      this._circleBtn('📜', () => this._openSkillWarehouse()),
      this._circleBtn('📊', () => this._openLog()),
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
    this._closeTilePanel()   // 打开新模态弹窗时关闭土地面板
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
      panel.add(this.add.text(0, -h / 2 + 14, `选择出征武将（最多 ${MAX_MARCH_PARTY} 队合击）`,
        style(15, '#ffffff', true)).setOrigin(0.5, 0))

      gens.forEach((g, i) => {
        const y = -h / 2 + 52 + i * rowH + (rowH - 8) / 2
        const st = g.stamina ?? STAMINA_MAX
        const lowStamina = st < MARCH_STAMINA_COST
        const enabled = g.state === 'idle' && g.troops > 0 && !lowStamina
        const picked = pick.has(g.id)
        const row = this._row(panel, y, w - 24, rowH - 8, enabled, () => {
          if (picked) pick.delete(g.id)
          else if (pick.size >= MAX_MARCH_PARTY) { this._toast(`最多同时出征 ${MAX_MARCH_PARTY} 队`, COLOR.toastWarn); return }
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

  // ── 弹窗：战法仓库（兑换 + 升级）─────────────────────────────────────────
  // 顶部展示玉石余额；列表分两段：
  //   1) 已拥有战法：显示当前等级，按钮为「升级」（满级置灰）
  //   2) 可兑换战法：按钮为「兑换」（玉石不足置灰）
  // 升级消耗 = cost × 当前等级；兑换消耗 = cost。

  _openSkillWarehouse() {
    const owned = this.state.ownedSkills()
    const ownedSet = new Set(owned)
    const buyable = BINDABLE_SKILLS.filter(s => !ownedSet.has(s.id))
    const rowCount = owned.length + buyable.length
    const rowH = 82
    const sw = this.scale.width, sh = this.scale.height
    const w = Math.min(sw - 24, 460)
    const headerH = 58, footerH = 26
    const listVH = Math.min(rowCount * rowH, (sh - 100) - headerH - footerH)
    const h = headerH + Math.max(listVH, rowH) + footerH
    const rw = w - 24
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 12, '📜 战法仓库', style(15, '#ffffff', true)).setOrigin(0.5, 0))
      const jade = Math.floor(this.state.res.jade || 0)
      panel.add(this.add.text(0, -h / 2 + 34, `💎 玉石 ${fmt(jade)}`,
        style(12, '#ffd54f', true)).setOrigin(0.5, 0))

      if (rowCount === 0) {
        panel.add(this.add.text(0, 0, '暂无战法\n（遣散武将或下方兑换可获得）',
          { ...style(12, '#888888'), align: 'center' }).setOrigin(0.5))
        panel.add(this._button(0, h / 2 - 22, 120, 26, '关闭', COLOR.btnGrey, true,
          () => this._closeModal()))
        return
      }

      const content = this._makeScrollRegion(
        sw / 2 - w / 2 + 12, sh / 2 - h / 2 + headerH, w - 24, listVH, rowCount * rowH + 8)

      // 第 1 段：已拥有战法（升级）
      owned.forEach((sid, i) => {
        const sk = getSkill(sid)
        if (!sk) return
        const lv = this.state.skillLevel(sid)
        const cy = i * rowH + rowH / 2
        const half = rowH - 8
        const row = this._row(content, cy, rw, half, false, null)
        row.x = rw / 2
        const holder = this.state.skillBoundTo(sid)
        // 第1行：名称 + 等级 (左) | 持有者 (右)
        row.add(this.add.text(-rw / 2 + 10, -half / 2 + 9,
          `【${sk.name}】  Lv.${lv}/${SKILL_MAX_LEVEL}`,
          style(13, '#ffffff', true)).setOrigin(0, 0.5))
        if (holder) {
          row.add(this.add.text(rw / 2 - 12, -half / 2 + 9, `已绑 ${holder.name}`,
            style(10, '#81c784')).setOrigin(1, 0.5))
        }
        // 第2行：当前 → 下级 关键数值（核心：让玩家看到升级收益）
        const maxed = lv >= SKILL_MAX_LEVEL
        const curLine = skillStatLine(sk, lv)
        const nextLine = maxed ? '' : skillStatLine(sk, lv + 1)
        const dataColor = maxed ? '#9e9e9e' : '#a5d6a7'
        const dataText = maxed
          ? `当前 ${curLine}（已满级）`
          : `Lv.${lv} ${curLine}  →  Lv.${lv + 1} ${nextLine}`
        row.add(this.add.text(-rw / 2 + 10, -8, dataText,
          style(10, dataColor)).setOrigin(0, 0.5))
        // 第3行：升级花费 (右偏左) + 升级按钮 (右)
        const upCost = (sk.cost || 0) * lv
        const sub = maxed ? '已满级' : `升级 💎${upCost}`
        row.add(this.add.text(rw / 2 - 92, half / 2 - 9, sub,
          style(10, maxed ? '#9e9e9e' : (jade < upCost ? '#ef9a9a' : '#9ccc9c')))
          .setOrigin(1, 0.5))
        const canUp = !maxed && jade >= upCost
        row.add(this._button(rw / 2 - 48, half / 2 - 12, 76, 24,
          maxed ? '满级' : '升级', COLOR.btnAmber, canUp, () => {
            const r = this.state.upgradeSkill(sid)
            if (r.error) this._toast(r.error, COLOR.toastWarn)
            else { this._toast(`【${sk.name}】升至 ${r.level} 级`, COLOR.toastWin); this._openSkillWarehouse() }
          }))
      })

      // 第 2 段：可兑换战法（兑换）— 显示 Lv.1 数据让玩家判断价值
      const offset = owned.length * rowH
      buyable.forEach((sk, j) => {
        const cy = offset + j * rowH + rowH / 2
        const half = rowH - 8
        const row = this._row(content, cy, rw, half, false, null)
        row.x = rw / 2
        row.add(this.add.text(-rw / 2 + 10, -half / 2 + 9,
          `【${sk.name}】`, style(13, '#ffd54f', true)).setOrigin(0, 0.5))
        row.add(this.add.text(rw / 2 - 12, -half / 2 + 9, '未拥有',
          style(10, '#9e9e9e')).setOrigin(1, 0.5))
        // Lv.1 数据 + 描述
        const lv1Line = skillStatLine(sk, 1)
        row.add(this.add.text(-rw / 2 + 10, -8, `Lv.1 ${lv1Line}`,
          style(10, '#a5d6a7')).setOrigin(0, 0.5))
        row.add(this._ellipsisText(sk.desc, style(9, '#9e9e9e'), rw - 24)
          .setPosition(-rw / 2 + 10, 12).setOrigin(0, 0.5))
        const cost = sk.cost || 0
        row.add(this.add.text(rw / 2 - 92, half / 2 - 9, `兑换 💎${cost}`,
          style(10, jade < cost ? '#ef9a9a' : '#9ccc9c')).setOrigin(1, 0.5))
        const canBuy = jade >= cost
        row.add(this._button(rw / 2 - 48, half / 2 - 12, 76, 24,
          '兑换', COLOR.btnGreen, canBuy, () => {
            const r = this.state.buySkill(sk.id)
            if (r.error) this._toast(r.error, COLOR.toastWarn)
            else { this._toast(`兑换【${sk.name}】成功`, COLOR.toastWin); this._openSkillWarehouse() }
          }))
      })

      panel.add(this.add.text(0, h / 2 - 16,
        '遣散武将产出玉石 · 升级消耗 = 兑换价 × 当前等级',
        style(10, '#9e9e9e')).setOrigin(0.5, 0))
    })
  }

  // ── 弹窗：战法绑定 ───────────────────────────────────────────────────────
  // 列出仓库全部战法：可用的点按即绑定（自动换下原战法）；当前武将已装备的点按解绑；
  // 已被其他武将占用的置灰并注明持有者。一将一法、一法一将。

  _openSkillBind(generalId) {
    const g = this.state.general(generalId)
    if (!g) return
    const owned = this.state.ownedSkills()
    const rowH = 58
    const sw = this.scale.width, sh = this.scale.height
    const w = Math.min(sw - 24, 400)
    const headerH = 50, footerH = 20
    const listH = Math.max(rowH, Math.min(owned.length * rowH, sh - 160 - headerH - footerH))
    const h = headerH + listH + footerH
    this._openModal(w, h, (panel) => {
      const cur = g.skillId ? getSkill(g.skillId) : null
      panel.add(this.add.text(0, -h / 2 + 12, `${g.name} · 配置战法`, style(15, '#ffffff', true)).setOrigin(0.5, 0))
      panel.add(this.add.text(0, -h / 2 + 32,
        cur ? `当前：【${cur.name}】（点它可解绑）` : '当前：无战法',
        style(11, cur ? '#ffd54f' : '#9e9e9e')).setOrigin(0.5, 0))

      if (!owned.length) {
        panel.add(this.add.text(0, 0, '仓库暂无战法\n（销毁武将/玉石兑换可获得）',
          { ...style(12, '#888888'), align: 'center' }).setOrigin(0.5))
        panel.add(this._button(0, h / 2 - 30, 120, 26, '关闭', COLOR.btnGrey, true, () => this._closeModal()))
        return
      }

      const content = this._makeScrollRegion(
        sw / 2 - w / 2 + 14, sh / 2 - h / 2 + headerH, w - 28, listH, owned.length * rowH)
      owned.forEach((sid, i) => {
        const sk = getSkill(sid)
        const holder = this.state.skillBoundTo(sid)
        const mine = holder && holder.id === generalId
        const other = holder && holder.id !== generalId
        const rw = w - 28, half = rowH - 8
        const y = i * rowH + rowH / 2
        const row = this._row(content, y, rw, half, !other, () => {
          if (!this._rowVisibleInScroll(y)) return   // 滚动出视区的行不响应点击
          if (mine) { this.state.unbindSkill(generalId); this._openGenerals() }
          else {
            const err = this.state.bindSkill(generalId, sid)
            if (err) this._toast(err, COLOR.toastWarn)
            else this._openGenerals()
          }
        })
        // _row 把容器放在 content 局部 x=0（=滚动区左缘），须右移半个行宽居中
        row.x = rw / 2
        const nameColor = mine ? '#ffd54f' : (other ? '#777777' : '#ffffff')
        row.add(this.add.text(-rw / 2 + 12, -half / 2 + 8, `【${sk.name}】`,
          style(13, nameColor, true)).setOrigin(0, 0))
        // 右上角状态标签
        const tag = mine ? '已装备' : (other ? `已绑 ${holder.name}` : '可装备')
        const tagColor = mine ? '#66bb6a' : (other ? '#ef5350' : '#81c784')
        row.add(this.add.text(rw / 2 - 12, -half / 2 + 8, tag, style(11, tagColor, true)).setOrigin(1, 0))
        // 描述
        row.add(this._ellipsisText(sk.desc, style(10, '#9e9e9e'), rw - 24)
          .setPosition(-rw / 2 + 12, -half / 2 + 26).setOrigin(0, 0))
      })
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
      // 招募入口（抽装备入口已移至「装备仓库」面板右上角）
      panel.add(this._button(w / 2 - 52, -h / 2 + 23, 92, 28, '🎲 招募', COLOR.btnAmber, true,
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

        // 布局分区：左头像（含装备按钮）+ 中间信息 + 右按钮列
        const btnW = 62, btnGap = 8
        const avatarSize = 56                  // 头像缩小，给下方装备按钮留空间
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

        // ── 头像下方：配装备按钮 ──
        const equipCount = EQUIP_TYPES.reduce((s, t) => s + (g.equip?.[t.id] ? 1 : 0), 0)
        row.add(this._button(avatarX + avatarSize / 2, half / 2 - 13, avatarSize, 22,
          equipCount ? `装备${equipCount}/6` : '配装备',
          equipCount ? COLOR.btnAmber : COLOR.btnGrey, true, () => {
            if (!this._rowVisibleInScroll(cy)) return
            this._openEquipManage(g.id)
          }))

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

        // ── 右侧按钮列：补兵 + 战法 + 销毁 ──
        const btnX = rw / 2 - btnW / 2 - 2
        const canRecruit = g.state === 'idle' && g.troops < cap
        row.add(this._button(btnX, -26, btnW, 22, '补满兵',
          COLOR.btnGreen, canRecruit, () => {
            if (!this._rowVisibleInScroll(cy)) return
            const err = this.state.recruit(g.id, cap - g.troops)
            if (err) this._toast(err, COLOR.toastWarn)
            else this._openGenerals()
          }))
        // 战法：绑定则显示战法名（琥珀），未绑定显示「配战法」（灰）
        const boundSkill = g.skillId ? getSkill(g.skillId) : null
        row.add(this._button(btnX, 0, btnW, 22, boundSkill ? boundSkill.name : '配战法',
          boundSkill ? COLOR.btnAmber : COLOR.btnGrey, true, () => {
            if (!this._rowVisibleInScroll(cy)) return
            this._openSkillBind(g.id)
          }))
        row.add(this._button(btnX, 26, btnW, 22, '销毁',
          COLOR.btnGrey, true, () => {
            if (!this._rowVisibleInScroll(cy)) return
            this._openConfirm(`确定销毁 ${g.name}？\n等级与觉醒将一并清除且不可恢复`, () => {
              const res = this.state.dismissGeneral(g.id)
              if (res.error) this._toast(res.error, COLOR.toastWarn)
              else this._openGenerals()
            })
          }))
      })
      const rc = RECRUIT_COST_PER_TROOP
      panel.add(this.add.text(0, h / 2 - 16,
        `征兵 ${rc.grain}粮${rc.iron}铁${rc.wood}木/兵 · 出征耗 ${MARCH_STAMINA_COST} 体力（每分钟回 ${STAMINA_REGEN_PER_HOUR}）`,
        style(10, '#9e9e9e')).setOrigin(0.5))
    })
  }

  // ── 弹窗：招募（抽卡）────────────────────────────────────────────────────

  _openRecruit() {
    const w = Math.min(this.scale.width - 24, 360), h = 300
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 16, '🎲 招募武将', style(16, '#ffffff', true)).setOrigin(0.5, 0))

      // 概率表（basic 为守将专用档，rate=0 不展示）
      const rates = Object.values(GENERAL_QUALITY)
        .filter(q => q.rate > 0)
        .map(q => `${q.name} ${q.rate}%`).join('    ')
      panel.add(this.add.text(0, -h / 2 + 46, rates, style(11, '#9e9e9e')).setOrigin(0.5, 0))

      // 自动转换玉石开关（普通/精良 → 玉石）
      const autoJade = !!this.state.autoJadeCommon
      panel.add(this._button(0, -h / 2 + 78, 280, 26,
        `💎 自动转换 普通/精良 → 玉石：${autoJade ? '开启' : '关闭'}`,
        autoJade ? COLOR.btnAmber : COLOR.btnGrey, true, () => {
          this.state.autoJadeCommon = !this.state.autoJadeCommon
          this.state.save()
          this._openRecruit()
        }))

      // 结果显示区
      const res = this._recruitResult
      const resY = -10
      const free = this.state.freeRecruits > 0
      const full = this.state.generals.length >= MAX_GENERALS
      if (res) {
        const q = GENERAL_QUALITY[res.quality] || GENERAL_QUALITY.common
        const title = res.type === 'new' ? '获得新武将！' :
          res.type === 'awaken' ? '武将觉醒！' : '已转换为玉石'
        panel.add(this.add.text(0, resY - 18, title, style(13, '#dddddd')).setOrigin(0.5))
        if (res.type === 'jade') {
          panel.add(this.add.text(0, resY + 8,
            `${q.name} · ${res.name}\n💎 +${res.jade} 玉石`,
            { ...style(18, q.color, true), align: 'center' }).setOrigin(0.5))
        } else {
          panel.add(this.add.text(0, resY + 8,
            `${q.name} · ${res.name}`, style(20, q.color, true)).setOrigin(0.5))
        }
      } else if (full) {
        panel.add(this.add.text(0, resY,
          `⚠️ 武将名额已满（${MAX_GENERALS}/${MAX_GENERALS}）\n请先遣散武将后再招募`,
          { ...style(12, '#ff8a65'), align: 'center' }).setOrigin(0.5))
      } else if (free) {
        panel.add(this.add.text(0, resY,
          `剩余 ${this.state.freeRecruits} 次免费招募机会\n重复武将转为觉醒（武+${AWAKEN_ATK} 防+${AWAKEN_DEF} 智+${AWAKEN_INT} 速+${AWAKEN_SPD} ×品质成长）`,
          { ...style(12, '#ffd54f'), align: 'center' }).setOrigin(0.5))
      } else {
        panel.add(this.add.text(0, resY,
          `消耗 ${RESOURCES.coin.icon}${RECRUIT_COST_COIN} 招募一名武将\n重复武将转为觉醒（武+${AWAKEN_ATK} 防+${AWAKEN_DEF} 智+${AWAKEN_INT} 速+${AWAKEN_SPD} ×品质成长）`,
          { ...style(12, '#9e9e9e'), align: 'center' }).setOrigin(0.5))
      }

      // 招募按钮（满员时禁用）
      const canAfford = !full && (free || this.state.res.coin >= RECRUIT_COST_COIN)
      panel.add(this._button(0, h / 2 - 58, 200, 36,
        free ? '免费招募' : `招募（${RESOURCES.coin.icon}${RECRUIT_COST_COIN}）`,
        COLOR.btnAmber, canAfford, () => {
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

  // ── 弹窗：抽装备 ─────────────────────────────────────────────────────────

  _openEquipDraw() {
    const w = Math.min(this.scale.width - 24, 360), h = 250
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 16, '✨ 抽装备', style(16, '#ffffff', true)).setOrigin(0.5, 0))
      panel.add(this.add.text(0, -h / 2 + 48,
        `单次消耗 ${RESOURCES.coin.icon}${EQUIP_DRAW_COST} · 当前 ${RESOURCES.coin.icon}${Math.floor(this.state.res.coin)}`,
        style(12, '#ffd54f')).setOrigin(0.5, 0))
      panel.add(this.add.text(0, -h / 2 + 76,
        '品质概率与武将招募一致（普通 50% / 精良 30% / 精锐 15% / 王牌 5%）',
        style(10, '#9e9e9e')).setOrigin(0.5, 0))
      panel.add(this.add.text(0, -h / 2 + 96,
        '随机类型（6 种）× 随机主属性（武/防/智/速）',
        style(10, '#9e9e9e')).setOrigin(0.5, 0))

      const canAfford = this.state.res.coin >= EQUIP_DRAW_COST
      panel.add(this._button(0, h / 2 - 58, 200, 36,
        `抽装备（${RESOURCES.coin.icon}${EQUIP_DRAW_COST}）`, COLOR.btnAmber, canAfford, () => {
          const r = this.state.drawEquipment()
          if (r.error) { this._toast(r.error, COLOR.toastWarn); return }
          this._equipDrawResult = r.eq
          this._openEquipDraw()   // 重建以显示结果
        }))

      // 显示上次抽取结果
      if (this._equipDrawResult) {
        const eq = this._equipDrawResult
        const qColor = EQUIP_QUALITY[eq.quality].color
        panel.add(this.add.text(0, 0,
          `✨ 抽得【${equipName(eq)}】`, style(15, qColor, true)).setOrigin(0.5, 0.5))
        panel.add(this.add.text(0, 26,
          equipDesc(eq), style(12, '#ffffff')).setOrigin(0.5, 0.5))
      }

      panel.add(this._button(0, h / 2 - 20, 120, 28, '返回仓库', COLOR.btnGrey, true, () => {
        this._equipDrawResult = null
        this._openEquipWarehouse()
      }))
    })
  }

  // ── 弹窗：武将装备管理 ───────────────────────────────────────────────────

  _openEquipManage(generalId) {
    const g = this.state.general(generalId)
    if (!g) return
    const sw = this.scale.width, sh = this.scale.height
    const w = Math.min(sw - 24, 420)
    const rowH = 56
    const headerH = 46, footerH = 28
    const listVH = Math.min(EQUIP_TYPES.length * rowH, (sh - 100) - headerH - footerH)
    const h = headerH + listVH + footerH
    const rw = w - 24
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(-w / 2 + 14, -h / 2 + 14,
        `📜 ${g.name} 装备`, style(15, '#ffffff', true)).setOrigin(0, 0))
      panel.add(this.add.text(-w / 2 + 110, -h / 2 + 16,
        `武${Math.round(g.atk)} 防${Math.round(g.def)} 智${Math.round(g.int)} 速${Math.round(g.spd)}`,
        style(11, '#9e9e9e')).setOrigin(0, 0))

      const content = this._makeScrollRegion(
        sw / 2 - w / 2 + 12, sh / 2 - h / 2 + headerH, w - 24, listVH, EQUIP_TYPES.length * rowH)
      EQUIP_TYPES.forEach((typeDef, i) => {
        const cy = i * rowH + rowH / 2
        const half = rowH - 8
        const row = this.add.container(rw / 2, cy)
        const bg = this.add.graphics()
        bg.fillStyle(COLOR.rowBg, 0.95)
        bg.fillRoundedRect(-rw / 2, -half / 2, rw, half, 6)
        row.add(bg)
        content.add(row)

        const iid = g.equip?.[typeDef.id]
        const eq = iid ? this.state.equipment(iid) : null
        const qColor = eq ? EQUIP_QUALITY[eq.quality].color : '#9e9e9e'

        // 类型名 + 图标
        row.add(this.add.text(-rw / 2 + 10, -half / 2 + 9,
          `${typeDef.icon} ${typeDef.name}`, style(13, '#ffffff', true)).setOrigin(0, 0.5))

        if (eq) {
          // 已装备：显示装备名 + 属性 + 等级
          row.add(this.add.text(-rw / 2 + 90, -half / 2 + 9,
            equipName(eq), style(12, qColor, true)).setOrigin(0, 0.5))
          row.add(this.add.text(-rw / 2 + 90, half / 2 - 10,
            `${equipDesc(eq)}`, style(11, '#e8e8e8')).setOrigin(0, 0.5))
          // 卸下按钮
          row.add(this._button(rw / 2 - 40, 0, 70, 24, '卸下', COLOR.btnGrey, true, () => {
            if (!this._rowVisibleInScroll(cy)) return
            this.state.unbindEquip(g.id, typeDef.id)
            this._openEquipManage(g.id)
          }))
        } else {
          // 空槽：显示「未装备」+ 选择按钮
          const avail = this.state.availableEquipments(typeDef.id)
          row.add(this.add.text(-rw / 2 + 90, 0,
            avail.length ? `未装备（仓库 ${avail.length} 件可选）` : '未装备（仓库无此类装备）',
            style(11, '#9e9e9e')).setOrigin(0, 0.5))
          row.add(this._button(rw / 2 - 40, 0, 70, 24, '选择',
            avail.length ? COLOR.btnAmber : COLOR.btnGrey, avail.length > 0, () => {
              if (!this._rowVisibleInScroll(cy)) return
              this._openEquipPick(g.id, typeDef.id)
            }))
        }
      })

      panel.add(this.add.text(0, h / 2 - 16,
        '同类型装备只能装 1 件 · 同件装备只能被 1 个武将绑定',
        style(10, '#9e9e9e')).setOrigin(0.5))
    })
  }

  /** 装备选择子面板：列出仓库内某类型可用装备 */
  _openEquipPick(generalId, type) {
    const g = this.state.general(generalId)
    const typeDef = EQUIP_TYPES.find(t => t.id === type)
    const avail = this.state.availableEquipments(type)
    const sw = this.scale.width, sh = this.scale.height
    const w = Math.min(sw - 24, 380)
    const rowH = 48
    const headerH = 46, footerH = 28
    const listVH = Math.min(avail.length * rowH, (sh - 100) - headerH - footerH)
    const h = headerH + listVH + footerH
    const rw = w - 24
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(0, -h / 2 + 14,
        `选择${typeDef.icon}${typeDef.name}`, style(15, '#ffffff', true)).setOrigin(0.5, 0))

      const content = this._makeScrollRegion(
        sw / 2 - w / 2 + 12, sh / 2 - h / 2 + headerH, w - 24, listVH, avail.length * rowH)
      avail.forEach((eq, i) => {
        const cy = i * rowH + rowH / 2
        const half = rowH - 8
        const row = this.add.container(rw / 2, cy)
        const bg = this.add.graphics()
        bg.fillStyle(COLOR.rowBg, 0.95)
        bg.fillRoundedRect(-rw / 2, -half / 2, rw, half, 6)
        row.add(bg)
        content.add(row)

        const qColor = EQUIP_QUALITY[eq.quality].color
        row.add(this.add.text(-rw / 2 + 10, 0,
          equipName(eq), style(13, qColor, true)).setOrigin(0, 0.5))
        row.add(this.add.text(-rw / 2 + 180, 0,
          equipDesc(eq), style(11, '#e8e8e8')).setOrigin(0, 0.5))
        row.add(this._button(rw / 2 - 40, 0, 70, 24, '装备', COLOR.btnGreen, true, () => {
          if (!this._rowVisibleInScroll(cy)) return
          const err = this.state.bindEquip(g.id, eq.iid)
          if (err) { this._toast(err, COLOR.toastWarn); return }
          this._openEquipManage(g.id)
        }))
      })

      panel.add(this._button(0, h / 2 - 16, 100, 24, '返回', COLOR.btnGrey, true, () => {
        this._openEquipManage(g.id)
      }))
    })
  }

  // ── 弹窗：装备仓库（底部 🎒 入口，分 tab 浏览 + 升级）─────────────────────

  _openEquipWarehouse() {
    if (!this._equipTab) this._equipTab = 'all'
    const tab = this._equipTab
    const all = this.state.ownedEquipments()
    const equips = tab === 'all' ? all : all.filter(e => e.type === tab)

    const sw = this.scale.width, sh = this.scale.height
    const w = Math.min(sw - 16, 460)
    const tabs = [{ id: 'all', name: '全部', icon: '📦' }, ...EQUIP_TYPES]
    const tabH = 32
    const headerH = 50 + tabH, footerH = 28
    const rowH = 56
    const listVH = Math.min(Math.max(equips.length, 1) * rowH, (sh - 100) - headerH - footerH)
    const h = headerH + listVH + footerH
    const rw = w - 24
    this._openModal(w, h, (panel) => {
      panel.add(this.add.text(-w / 2 + 14, -h / 2 + 14,
        '🎒 装备仓库', style(15, '#ffffff', true)).setOrigin(0, 0))
      // 方案 A：统计文字与标题合并到同一行，避免被「抽装备」按钮遮挡
      panel.add(this.add.text(-w / 2 + 130, -h / 2 + 17,
        `共 ${all.length} 件`,
        style(11, '#ffd54f')).setOrigin(0, 0))
      // 抽装备入口（原在「武将」面板，现移到本面板右上角）
      panel.add(this._button(w / 2 - 52, -h / 2 + 23, 92, 28, '✨ 抽装备', COLOR.btnAmber, true,
        () => this._openEquipDraw()))

      // Tab 行
      const tabY = -h / 2 + 50
      const tabW = (w - 16) / tabs.length
      tabs.forEach((t, i) => {
        const x = -w / 2 + 8 + tabW / 2 + i * tabW
        const active = tab === t.id
        const tabBg = this.add.graphics()
        tabBg.fillStyle(active ? 0x4a3a1a : 0x2c352a, 0.95)
        tabBg.fillRoundedRect(-tabW / 2 + 2, -tabH / 2, tabW - 4, tabH, 6)
        if (active) {
          tabBg.lineStyle(1.5, 0xffd700, 0.8)
          tabBg.strokeRoundedRect(-tabW / 2 + 2, -tabH / 2, tabW - 4, tabH, 6)
        }
        tabBg.x = x; tabBg.y = tabY
        panel.add(tabBg)
        panel.add(this.add.text(x, tabY, `${t.icon}${t.name}`,
          style(11, active ? '#ffd700' : '#cccccc', active)).setOrigin(0.5))
        panel.add(this.add.zone(x, tabY, tabW - 4, tabH)
          .setInteractive({ useHandCursor: true })
          .on('pointerup', () => {
            this._equipTab = t.id
            this._openEquipWarehouse()
          }))
      })

      // 列表区
      if (equips.length === 0) {
        panel.add(this.add.text(0, 0, '该分类下暂无装备', style(13, '#9e9e9e')).setOrigin(0.5))
      } else {
        const content = this._makeScrollRegion(
          sw / 2 - w / 2 + 12, sh / 2 - h / 2 + headerH, w - 24, listVH, equips.length * rowH)
        equips.forEach((eq, i) => {
          const cy = i * rowH + rowH / 2
          const half = rowH - 8
          const row = this.add.container(rw / 2, cy)
          const bg = this.add.graphics()
          bg.fillStyle(COLOR.rowBg, 0.95)
          bg.fillRoundedRect(-rw / 2, -half / 2, rw, half, 6)
          row.add(bg)
          content.add(row)

          const qColor = EQUIP_QUALITY[eq.quality].color
          const bound = eq.boundTo ? this.state.general(eq.boundTo) : null
          row.add(this.add.text(-rw / 2 + 10, -half / 2 + 9,
            equipName(eq), style(13, qColor, true)).setOrigin(0, 0.5))
          row.add(this.add.text(-rw / 2 + 180, -half / 2 + 9,
            equipDesc(eq), style(11, '#e8e8e8')).setOrigin(0, 0.5))
          row.add(this.add.text(-rw / 2 + 180, half / 2 - 10,
            bound ? `已装备：${bound.name}` : '仓库中',
            style(10, '#9e9e9e')).setOrigin(0, 0.5))

          const maxed = equipMaxed(eq)
          const cost = equipUpgradeCost(eq)
          const canAfford = this.state.res.coin >= cost
          const btnLabel = maxed ? '满级' : `${RESOURCES.coin.icon}${cost}`
          row.add(this._button(rw / 2 - 40, -13, 70, 20, btnLabel,
            maxed ? COLOR.btnGrey : COLOR.btnAmber, !maxed && canAfford, () => {
              if (!this._rowVisibleInScroll(cy)) return
              const r = this.state.upgradeEquipment(eq.iid)
              if (r.error) { this._toast(r.error, COLOR.toastWarn); return }
              this._toast(`【${equipName(eq)}】升至 ${r.level} 级`, COLOR.toastInfo)
              this._openEquipWarehouse()   // 重建刷新
            }))
          // 销毁按钮：按品质返还玉石（已装备的会先自动卸下）
          const jadeBack = EQUIP_DISMISS_JADE[eq.quality] ?? 0
          row.add(this._button(rw / 2 - 40, 13, 70, 20, `💎${jadeBack}`, COLOR.btnGrey, true, () => {
            if (!this._rowVisibleInScroll(cy)) return
            this._openConfirm(
              `确定销毁【${equipName(eq)}】？${bound ? `\n当前装备在 ${bound.name} 身上，将自动卸下` : ''}\n返还 ${jadeBack} 玉石，不可恢复`,
              () => {
                const r = this.state.dismissEquipment(eq.iid)
                if (r.error) { this._toast(r.error, COLOR.toastWarn); return }
                this._toast(`销毁成功，获得 ${r.jade} 玉石`, COLOR.toastWin)
                this._openEquipWarehouse()
              })
          }))
        })
      }

      panel.add(this.add.text(0, h / 2 - 16,
        '升级消耗 = 品质基础 × 当前等级',
        style(10, '#9e9e9e')).setOrigin(0.5))
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
        // 铁匠坊专属「打造」入口：跳转装备仓库
        // if (type === 'forge') {
        //   row.add(this._button(rw / 2 - 48, half / 2 - 14, 76, 24,
        //     '🔨 打造', COLOR.btnGreen, true, () => {
        //       this._openEquipWarehouse()
        //     }))
        // }
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
      const troopName = ti ? `${ti.icon} ` : ''
      // 敌将卡：第一行 名称+兵种+等级（品质色）；第二行 武/防/速/智（含等级加成）。
      // 先手/胜负不再在此重复（先手见下方准备回合，胜负见右上角总结）。
      rows.push({ x: 0, y: y + 2,
        text: `第${bi + 1}阵  ${troopName}${b.enemy.name} Lv.${b.enemy.lv}`,
        size: 12, color: q.color, bold: true, origin: 0 })
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
        rows.push({ x: 16, y, text: `我方  武${sv(p.our.atk, p.our.atkEff)} 防${sv(p.our.def, p.our.defEff)} 速${sv(p.our.spd, p.our.spdEff)} 智${sv(p.our.int ?? '?', p.our.intEff ?? p.our.int ?? '?')} · 兵${p.our.troops}`,
          size: 10, color: '#a5d6a7', origin: 0 })
        y += 15
        rows.push({ x: 16, y, text: `守军  武${sv(p.foe.atk, p.foe.atkEff)} 防${sv(p.foe.def, p.foe.defEff)} 速${sv(p.foe.spd, p.foe.spdEff)} 智${p.foe.int ?? '?'} · 兵${p.foe.troops}`,
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

  /** 战报 v2（多对多同场混战）：双方阵容卡 + 逐回合（简洁=兵力汇总 / 完整=逐次出手明细） */
  _layoutBattleRowsV2(report, mode) {
    const rows = []
    let y = 0
    // 双方阵容卡：名字/等级/兵种（品质色）+ 属性（基础→实战）+ 兵力与输出/承伤
    const sv = (base, eff) => (base === eff || eff == null) ? `${base}` : `${base}→${eff}`
    const roster = (title, units, color) => {
      rows.push({ x: 0, y: y + 2, text: title, size: 12, color, bold: true, origin: 0 })
      y += 20
      units.forEach((u) => {
        const q = GENERAL_QUALITY[u.quality] || GENERAL_QUALITY.common
        const ti = TROOP_TYPES[u.troopType]
        const dead = u.end <= 0
        const skillTag = u.skill ? `  【${u.skill}】` : ''
        rows.push({ x: 10, y,
          text: `${ti ? ti.icon : ''}${u.name} Lv.${u.lv}${skillTag}   兵 ${u.start} → ${u.end}${dead ? '（阵亡）' : ''}`,
          size: 11, color: dead ? '#ef5350' : q.color, bold: true, origin: 0 })
        y += 15
        // 战法统计（有绑定战法或触发过才显示），帮玩家看谁脸黑
        const stat = []
        if (u.skillFire) stat.push(`战法${u.skillFire}次`)
        if (u.extra) stat.push(`连击${u.extra}次`)
        if (u.control) stat.push(`控制${u.control}次`)
        const statTail = stat.length ? ` · ${stat.join(' ')}` : ''
        rows.push({ x: 16, y,
          text: `武${sv(u.atk, u.atkEff)} 防${sv(u.def, u.defEff)} 速${sv(u.spd, u.spdEff)} 智${sv(u.int, u.intEff)} · 输出${u.dealt} 承伤${u.taken}${statTail}`,
          size: 10, color: '#9e9e9e', origin: 0 })
        y += 17
      })
      y += 4
    }
    roster('我方阵容', report.our || [], '#a5d6a7')
    roster('守军阵容', report.foe || [], '#ef9a9a')

    ;(report.rounds || []).forEach((r) => {
      if (mode === 'simple') {
        rows.push({ x: 10, y, text: `第${r.round}回合   我方 ${r.atkTroops}（-${r.atkLoss}）    守军 ${r.defTroops}（-${r.defLoss}）`,
          size: 11, color: '#dddddd', origin: 0 })
        y += 22
      } else {
        rows.push({ x: 10, y, text: `第${r.round}回合`, size: 11, color: '#ffd54f', bold: true, origin: 0 })
        y += 14
        ;(r.events || []).forEach((e) => {
          const line = this._battleEventText(e)
          if (!line) return
          rows.push({ x: line.indent, y, text: line.text, size: 10, color: line.color, origin: 0 })
          y += 16
        })
      }
    })
    return { rows, height: y }
  }

  /** 把一条 BattleEvent 翻成战报里的一行文字（返回 null = 该事件不单独成行，如 action_start/end） */
  _battleEventText(e) {
    const mine = e.side === 'atk'
    const good = '#a5d6a7', bad = '#ef9a9a'
    switch (e.type) {
      case 'skill_trigger':
        return { indent: 16, color: '#ffd54f', text: `${e.actor} 发动【${e.skillName}】` }
      case 'skill_failed':
        return { indent: 16, color: '#777777', text: `${e.actor} 【${e.skillName}】未发动` }
      case 'extra_attack':
        return { indent: 16, color: '#ffd54f', text: `${e.actor} 触发【${e.skillName}】追加攻击` }
      case 'status_add':
        return { indent: 22, color: '#ce93d8', text: `${e.actor} 陷入【${e.statusName}】（${e.value}回合）` }
      case 'status_skip':
        return { indent: 16, color: '#ce93d8', text: `${e.actor} 受【${e.statusName}】影响，无法行动` }
      case 'heal':
        return { indent: 22, color: '#81d4fa', text: `${e.actor} 受【${e.skillName}】治疗 +${e.value}` }
      case 'buff_add': {
        const sign = e.value > 0 ? '+' : ''
        const attrName = { atk:'武力', def:'统率', int:'智力', spd:'速度' }[e.attr] || e.attr
        return { indent: 22, color: '#a5d6a7', text: `${e.actor} 受【${e.skillName}】增益 ${attrName}${sign}${e.value}%（${e.duration}回合）` }
      }
      case 'debuff_add': {
        const attrName = { atk:'武力', def:'统率', int:'智力', spd:'速度' }[e.attr] || e.attr
        return { indent: 22, color: '#ef9a9a', text: `${e.actor} 受【${e.skillName}】减益 ${attrName}${e.value}%（${e.duration}回合）` }
      }
      case 'lifesteal':
        return { indent: 22, color: '#ef9a9a', text: `${e.actor} 吸血 +${e.value}` }
      case 'condition_met':
        return { indent: 22, color: '#ff8a65', text: `${e.actor} 触发【残血爆发】倍率 ×${e.conditionMult}` }
      case 'damage': {
        // 克制标注（×1.25 克制 / ×0.85 被克）；战力值已含倍率/克制/浮动
        const counterNote = Math.abs((e.counter ?? 1) - 1) > 0.001 ? (e.counter > 1 ? ' 克制' : ' 被克') : ''
        // 标出该次伤害来自「普攻」还是某个战法，避免同一武将的战法伤害与普攻伤害看不出区别
        const src = e.skill === 'normal_attack' ? '普攻' : (e.skillName || '战法')
        // 防御显示目标「防御属性」（恒定值），不再是随兵力缩水的防御战力（旧档 defPow 兜底）
        const defShown = e.defStat ?? e.defPow ?? 0
        return { indent: 22, color: mine ? good : bad,
          text: `[${src}] ${e.actor}→${e.target} 战力${Math.round(e.atkPow)} vs 防御${Math.round(defShown)} ×${e.ratio.toFixed(2)}${counterNote} → -${e.value}${e.targetLeft <= 0 ? '（阵亡）' : ''}` }
      }
      default:
        return null   // round/action/normal_attack/death/status_remove 不单独成行
    }
  }

  _openBattleReport(report) {
    const isV2 = report.v === 2
    const battles = report.battles || []
    const mode = this._reportMode || 'simple'   // 'simple' | 'full'
    const { rows, height: contentH } = isV2
      ? this._layoutBattleRowsV2(report, mode)
      : this._layoutBattleRows(battles, mode)
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
      const guardRoster = isV2
        ? ((report.foe || []).map(u => `${TROOP_TYPES[u.troopType]?.icon || ''}${u.name}Lv.${u.lv}`).join('、') || '空虚守军')
        : (battles.length
          ? battles.map(b => `${TROOP_TYPES[b.enemy.troopType]?.icon || ''}${b.enemy.name}Lv.${b.enemy.lv}`).join('、')
          : '空虚守军')
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
