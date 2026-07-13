// 门派 PK · 梦幻西游风 - 战斗主场景
// 负责角色立绘（emoji 大字 + 圆角底座占位）、战斗动画演出、AI 决策调度、结算面板。
// 数据条/按钮/日志由 UIScene 渲染，坐标共享 layout.getBattleLayout。
//
// 演出流程：engine 同步跑完一回合 → BattleFeed 把事件按动画时长逐条重放 →
// 本场景收到 skill_cast 播起手、damage 播撞击/弹道命中、skill_end 收势归位。
// 因此两个场景都订阅 feed（this.feed）而不是 engine，保证血条与动画同步。
//
// 战斗结束时在此结算经验：算奖励 → 升级 → 写 localStorage 存档 → 结算面板展示。

import Phaser from 'phaser'
import { COLORS, Side, Phase, Result, SkillType, SkillCategory } from '../GameConstants.js'
import { getBattleLayout } from '../layout.js'
import { BattleFeed } from '../BattleFeed.js'
import { decideAI } from '../BattleAI.js'
import { expReward, applyExp, expToNext, LEVEL_MAX } from '../leveling.js'
import { saveCharacter } from '../save.js'
import { prepareBattle } from '../battleSetup.js'

const FONT = "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"

export class BattleScene extends Phaser.Scene {
  constructor() { super('Battle') }

  create() {
    this.engine = this.game.registry.get('menpai-engine')
    this.playerFaction = this.game.registry.get('menpai-player-faction')
    this.enemyFaction = this.game.registry.get('menpai-enemy-faction')
    this.enemyLevel = this.game.registry.get('menpai-enemy-level') ?? 1
    this.cameras.main.setBackgroundColor(COLORS.BG)
    this._subs = []           // [[event, fn]] 用于 shutdown 时 off
    this._acted = {}          // 本回合已选行动方
    this._resultPanel = null
    this._resultArgs = null   // 旋转屏幕时按新尺寸重建结算面板
    this._cast = null         // 当前正在演出的技能 { side, skill, hitIndex }
    this._lay = getBattleLayout(this.scale.width, this.scale.height)

    // feed 必须在 UIScene 启动前放进 registry
    this.feed = new BattleFeed(this.engine, this)
    this.game.registry.set('menpai-feed', this.feed)

    this._buildCharacters()
    this._subscribeEvents()
    this._layout()

    // UIScene 绑定 engine/feed 是在它自己的 create 里，所以每次开新局都得由本场景重新拉起它。
    // 渲染层级由 MenpaiGame 里 scene.add 的顺序决定（UI 最后加），与 launch 时机无关。
    if (!this.scene.isActive('UI')) this.scene.launch('UI')

    this.scale.on('resize', this._onResize, this)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this._shutdown())

    // 第 1 回合 engine 构造时不会 emit select_start，手动触发一次以启动 AI 调度
    this._onSelectStart()
  }

  // ── 角色立绘 ──────────────────────────────────────────────────────────────
  _buildCharacters() {
    // 等级取自 engine 的单位（而非 registry 存档），否则战后升级会让重绘出的立绘
    // 显示新等级，与本局实际参战等级对不上
    this.enemyChar = this._makeCharacter(this.enemyFaction, COLORS.ENEMY,
      this.engine.getUnitState(Side.ENEMY).level)
    this.playerChar = this._makeCharacter(this.playerFaction, COLORS.PLAYER,
      this.engine.getUnitState(Side.PLAYER).level)
  }

  _makeCharacter(faction, sideColor, level) {
    const { emojiSize, emojiOffset, nameOffset, baseW } = this._lay.char
    const c = this.add.container(0, 0)
    const half = baseW / 2
    const base = this.add.graphics()
    base.fillStyle(0x000000, 0.45)
    base.fillRoundedRect(-half - 4, -10, baseW + 8, 26, 12)
    base.fillStyle(sideColor, 0.85)
    base.fillRoundedRect(-half, -8, baseW, 20, 10)
    base.lineStyle(1.5, COLORS.GOLD, 0.55)
    base.strokeRoundedRect(-half, -8, baseW, 20, 10)
    const emoji = this.add.text(0, emojiOffset, faction.emoji, {
      fontFamily: FONT, fontSize: `${emojiSize}px`,
    }).setOrigin(0.5)
    const name = this.add.text(0, nameOffset, `${faction.name} Lv.${level}`, {
      fontFamily: FONT, fontSize: this._lay.portrait ? '12px' : '16px',
      color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)
    c.add([base, emoji, name])
    c._emoji = emoji
    return c
  }

  _layout() {
    this._placeChar(this.enemyChar, this._lay.enemyChar)
    this._placeChar(this.playerChar, this._lay.playerChar)
    if (this._resultPanel) {
      this._resultPanel.setPosition(this.scale.width / 2, this.scale.height / 2)
    }
  }

  /** 记录站位原点，突进动画结束后据此归位 */
  _placeChar(c, pos) {
    c.setPosition(pos.x, pos.y)
    c._home = { x: pos.x, y: pos.y }
  }

  _onResize() {
    const wasPortrait = this._lay.portrait
    this._lay = getBattleLayout(this.scale.width, this.scale.height)
    // 立绘尺寸/结算面板宽度在创建时烘进了 graphics，朝向切换后必须重建
    if (wasPortrait !== this._lay.portrait) {
      // 立绘与其 emoji 子对象都可能有在跑的 tween（突进/吟唱），销毁前必须先掐掉
      this.tweens.killTweensOf([
        this.enemyChar, this.playerChar, this.enemyChar._emoji, this.playerChar._emoji,
      ])
      this.enemyChar.destroy()
      this.playerChar.destroy()
      this._buildCharacters()
      if (this._resultArgs && this._resultPanel) {
        this._resultPanel.destroy()
        this._resultPanel = null
        this._showResult(...this._resultArgs)
      }
    }
    this._layout()
  }

  // ── 事件订阅（全部走 feed，保证与动画同步）────────────────────────────────
  _subscribeEvents() {
    const on = (ev, fn) => { this.feed.on(ev, fn); this._subs.push([ev, fn]) }
    on('select_start', () => this._onSelectStart())
    on('action_selected', ({ side }) => { this._acted[side] = true })
    on('skill_cast', (d) => this._onSkillCast(d))
    on('skill_end', (d) => this._onSkillEnd(d))
    on('damage', (d) => this._onDamage(d))
    on('heal', (d) => this._onHeal(d))
    on('defend', ({ side }) => this._onDefend(side))
    on('rest', ({ side }) => this._floatText(side, '休息', '#bbbbbb', 18))
    on('miss', ({ side }) => this._floatText(side, '未命中', '#bbbbbb', 20))
    on('controlled', ({ side, status }) => this._floatText(side, this._statusLabel(status), '#e2a04a', 22))
    on('buff', ({ side, buff }) => {
      const down = buff.type.includes('down')
      this._ring(this._charOf(side), down ? 0xff7777 : 0x7fd3ff)
      this._floatText(side, this._buffLabel(buff), down ? '#ff9f9f' : '#7fd3ff', 18)
    })
    on('status', ({ side, status }) => {
      this._ring(this._charOf(side), 0xc080ff)
      this._floatText(side, this._statusLabel(status), '#c080ff', 18)
    })
    on('transform_off', ({ side }) => {
      // 变身时放大到 1.12 并定格，解除时必须收回，否则立绘会一直是放大的
      this.tweens.add({ targets: this._charOf(side), scale: 1, duration: 240, ease: 'Quad.out' })
      this._floatText(side, '变身解除', '#bbbbbb', 18)
    })
    on('cleanse', ({ side }) => {
      this._ring(this._charOf(side), 0x7fff7f)
      this._floatText(side, '解除异常', '#7fff7f', 18)
    })
    on('revive', ({ side }) => {
      this._ring(this._charOf(side), 0x7fff7f)
      this._floatText(side, '复活!', '#7fff7f', 26)
    })
    on('game_over', (d) => this._onGameOver(d))

    // 玩家行动（来自 UIScene 的按钮点击）
    this._onPlayerAction = (action) => this._handlePlayerAction(action)
    this.game.events.on('player-action', this._onPlayerAction)
  }

  _onSelectStart() {
    this._acted = {}
    this.time.delayedCall(500, () => {   // AI 延时决策（模拟思考）
      if (this.engine.phase !== Phase.SELECT) return
      if (this._acted[Side.ENEMY]) return
      const action = decideAI(this.engine, Side.ENEMY)
      try { this.engine.selectAction(Side.ENEMY, action) } catch (e) { /* 忽略 */ }
    })
  }

  _handlePlayerAction(action) {
    if (this.engine.phase !== Phase.SELECT) return
    if (this._acted[Side.PLAYER]) return
    try { this.engine.selectAction(Side.PLAYER, action) } catch (e) { /* 忽略 */ }
  }

  // ── 动画：工具 ────────────────────────────────────────────────────────────
  _charOf(side) { return side === Side.PLAYER ? this.playerChar : this.enemyChar }
  _foeOf(side) { return side === Side.PLAYER ? this.enemyChar : this.playerChar }
  _colorOf(side) {
    return side === Side.PLAYER ? this.playerFaction.color : this.enemyFaction.color
  }

  /** 扩散光环：起手 / buff / 命中爆点通用 */
  _ring(at, color, radius = 46, duration = 380) {
    const y = at.y + this._lay.char.emojiOffset
    const ring = this.add.circle(at.x, y, 10).setStrokeStyle(3, color, 0.9).setDepth(44)
    this.tweens.add({
      targets: ring, radius, alpha: 0, duration, ease: 'Cubic.out',
      onComplete: () => ring.destroy(),
    })
  }

  /** 法术弹道：从施法者飞向目标，落点炸开 */
  _projectile(fromSide, color, travel = 170) {
    const from = this._charOf(fromSide), to = this._foeOf(fromSide)
    const off = this._lay.char.emojiOffset
    const r = this._lay.portrait ? 9 : 13
    const orb = this.add.circle(from.x, from.y + off, r, color, 0.95)
      .setStrokeStyle(2, 0xffffff, 0.85).setDepth(45)
    // 目标坐标在飞行开始时取一次即可：受击方此刻不会移动
    const tx = to.x, ty = to.y + off
    this.tweens.add({
      targets: orb, x: tx, y: ty, duration: travel, ease: 'Quad.in',
      onComplete: () => { orb.destroy(); this._ring(to, color, 54, 300) },
    })
  }

  /** 近战突进：冲到目标身前停住（多段攻击期间保持贴身，由 skill_end 收势） */
  _dashIn(side) {
    const caster = this._charOf(side), target = this._foeOf(side)
    const dx = target.x - caster.x, dy = target.y - caster.y
    const dist = Math.hypot(dx, dy) || 1
    const stop = this._lay.portrait ? 52 : 78
    this.tweens.add({
      targets: caster,
      x: target.x - (dx / dist) * stop,
      y: target.y - (dy / dist) * stop,
      duration: 260, ease: 'Cubic.out',
    })
  }

  /** 收势归位 */
  _returnHome(side) {
    const c = this._charOf(side)
    if (!c._home) return
    this.tweens.add({
      targets: c, x: c._home.x, y: c._home.y, duration: 220, ease: 'Cubic.inOut',
    })
  }

  /** 贴身后的每一刀：向目标方向short jab */
  _jab(side) {
    const caster = this._charOf(side), target = this._foeOf(side)
    const dx = target.x - caster.x, dy = target.y - caster.y
    const dist = Math.hypot(dx, dy) || 1
    this.tweens.add({
      targets: caster, x: caster.x + (dx / dist) * 14, y: caster.y + (dy / dist) * 14,
      duration: 80, yoyo: true, ease: 'Quad.out',
    })
  }

  /** 吟唱：托举上浮 + 法阵光环 */
  _chant(side, color) {
    const c = this._charOf(side)
    this.tweens.add({ targets: c._emoji, y: this._lay.char.emojiOffset - 10, duration: 220, yoyo: true, ease: 'Sine.inOut' })
    this._ring(c, color, 40, 420)
  }

  /** 必杀起手：全屏白闪 + 强震 + 金色蓄力 */
  _ultimateWindup(side) {
    const c = this._charOf(side)
    this.cameras.main.flash(220, 255, 255, 255)
    this.cameras.main.shake(320, 0.012)
    this._ring(c, COLORS.GOLD, 78, 620)
    this.tweens.add({ targets: c, scale: 1.18, duration: 260, yoyo: true, ease: 'Back.out' })
  }

  /** 变身：金色脉冲 + 放大定格 */
  _transformFx(side) {
    const c = this._charOf(side)
    this.cameras.main.shake(180, 0.006)
    this._ring(c, COLORS.GOLD, 62, 480)
    this.tweens.add({ targets: c, scale: 1.12, duration: 280, ease: 'Back.out' })
    this._floatText(side, '变身！', '#ffd700', 22)
  }

  /** 受击：抖屏 + 闪烁 + 击退 */
  _impact(side, crit) {
    const target = this._charOf(side)
    this.cameras.main.shake(crit ? 260 : 180, crit ? 0.016 : 0.01)
    this.tweens.add({
      targets: target, alpha: 0.35, duration: 80, yoyo: true,
      onComplete: () => target.setAlpha(1),
    })
    // 沿"背离攻击者"的方向被击退
    const foe = this._foeOf(side)
    const dx = target.x - foe.x, dy = target.y - foe.y
    const dist = Math.hypot(dx, dy) || 1
    const push = crit ? 20 : 12
    this.tweens.add({
      targets: target, x: target.x + (dx / dist) * push, y: target.y + (dy / dist) * push,
      duration: 90, yoyo: true, ease: 'Quad.out',
    })
  }

  /** 防御：蓝色护盾弹出 + 下蹲 */
  _onDefend(side) {
    const c = this._charOf(side)
    this._ring(c, 0x7fd3ff, 44, 380)
    this.tweens.add({ targets: c, scaleY: 0.9, duration: 140, yoyo: true, ease: 'Quad.out' })
    this._floatText(side, '🛡 防御', '#7fd3ff', 18)
  }

  // ── 动画：事件驱动 ────────────────────────────────────────────────────────
  _onSkillCast({ side, skill }) {
    this._cast = { side, skill }
    if (skill.category === SkillCategory.ULTIMATE) this._ultimateWindup(side)
    if (skill.setTransform) { this._transformFx(side); return }

    const color = this._colorOf(side)
    switch (skill.type) {
      case SkillType.PHYSICAL:
        this._dashIn(side)
        break
      case SkillType.MAGICAL:
      case SkillType.FIXED:
        this._chant(side, skill.type === SkillType.FIXED ? 0x16a085 : color)
        // 吟唱 300ms 后放出弹道，飞行 170ms 恰好在 skill_cast 的 470ms 预算末尾命中，
        // 与紧随其后的 damage 事件对齐（见 BattleFeed.STEP_DELAY）
        this.time.delayedCall(300, () => {
          if (!this.scene.isActive()) return
          this._projectile(side, skill.type === SkillType.FIXED ? 0x16a085 : color)
        })
        break
      case SkillType.HEAL:
        this._ring(this._charOf(side), 0x7fff7f, 48, 420)
        break
      case SkillType.SEAL:
        this._chant(side, 0xc080ff)
        this.time.delayedCall(200, () => {
          if (!this.scene.isActive()) return
          this._projectile(side, 0xc080ff, 200)
        })
        break
      default:
        this._ring(this._charOf(side), 0x7fd3ff, 44, 380)
    }
  }

  _onSkillEnd({ side }) {
    this._returnHome(side)
    this._cast = null
  }

  _onDamage({ side, amount, type, crit, hitIndex }) {
    if (type === 'dot') {
      // 持续伤害没有施法者，只做轻微抖动 + 暗红飘字
      this.cameras.main.shake(180, 0.004)
      const size = this._lay.portrait ? 15 : 20
      this._floatText(side, `-${amount}`, '#a04040', size, this._lay.char.emojiOffset - 30)
      return
    }

    // 第 1 击的表演已由 skill_cast 铺垫（突进到位 / 弹道命中）；第 2 击起要补动作
    const cast = this._cast
    if (cast && hitIndex > 1) {
      if (cast.skill.type === SkillType.PHYSICAL) this._jab(cast.side)
      else if (cast.skill.type === SkillType.MAGICAL || cast.skill.type === SkillType.FIXED) {
        this._projectile(cast.side, this._colorOf(cast.side), 90)
      }
    }

    this._impact(side, crit)
    let color = '#ff5555', size = 26
    if (crit) { color = '#ffd700'; size = 40 }
    if (this._lay.portrait) size = Math.round(size * 0.72)
    this._floatText(side, `-${amount}${crit ? ' 暴击!' : ''}`, color, size, this._lay.char.emojiOffset - 30)
  }

  _onHeal({ side, amount }) {
    const c = this._charOf(side)
    this._ring(c, 0x7fff7f, 50, 420)
    const size = this._lay.portrait ? 19 : 26
    this._floatText(side, `+${amount}`, '#7fff7f', size, this._lay.char.emojiOffset - 30)
  }

  _floatText(side, text, color, size, yOffset) {
    const target = this._charOf(side)
    const dy = yOffset ?? (this._lay.char.emojiOffset - 26)
    const t = this.add.text(target.x, target.y + dy, text, {
      fontFamily: FONT, fontSize: `${size}px`, color, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(50).setStroke('#000000', 3)
    this.tweens.add({
      targets: t, y: t.y - 52, alpha: 0, duration: 900, ease: 'Cubic.out',
      onComplete: () => t.destroy(),
    })
  }

  _statusLabel(type) {
    return { stun: '眩晕', sleep: '睡眠', seal_magic: '封法', seal_phys: '封物理',
             poison: '中毒', burn: '灼烧', defending: '防御' }[type] || type
  }

  _buffLabel(buff) {
    const map = { atk_up: '攻击↑', matk_up: '法攻↑', def_up: '防御↑', mdef_up: '法防↑',
                  spd_up: '速度↑', atk_down: '攻击↓', def_down: '防御↓',
                  mdef_down: '法防↓', spd_down: '速度↓', mdef_down_ult: '法防↓↓' }
    return map[buff.type] || buff.type
  }

  // ── 结算：经验 + 存档 ─────────────────────────────────────────────────────
  _onGameOver({ result, round }) {
    const settle = this._settleExp(result)
    let title, color
    if (result === Result.PLAYER_WIN) { title = '胜利！'; color = '#ffd700' }
    else if (result === Result.ENEMY_WIN) { title = '败北…'; color = '#e24a4a' }
    else { title = '平局'; color = '#bbbbbb' }
    this._resultArgs = [title, color, round, settle]
    this._showResult(title, color, round, settle)
  }

  /** 算经验、升级、写存档。返回结算摘要供面板展示 */
  _settleExp(result) {
    const character = this.game.registry.get('menpai-character')
    const outcome = result === Result.PLAYER_WIN ? 'win'
      : result === Result.ENEMY_WIN ? 'lose' : 'draw'
    const gained = expReward(outcome, character.level, this.enemyLevel)
    const before = character.level
    const { level, exp, levelsGained } = applyExp(character, gained)

    const updated = {
      ...character,
      level, exp,
      wins: character.wins + (outcome === 'win' ? 1 : 0),
      losses: character.losses + (outcome === 'lose' ? 1 : 0),
      draws: character.draws + (outcome === 'draw' ? 1 : 0),
    }
    this.game.registry.set('menpai-character', updated)
    saveCharacter(updated)
    return { gained, before, level, exp, levelsGained, character: updated }
  }

  _showResult(title, color, round, settle) {
    const { w: pw, h: ph } = this._lay.resultPanel
    const panel = this.add.container(this.scale.width / 2, this.scale.height / 2).setDepth(100)
    const left = -pw / 2, top = -ph / 2

    const g = this.add.graphics()
    g.fillStyle(0x000000, 0.72)
    g.fillRoundedRect(left, top, pw, ph, 16)
    g.lineStyle(2, COLORS.GOLD, 0.85)
    g.strokeRoundedRect(left, top, pw, ph, 16)
    panel.add(g)

    let y = top + 18
    panel.add(this.add.text(0, y, title, {
      fontFamily: FONT, fontSize: '40px', color, fontStyle: 'bold',
    }).setOrigin(0.5, 0))
    y += 52

    panel.add(this.add.text(0, y, `战斗回合 ${round}  ·  对手 ${this.enemyFaction.name} Lv.${this.enemyLevel}`, {
      fontFamily: FONT, fontSize: '13px', color: '#dddddd',
    }).setOrigin(0.5, 0))
    y += 26

    const expLabel = settle.gained > 0
      ? `获得经验 +${settle.gained.toLocaleString()}`
      : '已满级，不再获得经验'
    panel.add(this.add.text(0, y, expLabel, {
      fontFamily: FONT, fontSize: '16px', color: '#7fd3ff', fontStyle: 'bold',
    }).setOrigin(0.5, 0))
    y += 26

    if (settle.levelsGained > 0) {
      panel.add(this.add.text(0, y, `升级！Lv.${settle.before} → Lv.${settle.level}`, {
        fontFamily: FONT, fontSize: '18px', color: '#ffd700', fontStyle: 'bold',
      }).setOrigin(0.5, 0).setStroke('#000000', 3))
      y += 28
      this.cameras.main.flash(300, 255, 215, 0)
    }

    // 经验条
    y += 4
    const barW = pw - 48, barH = 14
    const atMax = settle.level >= LEVEL_MAX
    const need = expToNext(settle.level)
    const ratio = atMax ? 1 : settle.exp / need
    const bar = this.add.graphics()
    bar.fillStyle(0x223a55, 0.9)
    bar.fillRoundedRect(-barW / 2, y, barW, barH, 4)
    bar.fillStyle(atMax ? COLORS.GOLD : 0x4a90e2, 0.95)
    bar.fillRoundedRect(-barW / 2, y, Math.max(2, barW * Phaser.Math.Clamp(ratio, 0, 1)), barH, 4)
    bar.lineStyle(1, 0x000000, 0.5)
    bar.strokeRoundedRect(-barW / 2, y, barW, barH, 4)
    panel.add(bar)
    panel.add(this.add.text(0, y + barH / 2,
      atMax ? `Lv.${LEVEL_MAX} 满级` : `Lv.${settle.level}  ${settle.exp.toLocaleString()} / ${need.toLocaleString()}`, {
      fontFamily: FONT, fontSize: '10px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setStroke('#000000', 3))
    y += barH + 12

    const c = settle.character
    panel.add(this.add.text(0, y, `战绩  ${c.wins} 胜 ${c.losses} 负 ${c.draws} 平`, {
      fontFamily: FONT, fontSize: '12px', color: '#bbbbbb',
    }).setOrigin(0.5, 0))

    // 按钮从面板底部往上排，不受上方内容高度影响
    const btnW = pw - 60, btnH = 40, gap = 8
    let by = top + ph - 14 - btnH
    panel.add(this._makeButton(-btnW / 2, by, btnW, btnH, '返回游戏大厅', () => {
      this.game.events.emit('menpai-exit')
    }))
    by -= btnH + gap
    panel.add(this._makeButton(-btnW / 2, by, btnW, btnH, '重选角色', () => {
      this.scene.stop('UI')
      this.scene.start('RaceSelect')
    }))
    by -= btnH + gap
    panel.add(this._makeButton(-btnW / 2, by, btnW, btnH, '再战一局', () => this._restartBattle()))

    this._resultPanel = panel
  }

  /** 用当前（可能已升级的）角色开新一局，保持门派不变。UI 由 create() 重新拉起 */
  _restartBattle() {
    prepareBattle(this.game, this.playerFaction)
    this.scene.stop('UI')
    this.scene.restart()
  }

  _makeButton(x, y, w, h, label, onClick) {
    const c = this.add.container(x, y)
    const g = this.add.graphics()
    const txt = this.add.text(w / 2, h / 2, label, {
      fontFamily: FONT, fontSize: '15px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)
    let hover = false
    const draw = () => {
      g.clear()
      g.fillStyle(0x000000, 0.4)
      g.fillRoundedRect(2, 3, w, h, 8)
      g.fillStyle(hover ? 0xe74c3c : 0xc0392b, 0.95)
      g.fillRoundedRect(0, 0, w, h, 8)
      g.lineStyle(hover ? 2 : 1.5, COLORS.GOLD, 0.85)
      g.strokeRoundedRect(0, 0, w, h, 8)
    }
    draw()
    c.add([g, txt])
    c.setSize(w, h)
    c.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains)
    c.on('pointerover', () => { hover = true; draw() })
    c.on('pointerout', () => { hover = false; draw() })
    c.on('pointerup', () => onClick())
    return c
  }

  _shutdown() {
    this._subs.forEach(([ev, fn]) => { try { this.feed.off(ev, fn) } catch (e) { /* noop */ } })
    this._subs = []
    if (this._onPlayerAction) {
      this.game.events.off('player-action', this._onPlayerAction)
      this._onPlayerAction = null
    }
    this.feed?.destroy()
    this.feed = null
    this.scale.off('resize', this._onResize, this)
    this._resultPanel = null
    this._resultArgs = null
    this._cast = null
  }
}
