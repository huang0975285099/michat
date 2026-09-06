// Tekken - Phase 3 3D Fighter (Babylon.js, Option B)
// Two rendering paths, driven by the same set of methods:
// 1) glb in place: load the Mixamo character (Blender to glb) and play the skeletal animation according to the AnimationGroup name
// 2) glb default: use basic geometry to build a low-polygon mecha boxer as a placeholder, and rely on transform tweening for performance
// Self-contained: When changing to the official model, only change this file/throw it into glb, and BattleScene3D and the upper layer remain unchanged.
// For the glb contract, see docs/ironfist.md Section 22 + public/games/ironfist/README.

import * as BABYLON from '@babylonjs/core'

const FPS = 60
const FLOAT = BABYLON.Animation.ANIMATIONTYPE_FLOAT

// Keyframe tweening assistant (acts on subproperties of TransformNode)
function tween(scene, node, prop, keys, { loop = false, onEnd } = {}) {
  const mode = loop ? BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE : BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT
  const a = new BABYLON.Animation('t_' + prop, prop, FPS, FLOAT, mode)
  a.setKeys(keys)
  return scene.beginDirectAnimation(node, [a], keys[0].frame, keys[keys.length - 1].frame, loop, 1, onEnd)
}

// Action semantics → glb animation clip name (the user exports it under this name in Blender)
const CLIP = { attack: 'attack', defend: 'defend', charge: 'charge', counter: 'dodge' }
// Playback speed (1 = original animation speed). First set the speed at full speed, and then lift it individually according to the feel.
const CLIP_SPEED = { attack: 1.0, dodge: 1.0, defend: 1.0, charge: 1.0, hit: 1.0, ko: 1.0, idle: 1.0 }
// In the punching animation, the "fist hits hard" is approximately at this ratio of the entire segment (used to synchronize hit effects)
const ATTACK_CONTACT_FRACTION = 0.55

export class Fighter3D {
  /**
   * @param {BABYLON.Scene} scene
   * @param {string} side 'me' | 'opp'
   * @param {object} pal Color3 color matching
   * @param {number} faceSign towards the opponent's world X direction (me=+1 to the right, opp=-1 to the left)
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

  // ── Place-occupying low polygon mecha boxer ────────────────────────────────
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

  // ── glb model ──────────────────────────────────────────
  useModel(res) {
    const s = this.scene
    const root = new BABYLON.TransformNode('f3d_' + this.side, s)
    this.root = root
    res.meshes.forEach((m) => { if (!m.parent) m.parent = root })
    this.groups = {}
    res.animationGroups.forEach((g) => { g.stop(); this.groups[g.name.toLowerCase()] = g })
    this.hasModel = res.animationGroups.length > 0
    // Collect materials for hit highlighting (PBR: flash emissiveColor)
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

    // Soft light point map (programmed, no materials required)
    const tex = new BABYLON.DynamicTexture('auraTex_' + this.side, 64, s, false)
    const ctx = tex.getContext()
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,0.95)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64)
    tex.hasAlpha = true; tex.update()

    // Emission point: the middle part of the body (let the aura cover from the feet to the top of the head, not just at the feet)
    const emitNode = new BABYLON.TransformNode('auraEmit_' + this.side, s)
    emitNode.parent = this.root
    emitNode.position.y = 0.9

    // Flame aura (Super Saiyan style): cylindrical directional launch + stretch billboard → stretch along the speed into tongues of fire, covering the whole body
    const ps = new BABYLON.ParticleSystem('auraPs_' + this.side, 640, s)
    ps.particleTexture = tex
    ps.emitter = emitNode
    ps.createDirectedCylinderEmitter(0.42, 1.7, 0.5,
      new BABYLON.Vector3(-0.06, 1, -0.06),        //Direction: basically upward, with minimal spread
      new BABYLON.Vector3(0.06, 1, 0.06))
    // The color changes with life: the base is bright and the tip fades out (saturated camp color, dense stacking does not turn white)
    ps.addColorGradient(0.0, new BABYLON.Color4(c.r * 0.95, c.g * 0.95, c.b * 0.95, 0.9))
    ps.addColorGradient(0.5, new BABYLON.Color4(c.r, c.g, c.b, 0.65))
    ps.addColorGradient(1.0, new BABYLON.Color4(c.r * 0.5, c.g * 0.5, c.b * 0.5, 0.0))
    // Size changes with life: small base → bulging in the middle → narrowed tip (flame tongue shape)
    ps.addSizeGradient(0.0, 0.10)
    ps.addSizeGradient(0.55, 0.34)
    ps.addSizeGradient(1.0, 0.04)
    ps.minLifeTime = 0.45; ps.maxLifeTime = 0.95   //Longer life = higher flame
    ps.emitRate = 420                              //denser
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD
    ps.gravity = new BABYLON.Vector3(0, 3.4, 0)    //Continue to rise
    ps.minEmitPower = 2.2; ps.maxEmitPower = 4.4
    ps.updateSpeed = 0.02
    ps.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_STRETCHED  //Stretch along velocity = Tongue of Fire
    this.auraPs = ps
    } catch (e) { console.warn('[ironfist] aura build failed (non-fatal):', e) }
  }

  placeAt(pos, rotY) {
    this._down = false                      //New game (repositioning) to clear downed state
    this.home = pos.clone()
    this.baseRotY = rotY
    this.root.position.copyFrom(pos)
    this.root.rotation.set(0, rotY, 0)
    this.root.scaling.setAll(1)
  }

  // ── Status ────────────────────────────────────────────
  setCharged(on) {
    if (this._charged === on) return
    this._charged = on
    // Full body flame aura
    if (on) this.auraPs?.start(); else this.auraPs?.stop()

    // Glow on the body: When charging, the body pulsates emissively with each breath (GlowLayer makes the outline glow, like "charging")
    if (this._glowObs) { this.scene.onBeforeRenderObservable.remove(this._glowObs); this._glowObs = null }
    if (!this._flashMats?.length) return
    const c = this.pal.aura
    if (on) {
      this._restEmis = this._flashMats.map(() => new BABYLON.Color3(c.r * 0.8, c.g * 0.8, c.b * 0.8))
      const t0 = performance.now()
      this._glowObs = this.scene.onBeforeRenderObservable.add(() => {
        if (this._hitFlashing) return  //Give way when hit and flash white, not covered by pulse
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
    if (this._down) return                  //Has fallen to the ground and cannot get up
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

  // Start a new battle from a clean pose. Unlike resetToIdle(), this is allowed
  // to lift a fighter that was deliberately kept down after a K.O.
  resetForBattle() {
    if (!this.root) return
    this._down = false
    this.scene.stopAnimation(this.root)
    if (this._current) {
      this._current.onAnimationGroupEndObservable.clear()
      this._current.stop()
      this._current = null
    }
    this.root.position.copyFrom(this.home)
    this.root.rotation.set(0, this.baseRotY, 0)
    this.root.scaling.setAll(1)
    this.resetToIdle()
  }

  // ──Action ────────────────────────────────────────────
  playAction(name) {
    if (this._down) return                  //Has fallen to the ground, no more moves
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

  // Forward rush (model path only): The attacker rushes to targetX, reaches the target position before contact, and then returns home. Placeholder retains small built-in displacement.
  lunge(targetX) {
    if (!this.hasModel || !this.root) return
    const x0 = this.home.x
    tween(this.scene, this.root, 'position.x', [
      { frame: 0, value: x0 },
      { frame: 56, value: targetX },  //≈0.93s Rushing into position, slightly earlier than contact (≈1.1s), the punch reaches the person
      { frame: 82, value: targetX },  //Stable at the moment of contact
      { frame: 116, value: x0 },      //Return (≈1.93s, within round window)
    ])
  }

  reactHit() {
    if (this._down) return                  //Has fallen to the ground and will no longer be hit.
    if (this.hasModel) {
      this._playClip('hit', false, () => { if (!this._down) this._playClip('idle', true) }, CLIP_SPEED.hit)
    } else {
      const h = this.home, f = this.faceSign
      tween(this.scene, this.root, 'position.x', [{ frame: 0, value: h.x }, { frame: 4, value: h.x - f * 0.32 }, { frame: 14, value: h.x }])
    }
    this._flash()
  }

  knockout() {
    this._down = true                       //Downed: After that, everything "returns to idle" will give way and remain down.
    this.scene.stopAnimation(this.root)     //Cancel forward/return tweening, fall on the spot without sliding
    if (this.hasModel) {
      // Clear the end callback of the previous action group to prevent it from triggering the loop idle to "pull people up"
      if (this._current) { this._current.onAnimationGroupEndObservable.clear(); this._current.stop() }
      this._current = null
      this._playClip('ko', false)           //Play once and stop at the last frame of falling to the ground
      return
    }
    tween(this.scene, this.root, 'rotation.z', [{ frame: 0, value: 0 }, { frame: 22, value: this.faceSign * 1.45 }])
  }

  // The moment when the punch is "real" (ms): dynamically calculated based on the actual duration of the attack animation × contact ratio ÷ multiple speeds,
  // Avoid writing to death, causing the aperture/floating characters to arrive earlier than the fist. Give a minimum value when there is no model.
  attackContactMs() {
    const g = this.groups && this.groups.attack
    if (!g || !g.targetedAnimations?.length) return 360
    const fps = g.targetedAnimations[0].animation.framePerSecond || 60
    const durSec = Math.abs(g.to - g.from) / fps
    const speed = CLIP_SPEED.attack || 1
    return Math.round((durSec * ATTACK_CONTACT_FRACTION / speed) * 1000)
  }

  // Stutter frame: The moment of hit, the current animation will be frozen for a very short time, creating a "solid" lag feeling.
  hitStop(ms = 90) {
    if (!this.hasModel || !this._current) return
    const g = this._current
    const prev = g.speedRatio || 1
    g.speedRatio = 0
    setTimeout(() => { if (this._current === g) g.speedRatio = prev }, ms)
  }

  // Bullet time: Slow down the current animation for a period of time (exclusive slow motion for critical hits, more "punch" extension than hitStop full freeze)
  slowMo(ratio = 0.2, ms = 380) {
    if (!this.hasModel || !this._current) return
    const g = this._current
    const prev = g.speedRatio || 1
    g.speedRatio = ratio
    setTimeout(() => { if (this._current === g) g.speedRatio = prev }, ms)
  }

  _flash() {
    if (!this._flashMats?.length) return
    this._hitFlashing = true   //Pauses the charge pulse to show the red flash when hit.
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
