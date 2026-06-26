// 铁拳 - 三期 3D 斗士（Babylon.js，方案B）
// 两条渲染路径，同一组方法驱动：
//   1) glb 就位：加载 Mixamo 角色（Blender 转 glb），按 AnimationGroup 名播放骨骼动画
//   2) glb 缺省：用基础几何体拼一个低多边形机甲拳手作占位，靠 transform 补间表现
// 自包含：换正式模型只改本文件 / 丢入 glb，BattleScene3D 与上层不变。
// glb 契约见 docs/ironfist.md 第二十二节 + public/games/ironfist/README。

import * as BABYLON from '@babylonjs/core'

const FPS = 60
const FLOAT = BABYLON.Animation.ANIMATIONTYPE_FLOAT

// 关键帧补间助手（作用于 TransformNode 的子属性）
function tween(scene, node, prop, keys, { loop = false, onEnd } = {}) {
  const mode = loop ? BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE : BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT
  const a = new BABYLON.Animation('t_' + prop, prop, FPS, FLOAT, mode)
  a.setKeys(keys)
  return scene.beginDirectAnimation(node, [a], keys[0].frame, keys[keys.length - 1].frame, loop, 1, onEnd)
}

// 动作语义 → glb 动画 clip 名（用户在 Blender 里按此命名导出）
const CLIP = { attack: 'attack', defend: 'defend', charge: 'charge', counter: 'dodge' }
// 播放倍速（1 = 动画原速）。先全部原速，按手感再单独提
const CLIP_SPEED = { attack: 1.0, dodge: 1.0, defend: 1.0, charge: 1.0, hit: 1.0, ko: 1.0, idle: 1.0 }
// 出拳动画中"拳头打实"大约在整段的这个比例处（用于同步命中特效）
const ATTACK_CONTACT_FRACTION = 0.55

export class Fighter3D {
  /**
   * @param {BABYLON.Scene} scene
   * @param {string} side 'me' | 'opp'
   * @param {object} pal  Color3 配色
   * @param {number} faceSign 朝向对手的世界 X 方向（me=+1 向右，opp=-1 向左）
   */
  constructor(scene, side, pal, faceSign) {
    this.scene = scene
    this.side = side
    this.pal = pal
    this.faceSign = faceSign
    this.root = null
    this.aura = null
    this.groups = {}          // glb：clipName -> AnimationGroup
    this.hasModel = false
    this.home = new BABYLON.Vector3(0, 0, 0)
    this.baseRotY = 0
    this._auraAnims = []
    this._flashMats = []
  }

  // ── 占位低多边形机甲拳手 ────────────────────────────────
  buildPlaceholder() {
    const s = this.scene, p = this.pal
    const root = new BABYLON.TransformNode('f3d_' + this.side, s)
    this.root = root

    const bodyMat = new BABYLON.StandardMaterial('bm_' + this.side, s)
    bodyMat.diffuseColor = p.body; bodyMat.emissiveColor = p.bodyEmis
    bodyMat.specularColor = new BABYLON.Color3(0.25, 0.25, 0.3)
    const headMat = new BABYLON.StandardMaterial('hm_' + this.side, s)
    headMat.diffuseColor = p.head; headMat.emissiveColor = p.headEmis
    const gloveMat = new BABYLON.StandardMaterial('gm_' + this.side, s)
    gloveMat.diffuseColor = p.glove; gloveMat.emissiveColor = p.glove.scale(0.18)
    const visorMat = new BABYLON.StandardMaterial('vm_' + this.side, s)
    visorMat.emissiveColor = p.visor; visorMat.diffuseColor = new BABYLON.Color3(0, 0, 0); visorMat.disableLighting = true

    const body = BABYLON.MeshBuilder.CreateCapsule('body', { radius: 0.4, height: 1.25, tessellation: 12 }, s)
    body.position.y = 0.95; body.material = bodyMat; body.parent = root
    const head = BABYLON.MeshBuilder.CreateSphere('head', { diameter: 0.74, segments: 14 }, s)
    head.position.y = 1.78; head.material = headMat; head.parent = root
    const visor = BABYLON.MeshBuilder.CreateBox('visor', { width: 0.52, height: 0.16, depth: 0.12 }, s)
    visor.position.set(0, 1.8, 0.3 * this.faceSign); visor.material = visorMat; visor.parent = root
    const ant = BABYLON.MeshBuilder.CreateCylinder('ant', { height: 0.32, diameter: 0.05 }, s)
    ant.position.set(0, 2.18, 0); ant.material = headMat; ant.parent = root
    const antTip = BABYLON.MeshBuilder.CreateSphere('antTip', { diameter: 0.13 }, s)
    antTip.position.set(0, 2.36, 0); antTip.material = gloveMat; antTip.parent = root

    const gl = BABYLON.MeshBuilder.CreateSphere('gl', { diameter: 0.46, segments: 12 }, s)
    gl.position.set(0.32 * this.faceSign, 1.05, -0.3); gl.material = gloveMat; gl.parent = root
    const gr = BABYLON.MeshBuilder.CreateSphere('gr', { diameter: 0.46, segments: 12 }, s)
    gr.position.set(0.32 * this.faceSign, 1.05, 0.3); gr.material = gloveMat; gr.parent = root

    const legL = BABYLON.MeshBuilder.CreateCapsule('legL', { radius: 0.16, height: 0.55 }, s)
    legL.position.set(-0.2, 0.32, 0); legL.material = bodyMat; legL.parent = root
    const legR = BABYLON.MeshBuilder.CreateCapsule('legR', { radius: 0.16, height: 0.55 }, s)
    legR.position.set(0.2, 0.32, 0); legR.material = bodyMat; legR.parent = root

    this._flashMats = [bodyMat, headMat, gloveMat]
    this._flashBase = [p.bodyEmis, p.headEmis, p.glove.scale(0.18)]
    this.hasModel = false
    this._buildAura()
  }

  // ── glb 模型 ────────────────────────────────────────────
  useModel(res) {
    const s = this.scene
    const root = new BABYLON.TransformNode('f3d_' + this.side, s)
    this.root = root
    res.meshes.forEach((m) => { if (!m.parent) m.parent = root })
    this.groups = {}
    res.animationGroups.forEach((g) => { g.stop(); this.groups[g.name.toLowerCase()] = g })
    this.hasModel = res.animationGroups.length > 0
    // 收集材质用于受击高亮（PBR：闪一下 emissiveColor）
    this._flashMats = []
    this._flashBase = []
    res.meshes.forEach((m) => {
      const mat = m.material
      if (mat && mat.emissiveColor && !this._flashMats.includes(mat)) {
        this._flashMats.push(mat)
        this._flashBase.push(mat.emissiveColor.clone())
      }
    })
    this._buildAura()
  }

  _buildAura() {
    const s = this.scene
    const aura = BABYLON.MeshBuilder.CreateTorus('aura_' + this.side, { diameter: 1.7, thickness: 0.09, tessellation: 36 }, s)
    const am = new BABYLON.StandardMaterial('am_' + this.side, s)
    am.emissiveColor = this.pal.aura; am.disableLighting = true; am.alpha = 0.85
    aura.material = am; aura.parent = this.root
    aura.position.y = 0.06; aura.rotation.x = Math.PI / 2
    aura.setEnabled(false)
    this.aura = aura
  }

  placeAt(pos, rotY) {
    this.home = pos.clone()
    this.baseRotY = rotY
    this.root.position.copyFrom(pos)
    this.root.rotation.y = rotY
  }

  // ── 状态 ───────────────────────────────────────────────
  setCharged(on) {
    if (!this.aura) return
    if (on === this.aura.isEnabled()) return
    this.aura.setEnabled(on)
    this._auraAnims.forEach((a) => a.stop()); this._auraAnims = []
    if (on) {
      for (const ax of ['scaling.x', 'scaling.y', 'scaling.z']) {
        this._auraAnims.push(tween(this.scene, this.aura, ax,
          [{ frame: 0, value: 0.92 }, { frame: 30, value: 1.18 }, { frame: 60, value: 0.92 }], { loop: true }))
      }
    } else {
      this.aura.scaling.setAll(1)
    }
  }

  resetToIdle() {
    if (this.hasModel) {
      this._playClip('idle', true)
      return
    }
    const s = this.scene, h = this.home
    tween(s, this.root, 'position.x', [{ frame: 0, value: this.root.position.x }, { frame: 10, value: h.x }])
    tween(s, this.root, 'position.y', [{ frame: 0, value: this.root.position.y }, { frame: 10, value: h.y }])
    tween(s, this.root, 'position.z', [{ frame: 0, value: this.root.position.z }, { frame: 10, value: h.z }])
    tween(s, this.root, 'scaling.y', [{ frame: 0, value: this.root.scaling.y }, { frame: 10, value: 1 }])
    tween(s, this.root, 'rotation.z', [{ frame: 0, value: this.root.rotation.z }, { frame: 10, value: 0 }])
  }

  // ── 动作 ───────────────────────────────────────────────
  playAction(name) {
    if (this.hasModel) {
      const clip = CLIP[name] || 'idle'
      this._playClip(clip, false, () => this._playClip('idle', true), CLIP_SPEED[clip] || 1)
      return
    }
    const s = this.scene, h = this.home, f = this.faceSign
    if (name === 'attack') {
      tween(s, this.root, 'position.x', [{ frame: 0, value: h.x }, { frame: 7, value: h.x + f * 0.75 }, { frame: 20, value: h.x }])
    } else if (name === 'defend') {
      tween(s, this.root, 'scaling.y', [{ frame: 0, value: 1 }, { frame: 8, value: 0.82 }])
    } else if (name === 'charge') {
      tween(s, this.root, 'position.y', [{ frame: 0, value: h.y }, { frame: 15, value: h.y + 0.14 }, { frame: 30, value: h.y }])
    } else if (name === 'counter') {
      tween(s, this.root, 'position.z', [{ frame: 0, value: h.z }, { frame: 7, value: h.z + 0.7 }, { frame: 20, value: h.z }])
      tween(s, this.root, 'rotation.z', [{ frame: 0, value: 0 }, { frame: 7, value: -0.2 }, { frame: 20, value: 0 }])
    }
  }

  reactHit() {
    if (this.hasModel) {
      this._playClip('hit', false, () => this._playClip('idle', true), CLIP_SPEED.hit)
    } else {
      const h = this.home, f = this.faceSign
      tween(this.scene, this.root, 'position.x', [{ frame: 0, value: h.x }, { frame: 4, value: h.x - f * 0.32 }, { frame: 14, value: h.x }])
    }
    this._flash()
  }

  knockout() {
    if (this.hasModel) { this._playClip('ko', false); return }
    tween(this.scene, this.root, 'rotation.z', [{ frame: 0, value: 0 }, { frame: 22, value: this.faceSign * 1.45 }])
  }

  // 出拳"打实"的时刻（ms）：按 attack 动画实际时长 × 接触比例 ÷ 倍速动态计算，
  // 避免写死导致光圈/飘字早于拳头到位。无模型时给个保底值。
  attackContactMs() {
    const g = this.groups && this.groups.attack
    if (!g || !g.targetedAnimations?.length) return 360
    const fps = g.targetedAnimations[0].animation.framePerSecond || 60
    const durSec = Math.abs(g.to - g.from) / fps
    const speed = CLIP_SPEED.attack || 1
    return Math.round((durSec * ATTACK_CONTACT_FRACTION / speed) * 1000)
  }

  // 顿帧：命中瞬间把当前动画冻住极短时间，制造"打实"的卡顿感
  hitStop(ms = 90) {
    if (!this.hasModel || !this._current) return
    const g = this._current
    const prev = g.speedRatio || 1
    g.speedRatio = 0
    setTimeout(() => { if (this._current === g) g.speedRatio = prev }, ms)
  }

  _flash() {
    if (!this._flashMats?.length) return
    this._flashMats.forEach((m) => { m.emissiveColor = new BABYLON.Color3(1, 0.55, 0.5) })
    setTimeout(() => {
      this._flashMats.forEach((m, i) => { m.emissiveColor = this._flashBase[i] })
    }, 130)
  }

  _playClip(name, loop, onEnd, speed = 1) {
    const g = this.groups[name]
    if (!g) { if (onEnd) onEnd(); return }
    if (this._current && this._current !== g) this._current.stop()
    this._current = g
    g.stop(); g.start(loop, speed)
    if (!loop && onEnd) {
      g.onAnimationGroupEndObservable.addOnce(() => onEnd())
    }
  }
}

export const PAL_ME_3D = {
  body: new BABYLON.Color3(0.30, 0.55, 1.0), bodyEmis: new BABYLON.Color3(0.05, 0.10, 0.26),
  head: new BABYLON.Color3(0.82, 0.90, 1.0), headEmis: new BABYLON.Color3(0.10, 0.16, 0.28),
  glove: new BABYLON.Color3(1.0, 0.36, 0.36), visor: new BABYLON.Color3(0.42, 0.85, 1.0),
  aura: new BABYLON.Color3(0.45, 0.72, 1.0),
}
export const PAL_OPP_3D = {
  body: new BABYLON.Color3(1.0, 0.40, 0.40), bodyEmis: new BABYLON.Color3(0.28, 0.05, 0.07),
  head: new BABYLON.Color3(0.72, 0.74, 0.82), headEmis: new BABYLON.Color3(0.22, 0.06, 0.07),
  glove: new BABYLON.Color3(0.36, 0.62, 1.0), visor: new BABYLON.Color3(1.0, 0.35, 0.30),
  aura: new BABYLON.Color3(1.0, 0.78, 0.32),
}
