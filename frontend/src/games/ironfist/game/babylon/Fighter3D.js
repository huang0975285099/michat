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
    try {
    const s = this.scene
    const c = this.pal.aura

    // 柔光点贴图（程序化，无需素材）
    const tex = new BABYLON.DynamicTexture('auraTex_' + this.side, 64, s, false)
    const ctx = tex.getContext()
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,0.95)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64)
    tex.hasAlpha = true; tex.update()

    // 发射点：身体中段（让气场从脚到头顶都包住，而非只在脚下）
    const emitNode = new BABYLON.TransformNode('auraEmit_' + this.side, s)
    emitNode.parent = this.root
    emitNode.position.y = 0.9

    // 火焰气场（超级赛亚人式）：圆柱定向发射 + 拉伸 billboard → 沿速度拉成上窜火舌，包裹全身
    const ps = new BABYLON.ParticleSystem('auraPs_' + this.side, 640, s)
    ps.particleTexture = tex
    ps.emitter = emitNode
    ps.createDirectedCylinderEmitter(0.42, 1.7, 0.5,
      new BABYLON.Vector3(-0.06, 1, -0.06),        // 方向：基本朝上，带极小散开
      new BABYLON.Vector3(0.06, 1, 0.06))
    // 颜色随寿命：基部亮、尖端淡出（饱和阵营色，密集叠加也不发白）
    ps.addColorGradient(0.0, new BABYLON.Color4(c.r * 0.95, c.g * 0.95, c.b * 0.95, 0.9))
    ps.addColorGradient(0.5, new BABYLON.Color4(c.r, c.g, c.b, 0.65))
    ps.addColorGradient(1.0, new BABYLON.Color4(c.r * 0.5, c.g * 0.5, c.b * 0.5, 0.0))
    // 尺寸随寿命：基部小 → 中段鼓起 → 尖端收（火舌形）
    ps.addSizeGradient(0.0, 0.10)
    ps.addSizeGradient(0.55, 0.34)
    ps.addSizeGradient(1.0, 0.04)
    ps.minLifeTime = 0.45; ps.maxLifeTime = 0.95   // 寿命更长 = 火舌更高
    ps.emitRate = 420                              // 更密
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD
    ps.gravity = new BABYLON.Vector3(0, 3.4, 0)    // 持续上窜
    ps.minEmitPower = 2.2; ps.maxEmitPower = 4.4
    ps.updateSpeed = 0.02
    ps.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_STRETCHED  // 沿速度拉伸 = 火舌
    this.auraPs = ps
    } catch (e) { console.warn('[ironfist] aura build failed (non-fatal):', e) }
  }

  placeAt(pos, rotY) {
    this._down = false                      // 新对局(重新摆位)清除倒地态
    this.home = pos.clone()
    this.baseRotY = rotY
    this.root.position.copyFrom(pos)
    this.root.rotation.y = rotY
  }

  // ── 状态 ───────────────────────────────────────────────
  setCharged(on) {
    if (this._charged === on) return
    this._charged = on
    // 全身火焰气场
    if (on) this.auraPs?.start(); else this.auraPs?.stop()

    // 身上的光辉：蓄力时身体 emissive 一呼一吸地脉动（GlowLayer 让轮廓发光，像"充能"）
    if (this._glowObs) { this.scene.onBeforeRenderObservable.remove(this._glowObs); this._glowObs = null }
    if (!this._flashMats?.length) return
    const c = this.pal.aura
    if (on) {
      this._restEmis = this._flashMats.map(() => new BABYLON.Color3(c.r * 0.8, c.g * 0.8, c.b * 0.8))
      const t0 = performance.now()
      this._glowObs = this.scene.onBeforeRenderObservable.add(() => {
        if (this._hitFlashing) return  // 受击闪白时让出，不被脉动覆盖
        const p = 0.55 + 0.45 * Math.sin((performance.now() - t0) * 0.006)  // 0.1‥1
        const k = 0.45 + 0.55 * p
        this._flashMats.forEach((m) => { m.emissiveColor = new BABYLON.Color3(c.r * 0.85 * k, c.g * 0.85 * k, c.b * 0.85 * k) })
      })
    } else {
      this._restEmis = this._flashMats.map((_m, i) => this._flashBase[i])
      this._flashMats.forEach((m, i) => { m.emissiveColor = this._flashBase[i].clone() })
    }
  }

  resetToIdle() {
    if (this._down) return                  // 已倒地，保持不起身
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
    if (this._down) return                  // 已倒地，不再出招
    if (this.hasModel) {
      const clip = CLIP[name] || 'idle'
      this._playClip(clip, false, () => { if (!this._down) this._playClip('idle', true) }, CLIP_SPEED[clip] || 1)
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

  // 前冲（仅模型路径）：攻击方冲到 targetX，接触前到位，随后退回 home。占位斗士保留内置小位移。
  lunge(targetX) {
    if (!this.hasModel || !this.root) return
    const x0 = this.home.x
    tween(this.scene, this.root, 'position.x', [
      { frame: 0, value: x0 },
      { frame: 56, value: targetX },  // ≈0.93s 冲到位，略早于接触(≈1.1s)，拳到人到
      { frame: 82, value: targetX },  // 接触瞬间稳住
      { frame: 116, value: x0 },      // 退回（≈1.93s，回合窗口内）
    ])
  }

  reactHit() {
    if (this._down) return                  // 已倒地，不再播受击
    if (this.hasModel) {
      this._playClip('hit', false, () => { if (!this._down) this._playClip('idle', true) }, CLIP_SPEED.hit)
    } else {
      const h = this.home, f = this.faceSign
      tween(this.scene, this.root, 'position.x', [{ frame: 0, value: h.x }, { frame: 4, value: h.x - f * 0.32 }, { frame: 14, value: h.x }])
    }
    this._flash()
  }

  knockout() {
    this._down = true                       // 已倒地：此后一切"回到 idle"都让路，保持倒地
    this.scene.stopAnimation(this.root)     // 取消前冲/退回补间，原地倒下不滑步
    if (this.hasModel) {
      // 清掉上一动作组的结束回调，避免它触发循环 idle 把人"拉起来"
      if (this._current) { this._current.onAnimationGroupEndObservable.clear(); this._current.stop() }
      this._current = null
      this._playClip('ko', false)           // 播一次，停在倒地末帧
      return
    }
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

  // 子弹时间：把当前动画降速播放一段（暴击专属慢镜，比 hitStop 全冻更有"重拳"延展感）
  slowMo(ratio = 0.2, ms = 380) {
    if (!this.hasModel || !this._current) return
    const g = this._current
    const prev = g.speedRatio || 1
    g.speedRatio = ratio
    setTimeout(() => { if (this._current === g) g.speedRatio = prev }, ms)
  }

  _flash() {
    if (!this._flashMats?.length) return
    this._hitFlashing = true   // 暂停蓄力脉动，让受击红闪显示出来
    this._flashMats.forEach((m) => { m.emissiveColor = new BABYLON.Color3(1, 0.55, 0.5) })
    setTimeout(() => {
      this._hitFlashing = false
      this._flashMats.forEach((m, i) => { m.emissiveColor = ((this._restEmis && this._restEmis[i]) || this._flashBase[i]).clone() })
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
  aura: new BABYLON.Color3(1.0, 0.34, 0.30),
}
