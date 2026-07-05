// 九州征途 - 大世界场景（纯渲染层）
// 只读 GameState 并订阅其事件渲染；玩家操作通过 game.events 转发给 Vue UI 层处理。
// 贴图全部运行时用 Graphics 生成（MVP 无美术资源）。

import Phaser from 'phaser'
import { MAP_W, MAP_H, TILE_SIZE, TILE_TYPES, TILE_MAX_LEVEL } from '../GameConstants.js'

const T = TILE_SIZE
const CLICK_TOLERANCE = 8      // px：区分点击与拖拽
const MIN_ZOOM = 0.4
const MAX_ZOOM = 2.5
const AUTOSAVE_MS = 10000
const LEVEL_FONT = "'Segoe UI', 'Microsoft YaHei', sans-serif"

// 等级徽章底色：低级绿→高级红，一眼区分强弱地块
function levelBadgeColor(lv) {
  if (lv <= 2) return 0x4caf50
  if (lv <= 4) return 0x9ccc65
  if (lv <= 6) return 0xffca28
  if (lv <= 8) return 0xff7043
  return 0xe53935
}

// 颜色调亮/调暗工具（factor<1 变暗，>1 变亮），用于地块与面板的渐变立体感
function shade(color, factor) {
  const r = Math.min(255, Math.max(0, Math.floor(((color >> 16) & 0xff) * factor)))
  const g = Math.min(255, Math.max(0, Math.floor(((color >> 8) & 0xff) * factor)))
  const b = Math.min(255, Math.max(0, Math.floor((color & 0xff) * factor)))
  return (r << 16) | (g << 8) | b
}

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
      this.state.on('battle', ({ tile, outcome }) => this._battleFlash(tile, outcome)),
      this.state.on('city', () => this._drawTerritory()),
    ]
    this._saveTimer = 0

    // 标签页隐藏/窗口失焦时浏览器会暂停 rAF，update() 不再被调用，资源会停止增长；
    // 这里监听可见性/焦点恢复事件，按真实经过时长补一次产出（见 GameState.catchUp）
    this._lastRealMs = Date.now()
    this._onVisibilityRestore = () => {
      const now = Date.now()
      if (document.visibilityState === 'visible') {
        this.state.catchUp(now - this._lastRealMs)
      }
      this._lastRealMs = now
    }
    document.addEventListener('visibilitychange', this._onVisibilityRestore)
    window.addEventListener('focus', this._onVisibilityRestore)

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
      document.removeEventListener('visibilitychange', this._onVisibilityRestore)
      window.removeEventListener('focus', this._onVisibilityRestore)
      this.state.save()
    })
  }

  /** HUD 场景（用于输入命中判断，避免点击穿透到地图） */
  _ui() { return this.scene.get('UI') }

  update(_, delta) {
    this._lastRealMs = Date.now()
    this.state.tick(delta)
    this._drawMarches()
    this._drawSelection()   // 每帧重画，实现选中框脉冲发光
    this._saveTimer += delta
    if (this._saveTimer >= AUTOSAVE_MS) {
      this._saveTimer = 0
      this.state.save()
    }
  }

  // ── 贴图生成 ──────────────────────────────────────────────────────────────

  _buildTextures() {
    for (const [type, def] of Object.entries(TILE_TYPES)) {
      for (let lv = 1; lv <= TILE_MAX_LEVEL; lv++) {
        const key = `t_${type}_${lv}`
        if (this.textures.exists(key)) continue
        const g = this.make.graphics({ add: false })
        this._drawTileBase(g, def.color)
        this._drawMotif(g, type)
        // 注意：必须走 RenderTexture 烘焙，Graphics.generateTexture() 在 WebGL 下会漏渲染
        // fillGradientStyle 填充（纯色 fillStyle/lineStyle 不受影响），直接生成会导致地块显示透明。
        this._bakeTileTexture(key, g, def.passable ? lv : null)
      }
    }
    // 主城贴图
    if (!this.textures.exists('t_playerCity')) {
      const g = this.make.graphics({ add: false })
      this._drawTileBase(g, 0xd4a017)
      // 投影底座
      g.fillStyle(0x000000, 0.35)
      g.fillEllipse(T * 0.5, T * 0.84, T * 0.72, T * 0.16)
      // 城墙（上亮下暗渐变）
      g.fillGradientStyle(0xa8741e, 0xa8741e, 0x6e4a00, 0x6e4a00)
      g.fillRect(T * 0.2, T * 0.35, T * 0.6, T * 0.45)
      // 城垛
      g.fillStyle(0x5a3800, 1)
      g.fillRect(T * 0.2, T * 0.3, T * 0.12, T * 0.08)
      g.fillRect(T * 0.44, T * 0.3, T * 0.12, T * 0.08)
      g.fillRect(T * 0.68, T * 0.3, T * 0.12, T * 0.08)
      // 城楼
      g.fillGradientStyle(0xffe08a, 0xffe08a, 0xc89540, 0xc89540)
      g.fillRect(T * 0.42, T * 0.15, T * 0.16, T * 0.2)
      // 城楼顶高光
      g.fillStyle(0xfff5c0, 0.7)
      g.fillRect(T * 0.42, T * 0.15, T * 0.16, T * 0.04)
      // 旗杆与旗帜
      g.lineStyle(1.5, 0x3a2a1a, 1)
      g.lineBetween(T * 0.5, T * 0.02, T * 0.5, T * 0.16)
      g.fillStyle(0xd43a3a, 1)
      g.fillTriangle(T * 0.5, T * 0.03, T * 0.5, T * 0.13, T * 0.72, T * 0.08)
      this._bakeTileTexture('t_playerCity', g, null)
    }
  }

  _drawTileBase(g, color) {
    const dark = shade(color, 0.82)
    const light = shade(color, 1.18)
    // 上亮下暗渐变，模拟顶光（底部仅轻微压暗，保证整体明亮可读）
    g.fillGradientStyle(color, color, dark, dark)
    g.fillRect(0, 0, T, T)
    // 顶部/左侧内高光
    g.lineStyle(1, light, 0.55)
    g.lineBetween(1, 1, T - 1, 1)
    g.lineBetween(1, 1, 1, T - 1)
    // 外边缘暗线（比早期版本加深，让格子边界更清晰、地貌不糊成一片）
    g.lineStyle(1, 0x000000, 0.32)
    g.strokeRect(0.5, 0.5, T - 1, T - 1)
  }

  _drawMotif(g, type) {
    switch (type) {
      case 'plain':
        // 草丛暗底 + 亮尖
        g.fillStyle(0xffffff, 0.1)
        g.fillCircle(T * 0.3, T * 0.4, 3); g.fillCircle(T * 0.65, T * 0.6, 3)
        g.fillStyle(0xffffff, 0.25)
        g.fillTriangle(T * 0.28, T * 0.42, T * 0.3, T * 0.34, T * 0.33, T * 0.42)
        g.fillTriangle(T * 0.63, T * 0.62, T * 0.65, T * 0.54, T * 0.68, T * 0.62)
        break
      case 'farm':
        // 垄沟暗线 + 亮线模拟起伏
        for (let i = 1; i <= 3; i++) {
          const y = T * i / 4
          g.lineStyle(2, 0x5a4a1a, 0.6)
          g.lineBetween(T * 0.15, y + 1, T * 0.85, y + 1)
          g.lineStyle(1.5, 0xc8a838, 0.5)
          g.lineBetween(T * 0.15, y - 1, T * 0.85, y - 1)
        }
        break
      case 'forest': {
        // 树冠：投影 + 暗底 + 亮顶 + 高光
        const trees = [
          { cx: T * 0.3, cy: T * 0.75, r: T * 0.15 },
          { cx: T * 0.62, cy: T * 0.58, r: T * 0.17 },
          { cx: T * 0.42, cy: T * 0.4, r: T * 0.13 },
        ]
        for (const t of trees) {
          g.fillStyle(0x000000, 0.25)
          g.fillEllipse(t.cx, t.cy + t.r * 0.7, t.r * 1.8, t.r * 0.5)
          g.fillStyle(0x1f3a18, 1)
          g.fillCircle(t.cx, t.cy, t.r)
          g.fillStyle(0x4a7a35, 1)
          g.fillCircle(t.cx - t.r * 0.25, t.cy - t.r * 0.25, t.r * 0.7)
          g.fillStyle(0x7aa84f, 0.6)
          g.fillCircle(t.cx - t.r * 0.35, t.cy - t.r * 0.4, t.r * 0.3)
        }
        break
      }
      case 'hill':
        // 等高线 + 下半圆阴影
        g.lineStyle(2, 0x6a5a3e, 0.9)
        g.beginPath(); g.arc(T * 0.35, T * 0.65, T * 0.18, Math.PI, 0); g.strokePath()
        g.beginPath(); g.arc(T * 0.68, T * 0.72, T * 0.13, Math.PI, 0); g.strokePath()
        g.fillStyle(0x000000, 0.18)
        g.beginPath(); g.arc(T * 0.35, T * 0.65, T * 0.18, 0, Math.PI); g.fillPath()
        g.beginPath(); g.arc(T * 0.68, T * 0.72, T * 0.13, 0, Math.PI); g.fillPath()
        break
      case 'mountain':
        // 山体明暗面 + 雪顶 + 轮廓线（避免与灰绿底色糊在一起）
        g.fillStyle(0x3a332c, 1)
        g.fillTriangle(T * 0.5, T * 0.18, T * 0.2, T * 0.8, T * 0.5, T * 0.8)
        g.fillStyle(0x8a8078, 1)
        g.fillTriangle(T * 0.5, T * 0.18, T * 0.5, T * 0.8, T * 0.8, T * 0.8)
        g.fillStyle(0xffffff, 0.9)
        g.fillTriangle(T * 0.5, T * 0.18, T * 0.42, T * 0.36, T * 0.58, T * 0.36)
        g.lineStyle(1.2, 0x1f1a14, 0.55)
        g.beginPath()
        g.moveTo(T * 0.2, T * 0.8); g.lineTo(T * 0.5, T * 0.18); g.lineTo(T * 0.8, T * 0.8)
        g.strokePath()
        break
      case 'copper': {
        // 岩堆 + 铜矿脉高光：深色矿石块上嵌橙铜色矿点
        const rocks = [
          { cx: T * 0.34, cy: T * 0.6, r: T * 0.16 },
          { cx: T * 0.64, cy: T * 0.52, r: T * 0.13 },
        ]
        for (const rk of rocks) {
          g.fillStyle(0x000000, 0.22)
          g.fillEllipse(rk.cx, rk.cy + rk.r * 0.7, rk.r * 1.8, rk.r * 0.5)
          g.fillStyle(0x6b4a2a, 1)                       // 矿石暗底
          g.fillCircle(rk.cx, rk.cy, rk.r)
          g.fillStyle(0x9c6b34, 1)                       // 受光面
          g.fillCircle(rk.cx - rk.r * 0.25, rk.cy - rk.r * 0.25, rk.r * 0.65)
        }
        // 铜矿脉光点
        g.fillStyle(0xffb066, 0.95)
        g.fillCircle(T * 0.3, T * 0.55, 2.2)
        g.fillCircle(T * 0.4, T * 0.66, 1.6)
        g.fillCircle(T * 0.62, T * 0.5, 1.8)
        g.fillStyle(0xffe0b0, 0.9)
        g.fillCircle(T * 0.31, T * 0.53, 1)
        g.fillCircle(T * 0.61, T * 0.48, 0.9)
        break
      }
      case 'lake':
        // 水波 + 反光高光
        g.lineStyle(2, 0xffffff, 0.4)
        g.beginPath(); g.arc(T * 0.35, T * 0.45, T * 0.12, Math.PI * 0.1, Math.PI * 0.9); g.strokePath()
        g.beginPath(); g.arc(T * 0.65, T * 0.65, T * 0.12, Math.PI * 0.1, Math.PI * 0.9); g.strokePath()
        g.fillStyle(0xffffff, 0.7)
        g.fillCircle(T * 0.32, T * 0.38, 1.5)
        g.fillCircle(T * 0.62, T * 0.58, 1.5)
        break
      case 'npcCity':
        // 城墙渐变 + 城垛 + 城楼 + 城门阴影
        g.fillGradientStyle(0x8a3a2a, 0x8a3a2a, 0x5a2018, 0x5a2018)
        g.fillRect(T * 0.2, T * 0.3, T * 0.6, T * 0.5)
        g.fillStyle(0xa85040, 0.8)
        g.fillRect(T * 0.2, T * 0.3, T * 0.6, T * 0.04)
        g.fillStyle(0x6a2820, 1)
        g.fillRect(T * 0.2, T * 0.26, T * 0.1, T * 0.06)
        g.fillRect(T * 0.45, T * 0.26, T * 0.1, T * 0.06)
        g.fillRect(T * 0.7, T * 0.26, T * 0.1, T * 0.06)
        g.fillGradientStyle(0xe8b070, 0xe8b070, 0xb07840, 0xb07840)
        g.fillRect(T * 0.28, T * 0.2, T * 0.12, T * 0.12)
        g.fillRect(T * 0.6, T * 0.2, T * 0.12, T * 0.12)
        g.fillStyle(0x2a1008, 1)
        g.fillRoundedRect(T * 0.44, T * 0.55, T * 0.12, T * 0.25, 4)
        break
    }
  }

  /** 把地块底图（+ 可选右下角等级徽章）合成进最终纹理。
   *  除了徽章需要 Text（Graphics 画不了字）之外，这里也是 fillGradientStyle 的必经烘焙路径——
   *  见调用处注释，lv 传 null 时只烘焙底图不加徽章（湖泊/主城等无等级贴图）。 */
  _bakeTileTexture(key, g, lv) {
    const rt = this.make.renderTexture({ width: T, height: T }, false)
    rt.draw(g, 0, 0)
    g.destroy()

    if (lv == null) {
      rt.saveTexture(key)
      rt.destroy()
      return
    }

    const badgeW = lv >= 10 ? 20 : 15, badgeH = 14
    const bx = T - badgeW - 2, by = T - badgeH - 2
    const badgeG = this.make.graphics({ add: false })
    badgeG.fillStyle(0x000000, 0.4)
    badgeG.fillRoundedRect(bx + 1, by + 1.5, badgeW, badgeH, 4)
    badgeG.fillStyle(levelBadgeColor(lv), 1)
    badgeG.fillRoundedRect(bx, by, badgeW, badgeH, 4)
    badgeG.lineStyle(1, 0xffffff, 0.6)
    badgeG.strokeRoundedRect(bx, by, badgeW, badgeH, 4)
    rt.draw(badgeG, 0, 0)
    badgeG.destroy()

    const txt = this.make.text({
      text: String(lv),
      style: { fontFamily: LEVEL_FONT, fontSize: '11px', color: '#1a1408', fontStyle: 'bold' },
    }, false)
    txt.setOrigin(0.5)
    rt.draw(txt, bx + badgeW / 2, by + badgeH / 2)
    txt.destroy()

    rt.saveTexture(key)
    rt.destroy()
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
      // 拖尾：沿路径回溯几个递减光点
      for (let k = 1; k <= 4; k++) {
        const tp = p - k * 0.025
        if (tp <= 0) break
        const { px: tx, py: ty } = this._pointAlong(cells, tp, seg, c)
        g.fillStyle(color, (1 - k / 4) * 0.45)
        g.fillCircle(tx, ty, 5 - k)
      }
      // 外发光晕
      g.fillStyle(color, 0.35)
      g.fillCircle(px, py, 9)
      // 主光点
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
    // 脉冲：1.2 秒周期
    const t = (this.time.now % 1200) / 1200
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2)
    // 外发光环（呼吸）
    g.lineStyle(2 + pulse * 3, 0xffd700, 0.25 + pulse * 0.45)
    g.strokeRect(x * T + 0.5, y * T + 0.5, T - 1, T - 1)
    // 内框（静态亮线）
    g.lineStyle(2, 0xffffff, 0.9)
    g.strokeRect(x * T + 3, y * T + 3, T - 6, T - 6)
  }

  _battleFlash(tile, outcome) {
    const cx = tile.x * T + T / 2, cy = tile.y * T + T / 2
    const color = outcome === 'win' ? 0xffd700 : outcome === 'draw' ? 0x9e9e9e : 0xff3030
    // 中心光圈扩散
    const ring = this.add.circle(cx, cy, T * 0.3, color, 0.85).setDepth(40)
    this.tweens.add({
      targets: ring, alpha: 0, scale: 2.6, duration: 700,
      ease: 'Sine.easeOut', onComplete: () => ring.destroy(),
    })
    // 碎片飞溅
    const n = outcome === 'win' ? 10 : 7
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.3
      const shard = this.add.circle(cx, cy, 2.5, color, 1).setDepth(41)
      const dist = T * 0.5 + Math.random() * T * 0.35
      this.tweens.add({
        targets: shard,
        x: cx + Math.cos(a) * dist, y: cy + Math.sin(a) * dist,
        alpha: 0, scale: 0.3, duration: 450 + Math.random() * 250,
        ease: 'Sine.easeOut', onComplete: () => shard.destroy(),
      })
    }
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
