// 铁拳 - 三期 3D 战斗渲染器（Babylon.js，方案B）
// 工厂返回控制器：{ setCharge, playRound, resize, dispose, ready }。
// 渲染无关引擎(IronFistGame)与 HUD 不变；本控制器只消费每回合结算结果 + 蓄力态。
// 见 docs/ironfist.md 第十三/二十二节。

import * as BABYLON from '@babylonjs/core'
import '@babylonjs/loaders/glTF'  // 注册 glTF/glb 加载器（副作用 import）
import { Fighter3D, PAL_ME_3D, PAL_OPP_3D } from './Fighter3D.js'

// glb 放在 public/ 下，构建后从站点根提供
const GLB_ROOT = '/games/ironfist/'
const GLB_FILE = 'fighter.glb'       // 我方模型（Vanguard）
const GLB_FILE_OPP = 'fighter.glb'  // 对手模型（Mutant）；缺省则回退用 fighter.glb

const CRIT_THRESHOLD = 18

export function createBattleRenderer3D(canvas, { playerCharged = false, opponentCharged = false, onReady, onImpact } = {}) {
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true })
  const scene = new BABYLON.Scene(engine)
  scene.clearColor = new BABYLON.Color4(0.05, 0.04, 0.10, 1)

  // 机位：正面略俯，支持拖拽旋转 / 滚轮缩放（带限位，避免转到台底或拉太远）
  const cam = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, 1.15, 7.8, new BABYLON.Vector3(0, 1.15, 0), scene)
  cam.fov = 0.8
  cam.minZ = 0.1
  cam.attachControl(canvas, true)
  cam.lowerBetaLimit = 0.6        // 最高俯角（不飞到正上方看秃头）
  cam.upperBetaLimit = 1.46       // 最低视角（不钻到台面下）
  cam.lowerRadiusLimit = 5.5      // 最近（不穿进角色）
  cam.upperRadiusLimit = 10       // 最远
  cam.wheelDeltaPercentage = 0.01 // 滚轮缩放手感
  cam.panningSensibility = 0      // 禁用平移：只转不挪，镜头始终对着擂台中心
  cam.angularSensibilityX = 1400
  cam.angularSensibilityY = 1400

  // 环境光照(IBL / studio.hdr)按需求停用——仅靠下方灯光照明。

  // 灯光：环境 + 主光 + 蓝/红边缘光（呼应参考图左蓝右红）
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene)
  hemi.intensity = 0.7  // 无 IBL 补光，半球光提回
  hemi.groundColor = new BABYLON.Color3(0.1, 0.1, 0.2)
  const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-0.3, -1, 0.45), scene)
  dir.intensity = 0.55
  const blue = new BABYLON.PointLight('pBlue', new BABYLON.Vector3(-3.4, 2.2, -2.2), scene)
  blue.diffuse = new BABYLON.Color3(0.35, 0.55, 1.0); blue.intensity = 13
  const red = new BABYLON.PointLight('pRed', new BABYLON.Vector3(3.4, 2.2, -2.2), scene)
  red.diffuse = new BABYLON.Color3(1.0, 0.35, 0.32); red.intensity = 13

  // ── 后期 ───────────────────────────────────────────────
  // GlowLayer：让 emissive 物体（蓄力光环、命中火花、擂台环、受击高亮）真正"发光"溢出
  const glow = new BABYLON.GlowLayer('glow', scene, { blurKernelSize: 32 })
  glow.intensity = 0.55
  // 渲染管线：Bloom 整体辉光 + FXAA 抗锯齿 + ACES 色调映射 + 暗角，氛围/质感一次到位
  const pipe = new BABYLON.DefaultRenderingPipeline('pipe', true, scene, [cam])
  pipe.fxaaEnabled = true
  pipe.bloomEnabled = true
  pipe.bloomThreshold = 0.86
  pipe.bloomWeight = 0.28
  pipe.bloomKernel = 64
  pipe.bloomScale = 0.5
  pipe.imageProcessingEnabled = true
  pipe.imageProcessing.toneMappingEnabled = true
  pipe.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES
  pipe.imageProcessing.exposure = 0.92
  pipe.imageProcessing.contrast = 1.1
  pipe.imageProcessing.vignetteEnabled = true
  pipe.imageProcessing.vignetteWeight = 2.6
  pipe.imageProcessing.vignetteColor = new BABYLON.Color4(0, 0, 0, 0)

  // 擂台
  const plat = BABYLON.MeshBuilder.CreateCylinder('plat', { diameter: 5.4, height: 0.3, tessellation: 56 }, scene)
  const pm = new BABYLON.StandardMaterial('pm', scene)
  pm.diffuseColor = new BABYLON.Color3(0.12, 0.10, 0.20)
  pm.emissiveColor = new BABYLON.Color3(0.05, 0.04, 0.11)
  pm.specularColor = new BABYLON.Color3(0.06, 0.06, 0.08)  // 压掉默认白高光（地台被打爆白的主因）
  plat.material = pm; plat.position.y = -0.15
  const ring = BABYLON.MeshBuilder.CreateTorus('ring', { diameter: 5.2, thickness: 0.08, tessellation: 56 }, scene)
  const rm = new BABYLON.StandardMaterial('rm', scene)
  rm.emissiveColor = new BABYLON.Color3(0.42, 0.32, 0.85); rm.disableLighting = true
  ring.material = rm; ring.position.y = 0.02

  // ── 环境层：星空穹顶 / 反光地面 / 能量网格 / 浮尘 / 光柱（全部程序生成，无额外贴图文件）──
  // 软粒子贴图：中心实、边缘透的径向渐变，用于浮尘与（必要时）火花
  function _softTex(name) {
    const t = new BABYLON.DynamicTexture(name, 64, scene, false)
    const c = t.getContext()
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.4, 'rgba(255,255,255,0.6)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = g; c.fillRect(0, 0, 64, 64)
    t.hasAlpha = true; t.update()
    return t
  }

  // 1) 渐变星空穹顶：顶暗→地平线偏紫，撒星点；infiniteDistance 跟随相机当天空盒用
  function _skyTex() {
    const s = 512
    const t = new BABYLON.DynamicTexture('sky', { width: s, height: s }, scene, true)
    const c = t.getContext()
    const g = c.createLinearGradient(0, 0, 0, s)
    g.addColorStop(0, '#05030d'); g.addColorStop(0.55, '#0a0820'); g.addColorStop(1, '#160b2c')
    c.fillStyle = g; c.fillRect(0, 0, s, s)
    // 星云团：几坨柔光色斑，给纯渐变天空加远景层次
    for (const [col, al] of [['#3a1d6e', 0.20], ['#1d3a6e', 0.17], ['#6e1d52', 0.15], ['#24306e', 0.13]]) {
      const bx = Math.random() * s, by = Math.random() * s * 0.75, br = 120 + Math.random() * 140
      const rg = c.createRadialGradient(bx, by, 0, bx, by, br)
      rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)')
      c.globalAlpha = al; c.fillStyle = rg; c.fillRect(0, 0, s, s); c.globalAlpha = 1
    }
    for (let i = 0; i < 260; i++) {
      const a = Math.random() * 0.6 + 0.15
      c.fillStyle = 'rgba(255,255,255,' + a + ')'
      c.beginPath(); c.arc(Math.random() * s, Math.random() * s, Math.random() * 1.2 + 0.2, 0, 7); c.fill()
    }
    t.update()
    return t
  }
  const sky = BABYLON.MeshBuilder.CreateSphere('sky', { diameter: 60, segments: 16, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene)
  const skyM = new BABYLON.StandardMaterial('skyM', scene)
  skyM.emissiveTexture = _skyTex(); skyM.disableLighting = true; skyM.backFaceCulling = false
  sky.material = skyM; sky.infiniteDistance = true; sky.isPickable = false
  skyM.fogEnabled = false  // 天空不吃雾（否则星空被雾洗白）
  glow.addExcludedMesh(sky)  // 不让整穹顶进辉光（只想要星点微亮，不要全屏发灰）

  // 纵深雾：远处地面/网格往暗里融，画面有"无限延伸"的深度；密度低到几乎不碰中央角色
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2
  scene.fogColor = new BABYLON.Color3(0.03, 0.025, 0.06)
  scene.fogDensity = 0.024

  // 2) 反光金属地面：暗光泽 PBR 接住蓝/红点光，让擂台落在空间里而非浮在黑底
  const floor = BABYLON.MeshBuilder.CreateGround('floor', { width: 40, height: 40 }, scene)
  floor.position.y = -0.32
  const fm = new BABYLON.PBRMaterial('fm', scene)
  fm.albedoColor = new BABYLON.Color3(0.02, 0.02, 0.05)
  fm.metallic = 0.85; fm.roughness = 0.38; fm.environmentIntensity = 0.55
  floor.material = fm; floor.isPickable = false

  // 3) 地面能量网格：从擂台向外辐射的同心环+射线，边缘径向淡出，带呼吸脉冲
  function _gridTex() {
    const s = 1024
    const t = new BABYLON.DynamicTexture('grid', { width: s, height: s }, scene, true)
    const c = t.getContext()
    c.clearRect(0, 0, s, s); c.translate(s / 2, s / 2)
    c.strokeStyle = 'rgba(120,150,240,0.8)'; c.lineWidth = 2
    for (let r = 70; r < s / 2; r += 72) { c.beginPath(); c.arc(0, 0, r, 0, 7); c.stroke() }
    for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * s / 2, Math.sin(a) * s / 2); c.stroke() }
    // 径向遮罩：中心实、边缘透，做成圆形软淡出（避免方形硬边）
    c.globalCompositeOperation = 'destination-in'
    const g = c.createRadialGradient(0, 0, s * 0.1, 0, 0, s * 0.5)
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)')
    c.fillStyle = g; c.fillRect(-s / 2, -s / 2, s, s)
    t.hasAlpha = true; t.update()
    return t
  }
  const gridTex = _gridTex()
  const gridDisc = BABYLON.MeshBuilder.CreateGround('gridDisc', { width: 18, height: 18 }, scene)
  gridDisc.position.y = -0.305
  const gm = new BABYLON.StandardMaterial('gm', scene)
  gm.emissiveTexture = gridTex; gm.opacityTexture = gridTex
  gm.emissiveColor = new BABYLON.Color3(0.35, 0.5, 0.95); gm.disableLighting = true
  gm.backFaceCulling = false
  gridDisc.material = gm; gridDisc.isPickable = false

  // 4) 顶部双色光柱：左蓝右红两道体积光，加色混合当"光"读，呼应边缘光
  function _beam(x, color) {
    const cone = BABYLON.MeshBuilder.CreateCylinder('beam', { diameterTop: 0.2, diameterBottom: 3.0, height: 5.2, tessellation: 24 }, scene)
    cone.position.set(x, 3.0, -1.4); cone.isPickable = false
    const bm = new BABYLON.StandardMaterial('beamM', scene)
    bm.emissiveColor = color; bm.disableLighting = true; bm.backFaceCulling = false
    bm.alpha = 0.32; bm.alphaMode = BABYLON.Engine.ALPHA_ADD; bm.fogEnabled = false
    cone.material = bm; glow.addExcludedMesh(cone)
    return cone
  }
  _beam(-3.4, new BABYLON.Color3(0.30, 0.5, 1.0))
  _beam(3.4, new BABYLON.Color3(1.0, 0.32, 0.30))

  // 5) 空气浮尘：缓慢上升的发光微粒，给空间体积感与生命力
  const motes = new BABYLON.ParticleSystem('motes', 220, scene)
  motes.particleTexture = _softTex('mote')
  motes.emitter = new BABYLON.Vector3(0, 1.0, 0)
  motes.minEmitBox = new BABYLON.Vector3(-3.4, -1.2, -3.4)
  motes.maxEmitBox = new BABYLON.Vector3(3.4, 2.6, 3.4)
  motes.color1 = new BABYLON.Color4(0.55, 0.7, 1.0, 0.5)
  motes.color2 = new BABYLON.Color4(1.0, 0.6, 0.6, 0.5)
  motes.colorDead = new BABYLON.Color4(0, 0, 0, 0)
  motes.minSize = 0.02; motes.maxSize = 0.07
  motes.minLifeTime = 4; motes.maxLifeTime = 8
  motes.emitRate = 36
  motes.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD
  motes.gravity = new BABYLON.Vector3(0, 0.015, 0)
  motes.direction1 = new BABYLON.Vector3(-0.08, 0.08, -0.08)
  motes.direction2 = new BABYLON.Vector3(0.08, 0.28, 0.08)
  motes.minEmitPower = 0.04; motes.maxEmitPower = 0.14
  motes.updateSpeed = 0.01
  motes.start()

  // 6) 地面薄雾：擂台底部贴地的彩色雾气，大而软、缓慢流动
  const mist = new BABYLON.ParticleSystem('mist', 60, scene)
  mist.particleTexture = _softTex('mist')
  mist.emitter = new BABYLON.Vector3(0, -0.15, 0)
  mist.minEmitBox = new BABYLON.Vector3(-3.6, 0, -3.6)
  mist.maxEmitBox = new BABYLON.Vector3(3.6, 0.3, 3.6)
  mist.color1 = new BABYLON.Color4(0.28, 0.4, 0.85, 0.12)
  mist.color2 = new BABYLON.Color4(0.6, 0.28, 0.7, 0.12)
  mist.colorDead = new BABYLON.Color4(0, 0, 0, 0)
  mist.minSize = 1.6; mist.maxSize = 3.4
  mist.minLifeTime = 6; mist.maxLifeTime = 11
  mist.emitRate = 8
  mist.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD
  mist.direction1 = new BABYLON.Vector3(-0.05, 0, -0.05)
  mist.direction2 = new BABYLON.Vector3(0.05, 0.02, 0.05)
  mist.minEmitPower = 0.02; mist.maxEmitPower = 0.08
  mist.updateSpeed = 0.008
  mist.start()

  // 7) 环绕能量火花：几颗发光粒子绕擂台公转 + 上下浮动，增加动态
  const sparkM = new BABYLON.StandardMaterial('sparkM', scene)
  sparkM.emissiveColor = new BABYLON.Color3(0.6, 0.85, 1.0); sparkM.disableLighting = true; sparkM.fogEnabled = false
  const sparks = []
  for (let i = 0; i < 6; i++) {
    const s = BABYLON.MeshBuilder.CreateSphere('spark' + i, { diameter: 0.06, segments: 6 }, scene)
    s.material = sparkM; s.isPickable = false
    sparks.push({ mesh: s, a: (i / 6) * Math.PI * 2, r: 2.9 + (i % 2) * 0.35, h: 0.9 + (i % 3) * 0.45, sp: 0.00045 + i * 0.00004 })
  }

  // 网格+霓虹环呼吸脉冲 + 火花公转（合并到一个观察者）
  const _pulseT0 = performance.now()
  scene.onBeforeRenderObservable.add(() => {
    const now = performance.now() - _pulseT0
    const p = 0.5 + 0.5 * Math.sin(now * 0.0011)
    gm.emissiveColor.set(0.22 + 0.16 * p, 0.34 + 0.18 * p, 0.62 + 0.33 * p)
    rm.emissiveColor.set(0.34 + 0.12 * p, 0.26 + 0.10 * p, 0.78 + 0.12 * p)
    for (const o of sparks) {
      const ang = o.a + now * o.sp
      o.mesh.position.set(Math.cos(ang) * o.r, o.h + Math.sin(now * 0.001 + o.a) * 0.35, Math.sin(ang) * o.r)
    }
  })

  const me = new Fighter3D(scene, 'me', PAL_ME_3D, +1)
  const opp = new Fighter3D(scene, 'opp', PAL_OPP_3D, -1)

  const ctrl = {
    engine, scene, ready: false,
    setCharge(p, o) { me.setCharged(!!p); opp.setCharged(!!o) },
    playRound(r) { _play(r) },
    resize() { engine.resize() },
    dispose() {
      try { engine.stopRenderLoop() } catch { /* noop */ }
      scene.dispose(); engine.dispose()
    },
  }

  // 节拍（回合窗口≈2200ms）
  const HITSTOP_MS = 95    // 顿帧时长
  const RESET_MS = 2000    // 回到 idle（窗口内、避免拦腰打断出招）
  const REACH = 0.95       // 单方进攻：冲到离对手这么近
  const CENTER_GAP = 0.6   // 双方对攻：各自离场地中心这么远（防穿模）

  // 攻击方前冲到对手身边再出拳（仅模型路径在 Fighter3D.lunge 内生效）
  function _approach(r) {
    const meAdv = r.playerAction === 'attack'
    const oppAdv = r.opponentAction === 'attack'
    if (meAdv && oppAdv) { me.lunge(-CENTER_GAP); opp.lunge(CENTER_GAP) }
    else if (meAdv) { me.lunge(opp.home.x - me.faceSign * REACH) }
    else if (oppAdv) { opp.lunge(me.home.x - opp.faceSign * REACH) }
  }

  function _play(r) {
    if (!r) return
    me.playAction(r.playerAction)
    opp.playAction(r.opponentAction)
    _approach(r)

    const meKO = r.gameResult === 'lose' || r.gameResult === 'doubleLose'
    const oppKO = r.gameResult === 'win' || r.gameResult === 'doubleLose'

    // 命中/终局都挪到拳头"打实"的时刻统一触发（按动画时长动态算），才对得上
    if (r.playerDmg > 0 || r.opponentDmg > 0 || meKO || oppKO) {
      setTimeout(() => _impact(r, meKO, oppKO), me.attackContactMs())
    }

    if (!r.gameResult) {
      setTimeout(() => { me.resetToIdle(); opp.resetToIdle() }, RESET_MS)
    }
  }

  // 命中瞬间：致命一击直接倒地（不被受击动画打断），否则普通受击；叠加顿帧/震屏/推镜/火花/飘字
  function _impact(r, meKO, oppKO) {
    onImpact?.(r)  // 通知外层 HUD：拳头此刻打实，扣血/头像抖动与命中特效同帧呈现
    if (meKO) me.knockout()
    else if (r.playerDmg > 0) me.reactHit()
    if (oppKO) opp.knockout()
    else if (r.opponentDmg > 0) opp.reactHit()

    const big = Math.max(r.playerDmg, r.opponentDmg) >= CRIT_THRESHOLD
    if (r.playerDmg > 0) _impactFx(me, opp, r.playerDmg)
    if (r.opponentDmg > 0) _impactFx(opp, me, r.opponentDmg)

    me.hitStop(big ? 150 : HITSTOP_MS); opp.hitStop(big ? 150 : HITSTOP_MS)
    _shake(r)
    _zoomPunch(r)
    if (big) _critFlash()
    _dmgText(r)
  }

  // 命中镜头震屏
  function _shake(r) {
    const big = Math.max(r.playerDmg, r.opponentDmg) >= CRIT_THRESHOLD
    const amp = big ? 0.18 : 0.10
    const start = performance.now()
    const dur = 260
    const base = cam.target.clone()
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) { cam.target.copyFrom(base); scene.onBeforeRenderObservable.remove(obs); return }
      const k = (1 - t / dur) * amp
      cam.target.set(base.x + (Math.random() - 0.5) * k, base.y + (Math.random() - 0.5) * k, base.z)
    })
  }

  // 命中快速推镜（fov 短促下压再回弹，给一拳"凑近"的冲击）
  function _zoomPunch(r) {
    const big = Math.max(r.playerDmg, r.opponentDmg) >= CRIT_THRESHOLD
    const dip = big ? 0.10 : 0.06
    const base = 0.8
    const start = performance.now(), dur = 200
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) { cam.fov = base; scene.onBeforeRenderObservable.remove(obs); return }
      const k = t / dur
      const e = k < 0.35 ? (k / 0.35) : (1 - (k - 0.35) / 0.65) // 先压后弹
      cam.fov = base - dip * e
    })
  }

  // 命中特效共享贴图：火花点（软）+ 冲击波环（一次创建反复用，避免每拳新建贴图）
  const _fxSpark = _softTex('fxSpark')
  const _fxRing = (() => {
    const s = 128
    const t = new BABYLON.DynamicTexture('fxRing', s, scene, false)
    const c = t.getContext()
    c.translate(s / 2, s / 2)
    c.strokeStyle = 'rgba(255,255,255,1)'; c.lineWidth = 9
    c.beginPath(); c.arc(0, 0, s / 2 - 12, 0, 7); c.stroke()
    c.globalAlpha = 0.45; c.lineWidth = 24; c.stroke()
    t.hasAlpha = true; t.update()
    return t
  })()

  // 命中特效：核心热闪 + 冲击波环 + 火花迸射三层叠加；暴击更大更金
  function _impactFx(victim, other, dmg = 0) {
    const crit = dmg >= CRIT_THRESHOLD
    // 用两人实时位置：落在被击者(victim)朝向对手(other)的那一面——出拳/对攻/反击都对得上
    const vx = victim.root ? victim.root.position.x : victim.home.x
    const ox = other.root ? other.root.position.x : other.home.x
    const dir = Math.sign(ox - vx) || victim.faceSign
    const pos = new BABYLON.Vector3(vx + dir * 0.35, 1.15, 0.18)

    // ① 核心热闪：接触点一团高亮快速膨胀淡出
    const sp = BABYLON.MeshBuilder.CreateSphere('imp', { diameter: crit ? 0.30 : 0.22, segments: 8 }, scene)
    const m = new BABYLON.StandardMaterial('impM', scene)
    m.emissiveColor = crit ? new BABYLON.Color3(1, 0.78, 0.3) : new BABYLON.Color3(1, 0.9, 0.6)
    m.disableLighting = true; m.alpha = 0.9; m.backFaceCulling = false; m.fogEnabled = false
    sp.position.copyFrom(pos); sp.material = m
    const t0 = performance.now(), durC = 170
    const obsC = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - t0
      if (t >= durC) { sp.dispose(); m.dispose(); scene.onBeforeRenderObservable.remove(obsC); return }
      const k = t / durC
      sp.scaling.setAll(1 + k * (crit ? 2.2 : 1.6))
      m.alpha = 0.9 * (1 - k)
    })

    _shockwave(pos, crit)
    _sparkBurst(pos, crit, dir)
  }

  // ② 冲击波：朝相机的发光环急速扩张淡出（ease-out 收尾），暴击更大
  function _shockwave(pos, crit) {
    const plane = BABYLON.MeshBuilder.CreatePlane('sw', { size: 1 }, scene)
    plane.position.copyFrom(pos); plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
    const m = new BABYLON.StandardMaterial('swM', scene)
    m.emissiveTexture = _fxRing; m.opacityTexture = _fxRing
    m.emissiveColor = crit ? new BABYLON.Color3(1, 0.82, 0.35) : new BABYLON.Color3(0.7, 0.86, 1)
    m.disableLighting = true; m.backFaceCulling = false; m.fogEnabled = false
    m.alphaMode = BABYLON.Engine.ALPHA_ADD
    plane.material = m
    const t0 = performance.now(), dur = crit ? 320 : 240, max = crit ? 2.8 : 1.9
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - t0
      if (t >= dur) { plane.dispose(); m.dispose(); scene.onBeforeRenderObservable.remove(obs); return }
      const k = t / dur, e = 1 - Math.pow(1 - k, 3)
      plane.scaling.setAll(0.3 + e * max)
      m.alpha = 1 - k
    })
  }

  // ③ 火花迸射：一次性发射一簇拉伸粒子，朝被击方向外侧扇开后受重力下坠
  function _sparkBurst(pos, crit, dirSign) {
    const ps = new BABYLON.ParticleSystem('spk', 48, scene)
    ps.particleTexture = _fxSpark
    ps.emitter = pos.clone()
    ps.minEmitBox = BABYLON.Vector3.Zero(); ps.maxEmitBox = BABYLON.Vector3.Zero()
    const col = crit ? new BABYLON.Color4(1, 0.86, 0.36, 1) : new BABYLON.Color4(1, 0.95, 0.72, 1)
    ps.color1 = col; ps.color2 = col; ps.colorDead = new BABYLON.Color4(1, 0.4, 0.12, 0)
    ps.minSize = 0.04; ps.maxSize = crit ? 0.16 : 0.11
    ps.minLifeTime = 0.12; ps.maxLifeTime = crit ? 0.42 : 0.30
    ps.emitRate = 0; ps.manualEmitCount = crit ? 32 : 18   // 一次性爆发
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD
    ps.direction1 = new BABYLON.Vector3(dirSign * 0.3 - 1, -1, -1)
    ps.direction2 = new BABYLON.Vector3(dirSign * 0.3 + 1, 1.2, 1)
    ps.minEmitPower = crit ? 4 : 2.6; ps.maxEmitPower = crit ? 8.5 : 5.2
    ps.gravity = new BABYLON.Vector3(0, -13, 0)
    ps.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_STRETCHED
    ps.updateSpeed = 0.02
    ps.start()
    setTimeout(() => ps.dispose(), 700)
  }

  // 暴击全屏顿亮：曝光瞬间提亮再回落，强化"一记重拳"的闪光
  function _critFlash() {
    const base = pipe.imageProcessing.exposure
    const t0 = performance.now(), dur = 180
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - t0
      if (t >= dur) { pipe.imageProcessing.exposure = base; scene.onBeforeRenderObservable.remove(obs); return }
      const k = t / dur, e = k < 0.3 ? k / 0.3 : 1 - (k - 0.3) / 0.7
      pipe.imageProcessing.exposure = base + 0.45 * e
    })
  }

  // 伤害飘字（用 DynamicTexture 贴在朝向相机的平面上）
  function _dmgText(r) {
    if (r.opponentDmg > 0) _float(new BABYLON.Vector3(opp.home.x, 2.4, 0), r.opponentDmg)
    if (r.playerDmg > 0) _float(new BABYLON.Vector3(me.home.x, 2.4, 0), r.playerDmg)
  }
  function _float(pos, dmg) {
    const crit = dmg >= CRIT_THRESHOLD
    const dt = new BABYLON.DynamicTexture('dmg', { width: 256, height: 128 }, scene, false)
    dt.hasAlpha = true
    const ctx = dt.getContext()
    ctx.clearRect(0, 0, 256, 128)
    ctx.font = 'bold ' + (crit ? 96 : 72) + 'px Arial'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.lineWidth = 8; ctx.strokeStyle = '#000'
    ctx.strokeText('-' + dmg, 128, 64)
    ctx.fillStyle = crit ? '#ffd34d' : '#ff5a5a'
    ctx.fillText('-' + dmg, 128, 64)
    dt.update()
    const mat = new BABYLON.StandardMaterial('dmgM', scene)
    mat.diffuseTexture = dt; mat.emissiveColor = new BABYLON.Color3(1, 1, 1)
    mat.opacityTexture = dt; mat.disableLighting = true; mat.backFaceCulling = false
    const plane = BABYLON.MeshBuilder.CreatePlane('dmgP', { width: 1.6, height: 0.8 }, scene)
    plane.material = mat; plane.position.copyFrom(pos)
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
    const start = performance.now(), dur = 850, y0 = pos.y
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) { plane.dispose(); mat.dispose(); dt.dispose(); scene.onBeforeRenderObservable.remove(obs); return }
      const k = t / dur
      plane.position.y = y0 + k * 0.9
      mat.alpha = 1 - k
    })
  }

  engine.runRenderLoop(() => scene.render())

  // me=fighter.glb(Vanguard)，opp=fighter2.glb(Mutant)，各自独立骨骼/动画；
  // 对手模型缺省则回退到 fighter.glb；连第一个都没有则双方用占位斗士。
  BABYLON.SceneLoader.ImportMeshAsync('', GLB_ROOT, GLB_FILE, scene)
    .then((res1) => {
      me.useModel(res1)
      return BABYLON.SceneLoader.ImportMeshAsync('', GLB_ROOT, GLB_FILE_OPP, scene)
        .catch(() => BABYLON.SceneLoader.ImportMeshAsync('', GLB_ROOT, GLB_FILE, scene))
    })
    .then((res2) => { opp.useModel(res2); _finish() })
    .catch(() => { me.buildPlaceholder(); opp.buildPlaceholder(); _finish() })

  function _finish() {
    me.placeAt(new BABYLON.Vector3(-1.5, 0, 0), Math.PI / 2)
    opp.placeAt(new BABYLON.Vector3(1.5, 0, 0), -Math.PI / 2)
    me.resetToIdle(); opp.resetToIdle()
    ctrl.setCharge(playerCharged, opponentCharged)
    ctrl.ready = true
    onReady?.(ctrl)
  }

  return ctrl
}
