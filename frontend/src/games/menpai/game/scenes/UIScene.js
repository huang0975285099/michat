// 门派 PK · 梦幻西游风 - UI 层场景
// 后于 BattleScene 启动，渲染在上层。负责：HP/MP/愤怒数据条、状态/buff 图标、
// 回合标签、技能/必杀/防御按钮、战斗日志、玩家行动派发。
// 按钮点击 → emit 'player-action' {type, skill?} 给 game.events，BattleScene 监听并提交 engine。
//
// 数据条渲染的是**事件自带的状态快照**（payload.snapshot）而不是 engine 的当前状态：
// engine 一帧内就把整回合算完了，直接读它血条会瞬间跳到回合末的值，与逐条播放的动画脱节。
// 只有"选行动"时才读 engine 当前状态（技能可用性/CD/愤怒），那时两者本就一致。
//
// 所有坐标来自 layout.getBattleLayout（与 BattleScene 共用），横屏/竖屏两套。

import Phaser from 'phaser'
import {
  COLORS, MAX_ROUNDS, MAX_ANGER, TURN_TIME_SECONDS,
  Side, Phase, ActionType, SkillCategory, StatusType,
} from '../GameConstants.js'
import { getBattleLayout } from '../layout.js'
import { getNormalAttack } from '../factions.js'

const FONT = "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
const GREEN = 0x4caf50   // HP 前景色（红底绿前景）
const BAR_H = 13

export class UIScene extends Phaser.Scene {
  constructor() { super('UI') }

  create() {
    this.engine = this.game.registry.get('menpai-engine')
    this.feed = this.game.registry.get('menpai-feed')
    this.playerFaction = this.game.registry.get('menpai-player-faction')
    this.ultimateSkill = this.playerFaction.skills.find((s) => s.category === SkillCategory.ULTIMATE)
    this._subs = []            // [[event, fn]]
    this._playerActed = false
    this._logLines = []
    this._skillBtns = []
    this._btnsEnabled = false
    // 数据条渲染源：随事件推进的状态快照，初始等于开局状态
    this._display = {
      [Side.PLAYER]: this.engine.getUnitState(Side.PLAYER),
      [Side.ENEMY]: this.engine.getUnitState(Side.ENEMY),
    }

    this._timerEvt = null
    this._lay = getBattleLayout(this.scale.width, this.scale.height)

    this._buildRoundLabel()
    this._buildPanels()
    this._buildLogPanel()
    this._buildActionArea()

    this._layout()
    this._refresh()
    this._refreshLog()
    // 第 1 回合 engine 不会 emit select_start，手动启用按钮
    this._onSelectStart()

    this.scale.on('resize', this._onResize, this)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this._shutdown())

    // 订阅 feed（重放队列）而非 engine，数据条才能跟着动画一步步走
    const on = (ev, fn) => { this.feed.on(ev, fn); this._subs.push([ev, fn]) }
    const refreshFrom = (d) => this._refresh(d.snapshot)
    for (const ev of ['damage', 'heal', 'anger_change', 'buff', 'status', 'cleanse',
                      'revive', 'defend', 'rest', 'controlled', 'transform_off', 'round_end']) {
      on(ev, refreshFrom)
    }
    on('round_start', ({ round }) => { this.roundLabel.setText(`${round}`) })
    on('select_start', ({ round, snapshot }) => {
      this.roundLabel.setText(`${round}`) // 选行动阶段就显示新回合数，不等结算
      this._refresh(snapshot)
      this._onSelectStart()
    })
    on('log', (d) => this._onLog(d))
    on('game_over', ({ snapshot }) => {
      this._refresh(snapshot)
      this._setButtonsEnabled(false)
      this._stopCountdown()
      this.timerText.setText('')
      this.hintText.setText('')
    })
  }

  // ── 回合标签（横屏：顶部居中大红数字；竖屏：右上角小角标）─────────────────
  _buildRoundLabel() {
    this.roundLabel = this.add.text(0, 0, `${this.engine.round}`, {
      fontFamily: FONT, fontSize: '54px', color: '#e02020', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setStroke('#ffffff', 6).setDepth(80)
    this.roundSub = this.add.text(0, 0, `回合 · 上限 ${MAX_ROUNDS}`, {
      fontFamily: FONT, fontSize: '12px', color: '#bbbbbb',
    }).setOrigin(0.5, 0).setDepth(80)
    this.timerText = this.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '17px', color: '#ffd54f', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setStroke('#000000', 3).setDepth(80)
  }

  // ── 行动倒计时：超时未选择则自动普攻 ─────────────────────────────────────
  _startCountdown() {
    this._stopCountdown()
    this._countdown = TURN_TIME_SECONDS
    this._updateTimerText()
    this._timerEvt = this.time.addEvent({
      delay: 1000, loop: true,
      callback: () => {
        this._countdown -= 1
        if (this._countdown <= 0) {
          this._stopCountdown()
          this.timerText.setText('')
          if (!this._playerActed && this.engine.phase === Phase.SELECT) {
            this._emitAction({ type: ActionType.SKILL, skill: getNormalAttack(this.playerFaction) })
          }
        } else {
          this._updateTimerText()
        }
      },
    })
  }

  _updateTimerText() {
    this.timerText.setText(`${this._countdown}s`)
    this.timerText.setColor(this._countdown <= 5 ? '#ff5555' : '#ffd54f')
  }

  _stopCountdown() {
    if (this._timerEvt) { this._timerEvt.remove(); this._timerEvt = null }
  }

  // ── 角色状态面板 ───────────────────────────────────────────────────────────
  _buildPanels() {
    this.enemyPanel = this.add.container(0, 0).setDepth(50)
    this.playerPanel = this.add.container(0, 0).setDepth(50)
  }

  /** @param {object} [snapshot] 事件携带的状态快照；不传则沿用上一次的 */
  _refresh(snapshot) {
    if (!this.engine) return
    if (snapshot) this._display = snapshot
    this._drawPanel(this.enemyPanel, this._display[Side.ENEMY], COLORS.ENEMY)
    this._drawPanel(this.playerPanel, this._display[Side.PLAYER], COLORS.PLAYER)
    // 同步必杀按钮可用态（愤怒变化时即时高亮）
    this._updateUltBtn()
  }

  _drawPanel(panel, u, sideColor) {
    panel.removeAll(true)
    const { barW, panelH, portrait } = this._lay
    // 竖屏行距收紧，把 118px 面板压到 96px
    const rows = portrait
      ? { name: -4, nameSize: 13, hp: 14, mp: 31, anger: 48, chips: 68 }
      : { name: -2, nameSize: 15, hp: 22, mp: 42, anger: 62, chips: 86 }

    const g = this.add.graphics()
    g.fillStyle(0x000000, 0.42)
    g.fillRoundedRect(-barW / 2 - 12, -10, barW + 24, panelH, 10)
    g.lineStyle(1, sideColor, 0.6)
    g.strokeRoundedRect(-barW / 2 - 12, -10, barW + 24, panelH, 10)
    panel.add(g)

    const name = this.add.text(0, rows.name, `${u.emoji} ${u.name}  Lv.${u.level}`, {
      fontFamily: FONT, fontSize: `${rows.nameSize}px`, color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5, 0)
    panel.add(name)

    this._drawBar(panel, 0, rows.hp, barW, BAR_H, u.hp / u.maxHp, COLORS.HP, GREEN, `HP ${u.hp}/${u.maxHp}`)
    this._drawBar(panel, 0, rows.mp, barW, BAR_H, u.maxMp ? u.mp / u.maxMp : 0, 0x223a55, COLORS.MP, `MP ${u.mp}/${u.maxMp}`)
    const angerColor = u.anger >= MAX_ANGER ? COLORS.GOLD : COLORS.ANGER
    this._drawBar(panel, 0, rows.anger, barW, BAR_H, u.anger / MAX_ANGER, 0x4a3018, angerColor, `愤怒 ${u.anger}/${MAX_ANGER}`)

    this._drawChips(panel, u, rows.chips)
  }

  _drawBar(panel, x, y, w, h, ratio, trackColor, fillColor, label) {
    const g = this.add.graphics()
    g.fillStyle(trackColor, 0.9)
    g.fillRoundedRect(x - w / 2, y, w, h, 4)
    g.fillStyle(fillColor, 0.95)
    g.fillRoundedRect(x - w / 2, y, Math.max(2, w * Phaser.Math.Clamp(ratio, 0, 1)), h, 4)
    g.lineStyle(1, 0x000000, 0.5)
    g.strokeRoundedRect(x - w / 2, y, w, h, 4)
    panel.add(g)
    const t = this.add.text(x, y + h / 2, label, {
      fontFamily: FONT, fontSize: '11px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setStroke('#000000', 3)
    panel.add(t)
  }

  _drawChips(panel, u, chipY) {
    const chips = []
    const statusMap = {
      [StatusType.STUN]: { t: '晕', c: 0xffd700 },
      [StatusType.SLEEP]: { t: '眠', c: 0x99ccff },
      [StatusType.SEAL_MAGIC]: { t: '封法', c: 0xc080ff },
      [StatusType.SEAL_PHYS]: { t: '封物', c: 0xc080ff },
      [StatusType.POISON]: { t: '毒', c: 0x66cc66 },
      [StatusType.BURN]: { t: '烧', c: 0xff8844 },
      [StatusType.DEFENDING]: { t: '防', c: 0xaaaaaa },
    }
    for (const s of u.statuses) {
      const m = statusMap[s.type]
      if (m) chips.push({ ...m, n: s.turns })
    }
    const buffMap = {
      atk_up: '攻↑', matk_up: '法攻↑', def_up: '防↑', mdef_up: '法防↑', spd_up: '速↑',
      atk_down: '攻↓', def_down: '防↓', mdef_down: '法防↓', spd_down: '速↓', mdef_down_ult: '法防↓↓',
    }
    for (const b of u.buffs) {
      const t = buffMap[b.type]
      if (t) chips.push({ t, c: b.type.includes('down') ? 0xff7777 : 0x77ff77, n: b.turns })
    }
    if (u.transform) chips.push({ t: '变身', c: 0xffd700, n: '' })
    if (u.restTurns > 0) chips.push({ t: `休息${u.restTurns}`, c: 0xaaaaaa, n: '' })
    if (u.delayedAction) chips.push({ t: '蓄力', c: 0xffaa44, n: '' })

    const chipW = 32, chipH = 16, gap = 3
    const total = chips.length ? chips.length * chipW + (chips.length - 1) * gap : 0
    let cx = -total / 2
    for (const ch of chips) {
      const cg = this.add.graphics()
      cg.fillStyle(0x000000, 0.6)
      cg.fillRoundedRect(cx, chipY, chipW, chipH, 4)
      cg.lineStyle(1, ch.c, 0.9)
      cg.strokeRoundedRect(cx, chipY, chipW, chipH, 4)
      panel.add(cg)
      const lbl = (ch.n !== '' && ch.n !== undefined) ? `${ch.t}${ch.n}` : ch.t
      const ct = this.add.text(cx + chipW / 2, chipY + chipH / 2, lbl, {
        fontFamily: FONT, fontSize: '10px', color: '#ffffff',
      }).setOrigin(0.5)
      panel.add(ct)
      cx += chipW + gap
    }
  }

  // ── 战斗日志（横屏：左下角面板 5 条；竖屏：底部单行滚动）──────────────────
  _buildLogPanel() {
    this.logPanel = this.add.container(0, 0).setDepth(60)
  }

  _refreshLog() {
    this.logPanel.removeAll(true)
    const { log } = this._lay

    if (log.ticker) {
      // 竖屏：只留最后一条，居中单行，省下垂直空间给角色立绘
      const last = this._logLines[this._logLines.length - 1]
      if (!last) return
      const t = this.add.text(0, 0, last.msg, {
        fontFamily: FONT, fontSize: '11px', color: '#dddddd', align: 'center',
      }).setOrigin(0.5, 0)
      t.setWordWrapWidth(log.width)
      this.logPanel.add(t)
      return
    }

    const w = log.width, lineH = 18, n = log.lines
    const g = this.add.graphics()
    g.fillStyle(0x000000, 0.45)
    g.fillRoundedRect(0, 0, w, n * lineH + 26, 8)
    g.lineStyle(1, COLORS.GOLD, 0.4)
    g.strokeRoundedRect(0, 0, w, n * lineH + 26, 8)
    this.logPanel.add(g)
    this.logPanel.add(this.add.text(8, 6, '战斗日志', {
      fontFamily: FONT, fontSize: '11px', color: '#ffd700', fontStyle: 'bold',
    }))
    this._logLines.slice(-n).forEach((l, i) => {
      this.logPanel.add(this.add.text(8, 24 + i * lineH, `· ${l.msg}`, {
        fontFamily: FONT, fontSize: '11px', color: '#dddddd', wordWrap: { width: w - 16 },
      }))
    })
  }

  _onLog({ round, msg }) {
    this._logLines.push({ round, msg })
    this._refreshLog()
  }

  // ── 行动区（技能按钮 + 必杀 + 防御）──────────────────────────────────────
  _buildActionArea() {
    this.actionPanel = this.add.container(0, 0).setDepth(70)
    this.hintText = this.add.text(0, 0, '', {
      fontFamily: FONT, fontSize: '14px', color: '#ffd54f',
    }).setOrigin(0.5).setDepth(75)
  }

  _onSelectStart() {
    this._playerActed = false
    const u = this.engine.getUnitState(Side.PLAYER)
    const controlled = u.statuses.some((s) => s.type === StatusType.STUN || s.type === StatusType.SLEEP)
    // 玩家无法行动（休息/被控/后发制人蓄力中）时自动跳过，避免空等或选择被静默丢弃
    if (u.restTurns > 0 || controlled || !u.alive || u.delayedAction) {
      this.timerText.setText('')
      this._autoSkip(u)
      return
    }
    this._rebuildSkillButtons()
    this._setButtonsEnabled(true)
    this.hintText.setText('请选择行动')
    this._startCountdown()
  }

  _autoSkip(u) {
    this._rebuildSkillButtons()
    this._setButtonsEnabled(false)
    const reason = u.restTurns > 0 ? `休息中（${u.restTurns} 回合）`
      : u.delayedAction ? '蓄力中，下回合自动出手' : '被控制'
    this.hintText.setText(`${reason}，自动跳过…`)
    this.time.delayedCall(600, () => {
      if (this.engine.phase !== Phase.SELECT) return
      if (this._playerActed) return
      this._emitAction({ type: ActionType.DEFEND })
    })
  }

  _rebuildSkillButtons() {
    this.actionPanel.removeAll(true)
    this._skillBtns = []
    const { btnW, btnH } = this._lay.action
    const pState = this.engine.getUnitState(Side.PLAYER)
    const skills = this.engine.getAvailableSkills(Side.PLAYER)
      .filter((s) => s.category !== SkillCategory.ULTIMATE && s.category !== SkillCategory.NORMAL)

    skills.forEach((s) => {
      const cd = pState.cooldowns[s.id] || 0
      const b = this._makeSkillButton(0, 0, btnW, btnH, s.name, s, false, cd)
      this._skillBtns.push(b)
      this.actionPanel.add(b)
    })

    // 普通攻击（不耗 MP 的保底行动）
    this._attackBtn = this._makeSkillButton(0, 0, btnW, btnH, '普通攻击', getNormalAttack(this.playerFaction), false, 0)
    this.actionPanel.add(this._attackBtn)

    // 必杀按钮（愤怒满时金色高亮，否则灰色禁用）
    this._ultBtn = this._makeSkillButton(0, 0, btnW, btnH, '必杀', this.ultimateSkill, true, 0)
    this.actionPanel.add(this._ultBtn)

    this._defendBtn = this._makeSimpleButton(0, 0, btnW, btnH, '防御', () => {
      this._emitAction({ type: ActionType.DEFEND })
    })
    this.actionPanel.add(this._defendBtn)

    this._updateUltBtn()
    this._layoutActionArea()
  }

  _makeSkillButton(x, y, w, h, label, skill, isUlt, cd) {
    const c = this.add.container(x, y)
    const g = this.add.graphics()
    const txt = this.add.text(w / 2, h / 2 - 7, label, {
      fontFamily: FONT, fontSize: '13px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)
    const subLabel = isUlt ? '150 怒' : (cd ? `CD ${cd}` : (skill.mpCost ? `${skill.mpCost} MP` : '不耗 MP'))
    const sub = this.add.text(w / 2, h / 2 + 9, subLabel, {
      fontFamily: FONT, fontSize: '10px', color: '#ffe082',
    }).setOrigin(0.5)
    c._hover = false
    c._enabled = true
    const draw = () => {
      g.clear()
      g.fillStyle(0x000000, 0.4)
      g.fillRoundedRect(2, 3, w, h, 8)
      let base = isUlt ? 0x6a4a20 : 0x2f4a6a
      if (isUlt && this.engine.canUltimate(Side.PLAYER)) base = COLORS.GOLD
      if (c._hover && c._enabled) base = isUlt ? 0xffb300 : 0x3f6fa8
      g.fillStyle(base, c._enabled ? 0.95 : 0.5)
      g.fillRoundedRect(0, 0, w, h, 8)
      // 悬停时白色描边，与常态金色区分，焦点更明确
      const borderColor = (c._hover && c._enabled) ? 0xffffff : COLORS.GOLD
      g.lineStyle(c._enabled ? 2 : 1, borderColor, c._enabled ? 0.9 : 0.3)
      g.strokeRoundedRect(0, 0, w, h, 8)
    }
    draw()
    c.add([g, txt, sub])
    c.setSize(w, h)
    c.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains)
    c.on('pointerover', () => { c._hover = true; draw() })
    c.on('pointerout', () => { c._hover = false; draw() })
    c.on('pointerup', () => {
      if (!c._enabled) return
      if (isUlt) this._emitAction({ type: ActionType.ULTIMATE, skill: this.ultimateSkill })
      else this._emitAction({ type: ActionType.SKILL, skill })
    })
    c._draw = draw
    return c
  }

  // 即时同步必杀按钮可用态（愤怒变化时）
  _updateUltBtn() {
    if (!this._ultBtn) return
    const canUlt = this.engine.canUltimate(Side.PLAYER)
    const en = canUlt && !this._playerActed && this.engine.phase === Phase.SELECT
    this._ultBtn._enabled = en
    if (this._ultBtn.input) this._ultBtn.input.enabled = en
    if (this._ultBtn._draw) this._ultBtn._draw()
  }

  _setButtonsEnabled(enabled) {
    this._btnsEnabled = enabled
    const setBtn = (b, en) => {
      if (!b) return
      b._enabled = en
      if (b.input) b.input.enabled = en
      if (b._draw) b._draw()
    }
    this._skillBtns.forEach((b) => setBtn(b, enabled))
    setBtn(this._attackBtn, enabled)
    setBtn(this._defendBtn, enabled)
    setBtn(this._ultBtn, enabled && this.engine.canUltimate(Side.PLAYER))
  }

  _emitAction(action) {
    if (this._playerActed) return
    this._playerActed = true
    this._stopCountdown()
    this.timerText.setText('')
    this._setButtonsEnabled(false)
    this.hintText.setText('等待 AI 行动…')
    this.game.events.emit('player-action', action)
  }

  _makeSimpleButton(x, y, w, h, label, onClick) {
    const c = this.add.container(x, y)
    const g = this.add.graphics()
    const txt = this.add.text(w / 2, h / 2, label, {
      fontFamily: FONT, fontSize: '14px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)
    c._hover = false
    c._enabled = true
    const draw = () => {
      g.clear()
      g.fillStyle(0x000000, 0.4)
      g.fillRoundedRect(2, 3, w, h, 8)
      g.fillStyle(c._hover ? 0x5a5a5a : 0x444444, c._enabled ? 0.92 : 0.5)
      g.fillRoundedRect(0, 0, w, h, 8)
      g.lineStyle(2, (c._hover && c._enabled) ? 0xffffff : COLORS.GOLD, c._enabled ? 0.85 : 0.3)
      g.strokeRoundedRect(0, 0, w, h, 8)
    }
    draw()
    c.add([g, txt])
    c.setSize(w, h)
    c.setInteractive(new Phaser.Geom.Rectangle(0, 0, w, h), Phaser.Geom.Rectangle.Contains)
    c.on('pointerover', () => { c._hover = true; draw() })
    c.on('pointerout', () => { c._hover = false; draw() })
    c.on('pointerup', () => { if (c._enabled) onClick() })
    c._draw = draw
    return c
  }

  // ── 布局 ──────────────────────────────────────────────────────────────────
  _layout() {
    const L = this._lay
    this.roundLabel.setPosition(L.round.x, L.round.y)
      .setFontSize(L.round.size)
      .setOrigin(L.round.originX, 0)
      .setStroke('#ffffff', L.portrait ? 4 : 6)
    this.roundSub.setPosition(L.round.x, L.round.y + L.round.size + 4)
      .setOrigin(L.round.originX, 0)
      .setVisible(L.round.showSub)
    this.timerText.setPosition(L.timer.x, L.timer.y).setOrigin(L.timer.originX, 0)

    this.enemyPanel.setPosition(L.enemyPanel.x, L.enemyPanel.y)
    this.playerPanel.setPosition(L.playerPanel.x, L.playerPanel.y)
    this.logPanel.setPosition(L.log.x, L.log.y)
    this._layoutActionArea()
  }

  _layoutActionArea() {
    const L = this._lay
    const A = L.action
    const btns = this.actionPanel.list.filter((o) => o instanceof Phaser.GameObjects.Container)

    if (A.rightAligned) {
      // 横屏：右侧竖排指令栏，整列垂直居中
      const h = this.scale.height, w = this.scale.width
      let totalH = btns.reduce((acc, b) => acc + b.height + A.gap, 0) - A.gap
      if (totalH < 0) totalH = 0
      let y = (h - totalH) / 2
      btns.forEach((b) => {
        b.setPosition(w - b.width - 14, y)
        y += b.height + A.gap
      })
    } else {
      // 竖屏：底部 N 列网格，从左上往右下填
      btns.forEach((b, i) => {
        const col = i % A.cols, row = Math.floor(i / A.cols)
        b.setPosition(A.left + col * (A.btnW + A.gap), A.top + row * (A.btnH + A.gap))
      })
    }

    this.hintText.setPosition(L.hint.x, L.hint.y)
    // 恢复鼠标下按钮的悬停态：按钮每回合重建，pointerover 不会对新对象自动补发
    const p = this.input.activePointer
    btns.forEach((b) => {
      const over = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
      if (b._hover !== over) { b._hover = over; if (b._draw) b._draw() }
    })
  }

  _onResize() {
    const wasPortrait = this._lay.portrait
    const oldBtnW = this._lay.action.btnW
    this._lay = getBattleLayout(this.scale.width, this.scale.height)
    this._layout()
    this._refresh()
    this._refreshLog()
    // 按钮宽度/朝向变了就得重建（按钮尺寸在创建时烘进了 graphics），否则只需重新定位
    const geometryChanged = wasPortrait !== this._lay.portrait || oldBtnW !== this._lay.action.btnW
    if (geometryChanged && this.engine.phase !== Phase.GAME_OVER) {
      const enabled = this._btnsEnabled
      this._rebuildSkillButtons()
      this._setButtonsEnabled(enabled)
    } else {
      this._layoutActionArea()
    }
  }

  _shutdown() {
    this._stopCountdown()
    this._subs.forEach(([ev, fn]) => { try { this.feed.off(ev, fn) } catch (e) { /* noop */ } })
    this._subs = []
    this.scale.off('resize', this._onResize, this)
  }
}
