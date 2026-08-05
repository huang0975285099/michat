# Sugar Pop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fully Phaser-rendered, local-only Sugar Pop match-3 game with ten playable levels to the game center.

**Architecture:** `SugarPopPage.vue` mounts one Phaser game but renders no game UI. Phaser scenes own the boot, map, playable level, overlay and transition states. A pure JavaScript engine owns all board rules and persistence interfaces; scenes render its state with original SVG textures and convert input to engine actions.

**Tech Stack:** Vue 3, Quasar, Phaser 3, Node built-in test runner, browser `localStorage`.

## Global Constraints

- Game route: `/games/sugar-pop`; game-center card is added to `frontend/src/pages/GamesPage.vue`.
- All in-game UI, dialogs, animation and map rendering must be Phaser-rendered; Vue only mounts/destroys Phaser.
- Use original SVG/CSS-generated textures only; no external image or audio assets and Phaser must use `audio: { noAudio: true }`.
- 8×8, turn-limited, target-based levels; 10 local, data-driven configurations.
- Special candies: striped (four), wrapped (T/L), color bomb (five); no special-to-special combinations.
- Obstacles: jelly and layered frosting; boosters: hammer, shuffle, extra five moves; unlimited retries, each extra-moves booster only once per run.
- `localStorage` stores stars, high scores, unlocks and booster counts; corrupted data falls back to defaults.
- Initial and settled boards must have no automatic matches and at least one legal move; dead boards reshuffle.
- Mobile portrait first, desktop usable, pointer/touch input supported, and input locked during resolution.
- Do not add audio, payments, network requests, ads, lives, keyboard controls, color-blind mode or reduced-motion mode.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `frontend/src/games/sugar-pop/SugarPopPage.vue` | Vue lifecycle-only Phaser mounting surface. |
| `frontend/src/games/sugar-pop/game/createSugarPopGame.js` | Phaser configuration, scene registration, game factory. |
| `frontend/src/games/sugar-pop/game/constants.js` | Board dimensions, candy and booster identifiers, scoring constants. |
| `frontend/src/games/sugar-pop/game/board.js` | Pure board generation, matching, swaps, gravity, refill and reshuffle. |
| `frontend/src/games/sugar-pop/game/resolve.js` | Pure turn resolution, specials, obstacle damage, score and win/loss state. |
| `frontend/src/games/sugar-pop/game/levels.js` | Ten level configurations and validation. |
| `frontend/src/games/sugar-pop/game/save.js` | Versioned local storage load/save/default migration. |
| `frontend/src/games/sugar-pop/game/*.test.mjs` | Node tests for pure modules. |
| `frontend/src/games/sugar-pop/scenes/*.js` | Boot, map, level, overlay and transition Phaser scenes. |
| `frontend/src/games/sugar-pop/ui/*.js` | Phaser-only HUD, board-view and overlay component helpers. |
| `frontend/src/games/sugar-pop/assets/candies.js` | Original SVG texture definitions. |
| `frontend/src/router/index.js` | Lazy Sugar Pop route. |
| `frontend/src/pages/GamesPage.vue` | Sugar Pop game-center card. |
| `frontend/package.json` | `test:sugar-pop` script. |

### Task 1: Create the pure board module and its deterministic tests

**Files:**
- Create: `frontend/src/games/sugar-pop/game/constants.js`
- Create: `frontend/src/games/sugar-pop/game/board.js`
- Create: `frontend/src/games/sugar-pop/game/board.test.mjs`
- Modify: `frontend/package.json`

**Interfaces:**
- Produces `createBoard({ seed, blocked = [] })`, `findMatches(board)`, `isAdjacent(a, b)`, `trySwap(board, a, b)`, `findLegalMoves(board)`, `applyGravity(board, rng)`, and `reshuffle(board, rng)`.
- A board is an 8×8 array whose cells are `null` or `{ id: string, special: null|'striped-h'|'striped-v'|'wrapped'|'color-bomb', jelly: boolean, frosting: 0|1|2 }`.

- [ ] **Step 1: Write failing board tests**

```js
test('new board has no matches and has a legal move', () => {
  const board = createBoard({ seed: 7 })
  assert.deepEqual(findMatches(board), [])
  assert.ok(findLegalMoves(board).length > 0)
})

test('swap only succeeds when it makes a match', () => {
  const board = boardFromIds([
    'ABCDEFAB', 'BCDEFABC', 'CDEFABCD', 'DEFABCDE',
    'EFABCDEF', 'FABCDEF A'.replace(' ', ''), 'ABCDEFAB', 'BCDEFABC',
  ])
  assert.equal(trySwap(board, { row: 0, col: 0 }, { row: 0, col: 1 }).accepted, false)
})
```

- [ ] **Step 2: Run the new test and verify failure**

Run: `npm run test:sugar-pop -- --test-name-pattern="new board|swap only"`

Expected: failure because the script and modules do not exist.

- [ ] **Step 3: Implement deterministic board helpers**

```js
export const BOARD_SIZE = 8
export const CANDY_IDS = ['berry', 'lemon', 'mint', 'grape', 'orange', 'swirl']

export function findMatches(board) {
  // Return disjoint match groups as arrays of { row, col } after horizontal
  // and vertical scans; groups that intersect are merged before returning.
}

export function trySwap(board, a, b) {
  if (!isAdjacent(a, b)) return { accepted: false, board }
  const swapped = cloneAndSwap(board, a, b)
  return findMatches(swapped).length ? { accepted: true, board: swapped } : { accepted: false, board }
}
```

Implement a seeded Mulberry32 RNG in this module, generate cells one-by-one while rejecting immediate horizontal/vertical triples, then retry with a bounded loop until `findLegalMoves` is non-empty. `reshuffle` must preserve non-null cell IDs/specials/obstacles, retry bounded random permutations, and throw `Error('Unable to reshuffle board with a legal move')` after its retry limit.

- [ ] **Step 4: Run board tests and lint**

Run: `npm run test:sugar-pop; npm run lint`

Expected: all board tests pass; lint has no new errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/src/games/sugar-pop/game
git commit -m "feat: add Sugar Pop board engine"
```

### Task 2: Implement turn resolution, specials, obstacles and scoring

**Files:**
- Create: `frontend/src/games/sugar-pop/game/resolve.js`
- Create: `frontend/src/games/sugar-pop/game/resolve.test.mjs`
- Modify: `frontend/src/games/sugar-pop/game/board.js`

**Interfaces:**
- Consumes board helpers from Task 1.
- Produces `resolveTurn({ board, swap, movesLeft, target, score, rng })` returning `{ board, waves, score, movesLeft, target, status, createdSpecials }`.
- `status` is `'playing'`, `'won'`, or `'lost'`; every entry in `waves` contains `{ removed, activatedSpecials, scoreDelta }`.

- [ ] **Step 1: Write failing resolution tests**

```js
test('a four-match creates a striped candy at the swap destination', () => {
  const result = resolveTurn(fourMatchFixture())
  assert.equal(result.createdSpecials[0].special, 'striped-h')
})

test('a wrapped blast damages adjacent frosting and clears jelly', () => {
  const result = resolveTurn(wrappedFixture())
  assert.equal(result.board[3][3].frosting, 0)
  assert.equal(result.board[2][2].jelly, false)
})

test('a turn with no remaining moves loses unless its target is complete', () => {
  assert.equal(resolveTurn(lastMoveMissFixture()).status, 'lost')
  assert.equal(resolveTurn(lastMoveWinFixture()).status, 'won')
})
```

- [ ] **Step 2: Run resolution tests and verify failure**

Run: `npm run test:sugar-pop -- --test-name-pattern="striped|wrapped|remaining moves"`

Expected: failure because `resolveTurn` does not exist.

- [ ] **Step 3: Implement resolution in explicit phases**

```js
export function resolveTurn(input) {
  const swapped = trySwap(input.board, input.swap.from, input.swap.to)
  if (!swapped.accepted) return { ...input, status: 'playing', waves: [], createdSpecials: [] }
  // decrement moves once, then repeat: find groups → create specials → expand
  // special effects → damage obstacles/targets → remove → gravity/refill.
}
```

Give four-line runs striped orientation from swap direction; T/L components wrapped; five-or-more color bomb. Treat special activation as a queue so each location activates once per wave. Apply obstacle damage after the affected cells are identified; remove jelly at the cleared coordinate and decrement frosting for adjacent cleared coordinates. Score base removals, special activations and each later cascade with increasing multiplier. Invoke `reshuffle` after the final stable wave if legal moves are empty.

- [ ] **Step 4: Run the complete pure-engine suite**

Run: `npm run test:sugar-pop`

Expected: board and resolution tests pass, including cascades and dead-board reshuffle fixtures.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/sugar-pop/game
git commit -m "feat: resolve Sugar Pop turns and obstacles"
```

### Task 3: Add levels and versioned local persistence

**Files:**
- Create: `frontend/src/games/sugar-pop/game/levels.js`
- Create: `frontend/src/games/sugar-pop/game/save.js`
- Create: `frontend/src/games/sugar-pop/game/levels.test.mjs`
- Create: `frontend/src/games/sugar-pop/game/save.test.mjs`

**Interfaces:**
- Produces `LEVELS`, `getLevel(id)`, `validateLevels(levels)` and `createDefaultSave()`, `loadSave(storage)`, `saveProgress(storage, save)`.
- Each level has `{ id, seed, moves, targets, boardShape, obstacles, starScores }`.
- Save shape is `{ version: 1, unlockedLevel: number, results: Record<number, { stars: number, highScore: number }>, boosters: { hammer: number, shuffle: number, extraMoves: number } }`.

- [ ] **Step 1: Write failing level/save tests**

```js
test('level catalog has ten sequential valid levels', () => {
  assert.equal(LEVELS.length, 10)
  assert.deepEqual(LEVELS.map(({ id }) => id), [1,2,3,4,5,6,7,8,9,10])
  assert.deepEqual(validateLevels(LEVELS), [])
})

test('invalid persisted JSON returns the default save', () => {
  const storage = { getItem: () => '{bad json' }
  assert.deepEqual(loadSave(storage), createDefaultSave())
})
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run test:sugar-pop -- --test-name-pattern="level catalog|invalid persisted"`

Expected: failure because level and save modules do not exist.

- [ ] **Step 3: Implement data configuration and persistence**

```js
export const SAVE_KEY = 'sugar-pop:save'
export function loadSave(storage = window.localStorage) {
  try { return migrate(JSON.parse(storage.getItem(SAVE_KEY))) } catch { return createDefaultSave() }
}
```

Define all ten levels with the approved difficulty cadence. `validateLevels` must return readable errors for bad IDs, nonpositive moves, invalid targets, invalid obstacle coordinates and non-increasing star thresholds. Clamp deserialized stars, scores, unlocked level and booster amounts to safe integer ranges. Award boosters only when a level's recorded stars increase.

- [ ] **Step 4: Run persistence and engine suite**

Run: `npm run test:sugar-pop`

Expected: all tests pass, including corrupt-save fallback and progress upgrade behavior.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/sugar-pop/game
git commit -m "feat: add Sugar Pop levels and save data"
```

### Task 4: Build Phaser assets, game factory and route mounting surface

**Files:**
- Create: `frontend/src/games/sugar-pop/assets/candies.js`
- Create: `frontend/src/games/sugar-pop/game/createSugarPopGame.js`
- Create: `frontend/src/games/sugar-pop/SugarPopPage.vue`
- Create: `frontend/src/games/sugar-pop/scenes/BootScene.js`
- Modify: `frontend/src/router/index.js`

**Interfaces:**
- `createSugarPopGame(container, { onReady })` returns a `Phaser.Game` configured with all scene classes.
- `BootScene` registers texture keys `candy-berry`, `candy-lemon`, `candy-mint`, `candy-grape`, `candy-orange`, `candy-swirl`, plus special overlays and obstacle textures.

- [ ] **Step 1: Write the failing factory smoke test**

```js
test('game config disables audio and registers all five scenes', () => {
  const config = createSugarPopConfig({})
  assert.deepEqual(config.audio, { noAudio: true })
  assert.equal(config.scene.length, 5)
})
```

Use a separate `createSugarPopConfig(parent)` export so the test does not instantiate WebGL.

- [ ] **Step 2: Run smoke test and verify failure**

Run: `npm run test:sugar-pop -- --test-name-pattern="disables audio"`

Expected: failure because the factory does not exist.

- [ ] **Step 3: Implement original SVG texture registration and mount lifecycle**

```js
export function createSugarPopConfig(parent) {
  return { type: Phaser.AUTO, parent, audio: { noAudio: true }, scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: [BootScene, MapScene, LevelScene, OverlayScene, TransitionScene] }
}
```

Use SVG data URIs created from local string templates; each candy must differ in silhouette and an internal pattern as well as color. `SugarPopPage.vue` owns only `ref`, `onMounted`, `onUnmounted`, and `game.destroy(true)`, with a viewport-filling container. Add the lazy `/games/sugar-pop` router record under the existing main-layout children.

- [ ] **Step 4: Run unit test, lint and production build**

Run: `npm run test:sugar-pop; npm run lint; npm run build`

Expected: all pass and the lazy route compiles.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/sugar-pop frontend/src/router/index.js
git commit -m "feat: add Sugar Pop Phaser shell"
```

### Task 5: Implement map, board rendering and player interaction

**Files:**
- Create: `frontend/src/games/sugar-pop/scenes/MapScene.js`
- Create: `frontend/src/games/sugar-pop/scenes/LevelScene.js`
- Create: `frontend/src/games/sugar-pop/ui/BoardView.js`
- Create: `frontend/src/games/sugar-pop/ui/HudView.js`
- Modify: `frontend/src/games/sugar-pop/scenes/BootScene.js`

**Interfaces:**
- `BoardView.render(board)`, `BoardView.animateSwap(from, to)`, `BoardView.animateResolution(waves)`, and `BoardView.setInputEnabled(enabled)`.
- `LevelScene.startLevel(levelId)` loads `getLevel(levelId)` and owns one `resolveTurn` game state.
- `MapScene` only permits selecting `level.id <= save.unlockedLevel`.

- [ ] **Step 1: Add a manual browser QA checklist to the task notes**

```text
Desktop 1600×900: map opens, locked levels cannot start, level 1 starts.
Mobile 390×844: board, target, moves and three boosters fit above the fold.
Input: click adjacent cells and touch-swipe adjacent cells; invalid swaps rebound.
Resolution: input is disabled until all swap, clear, fall and refill tweens complete.
```

- [ ] **Step 2: Implement `MapScene` and a static `LevelScene` from level 1**

```js
this.input.on('gameobjectup', (_pointer, node) => {
  if (node.levelId <= this.save.unlockedLevel) this.scene.start('LevelScene', { levelId: node.levelId })
})
```

Render the approved winding Candy Town map with ten nodes and visible star progress. Use Phaser layout calculations based on `this.scale.gameSize`; do not use HTML/DOM overlays. Render the 8×8 board and original texture keys at a size derived from the smaller viewport axis.

- [ ] **Step 3: Wire pointer input to the pure engine**

```js
async attemptSwap(from, to) {
  if (this.resolving) return
  const preview = trySwap(this.state.board, from, to)
  if (!preview.accepted) return this.boardView.animateRejectedSwap(from, to)
  this.resolving = true
  await this.boardView.animateSwap(from, to)
  this.state = resolveTurn({ ...this.state, swap: { from, to }, rng: this.rng })
  await this.boardView.animateResolution(this.state.waves)
  this.resolving = false
}
```

Support first-cell/second-cell clicks and pointer down/up swipes. Resize must reflow map nodes, HUD and board without losing game state.

- [ ] **Step 4: Run tests, lint, build and perform manual responsive QA**

Run: `npm run test:sugar-pop; npm run lint; npm run build`

Then run `npm run dev`, inspect `/games/sugar-pop` at 1600×900 and 390×844, and complete the checklist from Step 1. Record any visual defects before proceeding.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/sugar-pop
git commit -m "feat: add Sugar Pop map and board play"
```

### Task 6: Add Phaser HUD, boosters, results and persistence integration

**Files:**
- Create: `frontend/src/games/sugar-pop/scenes/OverlayScene.js`
- Create: `frontend/src/games/sugar-pop/scenes/TransitionScene.js`
- Create: `frontend/src/games/sugar-pop/ui/OverlayView.js`
- Modify: `frontend/src/games/sugar-pop/scenes/LevelScene.js`
- Modify: `frontend/src/games/sugar-pop/ui/HudView.js`
- Modify: `frontend/src/games/sugar-pop/game/save.js`

**Interfaces:**
- `OverlayScene.open({ kind, payload, onAction })` supports `pause`, `win`, `lose`, and `recover-save`.
- `LevelScene.useBooster('hammer'|'shuffle'|'extraMoves', cell?)` decrements saved inventory only on successful use.
- `recordLevelResult(save, { levelId, score, stars })` returns updated progress and any newly earned booster rewards.

- [ ] **Step 1: Write failing persistence/booster tests**

```js
test('hammer is consumed only when it clears a valid occupied cell', () => {
  assert.equal(useBooster(boosterFixture(), 'hammer', { row: 0, col: 0 }).boosters.hammer, 1)
  assert.equal(useBooster(emptyCellFixture(), 'hammer', { row: 0, col: 0 }).boosters.hammer, 2)
})

test('a higher star result unlocks the next level once and awards its reward', () => {
  const next = recordLevelResult(createDefaultSave(), { levelId: 1, score: 1500, stars: 3 })
  assert.equal(next.unlockedLevel, 2)
  assert.equal(next.boosters.hammer, 1)
})
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run test:sugar-pop -- --test-name-pattern="hammer is consumed|higher star"`

Expected: failure because the booster/result interfaces do not exist.

- [ ] **Step 3: Implement HUD and Phaser overlays**

```js
this.scene.launch('OverlayScene')
this.events.on('level-finished', (result) => this.scene.get('OverlayScene').open({ kind: result.status, payload: result, onAction: this.handleOverlayAction.bind(this) }))
```

Use visible labeled Phaser buttons for hammer, shuffle and extra moves. Hammer enters one-cell selection mode; shuffle calls pure `reshuffle`; extra moves only succeeds once per run and adds five moves. Add pause/retry/map/next-level actions. On win, calculate stars, persist via `recordLevelResult` + `saveProgress`, animate bonus moves, then show reward state. On failure, show retry/map and extra-five-moves only when inventory and per-run limit allow it.

- [ ] **Step 4: Run complete checks and manual interaction QA**

Run: `npm run test:sugar-pop; npm run lint; npm run build`

Manually verify a win, a loss/retry, each booster path, map return, page refresh persistence and corrupt-save recovery. Confirm all overlays are Phaser canvas elements, not Quasar dialogs.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/sugar-pop
git commit -m "feat: add Sugar Pop overlays and boosters"
```

### Task 7: Expose the game center card and finish acceptance QA

**Files:**
- Modify: `frontend/src/pages/GamesPage.vue`
- Modify: `frontend/package.json`
- Modify: `docs/superpowers/specs/2026-08-04-sugar-pop-design.md` only if implementation reveals a confirmed design correction.

**Interfaces:**
- The Sugar Pop card calls `router.push('/games/sugar-pop')`.
- `test:sugar-pop` runs `node --test src/games/sugar-pop/game/*.test.mjs`.

- [ ] **Step 1: Add the game-center card**

```vue
<q-card class="game-card cursor-pointer" @click="router.push('/games/sugar-pop')">
  <q-card-section class="text-center q-pa-lg">
    <div style="font-size: 52px">🍬</div>
    <div class="text-subtitle1 text-bold q-mt-sm">Sugar Pop</div>
    <div class="text-caption text-grey-6">Sweet match-3 adventure</div>
  </q-card-section>
</q-card>
```

Replace the existing placeholder card rather than changing Iron Fist. Include chips labeled `Match-3` and `Offline`.

- [ ] **Step 2: Run automated verification**

Run: `npm run test:sugar-pop; npm run lint; npm run build`

Expected: all commands exit 0.

- [ ] **Step 3: Perform final visual and exploratory QA**

At 390×844 and 1600×900, verify: Game Center card opens Sugar Pop; map shows correct lock states; level 1 can complete; each obstacle appears by levels 4–7; levels 8–10 combine mechanics; no audio plays; no essential game element is clipped; no HTML/Quasar overlay appears over the canvas. Play two unscripted turns after normal flows, including an invalid swap and a forced shuffle. Refresh after a win and verify saved stars/high score/boosters persist.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/GamesPage.vue frontend/package.json docs/superpowers/specs/2026-08-04-sugar-pop-design.md
git commit -m "feat: add Sugar Pop to game center"
```

## Plan Self-Review

- Spec coverage: Tasks 1–2 implement matching, specials, obstacles, scoring and valid boards; Task 3 implements ten data-driven levels and persistence; Task 4 provides the pure Phaser shell and original assets; Tasks 5–6 implement every approved Phaser scene, responsive inputs, map, HUD, dialogs and boosters; Task 7 covers routing and end-to-end acceptance.
- No unsupported systems are introduced: no network, audio, payments, DOM game UI, accessibility modes or special-combination logic.
- Interface consistency: `resolveTurn` is the only turn entrypoint; `LEVELS/getLevel`, `loadSave/saveProgress`, and the BoardView/OverlayScene contracts are defined before their consuming tasks.
