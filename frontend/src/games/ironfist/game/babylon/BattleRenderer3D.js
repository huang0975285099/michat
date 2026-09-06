// Tekken - Phase 3 3D combat renderer (Babylon.js, Option B)
// The factory returns the controller: { setCharge, playRound, reset, resize, dispose, ready }.
// The rendering-independent engine (IronFistGame) and HUD remain unchanged; this controller only consumes the settlement result + charging state of each round.
// See docs/ironfist.md Section 13/22.

import * as BABYLON from '@babylonjs/core'
import '@babylonjs/loaders/glTF'  //Register glTF/glb loader (side-effect import)
import { Fighter3D, PAL_ME_3D, PAL_OPP_3D } from './Fighter3D.js'

// glb is placed under public/. Splice with BASE_URL to be compatible with both deployments:
// Web BASE_URL='/' → '/games/ironfist/'; Electron BASE_URL='./' → './games/ironfist/'
// (Electron is loaded using file://, the absolute path '/games' will point to the root of the disk and the loading will fail)
const GLB_ROOT = import.meta.env.BASE_URL + 'games/ironfist/'
const GLB_FILE = 'fighter.glb'       //Our model (Vanguard)
const GLB_FILE_OPP = 'fighter.glb'  //Opponent model (Mutant); default falls back to fighter.glb

const CRIT_THRESHOLD = 18

export function createBattleRenderer3D(canvas, { playerCharged = false, opponentCharged = false, onReady, onImpact } = {}) {
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true })
  const scene = new BABYLON.Scene(engine)
  scene.clearColor = new BABYLON.Color4(0.05, 0.04, 0.10, 1)

  // Camera position: Slightly tilted from the front, supports drag rotation/wheel zoom (with limiter to avoid turning to the bottom of the stage or pulling too far)
  const cam = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, 1.15, 7.8, new BABYLON.Vector3(0, 1.15, 0), scene)
  cam.fov = 0.8
  cam.minZ = 0.1
  cam.attachControl(canvas, true)
  cam.lowerBetaLimit = 0.6        //The highest angle of depression (do not fly directly above to see the bald head)
  cam.upperBetaLimit = 1.46       //Lowest viewing angle (without getting under the table)
  cam.lowerRadiusLimit = 5.5      //Recently (without entering the character)
  cam.upperRadiusLimit = 10       //farthest
  cam.wheelDeltaPercentage = 0.01 //Scroll wheel zoom feel
  cam.panningSensibility = 0      //Disable panning: only turn but not move, the camera is always facing the center of the ring
  cam.angularSensibilityX = 1400
  cam.angularSensibilityY = 1400

  // Ambient lighting (IBL/studio.hdr) is deactivated on demand - only illuminated by the light below.

  // Lighting: hemispheric fill light + upper main light + front neutral fill light + blue/red edge light (echoing the blue on the left and red on the right in the reference picture)
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene)
  hemi.intensity = 2  //No IBL, overall fill light is restored (the character is the protagonist, brightened)
  hemi.groundColor = new BABYLON.Color3(0.14, 0.14, 0.24)
  const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-0.2, -0.95, 0.35), scene)
  dir.intensity = 2
  // Frontal fill light: A neutral light on the side of the camera (−z), focusing on the side of the character facing the camera to solve the problem of "too dark to see clearly"
  const fill = new BABYLON.PointLight('pFill', new BABYLON.Vector3(0, 2.6, -4.8), scene)
  fill.diffuse = new BABYLON.Color3(1.0, 0.97, 0.92); fill.intensity = 24; fill.range = 20
  // fill.diffuse = new BABYLON.Color3(1.0, 0.97, 0.92); fill.intensity = 36; fill.range = 20
  const blue = new BABYLON.PointLight('pBlue', new BABYLON.Vector3(-3.4, 2.2, -2.2), scene)
  blue.diffuse = new BABYLON.Color3(0.35, 0.55, 1.0); blue.intensity = 13
  const red = new BABYLON.PointLight('pRed', new BABYLON.Vector3(3.4, 2.2, -2.2), scene)
  red.diffuse = new BABYLON.Color3(1.0, 0.35, 0.32); red.intensity = 13

  // ──Later period────────────────────────────────────────────
  // GlowLayer: Make emissive objects (charged halo, hit spark, ring ring, hit highlight) truly "glow" overflow
  const glow = new BABYLON.GlowLayer('glow', scene, { blurKernelSize: 32 })
  glow.intensity = 0.55
  // Rendering pipeline: Bloom overall glow + FXAA anti-aliasing + ACES tone mapping + vignetting, atmosphere/texture is in place at once
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

  // Arena: dark side walls (cylinder) + golden technology top (programmed map, self-illuminating without whitening) + golden neon edge ring
  const plat = BABYLON.MeshBuilder.CreateCylinder('plat', { diameter: 5.4, height: 0.3, tessellation: 56 }, scene)
  const pm = new BABYLON.StandardMaterial('pm', scene)
  pm.diffuseColor = new BABYLON.Color3(0.10, 0.07, 0.035)
  pm.emissiveColor = new BABYLON.Color3(0.04, 0.028, 0.012)
  pm.specularColor = new BABYLON.Color3(0.05, 0.04, 0.02)  //Suppress the white highlights to avoid being blown away by strong lights
  plat.material = pm; plat.position.y = -0.15

  // Golden Championship top surface (procedurally generated: concentric golden rings + radiating technology lines + central five-pointed star emblem)
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
    for (let i = 0; i < 5; i++) {            //Concentric golden rings
      c.strokeStyle = 'rgba(255,194,77,' + (0.45 + i * 0.1) + ')'
      c.lineWidth = i === 4 ? 11 : 4
      c.beginPath(); c.arc(0, 0, R * (0.22 + i * 0.16), 0, 7); c.stroke()
    }
    c.strokeStyle = 'rgba(255,138,61,0.38)'; c.lineWidth = 3   //Radiation Technology Line
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2
      c.beginPath(); c.moveTo(Math.cos(a) * R * 0.40, Math.sin(a) * R * 0.40); c.lineTo(Math.cos(a) * R * 0.84, Math.sin(a) * R * 0.84); c.stroke()
    }
    // Central emblem: dark round base + gold ring + golden five-pointed star
    c.fillStyle = 'rgba(18,12,6,0.96)'; c.beginPath(); c.arc(0, 0, R * 0.18, 0, 7); c.fill()
    c.strokeStyle = 'rgba(255,194,77,0.9)'; c.lineWidth = 5; c.beginPath(); c.arc(0, 0, R * 0.18, 0, 7); c.stroke()
    c.fillStyle = 'rgba(255,212,125,1)'; _star(c, 0, 0, R * 0.12, R * 0.05, 5)
    // Overall darkening: the golden stage is the background, don’t steal the role (overlay a layer of translucent black)
    // c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(-R, -R, s, s)
    t.update()
    return t
  }
  const platTop = BABYLON.MeshBuilder.CreateDisc('platTop', { radius: 2.68, tessellation: 64 }, scene)
  platTop.rotation.x = -Math.PI / 2          //facade → upward
  platTop.position.y = 0.012                  //Close to the top of the column and pressed under the edge ring to prevent z-fighting
  const ptm = new BABYLON.StandardMaterial('ptm', scene)
  ptm.emissiveTexture = _platTopTex(); ptm.disableLighting = true
  ptm.specularColor = new BABYLON.Color3(0, 0, 0); ptm.backFaceCulling = false
  platTop.material = ptm; platTop.isPickable = false

  // gold neon edge ring
  const ring = BABYLON.MeshBuilder.CreateTorus('ring', { diameter: 5.2, thickness: 0.08, tessellation: 56 }, scene)
  const rm = new BABYLON.StandardMaterial('rm', scene)
  rm.emissiveColor = new BABYLON.Color3(1.0, 0.62, 0.18); rm.disableLighting = true
  ring.material = rm; ring.position.y = 0.02

  // ──Environmental layer: starry sky dome/reflective ground/energy grid/floating dust/light beam (all procedurally generated, no additional texture files)──
  // Soft particle map: radial gradient with solid center and transparent edges, for dust and (if necessary) sparks
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

  // 1) Gradient starry sky dome: the top is dark → the horizon is purple, and star points are scattered; infiniteDistance follows the camera and is used as a sky box
  function _skyTex() {
    const s = 512
    const t = new BABYLON.DynamicTexture('sky', { width: s, height: s }, scene, true)
    const c = t.getContext()
    const g = c.createLinearGradient(0, 0, 0, s)
    g.addColorStop(0, '#05030d'); g.addColorStop(0.55, '#0a0820'); g.addColorStop(1, '#160b2c')
    c.fillStyle = g; c.fillRect(0, 0, s, s)
    // Nebula cluster: several soft light color spots, adding distant layers to the pure gradient sky
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
  skyM.fogEnabled = false  //The sky does not eat fog (otherwise the starry sky will be washed white by fog)
  glow.addExcludedMesh(sky)  //Prevent the entire dome from entering the glow (just want the star points to be slightly bright, not the entire screen to be gray)

  // Depth fog: The ground/grid in the distance melts into darkness, and the picture has an "infinitely extending" depth; the density is so low that the central character is barely touched
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2
  scene.fogColor = new BABYLON.Color3(0.03, 0.025, 0.06)
  scene.fogDensity = 0.024

  // 2) Reflective metal floor: Dark gloss PBR catches the blue/red dot light, allowing the ring to fall in space instead of floating on the black bottom
  const floor = BABYLON.MeshBuilder.CreateGround('floor', { width: 40, height: 40 }, scene)
  floor.position.y = -0.32
  const fm = new BABYLON.PBRMaterial('fm', scene)
  fm.albedoColor = new BABYLON.Color3(0.02, 0.02, 0.05)
  fm.metallic = 0.85; fm.roughness = 0.38; fm.environmentIntensity = 0.55
  floor.material = fm; floor.isPickable = false

  // 3) Ground energy grid: concentric rings + rays radiating outward from the arena, radially fading out at the edges, with breathing pulses
  function _gridTex() {
    const s = 1024
    const t = new BABYLON.DynamicTexture('grid', { width: s, height: s }, scene, true)
    const c = t.getContext()
    c.clearRect(0, 0, s, s); c.translate(s / 2, s / 2)
    c.strokeStyle = 'rgba(120,150,240,0.8)'; c.lineWidth = 2
    for (let r = 70; r < s / 2; r += 72) { c.beginPath(); c.arc(0, 0, r, 0, 7); c.stroke() }
    for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * s / 2, Math.sin(a) * s / 2); c.stroke() }
    // Radial mask: solid center, transparent edges, made into a round soft fade (avoid square hard edges)
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

  // 5) Airborne dust: slowly rising luminous particles give the space a sense of volume and vitality
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

  // 6) Ground mist: The colored mist at the bottom of the arena is large, soft and flowing slowly.
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

  // 7) Surrounding energy sparks: Several luminous particles revolve around the ring + float up and down to increase dynamics
  const sparkM = new BABYLON.StandardMaterial('sparkM', scene)
  sparkM.emissiveColor = new BABYLON.Color3(0.6, 0.85, 1.0); sparkM.disableLighting = true; sparkM.fogEnabled = false
  const sparks = []
  for (let i = 0; i < 6; i++) {
    const s = BABYLON.MeshBuilder.CreateSphere('spark' + i, { diameter: 0.06, segments: 6 }, scene)
    s.material = sparkM; s.isPickable = false
    sparks.push({ mesh: s, a: (i / 6) * Math.PI * 2, r: 2.9 + (i % 2) * 0.35, h: 0.9 + (i % 3) * 0.45, sp: 0.00045 + i * 0.00004 })
  }

  // Grid + Neon Ring Breathing Pulse + Spark Revolution (merged into one observer)
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

  // 8) Grandstand building: lathe spiral staircase section → bowl-shaped grandstand of the stadium surrounding the ring (dark color + cold color step edge, not eye-catching with the golden stage)
  // {
  //   const prof = [new BABYLON.Vector3(6.8, -0.35, 0)]
  //   for (let i = 0; i < 6; i++) {
  //     const r0 = 7.0 + i * 1.45, y0 = -0.1 + i * 0.6
  // prof.push(new BABYLON.Vector3(r0, y0, 0)) // Inner edge of step tread
  // prof.push(new BABYLON.Vector3(r0 + 1.25, y0, 0)) // outer edge of tread
  // prof.push(new BABYLON.Vector3(r0 + 1.25, y0 + 0.6, 0)) // Erected riser
  //   }
  // prof.push(new BABYLON.Vector3(16.6, 3.7, 0)) // Top ring closing
  //   const stands = BABYLON.MeshBuilder.CreateLathe('stands', { shape: prof, tessellation: 72, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene)
  //   const sm = new BABYLON.StandardMaterial('standsMat', scene)
  //   sm.diffuseColor = new BABYLON.Color3(0.05, 0.055, 0.085)
  //   sm.specularColor = new BABYLON.Color3(0.02, 0.02, 0.03)
  //   sm.emissiveColor = new BABYLON.Color3(0.015, 0.018, 0.03)
  //   stands.material = sm; stands.isPickable = false
  // //Cold neon edge lines at the front of each floor: define the level of the stands (dark to avoid competing with the golden platform)
  //   const edgeMat = new BABYLON.StandardMaterial('standEdge', scene)
  //   edgeMat.emissiveColor = new BABYLON.Color3(0.16, 0.30, 0.6); edgeMat.disableLighting = true
  //   for (let i = 0; i < 6; i++) {
  //     const r = 7.0 + i * 1.45 + 1.25
  //     const e = BABYLON.MeshBuilder.CreateTorus('standEdge' + i, { diameter: r * 2, thickness: 0.05, tessellation: 64 }, scene)
  //     e.position.y = -0.1 + i * 0.6 + 0.02; e.material = edgeMat; e.isPickable = false
  //     glow.addExcludedMesh(e)
  //   }
  // }

  // 9) Auditorium: Crowd light spots that surround the ring and rise layer by layer (thin instances → thousands of points, only 1 draw call)
  // Warm white/blue/red mixed color + random brightness, the distance is eaten away by deep fog and blends into the dark field, like a sea of lights from the audience in a stadium.
  const crowd = BABYLON.MeshBuilder.CreateBox('crowd', { size: 0.12 }, scene)
  const crowdMat = new BABYLON.StandardMaterial('crowdMat', scene)
  crowdMat.emissiveColor = new BABYLON.Color3(1, 1, 1); crowdMat.disableLighting = true
  crowd.material = crowdMat; crowd.isPickable = false
  crowd.alwaysSelectAsActiveMesh = true   //Prevent thin instances from being culled by the entire frustum
  glow.addExcludedMesh(crowd)             //Not entering GlowLayer (still eating pipeline Bloom, enough to flicker)
  {
    const mats = [], cols = [], tmp = BABYLON.Matrix.Identity()
    const palette = [[1.0, 0.86, 0.6], [0.4, 0.62, 1.0], [1.0, 0.45, 0.4], [0.82, 0.82, 0.95]]
    for (let tier = 0; tier < 6; tier++) {
      const radius = 8.0 + tier * 1.45      //Expansion layer by layer
      const y = 0.15 + tier * 0.6           //Increasing level by level (grandstand slope)
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
  // The overall light and dark breathing of the audience's sea of lights (single value, minimal overhead)
  const _crowdT0 = performance.now()
  scene.onBeforeRenderObservable.add(() => {
    const k = 0.9 + 0.1 * Math.sin((performance.now() - _crowdT0) * 0.0016)
    crowdMat.emissiveColor.set(k, k, k)
  })

  const me = new Fighter3D(scene, 'me', PAL_ME_3D, +1)
  const opp = new Fighter3D(scene, 'opp', PAL_OPP_3D, -1)

  // Camp aperture under your feet: Follow your respective fighters, breathe slightly, and strengthen your position (blue = our side / red = opponent)
  function _footRingTex() {
    const s = 256, R = s / 2
    const t = new BABYLON.DynamicTexture('footRing', s, scene, false)
    const c = t.getContext(); c.translate(R, R)
    const g = c.createRadialGradient(0, 0, 0, 0, 0, R)
    g.addColorStop(0, 'rgba(255,255,255,0.16)')   //center light fill
    g.addColorStop(0.74, 'rgba(255,255,255,0.04)')
    g.addColorStop(0.84, 'rgba(255,255,255,0.95)') //bright ring
    g.addColorStop(0.93, 'rgba(255,255,255,0.85)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, R, 0, 7); c.fill()
    c.strokeStyle = 'rgba(255,255,255,1)'; c.lineWidth = s * 0.05   //Real stroke, clear definition
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
  // The camp color main channel mentioned >1: stacked on a bright gold table can still suppress the gold and trigger bloom (it will not be washed into gray)
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
    reset() { me.resetForBattle(); opp.resetForBattle() },
    resize() { engine.resize() },
    dispose() {
      try { engine.stopRenderLoop() } catch { /* noop */ }
      scene.dispose(); engine.dispose()
    },
  }

  // Beat (round window ≈ 2200ms)
  const HITSTOP_MS = 95    //Frame duration
  const RESET_MS = 2000    //Return to idle (in the window, avoid blocking and interrupting moves)
  const DRAW_CUE_MS = 1100 //Determining a draw: the starting moment of the confrontation performance (≈after the last round of punching)
  const REACH = 0.95       //Unilateral attack: rush so close to the opponent
  const CENTER_GAP = 0.6   //Both sides attack: each is so far away from the center of the field (to prevent mold penetration)

  // The attacker rushes forward to the opponent and punches (only the model path takes effect in Fighter3D.lunge)
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

    // Check the blood volume when you fall to the ground, not just the result string: when the game ends, if HP ≤ 0, you will fall down (including "both are empty of blood, but the result is a draw")
    const ended = !!r.gameResult
    const meKO = ended && (r.gameResult === 'lose' || r.gameResult === 'doubleLose' || r.playerHP <= 0)
    const oppKO = ended && (r.gameResult === 'win' || r.gameResult === 'doubleLose' || r.opponentHP <= 0)

    // It is appropriate to move the hits/finals to the moment when the fist "hits the ground" and trigger them uniformly (calculated dynamically based on the animation duration)
    if (r.playerDmg > 0 || r.opponentDmg > 0 || meKO || oppKO) {
      setTimeout(() => _impact(r, meKO, oppKO), me.attackContactMs())
    }

    if (!r.gameResult) {
      setTimeout(() => { me.resetToIdle(); opp.resetToIdle() }, RESET_MS)
    } else if (!meKO && !oppKO) {
      // Determine a draw (timeout/round limit, both sides still have blood): No one is down, withdraw your moves and perform a "confrontation and draw" performance
      setTimeout(_drawStandoff, DRAW_CUE_MS)
    }
  }

  // Moment of hit: After a fatal blow, you will fall to the ground directly (not interrupted by the hit animation), otherwise you will be hit normally; superimposed frame/shock/scroller/sparks/floating characters
  function _impact(r, meKO, oppKO) {
    onImpact?.(r)  //Notify the outer HUD: The fist is hitting hard at this moment, and the blood deduction/avatar shake and hit special effects are presented in the same frame
    if (meKO) me.knockout()
    else if (r.playerDmg > 0) me.reactHit()
    if (oppKO) opp.knockout()
    else if (r.opponentDmg > 0) opp.reactHit()

    const big = Math.max(r.playerDmg, r.opponentDmg) >= CRIT_THRESHOLD
    if (r.playerDmg > 0) _impactFx(me, opp, r.playerDmg)
    if (r.opponentDmg > 0) _impactFx(opp, me, r.opponentDmg)
    _dmgText(r)

    // Ending: K.O. (single kill, push closer and fall to the ground) / DOUBLE K.O. (die together, pull away the cold scene) banner + exclusive lens,
    // Priority is given to ordinary hit/crit performance (the final blow will no longer shake the screen/push camera, and will be handed over to the final shot for unified ending).
    if (meKO || oppKO) { _finale(meKO, oppKO); return }

    if (big) {
      // Exclusive performance for critical strikes: bullet time + full screen highlight + close-up of the victim
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

  // Critical hit close-up: quickly push the victim closer (reduce radius + target and move to him), freeze briefly and then rebound;
  // It comes with slight jitter, which replaces the screen shake/push lens of ordinary hits. Temporarily relax lowerRadiusLimit to make it closer.
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
      const j = (t > inMs && t < inMs + hold) ? 0.05 : 0  //Slight jitter during freezing period
      cam.radius = baseR + (zoomR - baseR) * e
      cam.target.x = baseTarget.x + (focus.x - baseTarget.x) * e + (Math.random() - 0.5) * j
      cam.target.y = baseTarget.y + (focus.y - baseTarget.y) * e + (Math.random() - 0.5) * j
    })
  }

  // ──Final performance──────────────────────────────────────
  // Single kill: K.O. banner + push closer and fall to the ground; double kill: DOUBLE K.O. banner + zoom out panorama + draw color to silence.
  function _finale(meKO, oppKO) {
    const draw = meKO && oppKO
    _critFlash()                                    //Receive a white flash first, then support the finishing blow
    me.slowMo(0.16, draw ? 1100 : 900)              //Extended bullet time ending
    opp.slowMo(0.16, draw ? 1100 : 900)
    if (draw) {
      _banner('DOUBLE K.O.', 'double')
      _koZoomOut()                                  //Slowly zoom out and tell them both to fall to the ground
      setTimeout(_drainColor, 220)                  //After the white flash is over, there will be a color draw - there is no winner
    } else {
      _banner('K.O.', 'single')
      _koCinematic(meKO ? me : opp)                 //Push the downed party closer
    }
  }

  // Ending banner: large characters in the center, bounce into overshoot → short pause → fade out; billboard always faces the camera.
  function _banner(text, kind = 'single') {
    const W = 1024, H = 340
    const dt = new BABYLON.DynamicTexture('koBanner', { width: W, height: H }, scene, false)
    dt.hasAlpha = true
    const ctx = dt.getContext()
    ctx.clearRect(0, 0, W, H)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'
    const cx = W / 2, cy = H / 2 + 6
    const size = kind === 'double' ? 150 : kind === 'time' ? 132 : 232
    ctx.font = `900 italic ${size}px "Arial Black", Arial, sans-serif`
    ctx.lineWidth = 24; ctx.strokeStyle = '#000'; ctx.strokeText(text, cx, cy)
    if (kind === 'double') {
      // Left blue → right red: echoes the colors of the camps on both sides of the arena, pointing out "die together"
      const g = ctx.createLinearGradient(cx - 420, 0, cx + 420, 0)
      g.addColorStop(0, '#5cb3ff'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(1, '#ff5a52')
      ctx.fillStyle = g
    } else if (kind === 'time') {
      // Cold Steel Silver: A neutral color used to determine a tie, different from the fiery K.O./DOUBLE K.O.
      const g = ctx.createLinearGradient(0, cy - 110, 0, cy + 110)
      g.addColorStop(0, '#f2f6ff'); g.addColorStop(1, '#9fb2c8')
      ctx.fillStyle = g
    } else {
      const g = ctx.createLinearGradient(0, cy - 120, 0, cy + 120)   //golden gradient
      g.addColorStop(0, '#fff4c2'); g.addColorStop(1, '#ffb020')
      ctx.fillStyle = g
    }
    ctx.fillText(text, cx, cy)
    dt.update()

    const mat = new BABYLON.StandardMaterial('koBannerM', scene)
    mat.diffuseTexture = dt; mat.opacityTexture = dt
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1)
    mat.disableLighting = true; mat.backFaceCulling = false; mat.fogEnabled = false
    const w = kind === 'double' ? 6.6 : kind === 'time' ? 6.0 : 4.4, h = w * H / W
    const plane = BABYLON.MeshBuilder.CreatePlane('koBannerP', { width: w, height: h }, scene)
    plane.material = mat; plane.position.set(0, 2.35, 0)
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL; plane.isPickable = false
    glow.addExcludedMesh(plane)   //Bloom is bright enough through the pipeline to prevent GlowLayer from blurring the words.
    const start = performance.now(), dur = kind === 'time' ? 1900 : 2600
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) { plane.dispose(); mat.dispose(); dt.dispose(); scene.onBeforeRenderObservable.remove(obs); return }
      const k = t / dur
      const s = k < 0.10 ? (k / 0.10) * 1.22                    //Bounce overshoot 0→1.22→1
        : k < 0.20 ? 1.22 - 0.22 * ((k - 0.10) / 0.10)
          : 1
      plane.scaling.set(s, s, s)
      mat.alpha = k > 0.82 ? (1 - (k - 0.82) / 0.18) : 1        //end fade out
    })
  }

  // Close-up of a single kill: quickly push closer to the downed party, then slowly rebound after a long pause (temporarily relax the close range limit to get closer).
  function _koCinematic(victim) {
    const baseR = cam.radius, baseLower = cam.lowerRadiusLimit
    const baseTarget = cam.target.clone()
    cam.lowerRadiusLimit = 2.6
    const vx = victim.root ? victim.root.position.x : victim.home.x
    const focus = new BABYLON.Vector3(vx, 0.85, 0)
    const zoomR = Math.max(2.8, baseR * 0.52)
    const start = performance.now(), inMs = 240, hold = 1500, outMs = 900, dur = inMs + hold + outMs
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) {
        cam.radius = baseR; cam.target.copyFrom(baseTarget); cam.lowerRadiusLimit = baseLower
        scene.onBeforeRenderObservable.remove(obs); return
      }
      const k = t < inMs ? t / inMs : t < inMs + hold ? 1 : 1 - (t - inMs - hold) / outMs
      const e = k * k * (3 - 2 * k)
      cam.radius = baseR + (zoomR - baseR) * e
      cam.target.x = baseTarget.x + (focus.x - baseTarget.x) * e
      cam.target.y = baseTarget.y + (focus.y - baseTarget.y) * e
    })
  }

  // Double kill panorama: Slowly zoom out to see both players fall to the ground, then rebound after a short pause (temporarily relax the long-distance limit).
  function _koZoomOut() {
    const baseR = cam.radius, baseUpper = cam.upperRadiusLimit
    const baseTarget = cam.target.clone()
    cam.upperRadiusLimit = 14
    const focus = new BABYLON.Vector3(0, 0.8, 0)
    const zoomR = Math.min(13, baseR * 1.6)
    const start = performance.now(), inMs = 700, hold = 1100, outMs = 700, dur = inMs + hold + outMs
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) {
        cam.radius = baseR; cam.target.copyFrom(baseTarget); cam.upperRadiusLimit = baseUpper
        scene.onBeforeRenderObservable.remove(obs); return
      }
      const k = t < inMs ? t / inMs : t < inMs + hold ? 1 : 1 - (t - inMs - hold) / outMs
      const e = k * k * (3 - 2 * k)
      cam.radius = baseR + (zoomR - baseR) * e
      cam.target.x = baseTarget.x + (focus.x - baseTarget.x) * e
      cam.target.y = baseTarget.y + (focus.y - baseTarget.y) * e
    })
  }

  // Double kill cold scene: briefly remove the saturation of the picture + lower the exposure, and then pick up the heat at the end - the cold feeling of "no winner".
  function _drainColor() {
    const ip = pipe.imageProcessing
    const prevEnabled = ip.colorCurvesEnabled, prevCurves = ip.colorCurves
    const cc = new BABYLON.ColorCurves()
    ip.colorCurves = cc; ip.colorCurvesEnabled = true
    const baseExp = ip.exposure
    const start = performance.now(), dur = 2400
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) {
        ip.exposure = baseExp; ip.colorCurves = prevCurves; ip.colorCurvesEnabled = prevEnabled
        scene.onBeforeRenderObservable.remove(obs); return
      }
      const k = t / dur
      const drain = k < 0.12 ? k / 0.12 : k < 0.78 ? 1 : 1 - (k - 0.78) / 0.22
      cc.globalSaturation = -78 * drain   //0=Primary color → -78≈Significant desaturation
      ip.exposure = baseExp * (1 - 0.16 * drain)
    })
  }

  // Determined to be a draw (timeout/upper limit of round, both sides still have blood): No one is down - both sides retreat and defend themselves against each other,
  // TIME OVER silver banner, the camera returns to a symmetrical composition of two people (evenly matched, with a sense of closure judged by the sound of the bell).
  function _drawStandoff() {
    me.playAction('defend'); opp.playAction('defend')   //Take action and defend, then each of them will automatically return to idle.
    _banner('TIME OVER', 'time')
    _drawTwoShot()
  }

  // The shot that determines the tie: a balanced composition of two people returning to the center of symmetry, slightly zoomed out, and then rebounding after a short pause.
  function _drawTwoShot() {
    const baseR = cam.radius, baseUpper = cam.upperRadiusLimit
    const baseTarget = cam.target.clone(), baseBeta = cam.beta
    cam.upperRadiusLimit = 12
    const toR = Math.min(11, baseR * 1.18)
    const toTarget = new BABYLON.Vector3(0, 1.2, 0), toBeta = 1.2
    const start = performance.now(), inMs = 900, hold = 1200, outMs = 700, dur = inMs + hold + outMs
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) {
        cam.radius = baseR; cam.target.copyFrom(baseTarget); cam.beta = baseBeta; cam.upperRadiusLimit = baseUpper
        scene.onBeforeRenderObservable.remove(obs); return
      }
      const k = t < inMs ? t / inMs : t < inMs + hold ? 1 : 1 - (t - inMs - hold) / outMs
      const e = k * k * (3 - 2 * k)
      cam.radius = baseR + (toR - baseR) * e
      cam.beta = baseBeta + (toBeta - baseBeta) * e
      cam.target.x = baseTarget.x + (toTarget.x - baseTarget.x) * e
      cam.target.y = baseTarget.y + (toTarget.y - baseTarget.y) * e
    })
  }

  // Hit shot shakes screen
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

  // Hit and quickly push the mirror (fov presses down briefly and then rebounds, giving the punch a "closer" impact)
  function _zoomPunch(r) {
    const big = Math.max(r.playerDmg, r.opponentDmg) >= CRIT_THRESHOLD
    const dip = big ? 0.10 : 0.06
    const base = 0.8
    const start = performance.now(), dur = 200
    const obs = scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() - start
      if (t >= dur) { cam.fov = base; scene.onBeforeRenderObservable.remove(obs); return }
      const k = t / dur
      const e = k < 0.35 ? (k / 0.35) : (1 - (k - 0.35) / 0.65) //Press first and then bounce
      cam.fov = base - dip * e
    })
  }

  // Shared textures for hit effects: spark point (soft) + shock wave ring (create once and use repeatedly to avoid creating new textures for each punch)
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

  // Hit special effects: three layers of core heat flash + shock wave ring + spark burst; critical hits are bigger and more golden
  function _impactFx(victim, other, dmg = 0) {
    const crit = dmg >= CRIT_THRESHOLD
    // Use the real-time position of two people: fall on the side of the victim facing the opponent (other) - punching/attacking/counterattacking are all suitable.
    const vx = victim.root ? victim.root.position.x : victim.home.x
    const ox = other.root ? other.root.position.x : other.home.x
    const dir = Math.sign(ox - vx) || victim.faceSign
    const pos = new BABYLON.Vector3(vx + dir * 0.35, 1.15, 0.18)

    // ① Core heat flash: a ball of highlights at the contact point rapidly expands and fades out
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

  // ② Shock wave: Rapidly expands and fades out towards the camera's luminous ring (ease-out ending), with a greater critical hit
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

  // ③ Spark Burst: Launch a cluster of stretched particles at once, fan out towards the direction of being hit and then fall down due to gravity.
  function _sparkBurst(pos, crit, dirSign) {
    const ps = new BABYLON.ParticleSystem('spk', 48, scene)
    ps.particleTexture = _fxSpark
    ps.emitter = pos.clone()
    ps.minEmitBox = BABYLON.Vector3.Zero(); ps.maxEmitBox = BABYLON.Vector3.Zero()
    const col = crit ? new BABYLON.Color4(1, 0.86, 0.36, 1) : new BABYLON.Color4(1, 0.95, 0.72, 1)
    ps.color1 = col; ps.color2 = col; ps.colorDead = new BABYLON.Color4(1, 0.4, 0.12, 0)
    ps.minSize = 0.04; ps.maxSize = crit ? 0.16 : 0.11
    ps.minLifeTime = 0.12; ps.maxLifeTime = crit ? 0.42 : 0.30
    ps.emitRate = 0; ps.manualEmitCount = crit ? 32 : 18   //one-time outbreak
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

  // Critical hit full screen brighten: the exposure instantly brightens and then falls back, strengthening the "punch" flash
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

  // Damage floating word (pasted on the plane facing the camera using DynamicTexture)
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
      // CRITICAL! Banner
      ctx.font = 'bold italic 66px Arial'
      ctx.lineWidth = 10; ctx.strokeStyle = '#5a1500'; ctx.strokeText('CRITICAL!', W / 2, 60)
      ctx.fillStyle = '#ff7a1a'; ctx.fillText('CRITICAL!', W / 2, 60)
      // Damage number (big, gold)
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
      if (crit) {  //Bounce: 0→1.2 overshoot and then fall back to 1
        const s = k < 0.15 ? (k / 0.15) * 1.2 : k < 0.3 ? 1.2 - 0.2 * ((k - 0.15) / 0.15) : 1
        plane.scaling.setAll(s)
      }
    })
  }

  engine.runRenderLoop(() => scene.render())

  // me=fighter.glb(Vanguard), opp=fighter2.glb(Mutant), each has independent skeleton/animation;
  // The opponent model will fall back to fighter.glb by default; if there is not even the first one, both sides will use placeholder fighters.
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
