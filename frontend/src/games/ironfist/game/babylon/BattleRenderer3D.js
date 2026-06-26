// 铁拳 - 三期 3D 战斗渲染器（Babylon.js，方案B）
// 工厂返回控制器：{ setCharge, playRound, resize, dispose, ready }。
// 渲染无关引擎(IronFistGame)与 HUD 不变；本控制器只消费每回合结算结果 + 蓄力态。
// 见 docs/ironfist.md 第十三/二十二节。

import * as BABYLON from '@babylonjs/core'
import '@babylonjs/loaders/glTF'  // 注册 glTF/glb 加载器（副作用 import）
import { Fighter3D, PAL_ME_3D, PAL_OPP_3D } from './Fighter3D.js'

// glb 放在 public/ 下，构建后从站点根提供
const GLB_ROOT = '/games/ironfist/'
const GLB_FILE = 'fighter.glb'

const CRIT_THRESHOLD = 18

export function createBattleRenderer3D(canvas, { playerCharged = false, opponentCharged = false, onReady } = {}) {
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true })
  const scene = new BABYLON.Scene(engine)
  scene.clearColor = new BABYLON.Color4(0.05, 0.04, 0.10, 1)

  // 固定机位（正面略俯，无交互控制）
  const cam = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, 1.15, 7.8, new BABYLON.Vector3(0, 1.15, 0), scene)
  cam.fov = 0.8
  cam.minZ = 0.1

  // 灯光：环境 + 主光 + 蓝/红边缘光（呼应参考图左蓝右红）
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene)
  hemi.intensity = 0.75
  hemi.groundColor = new BABYLON.Color3(0.1, 0.1, 0.2)
  const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-0.3, -1, 0.45), scene)
  dir.intensity = 0.55
  const blue = new BABYLON.PointLight('pBlue', new BABYLON.Vector3(-3.4, 2.2, -2.2), scene)
  blue.diffuse = new BABYLON.Color3(0.35, 0.55, 1.0); blue.intensity = 22
  const red = new BABYLON.PointLight('pRed', new BABYLON.Vector3(3.4, 2.2, -2.2), scene)
  red.diffuse = new BABYLON.Color3(1.0, 0.35, 0.32); red.intensity = 22

  // 擂台
  const plat = BABYLON.MeshBuilder.CreateCylinder('plat', { diameter: 5.4, height: 0.3, tessellation: 56 }, scene)
  const pm = new BABYLON.StandardMaterial('pm', scene)
  pm.diffuseColor = new BABYLON.Color3(0.12, 0.10, 0.20)
  pm.emissiveColor = new BABYLON.Color3(0.05, 0.04, 0.11)
  plat.material = pm; plat.position.y = -0.15
  const ring = BABYLON.MeshBuilder.CreateTorus('ring', { diameter: 5.2, thickness: 0.08, tessellation: 56 }, scene)
  const rm = new BABYLON.StandardMaterial('rm', scene)
  rm.emissiveColor = new BABYLON.Color3(0.42, 0.32, 0.85); rm.disableLighting = true
  ring.material = rm; ring.position.y = 0.02

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

  function _play(r) {
    if (!r) return
    me.playAction(r.playerAction)
    opp.playAction(r.opponentAction)

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
    if (meKO) me.knockout()
    else if (r.playerDmg > 0) me.reactHit()
    if (oppKO) opp.knockout()
    else if (r.opponentDmg > 0) opp.reactHit()

    if (r.playerDmg > 0) _impactFx(me.home)
    if (r.opponentDmg > 0) _impactFx(opp.home)

    me.hitStop(HITSTOP_MS); opp.hitStop(HITSTOP_MS)
    _shake(r)
    _zoomPunch(r)
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

  // 命中火花：接触点一小团暖光快速膨胀淡出（小而短，是"火花"不是"光环"）
  function _impactFx(home) {
    const sp = BABYLON.MeshBuilder.CreateSphere('imp', { diameter: 0.22, segments: 8 }, scene)
    const m = new BABYLON.StandardMaterial('impM', scene)
    m.emissiveColor = new BABYLON.Color3(1, 0.86, 0.42); m.disableLighting = true
    m.alpha = 0.85; m.backFaceCulling = false
    sp.material = m
    // 落在被击者胸口、略偏向对手一侧
    sp.position.set(home.x * 0.82, 1.15, 0.18)
    const start = performance.now(), dur = 180
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) { sp.dispose(); m.dispose(); scene.onBeforeRenderObservable.remove(obs); return }
      const k = t / dur
      sp.scaling.setAll(1 + k * 1.6)
      m.alpha = 0.85 * (1 - k)
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

  // 尝试加载 glb（两次，各自独立骨骼/动画），失败则用占位斗士
  BABYLON.SceneLoader.ImportMeshAsync('', GLB_ROOT, GLB_FILE, scene)
    .then((res1) => {
      me.useModel(res1)
      return BABYLON.SceneLoader.ImportMeshAsync('', GLB_ROOT, GLB_FILE, scene)
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
