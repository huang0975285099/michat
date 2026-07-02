// 九州征途 - 大世界场景（纯渲染层）
// 只读 GameState 并订阅其事件渲染；玩家操作通过 game.events 转发给 Vue UI 层处理。
// 贴图全部运行时用 Graphics 生成（MVP 无美术资源）。

import Phaser from 'phaser'
import { MAP_W, MAP_H, TILE_SIZE, TILE_TYPES } from '../GameConstants.js'

const T = TILE_SIZE
const CLICK_TOLERANCE = 8      // px：区分点击与拖拽
const MIN_ZOOM = 0.4
const MAX_ZOOM = 2.5
const AUTOSAVE_MS = 10000

export class WorldScene extends Phaser.Scene {
  constructor() { super('World') }

  init(data) {
    this.state = data.state
  }

  create() {
    this._buildTextures()
    this._buildMap()

    // 覆盖层（绘制顺序：领地 < 行军 < 选中框）
    this.territoryG = this.add.graphics().setDepth(10)
    this.marchG = this.add.graphics().setDepth(20)
    this.selectG = this.add.graphics().setDepth(30)
    this.selected = null

    this._drawTerritory()
    this._setupCamera()
    this._setupInput()

    // 订阅逻辑层事件
    this._subs = [
      this.state.on('territory', ({ x, y }) => { this._refreshTile(x, y); this._drawTerritory() }),
      this.state.on('battle', ({ tile, win }) => this._battleFlash(tile, win)),
      this.state.on('city', () => this._drawTerritory()),
    ]
    this._saveTimer = 0

    // 相机初始定位到主城
    const { x, y } = this.state.spawn
    this.cameras.main.centerOn(x * T + T / 2, y * T + T / 2)

    // 跨场景事件（UIScene → 本场景）
    this._onCenterOn = ({ x: tx, y: ty }) => {
      this.cameras.main.pan(tx * T + T / 2, ty * T + T / 2, 300, 'Sine.easeInOut')
    }
    this._onClearSel = () => { this.selected = null; this._drawSelection() }
    this.game.events.on('center-on', this._onCenterOn)
    this.game.events.on('clear-selection', this._onClearSel)

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this._subs.forEach(off => off())
      this.game.events.off('center-on', this._onCenterOn)
      this.game.events.off('clear-selection', this._onClearSel)
      this.state.save()
    })
  }

  /** HUD 场景（用于输入命中判断，避免点击穿透到地图） */
  _ui() { return this.scene.get('UI') }

  update(_, delta) {
    this.state.tick(delta)
    this._drawMarches()
    this._saveTimer += delta
    if (this._saveTimer >= AUTOSAVE_MS) {
      this._saveTimer = 0
      this.state.save()
    }
  }

  // ── 贴图生成 ──────────────────────────────────────────────────────────────

  _buildTextures() {
    for (const [type, def] of Object.entries(TILE_TYPES)) {
      for (let lv = 1; lv <= 5; lv++) {
        const key = `t_${type}_${lv}`
        if (this.textures.exists(key)) continue
        const g = this.make.graphics({ add: false })
        this._drawTileBase(g, def.color)
        this._drawMotif(g, type)
        if (def.passable) this._drawLevelPips(g, lv)
        g.generateTexture(key, T, T)
        g.destroy()
      }
    }
    // 主城贴图
    if (!this.textures.exists('t_playerCity')) {
      const g = this.make.graphics({ add: false })
      this._drawTileBase(g, 0xd4a017)
      g.fillStyle(0x8a5a00, 1)
      g.fillRect(T * 0.2, T * 0.35, T * 0.6, T * 0.45)   // 城体
      g.fillStyle(0xffe08a, 1)
      g.fillRect(T * 0.42, T * 0.15, T * 0.16, T * 0.25) // 城楼
      g.fillStyle(0xd43a3a, 1)
      g.fillTriangle(T * 0.5, T * 0.02, T * 0.5, T * 0.16, T * 0.72, T * 0.09) // 旗
      g.generateTexture('t_playerCity', T, T)
      g.destroy()
    }
  }

  _drawTileBase(g, color) {
    g.fillStyle(color, 1)
    g.fillRect(0, 0, T, T)
    g.lineStyle(1, 0x000000, 0.18)
    g.strokeRect(0.5, 0.5, T - 1, T - 1)
  }

  _drawMotif(g, type) {
    switch (type) {
      case 'plain':
        g.fillStyle(0xffffff, 0.15)
        g.fillCircle(T * 0.3, T * 0.4, 2); g.fillCircle(T * 0.65, T * 0.6, 2)
        break
      case 'farm':
        g.lineStyle(2, 0x8a7a2a, 0.55)
        for (let i = 1; i <= 3; i++) {
          g.lineBetween(T * 0.15, T * i / 4, T * 0.85, T * i / 4)
        }
        break
      case 'forest':
        g.fillStyle(0x2f5426, 1)
        g.fillTriangle(T * 0.3, T * 0.65, T * 0.15, T * 0.85, T * 0.45, T * 0.85)
        g.fillTriangle(T * 0.62, T * 0.4, T * 0.45, T * 0.68, T * 0.79, T * 0.68)
        g.fillTriangle(T * 0.42, T * 0.22, T * 0.28, T * 0.5, T * 0.56, T * 0.5)
        break
      case 'hill':
        g.lineStyle(2, 0x7a6a4e, 0.8)
        g.beginPath()
        g.arc(T * 0.35, T * 0.65, T * 0.18, Math.PI, 0)
        g.strokePath()
        g.beginPath()
        g.arc(T * 0.68, T * 0.72, T * 0.13, Math.PI, 0)
        g.strokePath()
        break
      case 'mountain':
        g.fillStyle(0x6b625a, 1)
        g.fillTriangle(T * 0.5, T * 0.18, T * 0.2, T * 0.8, T * 0.8, T * 0.8)
        g.fillStyle(0xffffff, 0.85)
        g.fillTriangle(T * 0.5, T * 0.18, T * 0.42, T * 0.36, T * 0.58, T * 0.36)
        break
      case 'lake':
        g.lineStyle(2, 0xffffff, 0.35)
        g.beginPath(); g.arc(T * 0.35, T * 0.45, T * 0.12, Math.PI * 0.1, Math.PI * 0.9); g.strokePath()
        g.beginPath(); g.arc(T * 0.65, T * 0.65, T * 0.12, Math.PI * 0.1, Math.PI * 0.9); g.strokePath()
        break
      case 'npcCity':
        g.fillStyle(0x7a3a2a, 1)
        g.fillRect(T * 0.2, T * 0.3, T * 0.6, T * 0.5)
        g.fillStyle(0xd9a066, 1)
        g.fillRect(T * 0.28, T * 0.2, T * 0.12, T * 0.15)
        g.fillRect(T * 0.6, T * 0.2, T * 0.12, T * 0.15)
        g.fillStyle(0x3a1a12, 1)
        g.fillRect(T * 0.44, T * 0.55, T * 0.12, T * 0.25)   // 城门
        break
    }
  }

  _drawLevelPips(g, lv) {
    g.fillStyle(0xffffff, 0.9)
    for (let i = 0; i < lv; i++) {
      g.fillCircle(T - 6 - i * 7, T - 6, 2.4)
    }
  }

  // ── 地图铺设 ──────────────────────────────────────────────────────────────

  _buildMap() {
    this.tileImages = []
    for (let y = 0; y < MAP_H; y++) {
      const row = []
      for (let x = 0; x < MAP_W; x++) {
        const img = this.add.image(x * T, y * T, this._texKey(this.state.tiles[y][x]))
          .setOrigin(0, 0)
        row.push(img)
      }
      this.tileImages.push(row)
    }
  }

  _texKey(tile) {
    if (tile.isCity) return 't_playerCity'
    return `t_${tile.type}_${tile.level}`
  }

  _refreshTile(x, y) {
    this.tileImages[y][x].setTexture(this._texKey(this.state.tiles[y][x]))
  }

  // ── 覆盖层绘制 ────────────────────────────────────────────────────────────

  _drawTerritory() {
    const g = this.territoryG
    g.clear()
    for (const t of this.state.ownedTiles()) {
      g.fillStyle(0xffd700, t.isCity ? 0 : 0.14)
      g.fillRect(t.x * T, t.y * T, T, T)
      g.lineStyle(2, 0xffd700, 0.9)
      g.strokeRect(t.x * T + 1, t.y * T + 1, T - 2, T - 2)
    }
  }

  _drawMarches() {
    const g = this.marchG
    g.clear()
    const c = (n) => n * T + T / 2
    for (const m of this.state.marches) {
      const back = m.phase === 'back'
      // path 为 出程方向（from→to）的格子序列；回程反向遍历
      const cells = back ? [...m.path].reverse() : m.path
      if (!cells || cells.length === 0) continue
      const color = back ? 0x9ecbff : 0xff6b4a

      // 折线路径
      g.lineStyle(2, color, 0.8)
      g.beginPath()
      g.moveTo(c(cells[0].x), c(cells[0].y))
      for (let i = 1; i < cells.length; i++) g.lineTo(c(cells[i].x), c(cells[i].y))
      g.strokePath()

      // 沿路径按进度定位光点（按格均分时间）
      const p = Phaser.Math.Clamp(
        (this.state.now - m.departAt) / Math.max(m.arriveAt - m.departAt, 0.001), 0, 1)
      const seg = cells.length - 1
      const { px, py } = this._pointAlong(cells, p, seg, c)
      g.fillStyle(color, 1)
      g.fillCircle(px, py, 6)
      g.fillStyle(0xffffff, 1)
      g.fillCircle(px, py, 2.5)
    }
  }

  /** 沿格子序列按进度 p∈[0,1] 求插值点（每格等时） */
  _pointAlong(cells, p, seg, c) {
    if (seg <= 0) return { px: c(cells[0].x), py: c(cells[0].y) }
    const f = p * seg
    const i = Math.min(Math.floor(f), seg - 1)
    const t = f - i
    const a = cells[i], b = cells[i + 1]
    return { px: c(a.x) + (c(b.x) - c(a.x)) * t, py: c(a.y) + (c(b.y) - c(a.y)) * t }
  }

  _drawSelection() {
    const g = this.selectG
    g.clear()
    if (!this.selected) return
    const { x, y } = this.selected
    g.lineStyle(3, 0xffffff, 1)
    g.strokeRect(x * T + 2, y * T + 2, T - 4, T - 4)
  }

  _battleFlash(tile, win) {
    const r = this.add.rectangle(
      tile.x * T + T / 2, tile.y * T + T / 2, T, T,
      win ? 0xffd700 : 0xff3030, 0.75,
    ).setDepth(40)
    this.tweens.add({
      targets: r, alpha: 0, scale: 1.6, duration: 600,
      onComplete: () => r.destroy(),
    })
  }

  // ── 相机与输入 ────────────────────────────────────────────────────────────

  _setupCamera() {
    const cam = this.cameras.main
    cam.setBounds(-T * 2, -T * 2, MAP_W * T + T * 4, MAP_H * T + T * 4)
    cam.setZoom(1)
  }

  _setupInput() {
    const cam = this.cameras.main
    let down = null           // { x, y, camX, camY }
    let pinchDist = 0

    this.input.addPointer(1)  // 支持双指

    this.input.on('pointerdown', (p) => {
      if (this._ui()?.hitTest(p.x, p.y)) { down = null; return }
      if (this.input.pointer1.isDown && this.input.pointer2.isDown) {
        pinchDist = Phaser.Math.Distance.Between(
          this.input.pointer1.x, this.input.pointer1.y,
          this.input.pointer2.x, this.input.pointer2.y)
        down = null
        return
      }
      down = { x: p.x, y: p.y, camX: cam.scrollX, camY: cam.scrollY }
    })

    this.input.on('pointermove', (p) => {
      if (this._ui()?.modalOpen) return
      // 双指缩放
      if (this.input.pointer1.isDown && this.input.pointer2.isDown) {
        const d = Phaser.Math.Distance.Between(
          this.input.pointer1.x, this.input.pointer1.y,
          this.input.pointer2.x, this.input.pointer2.y)
        if (pinchDist > 0) {
          cam.setZoom(Phaser.Math.Clamp(cam.zoom * (d / pinchDist), MIN_ZOOM, MAX_ZOOM))
        }
        pinchDist = d
        return
      }
      // 单指/鼠标拖拽平移
      if (down && p.isDown) {
        cam.scrollX = down.camX - (p.x - down.x) / cam.zoom
        cam.scrollY = down.camY - (p.y - down.y) / cam.zoom
      }
    })

    this.input.on('pointerup', (p) => {
      if (!down) return
      const moved = Phaser.Math.Distance.Between(p.x, p.y, down.x, down.y)
      down = null
      if (moved > CLICK_TOLERANCE) return
      if (this._ui()?.hitTest(p.x, p.y)) return
      // 点击：换算成地块坐标
      const wp = cam.getWorldPoint(p.x, p.y)
      const tx = Math.floor(wp.x / T)
      const ty = Math.floor(wp.y / T)
      const tile = this.state.tileAt(tx, ty)
      if (!tile) { this.selected = null; this._drawSelection(); return }
      this.selected = { x: tx, y: ty }
      this._drawSelection()
      this.game.events.emit('tile-selected', { x: tx, y: ty })
    })

    // 滚轮缩放
    this.input.on('wheel', (p, _o, _dx, dy) => {
      if (this._ui()?.hitTest(p.x, p.y)) return
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM))
    })
  }
}
