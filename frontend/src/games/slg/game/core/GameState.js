// 九州征途 - 纯逻辑层（与渲染完全解耦，仿 ironfist 的分层方式）
// 职责：资源产出、征兵、行军队列、战斗结算、占领/放弃、主城升级、存档。
// 渲染层（Phaser WorldScene）与 UI 层（Vue）只通过事件与只读查询访问本类。

import {
  MAP_W, MAP_H, TILE_TYPES, RESOURCES, TIME_SCALE, OFFLINE_CAP_SECONDS,
  GAME_START_YEAR, GAME_SECONDS_PER_YEAR, GAME_SECONDS_PER_MONTH, GAME_SECONDS_PER_DAY,
  BASE_YIELD_PER_LEVEL, COIN_YIELD_PER_LEVEL,
  garrisonOf, guardStat,
  CITY_MAX_LEVEL, territoryCap, cityUpgradeCost,
  troopCapOf, expToLevel, GENERAL_MAX_LEVEL, maxSkillSlots, MAX_SKILL_SLOTS, SKILL_SLOT2_LEVEL,
  GENERAL_QUALITY, RECRUITABLE_GENERALS, findGeneralTemplate,
  RECRUIT_COST_COIN, MAX_GENERALS, AWAKEN_ATK, AWAKEN_DEF, AWAKEN_INT, AWAKEN_POL, AWAKEN_CHA, FREE_RECRUIT_COUNT,
  growthOf, LEVELUP_ATK, LEVELUP_DEF, LEVELUP_INT, LEVELUP_POL, LEVELUP_CHA, calcSpd,
  getRecruitCostPerTroop, tileMarchSeconds, MARCH_REF_SPEED, TROOP_TYPES,
  MAX_MARCH_PARTY, MAX_FORMATIONS, FORMATION_NAME_MAX_LEN, FORMATION_SIZE,
  npcCityLootOf, GARRISON_REGEN_PER_HOUR,
  BUILDINGS, BUILDING_MAX_LEVEL, buildingUpgradeCost,
  GRANARY_YIELD_PER_LEVEL, BARRACKS_CAP_PER_LEVEL, TRAINING_EXP_PER_LEVEL, FORGE_STAT_PER_LEVEL,
  STAMINA_MAX, MARCH_STAMINA_COST, STAMINA_REGEN_PER_HOUR,
  INITIAL_RESOURCES, INITIAL_TROOPS, SAVE_KEY,
  DISMISS_JADE, SKILL_MAX_LEVEL,
  EQUIP_TYPES, EQUIP_QUALITY, EQUIP_MAX_LEVEL, EQUIP_DRAW_COST, EQUIP_DISMISS_JADE,
} from '../GameConstants.js'
import { generateMap } from './MapGenerator.js'
import { findPath } from './pathfind.js'
import { resolveBattle } from './battle.js'
import { getSkill, BINDABLE_SKILLS } from './skills.js'
import {
  equipValue, equipUpgradeCost, equipMaxed, equipName, equipDesc, rollEquipment,
} from './equipment.js'

// 轻量事件发射器（不依赖 Phaser，保持核心层纯净）
class Emitter {
  constructor() { this._m = new Map() }
  on(ev, fn) {
    if (!this._m.has(ev)) this._m.set(ev, new Set())
    this._m.get(ev).add(fn)
    return () => this._m.get(ev)?.delete(fn)
  }
  emit(ev, payload) { this._m.get(ev)?.forEach(fn => fn(payload)) }
  clear() { this._m.clear() }
}

let marchSeq = 1

/** 由模板生成运行时武将对象。starter=true 时带初始兵力，招募武将初始 0 兵。 */
function makeGeneral(tpl, starter = false) {
  return {
    id: tpl.id, name: tpl.name, quality: tpl.quality || 'common',
    troopType: tpl.troopType || 'spear', faction: tpl.faction || null,
    atk: tpl.atk, def: tpl.def, int: tpl.int, pol: tpl.pol, cha: tpl.cha,
    spd: calcSpd(tpl),
    lv: 1, exp: 0, troops: starter ? INITIAL_TROOPS : 0, state: 'idle',
    stamina: STAMINA_MAX, awaken: 0, skillIds: [null, null],   // 绑定的主动战法（2 槽，第2槽需20级解锁）
    equip: { weapon: null, helmet: null, necklace: null, armor: null, belt: null, boots: null },   // 6 槽装备 iid
  }
}

export class GameState extends Emitter {
  /**
   * @param {number} seed 地图种子
   */
  constructor(seed) {
    super()
    this.seed = seed
    const { tiles, spawn, cities } = generateMap(seed)
    this.tiles = tiles
    this.spawn = spawn
    this.npcCities = cities

    // 玩家状态
    this.res = { ...INITIAL_RESOURCES }
    this.cityLv = 1
    this.buildings = { granary: 1, barracks: 1, training: 1, forge: 1 }
    this.generals = []
    this.skills = []           // 战法仓库：拥有的战法 id（每种仅一份；绑定关系存在各武将 g.skillIds 上）
    this.skillLevels = {}      // 战法等级：{ skillId: level }，缺省=1。等级跟战法走、不跟武将走
    this.equipments = []       // 装备仓库：所有装备实例数组（绑定关系存在各武将 g.equip.{type} iid 上）
    this._equipSeq = 0         // 装备实例 iid 自增序号
    this.freeRecruits = FREE_RECRUIT_COUNT   // 开局赠送的免费招募次数（不占铜币），每次必出王牌（Legend）
    this.autoJadeCommon = false  // 招募开关：开启后抽到的普通/精良武将自动转换为玉石，不入列也不觉醒
    this.autoJadeElite = false   // 招募开关：开启后抽到的精锐武将自动转换为玉石，与上面独立开关
    this.autoJadeEquipCommon = false  // 抽装备开关：开启后抽到的普通/精良装备自动转换为玉石，不入仓库
    this.autoJadeEquipElite = false   // 抽装备开关：开启后抽到的精锐装备自动转换为玉石，与上面独立开关
    this.marches = []          // { id, generalIds:[], from, to, departAt, arriveAt, phase:'out'|'back' }
    this.formations = []       // 玩家编队预设：{ id, name, generalIds:[id...] }（1~3 名武将，模板不锁武将）
    this._formationSeq = 1     // 编队 id 自增序号
    this.log = []              // 战报/事件日志（最近 50 条）
    this.damaged = new Set()   // 被挫伤（守军未满）的未占领地块，随时间回复
    this.victoryShown = false  // 「天下一统」只提示一次
    this._frozen = false       // 冻结后 save() 变为空操作（重置存档时用，防止 teardown 阶段的自动保存复活旧数据）

    // 主城落位
    const cityTile = this.tiles[spawn.y][spawn.x]
    cityTile.owner = 'player'
    cityTile.isCity = true
    cityTile.garrison = 0

    // 游戏内时钟（秒）。tick 按 TIME_SCALE 推进。
    this.now = 0
    this._acc = 0              // 产出结算的秒级累加器

    this._grantStarterSkills(3)   // 开局随机发 3 个战法进仓库（load() 会用存档覆盖）
  }

  // ── 战法仓库 & 绑定 ─────────────────────────────────────────────────────────
  // 每种战法仅一份，存在 this.skills；某战法是否「已绑定」由是否有武将 g.skillIds 指向它决定。
  // 绑定规则：一将至多 maxSkillSlots(lv) 法（默认 1，20 级解锁第 2 槽）、一法至多绑 1 将；
  // 解绑/销毁武将后战法自动回到可用池（仍在仓库里）。

  _grantStarterSkills(n) {
    // 开局起手战法只发 S 档，让新玩家一上来就摸到强力战法；S 档不够 n 个时（理论不会发生，
    // 目前 S 档有 6 个）退回全档池兜底，避免游戏内容变动后这里静默发出更少的战法。
    const sTier = BINDABLE_SKILLS.filter(s => s.tier === 'S').map(s => s.id)
    const pool = sTier.length >= n ? sTier : BINDABLE_SKILLS.map(s => s.id)
    for (let i = pool.length - 1; i > 0; i--) {   // Fisher-Yates
      const j = Math.floor(Math.random() * (i + 1));[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    this.skills = pool.slice(0, Math.min(n, pool.length))
  }

  /** 仓库全部战法 id */
  ownedSkills() { return this.skills.slice() }
  /** 某战法当前绑定的武将（无则 null） */
  skillBoundTo(skillId) { return this.generals.find(g => (g.skillIds || []).includes(skillId)) || null }
  /** 未被任何武将绑定、可自由绑定的战法 id */
  availableSkills() { return this.skills.filter(id => !this.skillBoundTo(id)) }

  /** 获得一个战法进仓库（第三期兑换用；已有则忽略） */
  grantSkill(skillId) {
    if (!getSkill(skillId) || this.skills.includes(skillId)) return
    this.skills.push(skillId)
    this.emit('skills', this.skills)
  }

  /**
   * 玉石兑换战法。扣 cost 玉石，战法入仓库，初始 Lv.1。
   * @returns {{success:true} | {error:string}}
   */
  buySkill(skillId) {
    const sk = getSkill(skillId)
    if (!sk) return { error: '战法不存在' }
    if (this.skills.includes(skillId)) return { error: '已拥有该战法' }
    const cost = sk.cost || 0
    if ((this.res.jade || 0) < cost) return { error: `玉石不足（需 ${cost}）` }
    this.res.jade -= cost
    this.skills.push(skillId)
    this.skillLevels[skillId] = 1
    this._pushLog(`💎 兑换战法【${sk.name}】，消耗 ${cost} 玉石`)
    this.emit('skills', this.skills)
    this.emit('resources', this.res)
    return { success: true }
  }

  /**
   * 升级战法。消耗 = cost × 当前等级。
   * @returns {{success:true, level:number} | {error:string}}
   */
  upgradeSkill(skillId) {
    const sk = getSkill(skillId)
    if (!sk) return { error: '战法不存在' }
    if (!this.skills.includes(skillId)) return { error: '尚未拥有该战法' }
    const curLv = this.skillLevels[skillId] || 1
    if (curLv >= SKILL_MAX_LEVEL) return { error: '战法已满级' }
    const cost = (sk.cost || 0) * curLv
    if ((this.res.jade || 0) < cost) return { error: `玉石不足（需 ${cost}）` }
    this.res.jade -= cost
    this.skillLevels[skillId] = curLv + 1
    this._pushLog(`⬆️ 战法【${sk.name}】升至 ${curLv + 1} 级，消耗 ${cost} 玉石`)
    this.emit('skills', this.skills)
    this.emit('resources', this.res)
    return { success: true, level: curLv + 1 }
  }

  /** 查询战法当前等级（未拥有/缺省=1） */
  skillLevel(skillId) {
    return this.skillLevels[skillId] || 1
  }

  // ── 装备仓库 & 绑定 ─────────────────────────────────────────────────────────
  // 每件装备实例 iid 全局唯一，存在 this.equipments；某装备是否「已绑定」由 boundTo 字段决定。
  // 绑定规则：6 槽，每名武将每种类型最多 1 件；同一装备同时只能被 1 个武将绑定。

  /** 仓库全部装备实例 */
  ownedEquipments() { return this.equipments.slice() }
  /** 仓库内未绑定装备（可装给武将） */
  availableEquipments(type) {
    return this.equipments.filter(e => !e.boundTo && (!type || e.type === type))
  }
  /** 按 iid 取装备实例 */
  equipment(iid) { return this.equipments.find(e => e.iid === iid) || null }

  /**
   * 抽装备。扣 EQUIP_DRAW_COST 铜币，随机掷品质/类型/属性，入仓库 Lv.1。
   * @returns {{success:true, eq} | {error:string}}
   */
  drawEquipment() {
    if (this.res.coin < EQUIP_DRAW_COST) return { error: `铜币不足（需 ${EQUIP_DRAW_COST}）` }
    this.res.coin -= EQUIP_DRAW_COST
    const rolled = rollEquipment()

    // 需求：自动转换玉石开关——开启后普通/精良装备直接转为玉石，不入仓库；
    // 精锐装备由独立开关 autoJadeEquipElite 控制，两个开关互不影响
    if ((this.autoJadeEquipCommon && (rolled.quality === 'common' || rolled.quality === 'rare')) ||
        (this.autoJadeEquipElite && rolled.quality === 'elite')) {
      const jade = EQUIP_DISMISS_JADE[rolled.quality] ?? 0
      this.res.jade = (this.res.jade || 0) + jade
      const name = equipName({ type: rolled.type, quality: rolled.quality, attr: rolled.attr, level: 1 })
      this._pushLog(`💎 ${name} 自动转换为 ${jade} 玉石`)
      this.emit('resources', this.res)
      return { success: true, type: 'jade', jade, name, quality: rolled.quality }
    }

    const iid = `eq_${++this._equipSeq}`
    const eq = { iid, ...rolled, boundTo: null }
    this.equipments.push(eq)
    this._pushLog(`✨ 抽得【${equipName(eq)}】${equipDesc(eq)}`)
    this.emit('equipments', this.equipments)
    this.emit('resources', this.res)
    return { success: true, eq }
  }

  /**
   * 升级装备。消耗 = costBase × 当前等级。
   * @returns {{success:true, level:number} | {error:string}}
   */
  upgradeEquipment(iid) {
    const eq = this.equipment(iid)
    if (!eq) return { error: '装备不存在' }
    if (equipMaxed(eq)) return { error: '装备已满级' }
    const cost = equipUpgradeCost(eq)
    if (this.res.coin < cost) return { error: `铜币不足（需 ${cost}）` }
    this.res.coin -= cost
    eq.level += 1
    this._pushLog(`⬆️【${equipName(eq)}】升至 ${eq.level} 级，消耗 ${cost} 铜币`)
    this.emit('equipments', this.equipments)
    this.emit('resources', this.res)
    return { success: true, level: eq.level }
  }

  /**
   * 给武将绑定装备（指定槽位）。若该槽已有装备则自动卸下回仓库。
   * @returns {null|string} 成功返回 null，失败返回错误信息
   */
  bindEquip(generalId, iid) {
    const g = this.general(generalId)
    if (!g) return '武将不存在'
    const eq = this.equipment(iid)
    if (!eq) return '装备不存在'
    if (!g.equip) g.equip = { weapon: null, helmet: null, necklace: null, armor: null, belt: null, boots: null }
    const holder = this.equipments.find(e => e.iid === g.equip[eq.type])
    if (eq.boundTo && eq.boundTo !== generalId) {
      const other = this.general(eq.boundTo)
      return `【${equipName(eq)}】已被 ${other?.name || '其他武将'} 装备`
    }
    // 卸下原装备
    if (holder) holder.boundTo = null
    // 装上新装备
    g.equip[eq.type] = iid
    eq.boundTo = generalId
    this._pushLog(`📜 ${g.name} 装备【${equipName(eq)}】`)
    this.emit('generals', this.generals)
    this.emit('equipments', this.equipments)
    return null
  }

  /** 卸下武将某槽位的装备 */
  unbindEquip(generalId, type) {
    const g = this.general(generalId)
    if (!g || !g.equip) return
    const iid = g.equip[type]
    if (!iid) return
    const eq = this.equipment(iid)
    if (eq) eq.boundTo = null
    g.equip[type] = null
    this._pushLog(`📜 ${g.name} 卸下装备${eq ? `【${equipName(eq)}】` : ''}`)
    this.emit('generals', this.generals)
    this.emit('equipments', this.equipments)
  }

  /**
   * 销毁装备，按品质返还玉石。若装备中会先自动卸下。
   * @returns {{success:true, jade:number} | {error:string}}
   */
  dismissEquipment(iid) {
    const idx = this.equipments.findIndex(e => e.iid === iid)
    if (idx === -1) return { error: '装备不存在' }
    const eq = this.equipments[idx]
    if (eq.boundTo) this.unbindEquip(eq.boundTo, eq.type)
    const jade = EQUIP_DISMISS_JADE[eq.quality] ?? 0
    this.equipments.splice(idx, 1)
    this.res.jade = (this.res.jade || 0) + jade
    this._pushLog(`🗑️ 销毁【${equipName(eq)}】，获得 ${jade} 玉石`)
    this.emit('equipments', this.equipments)
    this.emit('resources', this.res)
    return { success: true, jade }
  }

  /** 计算武将某属性的装备加成总和 */
  equipBonus(g, attr) {
    if (!g.equip) return 0
    let sum = 0
    for (const type of EQUIP_TYPES.map(t => t.id)) {
      const iid = g.equip[type]
      if (!iid) continue
      const eq = this.equipment(iid)
      if (eq && eq.attr === attr) sum += equipValue(eq)
    }
    return sum
  }

  /**
   * 武将实战属性（战斗时实际使用的值，与 _arriveAndFight 内部计算口径完全一致）。
   * 设计意图：守将 guardStat 系数 4（一次性给 +4×成长/级），玩家通过
   *   "升级 +2×成长 + 战斗再 +2×成长 = 4×成长" 对齐，故四项属性都补等级加成。
   * spd 是五维平均值（无独立 LEVELUP_SPD），按五维平均口径计算。
   * 供 UI 面板显示与战斗结算共用，避免出现"面板属性 vs 战报实战值"不一致。
   */
  effStats(g) {
    const forgeBonus = FORGE_STAT_PER_LEVEL * this.buildings.forge
    const lvBonus = (lv, k) => (lv - 1) * k * growthOf(g.quality)
    // spd 由五维平均值得出，临时战斗加成也取五维等级加成的平均值
    const avgLevelup = (LEVELUP_ATK + LEVELUP_DEF + LEVELUP_INT + LEVELUP_POL + LEVELUP_CHA) / 5
    return {
      atk: g.atk + lvBonus(g.lv, LEVELUP_ATK) + forgeBonus + this.equipBonus(g, 'atk'),
      def: g.def + lvBonus(g.lv, LEVELUP_DEF) + forgeBonus + this.equipBonus(g, 'def'),
      int: g.int + lvBonus(g.lv, LEVELUP_INT) + forgeBonus + this.equipBonus(g, 'int'),
      spd: g.spd + lvBonus(g.lv, avgLevelup) + (TROOP_TYPES[g.troopType]?.marchSpeed || 0) + forgeBonus + this.equipBonus(g, 'spd'),
    }
  }

  /** 武将当前战法槽位数（1；20 级起 2） */
  skillSlotsOf(g) { return maxSkillSlots(g.lv) }

  /**
   * 给武将指定槽位绑定战法。slot=0 为主槽（人人可用），slot=1 为副槽（需 20 级解锁）。
   * 返回错误信息或 null。同一战法不可在同一武将的两个槽位重复装备。
   */
  bindSkill(generalId, skillId, slot = 0) {
    const g = this.general(generalId)
    if (!g) return '武将不存在'
    if (!this.skills.includes(skillId)) return '尚未拥有该战法'
    if (slot < 0 || slot >= MAX_SKILL_SLOTS) return '战法槽位不存在'
    if (slot >= maxSkillSlots(g.lv)) return `武将等级达到 ${SKILL_SLOT2_LEVEL} 级才能装备第二个战法`
    const holder = this.skillBoundTo(skillId)
    if (holder && holder.id !== generalId) return `【${getSkill(skillId)?.name}】已绑定 ${holder.name}`
    if (!Array.isArray(g.skillIds)) g.skillIds = [null, null]
    if (g.skillIds.some((id, i) => id === skillId && i !== slot)) return '该武将已在另一槽位装备此战法'
    g.skillIds[slot] = skillId
    this._pushLog(`📜 ${g.name} 装备战法【${getSkill(skillId)?.name}】`)
    this.emit('generals', this.generals)
    this.emit('skills', this.skills)
    return null
  }

  /** 解绑武将指定槽位战法，战法回到可用池 */
  unbindSkill(generalId, slot = 0) {
    const g = this.general(generalId)
    if (!g || !Array.isArray(g.skillIds) || !g.skillIds[slot]) return
    const name = getSkill(g.skillIds[slot])?.name
    g.skillIds[slot] = null
    this._pushLog(`📜 ${g.name} 卸下战法${name ? `【${name}】` : ''}`)
    this.emit('generals', this.generals)
    this.emit('skills', this.skills)
  }

  // ── 时钟 ──────────────────────────────────────────────────────────────────

  /** 渲染层每帧调用；dtMs 为真实毫秒 */
  tick(dtMs) {
    const dt = (dtMs / 1000) * TIME_SCALE
    this.now += dt
    this._acc += dt
    if (this._acc >= 1) {
      const secs = Math.floor(this._acc)
      this._acc -= secs
      this._produce(secs)
    }
    this._processMarches()
  }

  /** 标签页从隐藏/失焦恢复可见时调用：浏览器会整页暂停 rAF，tick 期间不会被调用，
   *  这里按真实经过时长补算一次产出与行军（沿用离线收益的封顶规则，避免挂后台异常暴涨）*/
  catchUp(elapsedMs) {
    const offlineSecs = Math.max(0, elapsedMs / 1000)
    const gameSecs = Math.min(offlineSecs * TIME_SCALE, OFFLINE_CAP_SECONDS)
    if (gameSecs <= 0) return
    this.now += gameSecs
    this._produce(gameSecs)
    this._processMarches()
  }

  // ── 资源产出 ──────────────────────────────────────────────────────────────

  /** 每小时产量汇总（含粮仓加成，供 UI 展示与 _produce 结算） */
  yieldPerHour() {
    const y = { coin: 0, grain: 0, wood: 0, iron: 0, stone: 0 }
    for (const t of this.ownedTiles()) {
      y.coin += t.level * COIN_YIELD_PER_LEVEL
      const res = TILE_TYPES[t.type].res
      if (res === 'all') {
        const each = t.level * BASE_YIELD_PER_LEVEL / 2
        y.grain += each; y.wood += each; y.iron += each; y.stone += each
      } else if (res) {
        y[res] += t.level * BASE_YIELD_PER_LEVEL
      }
    }
    // 粮仓：全资源产出叠乘（含铜币）
    const mult = 1 + GRANARY_YIELD_PER_LEVEL * this.buildings.granary
    for (const key of Object.keys(y)) y[key] *= mult
    return y
  }

  /** 武将带兵上限 = 等级基线 + 兵营加成 */
  troopCap(g) { return troopCapOf(g.lv) + BARRACKS_CAP_PER_LEVEL * this.buildings.barracks }

  _produce(gameSeconds) {
    const y = this.yieldPerHour()
    const k = gameSeconds / 3600
    for (const key of Object.keys(y)) this.res[key] += y[key] * k
    this.emit('resources', this.res)
    this._regenGarrisons(gameSeconds)
    this._trainGenerals(k)
    this._regenStamina(k)
  }

  /** 校场：在城武将按等级挂机获得经验 */
  _trainGenerals(hours) {
    const exp = TRAINING_EXP_PER_LEVEL * this.buildings.training * hours
    if (exp <= 0) return
    for (const g of this.generals) {
      if (g.state === 'idle') this._gainExp(g, exp)
    }
  }

  /** 体力回复：全体武将（在城或行军均回复），封顶 STAMINA_MAX */
  _regenStamina(hours) {
    const gain = STAMINA_REGEN_PER_HOUR * hours
    for (const g of this.generals) {
      g.stamina = Math.min(STAMINA_MAX, (g.stamina ?? STAMINA_MAX) + gain)
    }
  }

  /** 被挫伤的未占领地块，守将各队按每游戏小时 10% 队伍上限缓慢回复 */
  _regenGarrisons(gameSeconds) {
    if (!this.damaged.size) return
    for (const t of this.damaged) {
      if (t.owner === 'player') { this.damaged.delete(t); continue }
      const teamMax = garrisonOf(t.level, t.type) / (t.guards.length || 1)
      let allFull = true
      for (const gd of t.guards) {
        gd.troops = Math.min(teamMax, gd.troops + teamMax * GARRISON_REGEN_PER_HOUR * gameSeconds / 3600)
        if (gd.troops < teamMax) allFull = false
      }
      t.garrison = t.guards.reduce((s, gd) => s + gd.troops, 0)
      if (allFull) this.damaged.delete(t)
    }
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  tileAt(x, y) {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return null
    return this.tiles[y][x]
  }

  ownedTiles() {
    const out = []
    for (const row of this.tiles) for (const t of row) if (t.owner === 'player') out.push(t)
    return out
  }

  territoryCount() { return this.ownedTiles().length }
  territoryCapNow() { return territoryCap(this.cityLv) }
  /** 势力值 = 领地等级总和 × 10 */
  power() { return this.ownedTiles().reduce((s, t) => s + t.level, 0) * 10 }

  /** 游戏内历法：{ year, month, day }，从公元 1 年 1 月 1 日起算（仅用于展示） */
  gameDate() {
    const y = Math.floor(this.now / GAME_SECONDS_PER_YEAR)
    const monthSec = this.now % GAME_SECONDS_PER_YEAR
    const m = Math.floor(monthSec / GAME_SECONDS_PER_MONTH)
    const d = Math.floor((monthSec % GAME_SECONDS_PER_MONTH) / GAME_SECONDS_PER_DAY)
    return { year: GAME_START_YEAR + y, month: m + 1, day: d + 1 }
  }

  /** 是否与己方领地八向相邻（出征前提） */
  isAdjacentToTerritory(x, y) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const t = this.tileAt(x + dx, y + dy)
        if (t && t.owner === 'player') return true
      }
    }
    return false
  }

  general(id) { return this.generals.find(g => g.id === id) }
  idleGenerals() { return this.generals.filter(g => g.state === 'idle' && g.troops > 0) }

  // ── 征兵 ──────────────────────────────────────────────────────────────────

  /** 给武将补兵到指定数量（受带兵上限与粮食约束），返回错误信息或 null */
  recruit(generalId, count) {
    const g = this.general(generalId)
    if (!g) return '武将不存在'
    if (g.state !== 'idle') return '武将出征中，无法征兵'
    const cap = this.troopCap(g)
    count = Math.min(count, cap - g.troops)
    if (count <= 0) return '已达带兵上限'
    const unit = getRecruitCostPerTroop(this.cityLv)
    const cost = { grain: count * unit.grain, iron: count * unit.iron, wood: count * unit.wood }
    for (const [k, v] of Object.entries(cost)) {
      if (this.res[k] < v) return `${RESOURCES[k].name}不足（需 ${v}）`
    }
    for (const [k, v] of Object.entries(cost)) this.res[k] -= v
    g.troops += count
    this.emit('resources', this.res)
    this.emit('generals', this.generals)
    return null
  }

  /**
   * 一键补满所有空闲且未满兵武将。
   * 若资源不足以补满全部，则不做任何操作并返回缺少的资源提示。
   * @returns {{recruited:number, cost:{grain:number,iron:number,wood:number}, lacked:string|null}}
   */
  recruitAll() {
    const unit = getRecruitCostPerTroop(this.cityLv)
    const details = []
    for (const g of this.generals) {
      if (g.state !== 'idle') continue
      const cap = this.troopCap(g)
      const need = cap - g.troops
      if (need <= 0) continue
      details.push({ g, need })
    }
    if (details.length === 0) return { recruited: 0, cost: { grain: 0, iron: 0, wood: 0 }, lacked: '所有武将已满兵' }

    const cost = {
      grain: details.reduce((s, d) => s + d.need, 0) * unit.grain,
      iron: details.reduce((s, d) => s + d.need, 0) * unit.iron,
      wood: details.reduce((s, d) => s + d.need, 0) * unit.wood,
    }

    for (const [k, v] of Object.entries(cost)) {
      if (this.res[k] < v) return { recruited: 0, cost, lacked: `${RESOURCES[k].name}不足（需 ${v}）` }
    }

    for (const [k, v] of Object.entries(cost)) this.res[k] -= v
    for (const { g, need } of details) g.troops += need

    this.emit('resources', this.res)
    this.emit('generals', this.generals)
    this._pushLog(`🛡️ 一键补满 ${details.length} 名武将，消耗 ${cost.grain}粮${cost.iron}铁${cost.wood}木`)
    return { recruited: details.reduce((s, d) => s + d.need, 0), cost, lacked: null }
  }

  // ── 招募（抽卡）────────────────────────────────────────────────────────────

  /** 掷品质：按各档 rate 加权（Math.random，单机版无需确定性） */
  _rollQuality() {
    const total = Object.values(GENERAL_QUALITY).reduce((s, q) => s + q.rate, 0)
    let r = Math.random() * total
    for (const [key, q] of Object.entries(GENERAL_QUALITY)) {
      r -= q.rate
      if (r < 0) return key
    }
    return 'common'
  }

  /**
   * 遣散武将，无视等级、觉醒、状态。按品质产出玉石（见 docs/slg-战法升级与扩展设计.md 6.6）。
   * @returns {{success:true, jade:number} | {error:string}}
   */
  dismissGeneral(id) {
    const idx = this.generals.findIndex(g => g.id === id)
    if (idx === -1) return { error: '武将不存在' }
    const g = this.generals[idx]
    if (g.state === 'marching') return { error: `${g.name} 正在行军中，无法遣散` }
    const jade = DISMISS_JADE[g.quality] ?? 1
    this.generals.splice(idx, 1)
    this.res.jade = (this.res.jade || 0) + jade
    // 编队预设是模板引用，遣散后要把该武将从所有编队里摘掉，否则编队里留下幽灵 id，出征时报错
    let formationsChanged = false
    for (const f of this.formations) {
      const i = f.generalIds.indexOf(id)
      if (i >= 0) { f.generalIds.splice(i, 1); formationsChanged = true }
    }
    this._pushLog(`🗑️ 遣散 ${g.name}（${GENERAL_QUALITY[g.quality]?.name || ''}），获得 ${jade} 玉石`)
    this.emit('generals', this.generals)
    this.emit('resources', this.res)
    if (formationsChanged) this.emit('formations', this.formations)
    return { success: true, jade }
  }

  /**
   * 铜币招募一名武将。返回 { error } 或 { type:'new'|'awaken', name, quality, general }。
   * - 抽到未拥有且阵容未满 → 入列新武将
   * - 抽到已拥有 → 该武将觉醒（+武/+防/+智/+速）
   * - 阵容已满且抽到新武将 → 转为觉醒一名同池随机已有武将（不浪费）
   */
  recruitGeneral() {
    // 需求 3：武将名额上限检查——满员后无法继续招募（即使抽到重复也禁止）
    if (this.generals.length >= MAX_GENERALS) {
      return { error: `武将名额已满（${MAX_GENERALS}/${MAX_GENERALS}），请先遣散武将` }
    }
    const free = this.freeRecruits > 0
    if (!free && this.res.coin < RECRUIT_COST_COIN) return { error: `铜币不足（需 ${RECRUIT_COST_COIN}）` }
    if (free) this.freeRecruits--
    else this.res.coin -= RECRUIT_COST_COIN

    // 免费招募次数内必出王牌（Legend），免费次数用完后按正常概率抽取
    const quality = free ? 'legend' : this._rollQuality()
    const pool = RECRUITABLE_GENERALS.filter(g => g.quality === quality)
    // 该档无可招募武将则退回普通档兜底
    const tpl = (pool.length ? pool : RECRUITABLE_GENERALS)[
      Math.floor(Math.random() * (pool.length ? pool.length : RECRUITABLE_GENERALS.length))]

    let result
    // 需求 1：自动转换玉石开关——开启后普通/精良武将直接转为玉石，不入列也不觉醒；
    // 精锐武将由独立开关 autoJadeElite 控制，两个开关互不影响
    if ((this.autoJadeCommon && (quality === 'common' || quality === 'rare')) ||
        (this.autoJadeElite && quality === 'elite')) {
      const jade = DISMISS_JADE[quality] ?? 1
      this.res.jade = (this.res.jade || 0) + jade
      this._pushLog(`💎 ${tpl.name}（${GENERAL_QUALITY[quality].name}）自动转换为 ${jade} 玉石`)
      result = { type: 'jade', name: tpl.name, quality, jade }
    } else {
      const owned = this.general(tpl.id)
      if (owned) {
        // 需求 2：已拥有武将自动进阶（觉醒）
        const gain = this._awaken(owned)
        this._pushLog(`✨ ${owned.name} 觉醒（五维提升，第 ${owned.awaken} 次）`)
        result = { type: 'awaken', name: owned.name, quality: owned.quality, general: owned }
      } else {
        // 新武将入列（此时已确保未满员）
        const g = makeGeneral(tpl, free && this.generals.length === 0)
        this.generals.push(g)
        this._pushLog(`🎲 招募新武将 ${g.name}（${GENERAL_QUALITY[g.quality].name}）`)
        result = { type: 'new', name: g.name, quality: g.quality, general: g }
      }
    }
    this.emit('resources', this.res)
    this.emit('generals', this.generals)
    return result
  }

  /** 觉醒：属性提升 = 基础值 × 品质成长值。返回本次实际增量（供日志展示） */
  _awaken(g) {
    g.awaken = (g.awaken || 0) + 1
    const gr = growthOf(g.quality)
    const gain = {
      atk: Math.round(AWAKEN_ATK * gr * 10) / 10,
      def: Math.round(AWAKEN_DEF * gr * 10) / 10,
      int: Math.round(AWAKEN_INT * gr * 10) / 10,
      pol: Math.round(AWAKEN_POL * gr * 10) / 10,
      cha: Math.round(AWAKEN_CHA * gr * 10) / 10,
    }
    g.atk += gain.atk
    g.def += gain.def
    g.int += gain.int
    g.pol += gain.pol
    g.cha += gain.cha
    g.spd = calcSpd(g)
    return gain
  }

  /** 按等级降序排列武将（等级相同时按觉醒次数降序） */
  sortedGenerals() {
    return [...this.generals].sort((a, b) => {
      if (b.lv !== a.lv) return b.lv - a.lv
      return (b.awaken || 0) - (a.awaken || 0)
    })
  }

  // ── 主城 ──────────────────────────────────────────────────────────────────

  upgradeCity() {
    if (this.cityLv >= CITY_MAX_LEVEL) return '主城已满级'
    const cost = cityUpgradeCost(this.cityLv + 1)
    for (const [k, v] of Object.entries(cost)) {
      if (this.res[k] < v) return `${k === 'coin' ? '铜币' : k === 'wood' ? '木材' : '石料'}不足`
    }
    for (const [k, v] of Object.entries(cost)) this.res[k] -= v
    this.cityLv++
    this._pushLog(`🏯 主城升至 ${this.cityLv} 级，领地上限 ${this.territoryCapNow()}`)
    this.emit('resources', this.res)
    this.emit('city', this.cityLv)
    return null
  }

  // ── 建筑 ──────────────────────────────────────────────────────────────────

  /** 升级建筑（等级不得超过主城等级）。返回错误信息或 null */
  upgradeBuilding(type) {
    if (!(type in this.buildings)) return '建筑不存在'
    const lv = this.buildings[type]
    if (lv >= BUILDING_MAX_LEVEL) return '该建筑已满级'
    if (lv >= this.cityLv) return `需先将主城升至 ${lv + 1} 级`
    const cost = buildingUpgradeCost(type, lv + 1)
    for (const [k, v] of Object.entries(cost)) {
      if (this.res[k] < v) return `${RESOURCES[k].name}不足`
    }
    for (const [k, v] of Object.entries(cost)) this.res[k] -= v
    this.buildings[type]++
    this._pushLog(`${BUILDINGS[type].icon} ${BUILDINGS[type].name} 升至 ${this.buildings[type]} 级`)
    this.emit('resources', this.res)
    this.emit('buildings', this.buildings)
    return null
  }

  // ── 出征 / 行军 ────────────────────────────────────────────────────────────

  /** 武将有效行军速度 = 基础速度 + 兵种加成 + 铁匠坊/装备速度加成 */
  _marchSpeed(g) {
    const forgeBonus = FORGE_STAT_PER_LEVEL * this.buildings.forge
    return g.spd + (TROOP_TYPES[g.troopType]?.marchSpeed || 0) + forgeBonus + this.equipBonus(g, 'spd')
  }

  /** 出征预估（供 UI 显示路程/耗时）。返回 { steps, gameSeconds, path } */
  estimateMarch(generalIds, tx, ty) {
    const ids = Array.isArray(generalIds) ? generalIds : [generalIds]
    const gens = ids.map(id => this.general(id)).filter(Boolean)
    const path = findPath(this.tiles, this.spawn, { x: tx, y: ty })
    const steps = path.length - 1
    const minSpd = gens.length ? Math.min(...gens.map(g => this._marchSpeed(g))) : MARCH_REF_SPEED
    return { steps, gameSeconds: steps * tileMarchSeconds(minSpd), path }
  }

  /** 派一名或多名武将合击目标地块。generalIds 可传数组或单个 id。返回错误信息或 null */
  march(generalIds, tx, ty) {
    const ids = Array.isArray(generalIds) ? generalIds : [generalIds]
    if (!ids.length) return '请选择出征武将'
    if (ids.length > MAX_MARCH_PARTY) return `最多同时出征 ${MAX_MARCH_PARTY} 队`
    const gens = []
    for (const id of ids) {
      const g = this.general(id)
      if (!g) return '武将不存在'
      if (g.state !== 'idle') return `${g.name} 已在行军中`
      if (g.troops <= 0) return `${g.name} 没有兵力，请先征兵`
      if ((g.stamina ?? STAMINA_MAX) < MARCH_STAMINA_COST) {
        const wait = Math.ceil((MARCH_STAMINA_COST - (g.stamina ?? STAMINA_MAX)) / STAMINA_REGEN_PER_HOUR)
        return `${g.name} 体力不足，约 ${wait} 分钟后可再出征`
      }
      gens.push(g)
    }
    const target = this.tileAt(tx, ty)
    if (!target) return '目标超出地图'
    if (!TILE_TYPES[target.type].passable) return '目标不可通行'
    if (target.owner === 'player') return '这是己方领地'
    if (!this.isAdjacentToTerritory(tx, ty)) return '只能攻打与领地相邻的地块'
    if (this.territoryCount() >= this.territoryCapNow()) {
      return `领地已达上限（${this.territoryCapNow()}），请升级主城或放弃部分领地`
    }

    // 合击：沿网格逐格行军，按全队最慢的有效速度计时
    const from = this.spawn
    const path = findPath(this.tiles, from, { x: tx, y: ty })
    const steps = path.length - 1
    const minSpd = Math.min(...gens.map(g => this._marchSpeed(g)))
    const dur = steps * tileMarchSeconds(minSpd)   // 游戏内秒
    const m = {
      id: marchSeq++, generalIds: ids.slice(),
      from: { x: from.x, y: from.y }, to: { x: tx, y: ty }, path,
      departAt: this.now, arriveAt: this.now + dur, phase: 'out',
    }
    for (const g of gens) {
      g.state = 'marching'
      g.stamina = (g.stamina ?? STAMINA_MAX) - MARCH_STAMINA_COST
    }
    this.marches.push(m)
    const total = gens.reduce((s, g) => s + g.troops, 0)
    this._pushLog(`⚔️ ${gens.map(g => g.name).join('、')} 率 ${total} 兵出征 (${tx},${ty})`)
    this.emit('marches', this.marches)
    this.emit('generals', this.generals)
    return null
  }

  // ── 编队预设 ──────────────────────────────────────────────────────────────────
  // 编队是「模板」而非锁：同一武将可出现在多个编队中；出征时实时校验 idle/兵力/体力。
  // 一键出征只派当前可用的武将，全不可用则报错（避免误送单将深入险地）。

  /** 创建编队。name 为空则用默认名。返回 { id } 或错误字符串 */
  createFormation(name) {
    if (this.formations.length >= MAX_FORMATIONS) return `编队已满（${MAX_FORMATIONS} 队上限）`
    const n = (name || '').trim().slice(0, FORMATION_NAME_MAX_LEN) || `编队${this.formations.length + 1}`
    const f = { id: this._formationSeq++, name: n, generalIds: [] }
    this.formations.push(f)
    this.emit('formations', this.formations)
    return { id: f.id }
  }

  /** 更新编队：{ name?, generalIds? }。返回 null 或错误字符串 */
  updateFormation(id, { name, generalIds } = {}) {
    const f = this.formations.find(x => x.id === id)
    if (!f) return '编队不存在'
    if (name !== undefined) {
      const n = String(name).trim().slice(0, FORMATION_NAME_MAX_LEN)
      if (n) f.name = n
    }
    if (generalIds !== undefined) {
      if (!Array.isArray(generalIds)) return '武将列表格式错误'
      if (generalIds.length > MAX_MARCH_PARTY) return `编队最多 ${MAX_MARCH_PARTY} 名武将`
      const seen = new Set()
      for (const gid of generalIds) {
        if (!this.generals.some(g => g.id === gid)) return `武将 ${gid} 不存在`
        if (seen.has(gid)) return '编队内武将不可重复'
        seen.add(gid)
      }
      f.generalIds = generalIds.slice()
    }
    this.emit('formations', this.formations)
    return null
  }

  /** 删除编队 */
  deleteFormation(id) {
    const i = this.formations.findIndex(x => x.id === id)
    if (i < 0) return '编队不存在'
    this.formations.splice(i, 1)
    this.emit('formations', this.formations)
    return null
  }

  /** 编队整队出征：编队内所有武将都必须 idle + 有兵 + 体力足。返回错误或 null */
  marchFormation(formationId, tx, ty) {
    const f = this.formations.find(x => x.id === formationId)
    if (!f) return '编队不存在'
    if (f.generalIds.length === 0) return `${f.name} 编队为空，请先编辑`
    for (const id of f.generalIds) {
      const g = this.general(id)
      if (!g) return `武将 ${id} 不存在`
      if (g.state !== 'idle') return `${g.name} 已在行军中`
      if (g.troops <= 0) return `${g.name} 没有兵力，请先征兵`
      if ((g.stamina ?? STAMINA_MAX) < MARCH_STAMINA_COST) {
        const wait = Math.ceil((MARCH_STAMINA_COST - (g.stamina ?? STAMINA_MAX)) / STAMINA_REGEN_PER_HOUR)
        return `${g.name} 体力不足，约 ${wait} 分钟后可再出征`
      }
    }
    return this.march(f.generalIds.slice(), tx, ty)
  }


  _processMarches() {
    let changed = false
    for (const m of this.marches) {
      if (m.arriveAt > this.now) continue
      changed = true
      if (m.phase === 'out') this._arriveAndFight(m)
      else this._returnHome(m)
    }
    if (changed) {
      this.marches = this.marches.filter(m => !m.done)
      this.emit('marches', this.marches)
      this.emit('generals', this.generals)
    }
  }

  _arriveAndFight(m) {
    const gens = m.generalIds.map(id => this.general(id)).filter(Boolean)
    const t = this.tileAt(m.to.x, m.to.y)
    const names = gens.map(g => g.name).join('、')

    // 行军期间地块已被己方先占领（如另一支队抢先攻下）：不再战斗/占领/掠夺，直接折返
    if (t && t.owner === 'player') {
      this._pushLog(`ℹ️ ${names} 抵达时 ${TILE_TYPES[t.type].name} (${t.x},${t.y}) 已是己方领地，未交战折返`)
      const steps = (m.path?.length ?? 1) - 1
      const minSpd = Math.min(...gens.map(g => this._marchSpeed(g)))
      m.phase = 'back'
      m.departAt = this.now
      m.arriveAt = this.now + steps * tileMarchSeconds(minSpd)
      return
    }

    // 分波次战斗：守军按编队分组（每 FORMATION_SIZE 名一队），攻方先打第 1 队，
    // 残余兵力继续打第 2 队，依此类推。攻方胜当且仅当所有守军编队被全灭。
    // 实战属性折算见 effStats()：等级加成 +(lv-1)*2×成长 + 铁匠坊全属性 + 装备主属性；
    // 速度另叠兵种加成（骑兵 +30，与行军同口径）。
    const atkInitial = gens.map(g => g.troops)   // 攻方初始兵力（首波入场）
    let atkCurrent = atkInitial.slice()          // 攻方当前兵力（每波结束更新为残余）
    const total = atkInitial.reduce((s, n) => s + n, 0)
    const effOf = g => this.effStats(g)

    // 守将单位：一队 = 一名武将，模板缺失或 0 兵的跳过（不参战也不掉兵）
    // 守将战法按 guardLv 分段：1~5→无 / 6~10→B / 11~16→A / 17~20→S，
    // 越高级地块/城池守军战法越强，最低级的新手地块维持无战法。具体战法在同档内由
    // 存档种子/坐标/编队序号确定性选取（同地块同种子必同战法，回放/离线结算/重进游戏都一致）。
    const guardSkillTier = (lv) => (lv >= 17 ? 'S' : lv >= 11 ? 'A' : lv >= 6 ? 'B' : null)
    const guardSkillOf = (i, lv) => {
      const tier = guardSkillTier(lv)
      if (!tier) return { skillId: null, skillLv: 1 }
      const pool = BINDABLE_SKILLS.filter(s => s.tier === tier)
      const idx = Math.abs((Math.imul(this.seed | 0, 0x9E3779B1) ^ Math.imul(i, 0x85EBCA6B) ^ (t.x * 8887 + t.y * 2971))) % pool.length
      const skillLv = Math.min(SKILL_MAX_LEVEL, Math.max(1, Math.floor(lv / 2)))
      return { skillId: pool[idx].id, skillLv }
    }
    // 按编队分组：须先按 t.guards 原始下标切成固定的 FORMATION_SIZE 组，再判断整队是否全灭——
    // 不能先按兵力过滤再切片，否则「半死」的编队（有人阵亡、有人残血）会把下一队的守将并进来，
    // 打乱队伍边界（伤损未完全回满的地块被二次进攻时会触发，见伤损保留逻辑）。
    const rawWaves = []
    for (let i = 0; i < t.guards.length; i += FORMATION_SIZE) {
      const slice = []
      for (let j = i; j < Math.min(i + FORMATION_SIZE, t.guards.length); j++) {
        const gd = t.guards[j]
        const tpl = findGeneralTemplate(gd.id)
        if (!tpl) continue
        const { skillId, skillLv } = guardSkillOf(j, gd.lv)
        slice.push({ gd, i: j, tpl, skillId, skillLv })
      }
      rawWaves.push(slice)
    }
    // 守军初始总兵力（满兵）—— 战斗开始前的值，用于战报 defStart；只统计尚存活的守将
    const allGuardDefs = rawWaves.flat().filter(x => x.gd.troops > 0)
    const defStart = allGuardDefs.reduce((s, x) => s + x.gd.troops, 0)

    // 已全灭的编队跳过（不参战、不再进入 waves）；半死编队整队保留（0 兵成员进战斗后自动跳过）
    const waves = rawWaves.filter(wave => wave.some(x => x.gd.troops > 0))

    // 攻方跨波累计统计
    const atkAgg = new Map()
    gens.forEach(g => atkAgg.set(g.id, {
      dealt: 0, taken: 0, healed: 0, lifesteal: 0,
      skillFire: 0, extra: 0, control: 0, buffCast: 0, debuffCast: 0, conditionMet: 0,
      shielded: 0, countered: 0, cleansed: 0,
    }))

    const allRounds = []
    const allFoeCards = []   // 所有波次守军 unitCard（每波独立 entry）
    let totalAtkLoss = 0
    let totalDefLoss = 0
    let totalExp = 0
    let totalDealt = 0
    let finalOutcome = 'win'   // 默认胜；遇到败/平覆盖
    let finalWaveIdx = 0       // 最终结局发生在第几波（0 = 守军空虚未交战）

    // 战报 v2：双方阵容卡（基础属性→实战属性 + 兵力/输出/承伤/战法统计）
    // skillIds：该单位携带的战法 id 数组（0~2 个，20 级武将可携带 2 个），展示时以顿号拼接
    const unitCard = (u, base, eff, quality, lv, troopType, skillIds) => ({
      key: u.key, name: u.name, quality, lv, troopType,
      skill: (skillIds || []).map(id => getSkill(id)?.name).filter(Boolean).join('、') || null,
      atk: Math.round(base.atk), atkEff: Math.round(eff.atk),
      def: Math.round(base.def), defEff: Math.round(eff.def),
      spd: Math.round(base.spd), spdEff: Math.round(eff.spd),
      int: Math.round(base.int), intEff: Math.round(eff.int),
      start: u.start, end: u.troops, dealt: u.dealt, taken: u.taken,
      healed: u.healed, lifesteal: u.lifesteal,
      skillFire: u.skillFire, extra: u.extra, control: u.control,
      buffCast: u.buffCast, debuffCast: u.debuffCast, conditionMet: u.conditionMet,
      shielded: u.shielded || 0, countered: u.countered || 0, cleansed: u.cleansed || 0,
    })

    // 守军空虚：不经交战直接判胜（给基础经验 50，按出兵比例分配）
    if (waves.length === 0) {
      totalExp = 50
    } else {
      // 战斗种子：由存档种子 + 行军 ID + 目标坐标确定 —— 同存档同输入必同结果（回放/离线一致）
      const baseSeed = (Math.imul(this.seed | 0, 0x9E3779B1) ^ Math.imul(m.id, 0x85EBCA6B) ^ (t.x * 8887 + t.y * 2971)) >>> 0
      for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
        // 过滤本波 0 兵守军（半死编队场景：伤损未回满被二次攻打时，0 兵成员不参战也不进战报）
        const wave = waves[waveIdx].filter(x => x.gd.troops > 0)
        if (wave.length === 0) continue   // 全灭编队跳过（waves 已过滤，双重保险）
        finalWaveIdx = waveIdx + 1
        const defUnits = wave.map(({ gd, i, tpl, skillId, skillLv }) => ({
          key: `${gd.id}:${i}`, name: tpl.name,
          atk: guardStat(tpl.atk, gd.lv, tpl.quality),
          def: guardStat(tpl.def, gd.lv, tpl.quality),
          int: guardStat(tpl.int, gd.lv, tpl.quality),
          pol: guardStat(tpl.pol, gd.lv, tpl.quality),
          cha: guardStat(tpl.cha, gd.lv, tpl.quality),
          spd: calcSpd({
            atk: guardStat(tpl.atk, gd.lv, tpl.quality),
            def: guardStat(tpl.def, gd.lv, tpl.quality),
            int: guardStat(tpl.int, gd.lv, tpl.quality),
            pol: guardStat(tpl.pol, gd.lv, tpl.quality),
            cha: guardStat(tpl.cha, gd.lv, tpl.quality),
          }) + (TROOP_TYPES[tpl.troopType]?.marchSpeed || 0),
          troops: gd.troops, troopType: tpl.troopType,
          skills: skillId ? [{ id: skillId, lv: skillLv }] : [],
        }))
        const atkUnits = gens.map((g, idx) => {
          const e = effOf(g)
          return {
            key: g.id, name: g.name,
            atk: e.atk, def: e.def, int: e.int, spd: e.spd,
            troops: atkCurrent[idx],   // 当前残余兵力入场
            troopType: g.troopType,
            skills: (g.skillIds || []).filter(Boolean).map(id => ({ id, lv: this.skillLevel(id) })),
          }
        }).filter(u => u.troops > 0)   // 兵力为 0 的武将不参加下一波战斗

        // 攻方全军覆没：无武将可战，直接判败，不再挑战后续守军编队
        if (atkUnits.length === 0) {
          finalOutcome = 'lose'
          break
        }

        // 每波战斗种子加波次偏移，避免重复序列
        const battleSeed = (baseSeed ^ Math.imul(waveIdx + 1, 0x9E3779B1)) >>> 0
        const r = resolveBattle(atkUnits, defUnits, battleSeed)

        // 合并回合（加 wave 标记，便于战报按波次分组显示）
        r.rounds.forEach(rd => { rd.wave = waveIdx + 1; allRounds.push(rd) })

        // 攻方残余兵力进入下一波
        r.units.atk.forEach(u => {
          const idx = gens.findIndex(g => g.id === u.key)
          if (idx >= 0) atkCurrent[idx] = u.troops
        })

        // 累加攻方统计
        r.units.atk.forEach(u => {
          const s = atkAgg.get(u.key)
          if (!s) return
          s.dealt += u.dealt; s.taken += u.taken
          s.healed += u.healed; s.lifesteal += u.lifesteal
          s.skillFire += u.skillFire; s.extra += u.extra
          s.control += u.control; s.buffCast += u.buffCast
          s.debuffCast += u.debuffCast; s.conditionMet += u.conditionMet
          s.shielded += u.shielded || 0; s.countered += u.countered || 0; s.cleansed += u.cleansed || 0
        })
        totalDealt += r.units.atk.reduce((s, u) => s + u.dealt, 0)

        // 守军伤损即时落账（胜则全灭清零，天然抹掉回复带来的小数残余）
        wave.forEach(({ gd, i }) => {
          const u = r.units.def.find(u => u.key === `${gd.id}:${i}`)
          if (u) gd.troops = u.troops
        })

        // 收集该波守军 unitCard（每波独立，end = 该波结束时兵力）
        wave.forEach(({ gd, i, tpl, skillId }) => {
          const u = r.units.def.find(u => u.key === `${gd.id}:${i}`)
          const eff = defUnits.find(d => d.key === `${gd.id}:${i}`)
          // tpl（招募池模板）不存 spd 字段（恒由 calcSpd 现算）：直接读 tpl.spd 会是 undefined
          // → Math.round 出 NaN → 存档 JSON 序列化后变 null → 战报显示「速null」
          allFoeCards.push(unitCard(u, { ...tpl, spd: calcSpd(tpl) }, eff, tpl.quality, gd.lv, tpl.troopType, skillId ? [skillId] : []))
        })

        totalAtkLoss += r.atkLoss
        totalDefLoss += r.defLoss
        totalExp += r.exp

        if (r.outcome !== 'win') {
          finalOutcome = r.outcome   // 败或平，结束战斗
          break
        }
        // 攻方胜，继续下一波（残余兵力自动进入）
      }
    }

    // 伤亡逐将落账 + 经验分配（按跨波累计输出占比 70% + 出兵占比 30%）
    // （纯控制/承伤流武将也能分到经验；守军空虚时 totalDealt=0 退化为纯出兵比例）
    gens.forEach((g, idx) => {
      const s = atkAgg.get(g.id)
      const preTroops = atkInitial[idx]
      g.troops = atkCurrent[idx]
      const share = totalDealt > 0
        ? (s.dealt / totalDealt) * 0.7 + (preTroops / total) * 0.3
        : preTroops / total
      this._gainExp(g, Math.round(totalExp * share))
    })

    // 败/平保留守军伤损，随时间回复
    if (finalOutcome !== 'win') this.damaged.add(t)
    t.garrison = t.guards.reduce((s, gd) => s + gd.troops, 0)

    const typeName = TILE_TYPES[t.type].name
    const enemyNames = allGuardDefs.length ? allGuardDefs.map(x => x.tpl.name).join('、') : '空虚守军'
    // 攻方 unitCard：用跨波累计统计 + 初始兵力 + 最终残余
    const our = gens.map((g, idx) => {
      const s = atkAgg.get(g.id)
      const u = {
        key: g.id, name: g.name,
        start: atkInitial[idx], troops: atkCurrent[idx],
        dealt: s.dealt, taken: s.taken, healed: s.healed, lifesteal: s.lifesteal,
        skillFire: s.skillFire, extra: s.extra, control: s.control,
        buffCast: s.buffCast, debuffCast: s.debuffCast, conditionMet: s.conditionMet,
        shielded: s.shielded, countered: s.countered, cleansed: s.cleansed,
      }
      return unitCard(u, g, this.effStats(g), g.quality, g.lv, g.troopType, (g.skillIds || []).filter(Boolean))
    })
    const report = {
      v: 2, names, outcome: finalOutcome, exp: totalExp,
      // atkStart/defStart 取整：守军经在线/离线挂机回复（_regenGarrisons）后 gd.troops 会带小数，
      // 这个小数是刻意保留的（避免逐 tick 取整把缓慢回复量磨没），只在这类展示用汇总字段处取整，
      // 不影响 gd.troops 本身继续按小数精度累积回复。
      atkStart: Math.round(atkInitial.reduce((s, n) => s + n, 0)), atkLossTotal: totalAtkLoss,
      defStart: Math.round(defStart), defLossTotal: totalDefLoss,
      our, foe: allFoeCards,
      rounds: allRounds,
      waves: waves.length,
      tile: { x: t.x, y: t.y, type: typeName, level: t.level },
    }
    if (finalOutcome === 'win') {
      // 占领（发起时已校验上限；若期间达到上限则只战胜不占领）
      if (this.territoryCount() < this.territoryCapNow()) {
        t.owner = 'player'
        t.garrison = 0
        this.damaged.delete(t)
        const waveNote = waves.length > 1 ? `（连破 ${waves.length} 队守军）` : ''
        this._pushLog(`🚩 ${names} 击败守将 ${enemyNames}${waveNote}，攻克 ${typeName} Lv.${t.level} (${t.x},${t.y})，损失 ${totalAtkLoss} 兵`, report)
        if (t.type === 'npcCity') this._lootCity(names, t.level)
        this.emit('territory', { x: t.x, y: t.y, owner: 'player' })
        if (t.type === 'npcCity') this._checkVictory()
      } else {
        // 战胜但领地已满：守军已被打空却未占领，加入回复列表，避免永久停在 0 兵被白嫖
        if (t.garrison < garrisonOf(t.level, t.type)) this.damaged.add(t)
        this._pushLog(`⚠️ ${names} 战胜但领地已满，未能占领 (${t.x},${t.y})`, report)
      }
    } else {
      const survivors = allFoeCards.filter(u => u.end > 0).map(u => u.name).join('、') || enemyNames
      const note = `（守军余 ${Math.floor(t.garrison)}）`
      const waveNote = waves.length > 1 ? `第 ${finalWaveIdx} 队` : ''
      if (finalOutcome === 'draw') {
        this._pushLog(`⚔️ ${names} 与 ${survivors} ${waveNote}激战 ${allRounds.length} 回合未分胜负，攻打 ${typeName} Lv.${t.level} (${t.x},${t.y}) 无功而返${note}`, report)
      } else {
        this._pushLog(`💀 ${names} 进攻 ${typeName} Lv.${t.level} (${t.x},${t.y}) 被 ${survivors} ${waveNote}击退，损失 ${totalAtkLoss} 兵${note}`, report)
      }
    }
    this.emit('battle', { tile: { x: t.x, y: t.y }, outcome: finalOutcome, general: names })

    // 折返（沿原路径逐格，同样按全队最慢有效速度）
    const steps = (m.path?.length ?? 1) - 1
    const minSpd = Math.min(...gens.map(g => this._marchSpeed(g)))
    m.phase = 'back'
    m.departAt = this.now
    m.arriveAt = this.now + steps * tileMarchSeconds(minSpd)
  }

  /** 攻克 NPC 城池的一次性掠夺 */
  _lootCity(names, level) {
    const loot = npcCityLootOf(level)
    for (const [k, v] of Object.entries(loot)) this.res[k] += v
    this._pushLog(`💰 ${names} 掠夺城池：铜${loot.coin} 粮${loot.grain} 木${loot.wood} 铁${loot.iron} 石${loot.stone}`)
    this.emit('resources', this.res)
  }

  /** 全部 NPC 城池尽克 → 天下一统（单机版胜利目标，只提示一次） */
  _checkVictory() {
    if (this.victoryShown) return
    const allMine = this.npcCities.every(c => this.tileAt(c.x, c.y).owner === 'player')
    if (!allMine) return
    this.victoryShown = true
    this._pushLog(`👑 ${this.npcCities.length} 座城池尽克，天下一统！`)
    this.emit('victory')
  }

  _returnHome(m) {
    const gens = m.generalIds.map(id => this.general(id)).filter(Boolean)
    for (const g of gens) g.state = 'idle'
    m.done = true
    this._pushLog(`🏠 ${gens.map(g => g.name).join('、')} 回城`)
  }

  _gainExp(g, exp) {
    if (g.lv >= GENERAL_MAX_LEVEL) return
    g.exp += exp
    while (g.lv < GENERAL_MAX_LEVEL && g.exp >= expToLevel(g.lv)) {
      g.exp -= expToLevel(g.lv)
      g.lv++
      // 升级属性提升 = 基础值 × 品质成长值（品质越高成长越快）
      const gr = growthOf(g.quality)
      g.atk += Math.round(LEVELUP_ATK * gr * 10) / 10
      g.def += Math.round(LEVELUP_DEF * gr * 10) / 10
      g.int += Math.round(LEVELUP_INT * gr * 10) / 10
      g.pol += Math.round(LEVELUP_POL * gr * 10) / 10
      g.cha += Math.round(LEVELUP_CHA * gr * 10) / 10
      g.spd = calcSpd(g)
      this._pushLog(`⭐ ${g.name} 升至 ${g.lv} 级`)
    }
  }

  // ── 放弃领地 ──────────────────────────────────────────────────────────────

  abandon(x, y) {
    const t = this.tileAt(x, y)
    if (!t || t.owner !== 'player') return '不是己方领地'
    if (t.isCity) return '不能放弃主城'
    t.owner = null
    const teamMax = garrisonOf(t.level, t.type) / (t.guards.length || 1)
    for (const gd of t.guards) gd.troops = teamMax
    t.garrison = garrisonOf(t.level, t.type)
    this.damaged.delete(t)
    this._pushLog(`🏳️ 放弃领地 (${x},${y})`)
    this.emit('territory', { x, y, owner: null })
    return null
  }

  // ── 日志 ──────────────────────────────────────────────────────────────────

  _pushLog(text, report = null) {
    this.log.unshift({ text, at: Date.now(), report })
    if (this.log.length > 50) this.log.length = 50
    this.emit('log', this.log)
  }

  // ── 存档 ──────────────────────────────────────────────────────────────────

  /** 冻结后 save() 不再写入 localStorage；用于「重置存档」等场景，避免旧实例的
   *  beforeunload/场景 SHUTDOWN 等 teardown 保存把刚清空的存档又写回去 */
  freeze() { this._frozen = true }

  save() {
    if (this._frozen) return
    const owned = []
    for (const row of this.tiles) {
      for (const t of row) {
        if (t.owner === 'player') owned.push({ x: t.x, y: t.y, isCity: !!t.isCity })
      }
    }
    const data = {
      v: 12, seed: this.seed, savedAt: Date.now(), now: this.now,
      res: this.res, cityLv: this.cityLv,
      freeRecruits: this.freeRecruits,
      autoJadeCommon: !!this.autoJadeCommon,
      autoJadeElite: !!this.autoJadeElite,
      autoJadeEquipCommon: !!this.autoJadeEquipCommon,
      autoJadeEquipElite: !!this.autoJadeEquipElite,
      skills: this.skills.slice(),
      skillLevels: { ...this.skillLevels },
      equipments: this.equipments.map(e => ({ ...e })),
      _equipSeq: this._equipSeq,
      buildings: { ...this.buildings },
      generals: this.generals.map(g => ({
        id: g.id, name: g.name, quality: g.quality, troopType: g.troopType, faction: g.faction,
        // spd 由五维平均值计算得出，存档时一并保存便于旧档兼容，加载后会重算
        spd: g.spd,
        lv: g.lv, exp: Math.round(g.exp), troops: g.troops,
        atk: g.atk, def: g.def, int: g.int, pol: g.pol, cha: g.cha,
        stamina: Math.round(g.stamina), awaken: g.awaken || 0,
        // v11+ 战法 2 槽（第2槽需20级解锁）；缺省补 [null,null]
        skillIds: [g.skillIds?.[0] || null, g.skillIds?.[1] || null],
        // v9+ 武将装备槽：6 类 iid（旧档缺省时回退空槽）
        equip: { ...(g.equip || { weapon: null, helmet: null, necklace: null, armor: null, belt: null, boots: null }) },
      })),
      owned,
      marches: this.marches,
      // v10+ 玩家编队预设（模板，不锁武将）
      formations: this.formations.map(f => ({ id: f.id, name: f.name, generalIds: f.generalIds.slice() })),
      _formationSeq: this._formationSeq,
      // 守将阵容由 seed 确定重建，只需存各队剩余兵力
      damaged: [...this.damaged].map(t => ({ x: t.x, y: t.y, teams: t.guards.map(gd => Math.round(gd.troops)) })),
      log: this.log.slice(0, 20),
    }
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)) } catch { /* 存储满等忽略 */ }
  }

  static hasSave() {
    try { return !!localStorage.getItem(SAVE_KEY) } catch { return false }
  }

  static clearSave() {
    try { localStorage.removeItem(SAVE_KEY) } catch { /* ignore */ }
  }

  /** 从存档恢复；失败返回 null（调用方应新开局） */
  static load() {
    let data
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY)) } catch { return null }
    // 地图生成器已重构，旧存档（v1~v5）的 seed 会生成不一致地图，直接开始新局。
    // v6（战法系统前）与 v7 地图口径一致，可平滑迁移。
    if (!data || data.v < 6) return null

    const gs = new GameState(data.seed)
    gs.now = data.now || 0
    gs.res = { ...gs.res, ...data.res }
    gs.cityLv = data.cityLv || 1
    // v3+ 才有建筑；v1/v2 迁移时保持默认各 1 级
    gs.buildings = { ...gs.buildings, ...(data.buildings || {}) }
    // v4+ 才有免费招募次数；v1~v3 旧存档已获得过起手三武将，不再补送
    gs.freeRecruits = data.v >= 4 ? (data.freeRecruits ?? 0) : 0
    // v9+ 招募开关：旧档缺省 false
    gs.autoJadeCommon = data.autoJadeCommon === true
    // v12+ 精锐招募开关：旧档缺省 false
    gs.autoJadeElite = data.autoJadeElite === true
    // v9+ 抽装备开关：旧档缺省 false
    gs.autoJadeEquipCommon = data.autoJadeEquipCommon === true
    // v12+ 精锐抽装备开关：旧档缺省 false
    gs.autoJadeEquipElite = data.autoJadeEquipElite === true
    // v7+ 才有战法仓库；从 v6 迁移的旧档保留构造时随机发的 3 个（data.skills 缺省）
    if (data.skills) gs.skills = data.skills.slice()
    // v8+ 才有战法等级；v6/v7 旧档缺省 {}，所有战法默认 Lv.1
    if (data.skillLevels) gs.skillLevels = { ...data.skillLevels }
    // v9+ 才有装备仓库；旧档缺省空仓库，武将装备槽在 Object.assign 后由 makeGeneral 兜底为空槽
    if (data.equipments) gs.equipments = data.equipments.map(e => ({ ...e }))
    if (data._equipSeq) gs._equipSeq = data._equipSeq

    for (const sg of data.generals || []) {
      let g = gs.general(sg.id)
      // 招募武将不在初始阵容，需按模板重建后再套用存档动态字段
      if (!g) {
        const tpl = findGeneralTemplate(sg.id)
        if (!tpl) continue
        g = makeGeneral(tpl, false)
        gs.generals.push(g)
      }
      // v1/v2 存档无 stamina/awaken 字段：Object.assign 不会覆盖，保留 makeGeneral 的默认
      Object.assign(g, sg)
      // v8 旧档无 equip 字段：补默认空槽（避免后续 equipBonus/g.equip.xxx 访问报错）
      if (!g.equip) g.equip = { weapon: null, helmet: null, necklace: null, armor: null, belt: null, boots: null }
      // v11+ 才有 skillIds 数组；v6~v10 旧档为单一 skillId 字段，迁移进槽位 0
      if (!Array.isArray(g.skillIds)) g.skillIds = [null, null]
      if (sg.skillId && !g.skillIds[0] && !g.skillIds[1]) g.skillIds[0] = sg.skillId
      delete g.skillId
      // spd 由五维平均值得出；旧档可能缺失 pol/cha，用模板补齐后重算
      const tpl = findGeneralTemplate(g.id)
      if (tpl) {
        if (g.pol === undefined) g.pol = tpl.pol
        if (g.cha === undefined) g.cha = tpl.cha
        g.spd = calcSpd(g)
      }
    }
    // V2.0 战法精简迁移：旧 ID → 新 ID（17 旧战法收缩为 7 保留战法）
    // 武将 skillId、gs.skills 仓库、gs.skillLevels 等级一并迁移；等级取 max 避免回退
    _migrateV2Skills(gs)
    for (const o of data.owned || []) {
      const t = gs.tileAt(o.x, o.y)
      if (!t) continue
      t.owner = 'player'
      t.garrison = 0
      for (const gd of t.guards) gd.troops = 0
      if (o.isCity) t.isCity = true
    }
    for (const m of data.marches || []) {
      // v1 行军为单武将（generalId），迁移为 generalIds 数组
      if (!m.generalIds) m.generalIds = m.generalId ? [m.generalId] : []
      // 旧存档无 path（直线行军）：按当前地图重建网格路径
      if (!m.path) m.path = findPath(gs.tiles, m.from, m.to)
      gs.marches.push(m)
      for (const id of m.generalIds) {
        const g = gs.general(id)
        if (g) g.state = 'marching'
      }
      if (m.id >= marchSeq) marchSeq = m.id + 1
    }
    // v10+ 玩家编队预设；旧档缺省空列表
    if (Array.isArray(data.formations)) {
      gs.formations = data.formations
        .filter(f => f && typeof f.id === 'number' && Array.isArray(f.generalIds))
        .map(f => ({ id: f.id, name: String(f.name || '').slice(0, FORMATION_NAME_MAX_LEN) || '编队', generalIds: f.generalIds.filter(id => gs.generals.some(g => g.id === id)) }))
      gs._formationSeq = data._formationSeq || (gs.formations.reduce((m, f) => Math.max(m, f.id), 0) + 1)
    }
    for (const d of data.damaged || []) {
      const t = gs.tileAt(d.x, d.y)
      if (!t || t.owner === 'player') continue
      if (data.v >= 10 && Array.isArray(d.teams)) {
        // v10+：编队制守将，各将剩余兵力逐一恢复（长度 = teams × FORMATION_SIZE）
        t.guards.forEach((gd, i) => { gd.troops = d.teams[i] ?? gd.troops })
      } else if (!Array.isArray(d.teams)) {
        // v1~v4：单一守军数字，按比例摊到各将
        const max = garrisonOf(t.level, t.type)
        const factor = Math.max(0, Math.min(1, (d.garrison ?? max) / max))
        t.guards.forEach(gd => { gd.troops = Math.round(gd.troops * factor) })
      }
      // v6~v9 的 d.teams 数组（旧口径：teams 名武将）忽略 —— 守将结构已改为 teams×3，
      // 旧兵力值会越界新上限，故按 seed 重建满兵，不加入回复列表。
      t.garrison = t.guards.reduce((s, gd) => s + gd.troops, 0)
      if (t.garrison < garrisonOf(t.level, t.type)) gs.damaged.add(t)
    }
    // 若存档时已一统，不再重复提示
    gs.victoryShown = gs.npcCities.every(c => gs.tileAt(c.x, c.y).owner === 'player')
    gs.log = data.log || []

    // 离线推进：把离线真实时长折算为游戏时长（封顶），补产出并结算行军
    const offline = Math.max(0, (Date.now() - (data.savedAt || Date.now())) / 1000)
    const gameSecs = Math.min(offline * TIME_SCALE, OFFLINE_CAP_SECONDS)
    if (gameSecs > 1) {
      gs.now += gameSecs
      gs._produce(gameSecs)
      gs._processMarches()
      gs._pushLog(`⏳ 离线收益已结算（${Math.round(gameSecs / 3600 * 10) / 10} 游戏小时）`)
    }
    return gs
  }
}

// V2.0 战法精简迁移表：17 个旧战法 ID → 7 个保留战法 ID
// 删除的旧战法按属性/类型映射到保留代表：武力单体→力劈、速度单体→疾风、智力单体→火攻、
// 武力群体→箭雨（旋风）、智力群体→落雷（毒计）、追击→连击、控制→谎报
const SKILL_MIGRATION_V2 = {
  huikan:  'lipi',     mengji:  'lipi',     tuci:    'lipi',
  jianta:  'jifeng',   tuxi:    'jifeng',
  shuigong:'huogong',  tianlei: 'huogong',
  xuanfeng:'jianyu',
  duji:    'luolei',
  zhuiji:  'lianji',   hengsao: 'lianji',
  weishe:  'huangbao', mizhen:  'huangbao', jiaoxie: 'huangbao',
}
// 旧战法兑换价表（用于迁移玉石补偿；旧战法已从 SKILLS 字典删除，需硬编码）
const OLD_SKILL_COSTS_V2 = {
  huikan: 20, mengji: 30, tuci: 20,
  jianta: 20, tuxi: 25,
  shuigong: 25, tianlei: 30,
  xuanfeng: 25, duji: 30,
  zhuiji: 25, hengsao: 30,
  weishe: 25, mizhen: 30, jiaoxie: 20,
}

/**
 * V2.0 战法精简迁移：在 GameState.load() 末尾调用，把旧战法 ID 迁移到新 ID。
 * 1) 武将 skillIds 各槽位旧 ID → 新 ID（同新 ID 冲突时只保留第一个，其余清空让玩家重绑）
 * 2) gs.skills 仓库去重（旧+新合并到新 ID）
 * 3) gs.skillLevels 等级迁移（同新 ID 取 max，避免回退）
 * 4) 玉石补偿：仓库中重复映射导致丢失的旧战法按兑换价退还
 * 5) 过滤掉迁移后仍不在 SKILLS 字典中的无效 ID（保险）
 */
function _migrateV2Skills(gs) {
  // 1) 武将 skillIds 各槽位迁移（处理冲突：同新 ID 只保留第一个武将/槽位，其余清空）
  const usedSkillIds = new Set()
  for (const g of gs.generals) {
    if (!Array.isArray(g.skillIds)) g.skillIds = [null, null]
    for (let slot = 0; slot < g.skillIds.length; slot++) {
      const sid = g.skillIds[slot]
      if (!sid) continue
      const newId = SKILL_MIGRATION_V2[sid] || sid
      if (!getSkill(newId)) { g.skillIds[slot] = null; continue }   // 未知 ID 清空
      if (usedSkillIds.has(newId)) {
        g.skillIds[slot] = null                                    // 冲突：清空，玩家需重新绑定
      } else {
        g.skillIds[slot] = newId
        usedSkillIds.add(newId)
      }
    }
  }
  // 2) skills 仓库去重迁移 + 统计丢失的旧战法（用于玉石补偿）
  let refund = 0
  if (Array.isArray(gs.skills) && gs.skills.length) {
    const seen = new Set()
    const next = []
    for (const id of gs.skills) {
      const nid = SKILL_MIGRATION_V2[id] || id
      if (!getSkill(nid)) continue                         // 保险：跳过未知 ID
      if (!seen.has(nid)) {
        seen.add(nid); next.push(nid)
      } else if (OLD_SKILL_COSTS_V2[id]) {
        // 重复映射：此旧战法被合并丢失，退还兑换价
        refund += OLD_SKILL_COSTS_V2[id]
      }
    }
    gs.skills = next
  }
  // 3) skillLevels 等级迁移（同新 ID 取 max）
  if (gs.skillLevels && Object.keys(gs.skillLevels).length) {
    const next = {}
    for (const [id, lv] of Object.entries(gs.skillLevels)) {
      const nid = SKILL_MIGRATION_V2[id] || id
      if (!getSkill(nid)) continue                         // 保险：跳过未知 ID
      next[nid] = Math.max(next[nid] || 0, lv)
    }
    gs.skillLevels = next
  }
  // 4) 玉石补偿发放
  if (refund > 0) {
    gs.res.jade = (gs.res.jade || 0) + refund
    gs._pushLog?.(`💎 战法精简迁移补偿 +${refund} 玉石（重复战法已合并）`)
  }
}
