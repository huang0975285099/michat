// 九州征途 - 纯逻辑层（与渲染完全解耦，仿 ironfist 的分层方式）
// 职责：资源产出、征兵、行军队列、战斗结算、占领/放弃、主城升级、存档。
// 渲染层（Phaser WorldScene）与 UI 层（Vue）只通过事件与只读查询访问本类。

import {
  MAP_W, MAP_H, TILE_TYPES, RESOURCES, TIME_SCALE, OFFLINE_CAP_SECONDS,
  GAME_START_YEAR, GAME_SECONDS_PER_YEAR, GAME_SECONDS_PER_MONTH, GAME_SECONDS_PER_DAY,
  BASE_YIELD_PER_LEVEL, COIN_YIELD_PER_LEVEL,
  garrisonOf, guardStat,
  CITY_MAX_LEVEL, territoryCap, cityUpgradeCost,
  troopCapOf, expToLevel, GENERAL_MAX_LEVEL,
  GENERAL_QUALITY, RECRUITABLE_GENERALS, findGeneralTemplate,
  RECRUIT_COST_COIN, MAX_GENERALS, AWAKEN_ATK, AWAKEN_DEF, AWAKEN_INT, AWAKEN_SPD, FREE_RECRUIT_COUNT,
  growthOf, LEVELUP_ATK, LEVELUP_DEF, LEVELUP_INT, LEVELUP_SPD,
  RECRUIT_GRAIN_PER_TROOP, tileMarchSeconds, MARCH_REF_SPEED, TROOP_TYPES,
  MAX_MARCH_PARTY,
  npcCityLootOf, GARRISON_REGEN_PER_HOUR,
  BUILDINGS, BUILDING_MAX_LEVEL, buildingUpgradeCost,
  GRANARY_YIELD_PER_LEVEL, BARRACKS_CAP_PER_LEVEL, TRAINING_EXP_PER_LEVEL, FORGE_STAT_PER_LEVEL,
  STAMINA_MAX, MARCH_STAMINA_COST, STAMINA_REGEN_PER_HOUR,
  INITIAL_RESOURCES, INITIAL_TROOPS, SAVE_KEY,
} from '../GameConstants.js'
import { generateMap } from './MapGenerator.js'
import { findPath } from './pathfind.js'
import { resolveBattle } from './battle.js'
import { getSkill, BINDABLE_SKILLS } from './skills.js'

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
    atk: tpl.atk, def: tpl.def, spd: tpl.spd, int: tpl.int,
    lv: 1, exp: 0, troops: starter ? INITIAL_TROOPS : 0, state: 'idle',
    stamina: STAMINA_MAX, awaken: 0, skillId: null,   // 绑定的主动战法（第二期由绑定 UI 设置）
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
    this.skills = []           // 战法仓库：拥有的战法 id（每种仅一份；绑定关系存在各武将 g.skillId 上）
    this.freeRecruits = FREE_RECRUIT_COUNT   // 开局赠送的免费招募次数（不占铜币）
    this.marches = []          // { id, generalIds:[], from, to, departAt, arriveAt, phase:'out'|'back' }
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
  // 每种战法仅一份，存在 this.skills；某战法是否「已绑定」由是否有武将 g.skillId 指向它决定。
  // 绑定规则：一将至多 1 法、一法至多绑 1 将；解绑/销毁武将后战法自动回到可用池（仍在仓库里）。

  _grantStarterSkills(n) {
    const pool = BINDABLE_SKILLS.map(s => s.id)
    for (let i = pool.length - 1; i > 0; i--) {   // Fisher-Yates
      const j = Math.floor(Math.random() * (i + 1));[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    this.skills = pool.slice(0, Math.min(n, pool.length))
  }

  /** 仓库全部战法 id */
  ownedSkills() { return this.skills.slice() }
  /** 某战法当前绑定的武将（无则 null） */
  skillBoundTo(skillId) { return this.generals.find(g => g.skillId === skillId) || null }
  /** 未被任何武将绑定、可自由绑定的战法 id */
  availableSkills() { return this.skills.filter(id => !this.skillBoundTo(id)) }

  /** 获得一个战法进仓库（第三期兑换用；已有则忽略） */
  grantSkill(skillId) {
    if (!getSkill(skillId) || this.skills.includes(skillId)) return
    this.skills.push(skillId)
    this.emit('skills', this.skills)
  }

  /** 给武将绑定战法。返回错误信息或 null。若该将已有战法则先自动换下（换下的自动回可用池） */
  bindSkill(generalId, skillId) {
    const g = this.general(generalId)
    if (!g) return '武将不存在'
    if (!this.skills.includes(skillId)) return '尚未拥有该战法'
    const holder = this.skillBoundTo(skillId)
    if (holder && holder.id !== generalId) return `【${getSkill(skillId)?.name}】已绑定 ${holder.name}`
    g.skillId = skillId
    this._pushLog(`📜 ${g.name} 装备战法【${getSkill(skillId)?.name}】`)
    this.emit('generals', this.generals)
    this.emit('skills', this.skills)
    return null
  }

  /** 解绑武将战法，战法回到可用池 */
  unbindSkill(generalId) {
    const g = this.general(generalId)
    if (!g || !g.skillId) return
    const name = getSkill(g.skillId)?.name
    g.skillId = null
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
    const cost = count * RECRUIT_GRAIN_PER_TROOP
    if (this.res.grain < cost) return `粮食不足（需 ${cost}）`
    this.res.grain -= cost
    g.troops += count
    this.emit('resources', this.res)
    this.emit('generals', this.generals)
    return null
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
   * 遣散武将，无视等级、觉醒、状态。
   * @returns {{success:true} | {error:string}}
   */
  dismissGeneral(id) {
    const idx = this.generals.findIndex(g => g.id === id)
    if (idx === -1) return { error: '武将不存在' }
    const g = this.generals[idx]
    if (g.state === 'marching') return { error: `${g.name} 正在行军中，无法遣散` }
    this.generals.splice(idx, 1)
    this._pushLog(`🗑️ 遣散 ${g.name}`)
    this.emit('generals', this.generals)
    return { success: true }
  }

  /**
   * 铜币招募一名武将。返回 { error } 或 { type:'new'|'awaken', name, quality, general }。
   * - 抽到未拥有且阵容未满 → 入列新武将
   * - 抽到已拥有 → 该武将觉醒（+武/+防/+智/+速）
   * - 阵容已满且抽到新武将 → 转为觉醒一名同池随机已有武将（不浪费）
   */
  recruitGeneral() {
    const free = this.freeRecruits > 0
    if (!free && this.res.coin < RECRUIT_COST_COIN) return { error: `铜币不足（需 ${RECRUIT_COST_COIN}）` }
    if (free) this.freeRecruits--
    else this.res.coin -= RECRUIT_COST_COIN

    const quality = this._rollQuality()
    const pool = RECRUITABLE_GENERALS.filter(g => g.quality === quality)
    // 该档无可招募武将则退回普通档兜底
    const tpl = (pool.length ? pool : RECRUITABLE_GENERALS)[
      Math.floor(Math.random() * (pool.length ? pool.length : RECRUITABLE_GENERALS.length))]

    const owned = this.general(tpl.id)
    let result
    if (!owned && this.generals.length < MAX_GENERALS) {
      // 首名武将（开局免费招募所得）自带起始兵力，付费招募的武将则需另行征兵
      const g = makeGeneral(tpl, free && this.generals.length === 0)
      this.generals.push(g)
      this._pushLog(`🎲 招募新武将 ${g.name}（${GENERAL_QUALITY[g.quality].name}）`)
      result = { type: 'new', name: g.name, quality: g.quality, general: g }
    } else {
      // 觉醒目标：已拥有则本人，否则（阵容满）随机一名已有武将
      const target = owned || this.generals[Math.floor(Math.random() * this.generals.length)]
      const gain = this._awaken(target)
      this._pushLog(`✨ ${target.name} 觉醒（武+${gain.atk} 防+${gain.def}，第 ${target.awaken} 次）`)
      result = { type: 'awaken', name: target.name, quality: target.quality, general: target }
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
      spd: Math.round(AWAKEN_SPD * gr * 10) / 10,
    }
    g.atk += gain.atk
    g.def += gain.def
    g.int += gain.int
    g.spd += gain.spd
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

  /** 武将有效行军速度 = 基础速度 + 兵种加成（骑兵 +marchSpeed） */
  _marchSpeed(g) {
    return g.spd + (TROOP_TYPES[g.troopType]?.marchSpeed || 0)
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

    // 多对多同场混战：攻方每名武将、守方每队守将都是独立战斗单位，
    // 全场按速度排序逐个行动（见 battle.js）。实战属性在此折算：
    // 等级加成 +(lv-1)*2×成长 + 铁匠坊全属性；速度另叠兵种加成（骑兵 +30，与行军同口径）。
    const total = gens.reduce((s, g) => s + g.troops, 0)
    const forgeBonus = FORGE_STAT_PER_LEVEL * this.buildings.forge
    const effAtk = g => g.atk + (g.lv - 1) * LEVELUP_ATK * growthOf(g.quality) + forgeBonus
    const effDef = g => g.def + (g.lv - 1) * LEVELUP_DEF * growthOf(g.quality) + forgeBonus
    const effInt = g => g.int + forgeBonus
    const effSpd = g => g.spd + (TROOP_TYPES[g.troopType]?.marchSpeed || 0) + forgeBonus

    const atkUnits = gens.map(g => ({
      key: g.id, name: g.name,
      atk: effAtk(g), def: effDef(g), int: effInt(g), spd: effSpd(g),
      troops: g.troops, troopType: g.troopType, skillId: g.skillId || null,
    }))
    // 守将单位：一队 = 一名武将，模板缺失的队伍跳过（不参战也不掉兵）
    const guardDefs = t.guards
      .map((gd, i) => ({ gd, i, tpl: findGeneralTemplate(gd.id) }))
      .filter(x => x.tpl && x.gd.troops > 0)
    const defUnits = guardDefs.map(({ gd, i, tpl }) => ({
      key: `${gd.id}:${i}`, name: tpl.name,
      atk: guardStat(tpl.atk, gd.lv, tpl.quality),
      def: guardStat(tpl.def, gd.lv, tpl.quality),
      int: guardStat(tpl.int, gd.lv, tpl.quality),
      spd: guardStat(tpl.spd, gd.lv, tpl.quality) + (TROOP_TYPES[tpl.troopType]?.marchSpeed || 0),
      troops: gd.troops, troopType: tpl.troopType,
    }))

    // 战斗种子：由存档种子 + 行军 ID + 目标坐标确定 —— 同存档同输入必同结果（回放/离线一致）
    const battleSeed = (Math.imul(this.seed | 0, 0x9E3779B1) ^ Math.imul(m.id, 0x85EBCA6B) ^ (t.x * 8887 + t.y * 2971)) >>> 0
    const r = resolveBattle(atkUnits, defUnits, battleSeed)
    const outcome = r.outcome
    const totalAtkLoss = r.atkLoss
    const totalExp = r.exp

    // 伤亡逐将落账（谁被打谁掉兵）；经验按输出占比分（无输出则按出兵比例兜底）
    const totalDealt = r.units.atk.reduce((s, u) => s + u.dealt, 0)
    gens.forEach((g) => {
      const u = r.units.atk.find(u => u.key === g.id)
      if (!u) return
      g.troops = u.troops
      const share = totalDealt > 0 ? u.dealt / totalDealt : g.troops / Math.max(1, total)
      this._gainExp(g, Math.round(totalExp * share))
    })
    // 守军伤损直接落账（胜则全灭清零，天然抹掉回复带来的小数残余）
    guardDefs.forEach(({ gd, i }) => {
      const u = r.units.def.find(u => u.key === `${gd.id}:${i}`)
      if (u) gd.troops = u.troops
    })
    // 同场混战后不再有「多队未一次全灭回满」的惩罚：败/平一律保留伤损，随时间回复
    if (outcome !== 'win') this.damaged.add(t)
    t.garrison = t.guards.reduce((s, gd) => s + gd.troops, 0)

    const typeName = TILE_TYPES[t.type].name
    const enemyNames = guardDefs.length ? guardDefs.map(x => x.tpl.name).join('、') : '空虚守军'
    // 战报 v2：双方阵容卡（基础属性→实战属性 + 兵力/输出/承伤/战法统计）+ 逐回合事件流
    const unitCard = (u, base, eff, quality, lv, troopType, skillId) => ({
      key: u.key, name: u.name, quality, lv, troopType,
      skill: skillId ? getSkill(skillId)?.name || null : null,
      atk: Math.round(base.atk), atkEff: Math.round(eff.atk),
      def: Math.round(base.def), defEff: Math.round(eff.def),
      spd: Math.round(base.spd), spdEff: Math.round(eff.spd),
      int: Math.round(base.int), intEff: Math.round(eff.int),
      start: u.start, end: u.troops, dealt: u.dealt, taken: u.taken,
      skillFire: u.skillFire, extra: u.extra, control: u.control,
    })
    const report = {
      v: 2, names, outcome, exp: totalExp,
      atkStart: r.atkStart, atkLossTotal: r.atkLoss,
      defStart: r.defStart, defLossTotal: r.defLoss,
      our: r.units.atk.map(u => {
        const g = gens.find(g => g.id === u.key)
        return unitCard(u, g, { atk: effAtk(g), def: effDef(g), spd: effSpd(g), int: effInt(g) },
          g.quality, g.lv, g.troopType, g.skillId)
      }),
      foe: r.units.def.map(u => {
        const { gd, tpl } = guardDefs.find(x => `${x.gd.id}:${x.i}` === u.key)
        const eff = defUnits.find(d => d.key === u.key)
        return unitCard(u, tpl, eff, tpl.quality, gd.lv, tpl.troopType, null)
      }),
      rounds: r.rounds,
      tile: { x: t.x, y: t.y, type: typeName, level: t.level },
    }
    if (outcome === 'win') {
      // 占领（发起时已校验上限；若期间达到上限则只战胜不占领）
      if (this.territoryCount() < this.territoryCapNow()) {
        t.owner = 'player'
        t.garrison = 0
        this.damaged.delete(t)
        this._pushLog(`🚩 ${names} 击败守将 ${enemyNames}，攻克 ${typeName} Lv.${t.level} (${t.x},${t.y})，损失 ${totalAtkLoss} 兵`, report)
        if (t.type === 'npcCity') this._lootCity(names, t.level)
        this.emit('territory', { x: t.x, y: t.y, owner: 'player' })
        if (t.type === 'npcCity') this._checkVictory()
      } else {
        // 战胜但领地已满：守军已被打空却未占领，加入回复列表，避免永久停在 0 兵被白嫖
        if (t.garrison < garrisonOf(t.level, t.type)) this.damaged.add(t)
        this._pushLog(`⚠️ ${names} 战胜但领地已满，未能占领 (${t.x},${t.y})`, report)
      }
    } else {
      const survivors = report.foe.filter(u => u.end > 0).map(u => u.name).join('、') || enemyNames
      const note = `（守军余 ${Math.floor(t.garrison)}）`
      if (outcome === 'draw') {
        this._pushLog(`⚔️ ${names} 与 ${survivors} 激战 ${r.rounds.length} 回合未分胜负，攻打 ${typeName} Lv.${t.level} (${t.x},${t.y}) 无功而返${note}`, report)
      } else {
        this._pushLog(`💀 ${names} 进攻 ${typeName} Lv.${t.level} (${t.x},${t.y}) 被 ${survivors} 击退，损失 ${totalAtkLoss} 兵${note}`, report)
      }
    }
    this.emit('battle', { tile: { x: t.x, y: t.y }, outcome, general: names })

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
      // int/spd 仅用于展示，不参与战斗结算
      const gr = growthOf(g.quality)
      g.atk += Math.round(LEVELUP_ATK * gr * 10) / 10
      g.def += Math.round(LEVELUP_DEF * gr * 10) / 10
      g.int += Math.round(LEVELUP_INT * gr * 10) / 10
      g.spd += Math.round(LEVELUP_SPD * gr * 10) / 10
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
      v: 7, seed: this.seed, savedAt: Date.now(), now: this.now,
      res: this.res, cityLv: this.cityLv,
      freeRecruits: this.freeRecruits,
      skills: this.skills.slice(),
      buildings: { ...this.buildings },
      generals: this.generals.map(g => ({
        id: g.id, name: g.name, quality: g.quality, troopType: g.troopType, faction: g.faction,
        spd: g.spd,
        // int 参与战斗（智力战法）且会被升级/觉醒加成，必须持久化（旧档缺省时回退模板值）
        lv: g.lv, exp: Math.round(g.exp), troops: g.troops, atk: g.atk, def: g.def, int: g.int,
        stamina: Math.round(g.stamina), awaken: g.awaken || 0, skillId: g.skillId || null,
      })),
      owned,
      marches: this.marches,
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
    // v7+ 才有战法仓库；从 v6 迁移的旧档保留构造时随机发的 3 个（data.skills 缺省）
    if (data.skills) gs.skills = data.skills.slice()

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
    }
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
    for (const d of data.damaged || []) {
      const t = gs.tileAt(d.x, d.y)
      if (!t || t.owner === 'player') continue
      if (Array.isArray(d.teams)) {
        // v5：各队剩余兵力逐一恢复
        t.guards.forEach((gd, i) => { gd.troops = d.teams[i] ?? gd.troops })
      } else {
        // v1~v4：单一守军数字，按比例摊到各队
        const max = garrisonOf(t.level, t.type)
        const factor = Math.max(0, Math.min(1, (d.garrison ?? max) / max))
        t.guards.forEach(gd => { gd.troops = Math.round(gd.troops * factor) })
      }
      t.garrison = t.guards.reduce((s, gd) => s + gd.troops, 0)
      gs.damaged.add(t)
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
