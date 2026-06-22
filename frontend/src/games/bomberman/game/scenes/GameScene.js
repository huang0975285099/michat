import Phaser from 'phaser'
import { generateMap } from '../MapGenerator.js'
import {
  TILE, COLS, ROWS, CANVAS_W,
  PLAYER_SPEED, BOMB_FUSE_MS, EXPLOSION_MS,
  DEFAULT_RANGE, DEFAULT_MAX_BOMBS, BROADCAST_MS,
  TILE_EMPTY, TILE_HARD, TILE_SOFT,
  PU_FIRE, PU_BOMB, PU_SPEED,
  COL_FLOOR, COL_FLOOR2, COL_HARD, COL_HARD2,
  COL_SOFT, COL_SOFT2, COL_BOMB, COL_FUSE, COL_FIRE, COL_FIRE2,
  COL_P1, COL_P2, COL_PU_FIRE, COL_PU_BOMB, COL_PU_SPEED,
} from '../GameConstants.js'

const GAME_SECS = 180
const HITBOX = 15  // half-size of player hitbox in px

export default class GameScene extends Phaser.Scene {
  constructor() { super({ key: 'GameScene' }) }

  init(data) {
    this.isHost     = data.isHost
    this.seed       = data.seed
    this.gameNet    = data.gameNet
    this.onGameEnd  = data.onGameEnd
  }

  create() {
    this.map        = generateMap(this.seed)
    this.wallGfx    = {}   // 'col,row' → Graphics
    this.bombs      = []
    this.explosions = []   // { gfx, col, row }
    this.powerups   = {}   // 'col,row' → { type, gfx }
    this.gameOver   = false
    this.lastBcast  = 0

    this._drawFloor()
    this._drawWalls()

    const p1Tile = { col: 1, row: 1 }
    const p2Tile = { col: 13, row: 11 }
    const localTile  = this.isHost ? p1Tile : p2Tile
    const remoteTile = this.isHost ? p2Tile : p1Tile
    const localCol   = this.isHost ? COL_P1 : COL_P2
    const remoteCol  = this.isHost ? COL_P2 : COL_P1

    this.local  = this._makePlayer(localTile,  localCol)
    this.remote = this._makePlayer(remoteTile, remoteCol)
    this.remoteTarget = null

    this._setupInput()
    this._setupTouchControl()
    this._setupHUD()
    this._setupNetwork()
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  _drawFloor() {
    const g = this.add.graphics()
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const x = col * TILE, y = row * TILE
        const shade = (col + row) % 2 === 0 ? COL_FLOOR : COL_FLOOR2
        g.fillStyle(shade)
        g.fillRect(x, y, TILE, TILE)
      }
    }
    g.setDepth(0)
  }

  _drawWalls() {
    const staticGfx = this.add.graphics().setDepth(1)
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        if (this.map[row][col] !== TILE_HARD) continue
        const x = col * TILE, y = row * TILE
        staticGfx.fillStyle(COL_HARD)
        staticGfx.fillRect(x, y, TILE, TILE)
        staticGfx.fillStyle(COL_HARD2)
        staticGfx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4)
        staticGfx.fillStyle(0x555555)
        staticGfx.fillRect(x + 4, y + 4, TILE - 8, TILE - 8)
      }
    }
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        if (this.map[row][col] !== TILE_SOFT) continue
        this._drawSoftWall(col, row)
      }
    }
  }

  _drawSoftWall(col, row) {
    const x = col * TILE, y = row * TILE
    const g = this.add.graphics().setDepth(2)
    g.fillStyle(COL_SOFT)
    g.fillRect(x, y, TILE, TILE)
    g.fillStyle(COL_SOFT2)
    g.fillRect(x + 3, y + 3, TILE - 6, TILE - 6)
    // brick lines
    g.lineStyle(1, 0x5a2a0a, 0.7)
    g.strokeRect(x + 3, y + 3, TILE - 6, TILE - 6)
    this.wallGfx[`${col},${row}`] = g
  }

  _drawPowerup(col, row, type) {
    const x = col * TILE + TILE / 2, y = row * TILE + TILE / 2
    const g = this.add.graphics().setDepth(3)
    const color = type === PU_FIRE ? COL_PU_FIRE : type === PU_BOMB ? COL_PU_BOMB : COL_PU_SPEED
    g.fillStyle(color)
    g.fillCircle(x, y, 10)
    const label = type === PU_FIRE ? '🔥' : type === PU_BOMB ? '💣' : '👟'
    const txt = this.add.text(x, y, label, { fontSize: '14px' }).setOrigin(0.5).setDepth(4)
    this.powerups[`${col},${row}`] = { type, gfx: g, txt }
  }

  // ── Player ───────────────────────────────────────────────────────────────

  _makePlayer(tile, color) {
    const x = tile.col * TILE + TILE / 2
    const y = tile.row * TILE + TILE / 2

    const body = this.add.graphics()
    body.fillStyle(color)
    body.fillCircle(0, 0, 17)
    body.fillStyle(0xffd0a0)
    body.fillCircle(0, 1, 11)
    body.fillStyle(0x000000)
    body.fillCircle(-5, -3, 3)
    body.fillCircle(5, -3, 3)
    body.fillStyle(0xffffff)
    body.fillCircle(-4, -4, 2)
    body.fillCircle(4, -4, 2)

    const cont = this.add.container(x, y, [body]).setDepth(10)

    return {
      cont, x, y,
      col: tile.col, row: tile.row,
      color,
      range: DEFAULT_RANGE,
      maxBombs: DEFAULT_MAX_BOMBS,
      activeBombs: 0,
      speed: PLAYER_SPEED,
      alive: true,
      vx: 0, vy: 0,
    }
  }

  // ── Input ────────────────────────────────────────────────────────────────

  _setupInput() {
    this.cursors = this.input.keyboard.createCursorKeys()
    this.keys = this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      bomb:  Phaser.Input.Keyboard.KeyCodes.SPACE,
    })
  }

  // 触摸输入：Vue 层虚拟摇杆通过 game.events 传入方向与放炸弹指令
  _setupTouchControl() {
    this.touchDir = { x: 0, y: 0 }
    this._bombQueued = false
    const g = this.game.events
    this._onVMove = (d) => { this.touchDir.x = d.x; this.touchDir.y = d.y }
    this._onVBomb = () => { this._bombQueued = true }
    g.on('vjoy-move', this._onVMove)
    g.on('vjoy-bomb', this._onVBomb)
    this.events.once('shutdown', () => {
      g.off('vjoy-move', this._onVMove)
      g.off('vjoy-bomb', this._onVBomb)
    })
  }

  // ── HUD ──────────────────────────────────────────────────────────────────

  _setupHUD() {
    const hy = ROWS * TILE
    const hudBg = this.add.graphics().setDepth(20)
    hudBg.fillStyle(0x1a1a2e)
    hudBg.fillRect(0, hy, CANVAS_W, 52)

    const p1Color = this.isHost ? '#ff3333' : '#3399ff'
    const p2Color = this.isHost ? '#3399ff' : '#ff3333'

    this.add.text(12, hy + 10, '● 你', { fontSize: '15px', color: p1Color }).setDepth(21)
    this.add.text(CANVAS_W - 12, hy + 10, '对手 ●', { fontSize: '15px', color: p2Color })
      .setOrigin(1, 0).setDepth(21)

    this.remainSecs = GAME_SECS
    this.timerTxt = this.add.text(CANVAS_W / 2, hy + 8, '3:00', {
      fontSize: '22px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(21)

    this.time.addEvent({
      delay: 1000,
      callback: this._tick,
      callbackScope: this,
      repeat: GAME_SECS - 1,
    })
  }

  _tick() {
    this.remainSecs--
    const m = Math.floor(this.remainSecs / 60)
    const s = String(this.remainSecs % 60).padStart(2, '0')
    this.timerTxt.setText(`${m}:${s}`)
    if (this.timerTxt && this.remainSecs <= 10) this.timerTxt.setColor('#ff4444')
    if (this.remainSecs <= 0) this._endGame('draw')
  }

  // ── Network ──────────────────────────────────────────────────────────────

  _setupNetwork() {
    this.gameNet.on('game_move', ({ x, y }) => {
      this.remoteTarget = { x, y }
    })
    this.gameNet.on('game_bomb', ({ col, row, ts, range }) => {
      const remaining = BOMB_FUSE_MS - (Date.now() - ts)
      // 爆炸范围由放置方决定（随其道具变化），对端不再依赖本地的 remote.range
      if (remaining > 200) this._placeBomb(this.remote, col, row, remaining, range)
    })
    this.gameNet.on('game_death', () => {
      this._killPlayer(this.remote)
      this._endGame('win')
    })
    this.gameNet.on('game_resign', () => {
      this._endGame('win')
    })
    this.gameNet.on('game_powerup', ({ col, row }) => {
      this._collectPowerup(`${col},${row}`)
    })
  }

  // ── Main Loop ────────────────────────────────────────────────────────────

  update(time, delta) {
    if (this.gameOver) return
    this._handleInput(delta)
    this._interpolateRemote(delta)
    if (time - this.lastBcast > BROADCAST_MS) {
      if (this.local.vx !== 0 || this.local.vy !== 0) {
        this.gameNet.send('game_move', { x: this.local.x, y: this.local.y })
      }
      this.lastBcast = time
    }
  }

  _interpolateRemote(delta) {
    if (!this.remoteTarget || !this.remote.alive) return
    const f = 1 - Math.pow(0.001, delta / 1000)
    this.remote.x = Phaser.Math.Linear(this.remote.x, this.remoteTarget.x, f)
    this.remote.y = Phaser.Math.Linear(this.remote.y, this.remoteTarget.y, f)
    this.remote.cont.setPosition(this.remote.x, this.remote.y)
  }

  _handleInput(delta) {
    if (!this.local.alive) return

    const dt = delta / 1000
    const spd = this.local.speed

    let vx = 0, vy = 0
    if (this.cursors.left.isDown  || this.keys.left.isDown)  vx = -spd
    else if (this.cursors.right.isDown || this.keys.right.isDown) vx = spd
    else if (this.cursors.up.isDown   || this.keys.up.isDown)   vy = -spd
    else if (this.cursors.down.isDown || this.keys.down.isDown)  vy = spd

    // 无键盘输入时用虚拟摇杆方向（取主轴，4 向移动；带死区）
    if (vx === 0 && vy === 0) {
      const { x: tx, y: ty } = this.touchDir
      if (Math.abs(tx) > 8 || Math.abs(ty) > 8) {
        if (Math.abs(tx) >= Math.abs(ty)) vx = Math.sign(tx) * spd
        else vy = Math.sign(ty) * spd
      }
    }

    this.local.vx = vx
    this.local.vy = vy

    if (vx !== 0) {
      const nx = this.local.x + vx * dt
      if (this._passable(nx, this.local.y)) this.local.x = nx
    }
    if (vy !== 0) {
      const ny = this.local.y + vy * dt
      if (this._passable(this.local.x, ny)) this.local.y = ny
    }

    this.local.col = Math.floor(this.local.x / TILE)
    this.local.row = Math.floor(this.local.y / TILE)
    this.local.cont.setPosition(this.local.x, this.local.y)

    // 玩家 hitbox 完全离开某炸弹格后，该炸弹对其恢复为实体障碍
    for (const b of this.bombs) {
      if (!b.passLocal) continue
      const bx = b.col * TILE, by = b.row * TILE
      const noOverlap =
        this.local.x + HITBOX <= bx || this.local.x - HITBOX >= bx + TILE ||
        this.local.y + HITBOX <= by || this.local.y - HITBOX >= by + TILE
      if (noOverlap) b.passLocal = false
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.bomb) ||
        Phaser.Input.Keyboard.JustDown(this.cursors.space) ||
        this._bombQueued) {
      this._tryPlaceBomb()
      this._bombQueued = false
    }

    this._checkExplosion(this.local, true)
    this._checkPowerup(this.local, true)
  }

  _passable(x, y) {
    const corners = [
      [x - HITBOX, y - HITBOX],
      [x + HITBOX, y - HITBOX],
      [x - HITBOX, y + HITBOX],
      [x + HITBOX, y + HITBOX],
    ]
    for (const [cx, cy] of corners) {
      const col = Math.floor(cx / TILE)
      const row = Math.floor(cy / TILE)
      if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false
      const t = this.map[row][col]
      if (t === TILE_HARD || t === TILE_SOFT) return false
      // passLocal 的炸弹（本地玩家刚放、尚未走出）不阻挡
      if (this.bombs.some(b => b.col === col && b.row === row && !b.passLocal)) return false
    }
    return true
  }

  // ── Bomb ─────────────────────────────────────────────────────────────────

  _tryPlaceBomb() {
    const p = this.local
    if (p.activeBombs >= p.maxBombs) return
    const col = Math.floor(p.x / TILE)
    const row = Math.floor(p.y / TILE)
    if (this.bombs.some(b => b.col === col && b.row === row)) return

    this._placeBomb(p, col, row, BOMB_FUSE_MS)
    this.gameNet.send('game_bomb', { col, row, ts: Date.now(), range: p.range })
  }

  _placeBomb(owner, col, row, fuseMs, rangeOverride) {
    const cx = col * TILE + TILE / 2
    const cy = row * TILE + TILE / 2

    const g = this.add.graphics().setDepth(6)
    g.fillStyle(COL_BOMB)
    g.fillCircle(cx, cy, 16)
    g.fillStyle(COL_FUSE)
    g.fillRect(cx - 2, cy - 24, 4, 10)
    g.fillCircle(cx, cy - 24, 4)

    // passLocal: 放炸弹时本地玩家正站在格子上，允许其穿过直到完全离开（经典炸弹人手感）
    const bombRange = rangeOverride != null ? rangeOverride : owner.range
    const bomb = { col, row, owner, range: bombRange, gfx: g, passLocal: owner === this.local }
    owner.activeBombs++
    this.bombs.push(bomb)

    // Pulse tween
    this.tweens.add({
      targets: g, alpha: 0.6, duration: fuseMs / 6,
      yoyo: true, repeat: 2, ease: 'Sine.easeInOut',
    })

    bomb.timer = this.time.delayedCall(fuseMs, () => this._explode(bomb))
  }

  _explode(bomb) {
    const idx = this.bombs.indexOf(bomb)
    if (idx === -1) return
    this.bombs.splice(idx, 1)
    bomb.owner.activeBombs = Math.max(0, bomb.owner.activeBombs - 1)
    bomb.gfx.destroy()

    const cells = [{ col: bomb.col, row: bomb.row }]
    const dirs = [[0,-1],[0,1],[-1,0],[1,0]]

    for (const [dc, dr] of dirs) {
      for (let i = 1; i <= bomb.range; i++) {
        const c = bomb.col + dc * i, r = bomb.row + dr * i
        if (c < 0 || c >= COLS || r < 0 || r >= ROWS) break
        const tile = this.map[r][c]
        if (tile === TILE_HARD) break
        cells.push({ col: c, row: r })
        if (tile === TILE_SOFT) {
          this._destroyWall(c, r)
          break
        }
      }
    }

    for (const { col, row } of cells) {
      this._spawnExplosion(col, row)
    }

    // chain: explode any bomb caught in fire
    for (const { col, row } of cells) {
      const chain = this.bombs.find(b => b.col === col && b.row === row)
      if (chain) {
        chain.timer.remove()
        this._explode(chain)
      }
    }

    // player hit check happens in update via _checkExplosion
  }

  _spawnExplosion(col, row) {
    const x = col * TILE, y = row * TILE
    const g = this.add.graphics().setDepth(8)
    g.fillStyle(COL_FIRE2, 0.9)
    g.fillRect(x + 2, y + 2, TILE - 4, TILE - 4)
    g.fillStyle(COL_FIRE, 0.7)
    g.fillRect(x + 6, y + 6, TILE - 12, TILE - 12)

    const entry = { gfx: g, col, row }
    this.explosions.push(entry)

    this.time.delayedCall(EXPLOSION_MS, () => {
      const i = this.explosions.indexOf(entry)
      if (i !== -1) this.explosions.splice(i, 1)
      g.destroy()
    })
  }

  _destroyWall(col, row) {
    this.map[row][col] = TILE_EMPTY
    const key = `${col},${row}`
    if (this.wallGfx[key]) {
      this.wallGfx[key].destroy()
      delete this.wallGfx[key]
    }
    // 确定性掉落：基于 seed + 格子坐标，两端结果一致，无需网络同步道具的生成
    const drop = this._rollPowerup(col, row)
    if (drop) this._drawPowerup(col, row, drop)
  }

  // 返回掉落的道具类型，或 null（不掉落）。同 seed + 同坐标恒定返回相同结果。
  _rollPowerup(col, row) {
    let h = (this.seed + col * 374761393 + row * 668265263) >>> 0
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
    const r = h / 4294967296
    if (r >= 0.25) return null // 25% 掉落概率
    const types = [PU_FIRE, PU_BOMB, PU_SPEED]
    return types[h % 3]
  }

  // ── Hit detection ────────────────────────────────────────────────────────

  _checkExplosion(player, isLocal) {
    if (!player.alive) return
    const col = Math.floor(player.x / TILE)
    const row = Math.floor(player.y / TILE)
    if (!this.explosions.some(e => e.col === col && e.row === row)) return

    this._killPlayer(player)
    if (isLocal) {
      this.gameNet.send('game_death', {})
      this._endGame('lose')
    }
  }

  _checkPowerup(player, isLocal) {
    if (!player.alive) return
    const col = Math.floor(player.x / TILE)
    const row = Math.floor(player.y / TILE)
    const key = `${col},${row}`
    if (!this.powerups[key]) return

    const { type } = this.powerups[key]
    this._applyPowerup(player, type)
    this._collectPowerup(key)
    if (isLocal) this.gameNet.send('game_powerup', { col, row })
  }

  _collectPowerup(key) {
    const pu = this.powerups[key]
    if (!pu) return
    pu.gfx.destroy()
    pu.txt?.destroy()
    delete this.powerups[key]
  }

  _applyPowerup(player, type) {
    if (type === PU_FIRE)  player.range    = Math.min(6, player.range + 1)
    if (type === PU_BOMB)  player.maxBombs = Math.min(5, player.maxBombs + 1)
    if (type === PU_SPEED) player.speed    = Math.min(240, player.speed + 30)
  }

  _killPlayer(player) {
    player.alive = false
    this.tweens.add({
      targets: player.cont,
      alpha: 0, scaleX: 2.5, scaleY: 2.5,
      duration: 400, ease: 'Power2',
    })
  }

  // ── Game end ─────────────────────────────────────────────────────────────

  _endGame(result) {
    if (this.gameOver) return
    this.gameOver = true

    const cx = CANVAS_W / 2, cy = (ROWS * TILE) / 2

    const overlay = this.add.graphics().setDepth(30)
    overlay.fillStyle(0x000000, 0.65)
    overlay.fillRect(0, 0, CANVAS_W, ROWS * TILE)

    const msgs   = { win: '胜利!', lose: '败北', draw: '平局' }
    const colors = { win: '#ffd700', lose: '#ff4444', draw: '#aaaaaa' }

    this.add.text(cx, cy - 20, msgs[result], {
      fontSize: '48px', fontStyle: 'bold',
      color: colors[result] || '#ffffff',
      stroke: '#000000', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(31)

    this.time.delayedCall(2500, () => {
      this.gameNet.destroy()
      this.onGameEnd?.(result)
    })
  }
}
