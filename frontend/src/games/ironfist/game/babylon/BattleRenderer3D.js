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

  // 灯光：半球补光 + 上方主光 + 正面中性补光 + 蓝/红边缘光（呼应参考图左蓝右红）
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene)
  hemi.intensity = 2  // 无 IBL，整体补光提回（人物为主角，提亮）
  hemi.groundColor = new BABYLON.Color3(0.14, 0.14, 0.24)
  const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-0.2, -0.95, 0.35), scene)
  dir.intensity = 2
  // 正面补光：相机一侧(−z)一盏中性灯，专打角色朝镜头的那面，解决"太暗看不清"
  const fill = new BABYLON.PointLight('pFill', new BABYLON.Vector3(0, 2.6, -4.8), scene)
  fill.diffuse = new BABYLON.Color3(1.0, 0.97, 0.92); fill.intensity = 24; fill.range = 20
  // fill.diffuse = new BABYLON.Color3(1.0, 0.97, 0.92); fill.intensity = 36; fill.range = 20
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
  pipe.imageProcessing.exposure = 1.06
  pipe.imageProcessing.contrast = 1.05
  pipe.imageProcessing.vignetteEnabled = true
  pipe.imageProcessing.vignetteWeight = 1.8
  pipe.imageProcessing.vignetteColor = new BABYLON.Color4(0, 0, 0, 0)

  // 擂台：暗色侧壁(柱体) + 金色科技顶面(程序贴图，自发光不泛白) + 金色霓虹边环
  const plat = BABYLON.MeshBuilder.CreateCylinder('plat', { diameter: 5.4, height: 0.3, tessellation: 56 }, scene)
  const pm = new BABYLON.StandardMaterial('pm', scene)
  pm.diffuseColor = new BABYLON.Color3(0.10, 0.07, 0.035)
  pm.emissiveColor = new BABYLON.Color3(0.04, 0.028, 0.012)
  pm.specularColor = new BABYLON.Color3(0.05, 0.04, 0.02)  // 压掉白高光，避免被强灯打爆
  plat.material = pm; plat.position.y = -0.15

  // 金色冠军赛顶面（程序生成：同心金环 + 辐射科技线 + 中心五角星徽记）
  function _star(c, cx, cy, ro, ri, n) {
    c.beginPath()
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? ro : ri
      const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
      i === 0 ? c.moveTo(x, y) : c.lineTo(x, y)
    }
    c.closePath(); c.fill()
  }
  function _platTopTex() {
    const s = 1024, R = s / 2
    const t = new BABYLON.DynamicTexture('platTopTex', { width: s, height: s }, scene, true)
    const c = t.getContext()
    const bg = c.createRadialGradient(R, R, 0, R, R, R)
    bg.addColorStop(0, '#2c1e0b'); bg.addColorStop(0.7, '#1a1208'); bg.addColorStop(1, '#0d0904')
    c.fillStyle = bg; c.fillRect(0, 0, s, s)
    c.translate(R, R)
    for (let i = 0; i < 5; i++) {            // 同心金环
      c.strokeStyle = 'rgba(255,194,77,' + (0.45 + i * 0.1) + ')'
      c.lineWidth = i === 4 ? 11 : 4
      c.beginPath(); c.arc(0, 0, R * (0.22 + i * 0.16), 0, 7); c.stroke()
    }
    c.strokeStyle = 'rgba(255,138,61,0.38)'; c.lineWidth = 3   // 辐射科技线
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2
      c.beginPath(); c.moveTo(Math.cos(a) * R * 0.40, Math.sin(a) * R * 0.40); c.lineTo(Math.cos(a) * R * 0.84, Math.sin(a) * R * 0.84); c.stroke()
    }
    // 中心徽记：暗圆底 + 金环 + 金色五角星
    c.fillStyle = 'rgba(18,12,6,0.96)'; c.beginPath(); c.arc(0, 0, R * 0.18, 0, 7); c.fill()
    c.strokeStyle = 'rgba(255,194,77,0.9)'; c.lineWidth = 5; c.beginPath(); c.arc(0, 0, R * 0.18, 0, 7); c.stroke()
    c.fillStyle = 'rgba(255,212,125,1)'; _star(c, 0, 0, R * 0.12, R * 0.05, 5)
    // 整体压暗：金台是背景、别抢角色（叠一层半透明黑）
    // c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(-R, -R, s, s)
    t.update()
    return t
  }
  const platTop = BABYLON.MeshBuilder.CreateDisc('platTop', { radius: 2.68, tessellation: 64 }, scene)
  platTop.rotation.x = -Math.PI / 2          // 立面 → 朝上
  platTop.position.y = 0.012                  // 紧贴柱顶、压在边环之下，防 z-fighting
  const ptm = new BABYLON.StandardMaterial('ptm', scene)
  ptm.emissiveTexture = _platTopTex(); ptm.disableLighting = true
  ptm.specularColor = new BABYLON.Color3(0, 0, 0); ptm.backFaceCulling = false
  platTop.material = ptm; platTop.isPickable = false

  // 金色霓虹边环
  const ring = BABYLON.MeshBuilder.CreateTorus('ring', { diameter: 5.2, thickness: 0.08, tessellation: 56 }, scene)
  const rm = new BABYLON.StandardMaterial('rm', scene)
  rm.emissiveColor = new BABYLON.Color3(1.0, 0.62, 0.18); rm.disableLighting = true
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
    // rm.emissiveColor.set(0.90 + 0.28 * p, 0.52 + 0.18 * p, 0.14 + 0.08 * p)
    rm.emissiveColor.set(0.52 + 0.16 * p, 0.30 + 0.10 * p, 0.08 + 0.05 * p)
    for (const o of sparks) {
      const ang = o.a + now * o.sp
      o.mesh.position.set(Math.cos(ang) * o.r, o.h + Math.sin(now * 0.001 + o.a) * 0.35, Math.sin(ang) * o.r)
    }
  })

  // 8) 看台建筑：lathe 旋转阶梯剖面 → 环绕擂台的体育馆碗状看台（暗色 + 冷色台阶边线，不与金台抢眼）
  // {
  //   const prof = [new BABYLON.Vector3(6.8, -0.35, 0)]
  //   for (let i = 0; i < 6; i++) {
  //     const r0 = 7.0 + i * 1.45, y0 = -0.1 + i * 0.6
  //     prof.push(new BABYLON.Vector3(r0, y0, 0))            // 台阶踏面内沿
  //     prof.push(new BABYLON.Vector3(r0 + 1.25, y0, 0))     // 踏面外沿
  //     prof.push(new BABYLON.Vector3(r0 + 1.25, y0 + 0.6, 0)) // 竖起的踢面
  //   }
  //   prof.push(new BABYLON.Vector3(16.6, 3.7, 0))           // 顶圈收口
  //   const stands = BABYLON.MeshBuilder.CreateLathe('stands', { shape: prof, tessellation: 72, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene)
  //   const sm = new BABYLON.StandardMaterial('standsMat', scene)
  //   sm.diffuseColor = new BABYLON.Color3(0.05, 0.055, 0.085)
  //   sm.specularColor = new BABYLON.Color3(0.02, 0.02, 0.03)
  //   sm.emissiveColor = new BABYLON.Color3(0.015, 0.018, 0.03)
  //   stands.material = sm; stands.isPickable = false
  //   // 各层踏面前沿冷色霓虹边线：定义看台层次（暗，避免与金台争抢）
  //   const edgeMat = new BABYLON.StandardMaterial('standEdge', scene)
  //   edgeMat.emissiveColor = new BABYLON.Color3(0.16, 0.30, 0.6); edgeMat.disableLighting = true
  //   for (let i = 0; i < 6; i++) {
  //     const r = 7.0 + i * 1.45 + 1.25
  //     const e = BABYLON.MeshBuilder.CreateTorus('standEdge' + i, { diameter: r * 2, thickness: 0.05, tessellation: 64 }, scene)
  //     e.position.y = -0.1 + i * 0.6 + 0.02; e.material = edgeMat; e.isPickable = false
  //     glow.addExcludedMesh(e)
  //   }
  // }

  // 9) 观众席：环绕擂台、逐层升高的人群光点（thin instances → 上千个点仅 1 个 draw call）
  //    暖白/蓝/红混色 + 亮度随机，远处被纵深雾吃掉融入暗场，像体育馆里的观众灯海。
  const crowd = BABYLON.MeshBuilder.CreateBox('crowd', { size: 0.12 }, scene)
  const crowdMat = new BABYLON.StandardMaterial('crowdMat', scene)
  crowdMat.emissiveColor = new BABYLON.Color3(1, 1, 1); crowdMat.disableLighting = true
  crowd.material = crowdMat; crowd.isPickable = false
  crowd.alwaysSelectAsActiveMesh = true   // 防止 thin instance 被整体视锥剔除
  glow.addExcludedMesh(crowd)             // 不进 GlowLayer（仍吃管线 Bloom，足够闪烁）
  {
    const mats = [], cols = [], tmp = BABYLON.Matrix.Identity()
    const palette = [[1.0, 0.86, 0.6], [0.4, 0.62, 1.0], [1.0, 0.45, 0.4], [0.82, 0.82, 0.95]]
    for (let tier = 0; tier < 6; tier++) {
      const radius = 8.0 + tier * 1.45      // 逐层外扩
      const y = 0.15 + tier * 0.6           // 逐层升高（看台坡度）
      const n = Math.max(40, Math.floor(2 * Math.PI * radius / 0.42))
      for (let j = 0; j < n; j++) {
        const ang = (j / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.06
        const rr = radius + (Math.random() - 0.5) * 0.7
        BABYLON.Matrix.TranslationToRef(Math.cos(ang) * rr, y + (Math.random() - 0.5) * 0.3, Math.sin(ang) * rr, tmp)
        mats.push(...tmp.asArray())
        const col = palette[(Math.random() * palette.length) | 0], b = 0.45 + Math.random() * 0.85
        cols.push(col[0] * b, col[1] * b, col[2] * b, 1)
      }
    }
    crowd.thinInstanceSetBuffer('matrix', new Float32Array(mats), 16)
    crowd.thinInstanceSetBuffer('color', new Float32Array(cols), 4)
  }
  // 观众灯海整体的轻微明暗呼吸（单值，开销极小）
  const _crowdT0 = performance.now()
  scene.onBeforeRenderObservable.add(() => {
    const k = 0.9 + 0.1 * Math.sin((performance.now() - _crowdT0) * 0.0016)
    crowdMat.emissiveColor.set(k, k, k)
  })

  const me = new Fighter3D(scene, 'me', PAL_ME_3D, +1)
  const opp = new Fighter3D(scene, 'opp', PAL_OPP_3D, -1)

  // 脚下阵营光圈：跟随各自斗士、轻微呼吸脉动，强化站位（蓝=我方 / 红=对手）
  function _footRingTex() {
    const s = 256, R = s / 2
    const t = new BABYLON.DynamicTexture('footRing', s, scene, false)
    const c = t.getContext(); c.translate(R, R)
    const g = c.createRadialGradient(0, 0, 0, 0, 0, R)
    g.addColorStop(0, 'rgba(255,255,255,0.16)')   // 中心淡填充
    g.addColorStop(0.74, 'rgba(255,255,255,0.04)')
    g.addColorStop(0.84, 'rgba(255,255,255,0.95)') // 亮环带
    g.addColorStop(0.93, 'rgba(255,255,255,0.85)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, R, 0, 7); c.fill()
    c.strokeStyle = 'rgba(255,255,255,1)'; c.lineWidth = s * 0.05   // 实描边，定义清晰
    c.beginPath(); c.arc(0, 0, R * 0.87, 0, 7); c.stroke()
    t.hasAlpha = true; t.update()
    return t
  }
  const footTex = _footRingTex()
  function _footRing(color) {
    const d = BABYLON.MeshBuilder.CreateDisc('foot', { radius: 0.8, tessellation: 40 }, scene)
    d.rotation.x = -Math.PI / 2; d.position.y = 0.024; d.isPickable = false
    const m = new BABYLON.StandardMaterial('footM', scene)
    m.emissiveTexture = footTex; m.opacityTexture = footTex; m.emissiveColor = color
    m.disableLighting = true; m.backFaceCulling = false; m.fogEnabled = false
    m.alphaMode = BABYLON.Engine.ALPHA_ADD
    d.material = m; return d
  }
  // 阵营色主通道提到 >1：叠在亮金台面上仍能压住金色、并触发 bloom 发光（不会被洗成灰）
  const meFoot = _footRing(new BABYLON.Color3(0.22, 0.6, 2.1))
  const oppFoot = _footRing(new BABYLON.Color3(2.1, 0.28, 0.22))
  scene.onBeforeRenderObservable.add(() => {
    const pulse = 0.88 + 0.12 * Math.sin(performance.now() * 0.004)
    if (me.root) { meFoot.position.x = me.root.position.x; meFoot.position.z = me.root.position.z }
    if (opp.root) { oppFoot.position.x = opp.root.position.x; oppFoot.position.z = opp.root.position.z }
    meFoot.scaling.setAll(pulse); oppFoot.scaling.setAll(pulse)
  })

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

    // 倒地看血量，不只看结果字串：游戏结束时 HP≤0 即倒下（含"双双空血却判平局"）
    const ended = !!r.gameResult
    const meKO = ended && (r.gameResult === 'lose' || r.gameResult === 'doubleLose' || r.playerHP <= 0)
    const oppKO = ended && (r.gameResult === 'win' || r.gameResult === 'doubleLose' || r.opponentHP <= 0)

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
    _dmgText(r)

    if (big) {
      // 暴击专属演出：子弹时间 + 全屏顿亮 + 推近受击者的特写镜头
      me.slowMo(0.2, 430); opp.slowMo(0.2, 430)
      _critFlash()
      const victim = meKO ? me : oppKO ? opp : (r.playerDmg >= r.opponentDmg ? me : opp)
      _critCinematic(victim)
    } else {
      me.hitStop(HITSTOP_MS); opp.hitStop(HITSTOP_MS)
      _shake(r)
      _zoomPunch(r)
    }
  }

  // 暴击特写：快速推近受击者(降 radius + target 平移到其身上)，短暂定格后回弹；
  // 自带轻微抖动，替代普通命中的震屏/推镜。临时放宽 lowerRadiusLimit 以便贴近。
  function _critCinematic(victim) {
    const baseR = cam.radius, baseLower = cam.lowerRadiusLimit
    const baseTarget = cam.target.clone()
    cam.lowerRadiusLimit = 3.0
    const vx = victim.root ? victim.root.position.x : victim.home.x
    const focus = new BABYLON.Vector3(vx, 1.2, 0)
    const zoomR = Math.max(3.0, baseR * 0.6)
    const start = performance.now(), inMs = 120, hold = 170, outMs = 280, dur = inMs + hold + outMs
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) {
        cam.radius = baseR; cam.target.copyFrom(baseTarget); cam.lowerRadiusLimit = baseLower
        scene.onBeforeRenderObservable.remove(obs); return
      }
      const k = t < inMs ? t / inMs : t < inMs + hold ? 1 : 1 - (t - inMs - hold) / outMs
      const e = k * k * (3 - 2 * k)  // smoothstep
      const j = (t > inMs && t < inMs + hold) ? 0.05 : 0  // 定格期轻微抖动
      cam.radius = baseR + (zoomR - baseR) * e
      cam.target.x = baseTarget.x + (focus.x - baseTarget.x) * e + (Math.random() - 0.5) * j
      cam.target.y = baseTarget.y + (focus.y - baseTarget.y) * e + (Math.random() - 0.5) * j
    })
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
    const W = 512, H = crit ? 256 : 160
    const dt = new BABYLON.DynamicTexture('dmg', { width: W, height: H }, scene, false)
    dt.hasAlpha = true
    const ctx = dt.getContext()
    ctx.clearRect(0, 0, W, H)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    if (crit) {
      // CRITICAL! 横幅
      ctx.font = 'bold italic 66px Arial'
      ctx.lineWidth = 10; ctx.strokeStyle = '#5a1500'; ctx.strokeText('CRITICAL!', W / 2, 60)
      ctx.fillStyle = '#ff7a1a'; ctx.fillText('CRITICAL!', W / 2, 60)
      // 伤害数字（大、金）
      ctx.font = 'bold 140px Arial'
      ctx.lineWidth = 13; ctx.strokeStyle = '#000'; ctx.strokeText('-' + dmg, W / 2, 178)
      ctx.fillStyle = '#ffd34d'; ctx.fillText('-' + dmg, W / 2, 178)
    } else {
      ctx.font = 'bold 100px Arial'
      ctx.lineWidth = 8; ctx.strokeStyle = '#000'; ctx.strokeText('-' + dmg, W / 2, H / 2)
      ctx.fillStyle = '#ff5a5a'; ctx.fillText('-' + dmg, W / 2, H / 2)
    }
    dt.update()
    const mat = new BABYLON.StandardMaterial('dmgM', scene)
    mat.diffuseTexture = dt; mat.emissiveColor = new BABYLON.Color3(1, 1, 1)
    mat.opacityTexture = dt; mat.disableLighting = true; mat.backFaceCulling = false; mat.fogEnabled = false
    const w = crit ? 3.2 : 2.0, h = w * H / W
    const plane = BABYLON.MeshBuilder.CreatePlane('dmgP', { width: w, height: h }, scene)
    plane.material = mat; plane.position.copyFrom(pos)
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL
    const start = performance.now(), dur = crit ? 1150 : 850, y0 = pos.y, rise = crit ? 1.2 : 0.9
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) { plane.dispose(); mat.dispose(); dt.dispose(); scene.onBeforeRenderObservable.remove(obs); return }
      const k = t / dur
      plane.position.y = y0 + k * rise
      mat.alpha = k > 0.7 ? (1 - (k - 0.7) / 0.3) : 1
      if (crit) {  // 弹入：0→1.2 过冲再回落到 1
        const s = k < 0.15 ? (k / 0.15) * 1.2 : k < 0.3 ? 1.2 - 0.2 * ((k - 0.15) / 0.15) : 1
        plane.scaling.setAll(s)
      }
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
