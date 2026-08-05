import test from 'node:test'
import assert from 'node:assert/strict'
import BoardView, { calculateBoardLayout, adjacentPositionFromSwipe, remapSurvivorDisplays } from '../ui/BoardView.js'
import { calculateHudLayout } from '../ui/HudView.js'
import { canSelectLevel } from '../scenes/MapScene.js'
import LevelScene, { isPlayableSwap } from '../scenes/LevelScene.js'
import { createBoard, findLegalMoves } from './board.js'

function deferred() {
  let resolve
  const promise = new Promise((complete) => { resolve = complete })
  return { promise, resolve }
}

test('mobile layout keeps the complete board between the HUD and booster row', () => {
  const layout = calculateBoardLayout(390, 844)

  assert.ok(layout.x >= 12)
  assert.ok(layout.x + layout.size <= 378)
  assert.ok(layout.y >= 112)
  assert.ok(layout.y + layout.size <= 690)
  assert.equal(layout.cellSize * 8, layout.size)
})

test('desktop layout centers a bounded square board', () => {
  const layout = calculateBoardLayout(1600, 900)

  assert.equal(layout.x + layout.size / 2, 800)
  assert.ok(layout.size <= 680)
  assert.ok(layout.y + layout.size <= 780)
})

test('HUD layout keeps targets, moves, and all three boosters in view on mobile', () => {
  const layout = calculateHudLayout(390, 844)

  assert.ok(layout.targets.y >= 16)
  assert.ok(layout.moves.x < 390)
  assert.equal(layout.boosters.length, 3)
  assert.ok(layout.boosters.every(({ x, y }) => x >= 36 && x <= 354 && y <= 816))
})

test('swipe selects one orthogonally adjacent cell and rejects short drags', () => {
  const from = { row: 3, col: 3 }

  assert.deepEqual(adjacentPositionFromSwipe(from, 42, 8, 20), { row: 3, col: 4 })
  assert.deepEqual(adjacentPositionFromSwipe(from, -4, -35, 20), { row: 2, col: 3 })
  assert.equal(adjacentPositionFromSwipe(from, 8, 5, 20), null)
  assert.equal(adjacentPositionFromSwipe({ row: 0, col: 0 }, -30, 0, 20), null)
})

test('pointer-up dispatches short gestures as clicks and long gestures as swaps', () => {
  const dispatched = []
  const view = {
    enabled: true,
    gesture: { from: { row: 3, col: 3 }, x: 100, y: 100, pointerId: 7 },
    onSelect: (position) => dispatched.push({ kind: 'select', position }),
    onSwap: (from, to) => dispatched.push({ kind: 'swap', from, to }),
  }

  BoardView.prototype.handlePointerUp.call(view, { id: 7, x: 106, y: 104 })
  view.gesture = { from: { row: 3, col: 3 }, x: 100, y: 100, pointerId: 7 }
  BoardView.prototype.handlePointerUp.call(view, { id: 7, x: 132, y: 102 })

  assert.deepEqual(dispatched, [
    { kind: 'select', position: { row: 3, col: 3 } },
    { kind: 'swap', from: { row: 3, col: 3 }, to: { row: 3, col: 4 } },
  ])
})

test('rejected swap tween rebounds without remapping either cell', async () => {
  const from = { row: 2, col: 2 }
  const to = { row: 2, col: 3 }
  const first = { x: 25, y: 25 }
  const second = { x: 35, y: 25 }
  let tween
  const view = {
    cells: new Map([['2,2', first], ['2,3', second]]),
    layout: { x: 0, y: 0, cellSize: 10 },
    cellCenter: BoardView.prototype.cellCenter,
    scene: { tweens: { add: (config) => { tween = config; config.onComplete() } } },
  }

  await BoardView.prototype.animateRejectedSwap.call(view, from, to)

  assert.equal(tween.yoyo, true)
  assert.equal(tween.x(first), 35)
  assert.equal(tween.x(second), 25)
  assert.equal(view.cells.get('2,2'), first)
  assert.equal(view.cells.get('2,3'), second)
})

test('survivor display mapping follows gravity destinations between waves', () => {
  const falling = { name: 'falling' }
  const stationary = { name: 'stationary' }
  const cells = new Map([['0,1', falling], ['7,7', stationary]])

  const remapped = remapSurvivorDisplays(cells, [
    { from: { row: 0, col: 1 }, to: { row: 1, col: 1 } },
    { from: { row: 7, col: 7 }, to: { row: 7, col: 7 } },
  ])

  assert.equal(remapped.has('0,1'), false)
  assert.equal(remapped.get('1,1'), falling)
  assert.equal(remapped.get('7,7'), stationary)
})

test('wave animation preserves survivor displays and creates only actual refills', async () => {
  const makeDisplay = (signature) => ({
    cellSignature: signature,
    boardPosition: null,
    setPosition(x, y) { this.x = x; this.y = y; return this },
    setAlpha(alpha) { this.alpha = alpha; return this },
    disableInteractive() {},
  })
  const survivor = makeDisplay('berry:null:false:0')
  const created = []
  const board = Array.from({ length: 8 }, () => Array(8).fill(null))
  board[1][1] = { id: 'berry', special: null, jelly: false, frosting: 0 }
  board[0][1] = { id: 'mint', special: null, jelly: false, frosting: 0 }
  const view = {
    cells: new Map([['0,1', survivor]]),
    enabled: false,
    board: null,
    layout: { x: 0, y: 0, cellSize: 10 },
    layer: { add() {} },
    scene: { tweens: { add: ({ onComplete }) => onComplete() } },
    cellCenter: BoardView.prototype.cellCenter,
    createCell: (cell, position) => {
      const display = makeDisplay(`${cell.id}:${cell.special}:${cell.jelly}:${cell.frosting}`)
      display.boardPosition = { ...position }
      created.push(display)
      return display
    },
    replaceDisplay() { throw new Error('unchanged survivor must not be recreated') },
  }

  await BoardView.prototype.animateWaveMovement.call(view, {
    board,
    movements: [{ from: { row: 0, col: 1 }, to: { row: 1, col: 1 } }],
    refills: [{ from: { row: -1, col: 1 }, to: { row: 0, col: 1 } }],
  })

  assert.equal(view.cells.get('1,1'), survivor)
  assert.equal(view.cells.get('0,1'), created[0])
  assert.equal(created.length, 1)
  assert.deepEqual(survivor.boardPosition, { row: 1, col: 1 })
})

test('multi-wave resolution remaps survivors before the next clear without a full redraw', async () => {
  const destroyed = []
  const created = []
  let fullRedraws = 0
  const signature = (cell) => `${cell.id}:${cell.special}:${cell.jelly}:${cell.frosting}`
  const cell = (id) => ({ id, special: null, jelly: false, frosting: 0 })
  const makeDisplay = (name, value, position) => ({
    name,
    cellSignature: signature(value),
    boardPosition: { ...position },
    positions: [],
    setPosition(x, y) { this.x = x; this.y = y; this.positions.push({ x, y }); return this },
    setAlpha(alpha) { this.alpha = alpha; return this },
    disableInteractive() {},
    destroy() { destroyed.push({ name: this.name, at: { ...this.boardPosition } }) },
  })
  const initialValues = Array.from({ length: 8 }, (_, row) => cell(`c${row}`))
  initialValues[0] = cell('berry')
  initialValues[1] = cell('doomed')
  const initialDisplays = initialValues.map((value, row) => makeDisplay(
    row === 0 ? 'survivor' : `initial-${row}`,
    value,
    { row, col: 0 },
  ))
  const waveOneBoard = Array.from({ length: 8 }, () => Array(8).fill(null))
  waveOneBoard[0][0] = cell('mint')
  waveOneBoard[1][0] = initialValues[0]
  for (let row = 2; row < 8; row += 1) waveOneBoard[row][0] = initialValues[row]
  const waveTwoBoard = structuredClone(waveOneBoard)
  waveTwoBoard[0][0] = cell('orange')
  waveTwoBoard[1][0] = cell('lemon')
  const waveOne = {
    removed: [{ row: 1, col: 0 }],
    board: waveOneBoard,
    movements: [
      ...Array.from({ length: 6 }, (_, index) => {
        const row = 7 - index
        return { from: { row, col: 0 }, to: { row, col: 0 } }
      }),
      { from: { row: 0, col: 0 }, to: { row: 1, col: 0 } },
    ],
    refills: [{ from: { row: -1, col: 0 }, to: { row: 0, col: 0 } }],
  }
  const waveTwo = {
    removed: [{ row: 1, col: 0 }, { row: 0, col: 0 }],
    board: waveTwoBoard,
    movements: Array.from({ length: 6 }, (_, index) => {
      const row = 7 - index
      return { from: { row, col: 0 }, to: { row, col: 0 } }
    }),
    refills: [
      { from: { row: -1, col: 0 }, to: { row: 1, col: 0 } },
      { from: { row: -2, col: 0 }, to: { row: 0, col: 0 } },
    ],
  }
  const view = {
    cells: new Map(initialDisplays.map((display, row) => [`${row},0`, display])),
    enabled: false,
    board: null,
    layout: { x: 0, y: 0, cellSize: 10 },
    layer: { add() {} },
    scene: { tweens: { add: ({ onComplete }) => onComplete() } },
    cellCenter: BoardView.prototype.cellCenter,
    animateWaveMovement: BoardView.prototype.animateWaveMovement,
    reconcileBoard: BoardView.prototype.reconcileBoard,
    createCell: (value, position) => {
      const display = makeDisplay(`refill-${created.length + 1}`, value, position)
      created.push({ display, destination: { ...position } })
      return display
    },
    replaceDisplay() { throw new Error('settled board must not replace unchanged displays') },
    render() { fullRedraws += 1 },
  }

  await BoardView.prototype.animateResolution.call(view, [waveOne, waveTwo], waveTwoBoard)

  assert.deepEqual(destroyed.filter(({ name }) => name === 'survivor'), [
    { name: 'survivor', at: { row: 1, col: 0 } },
  ])
  assert.deepEqual(destroyed.filter(({ name }) => name === 'refill-1'), [
    { name: 'refill-1', at: { row: 0, col: 0 } },
  ])
  assert.deepEqual(created.map(({ destination }) => destination), [
    { row: 0, col: 0 },
    { row: 1, col: 0 },
    { row: 0, col: 0 },
  ])
  assert.ok(created.every(({ display }) => display.positions[0].y < 0))
  for (let row = 2; row < 8; row += 1) assert.equal(view.cells.get(`${row},0`), initialDisplays[row])
  assert.equal(fullRedraws, 0)
})

test('accepted turn keeps input locked through swap and resolution promises', async () => {
  const board = createBoard({ seed: 7 })
  const move = findLegalMoves(board)[0]
  const swapGate = deferred()
  const resolutionGate = deferred()
  const enabled = []
  let resolutionStarted = false
  const scene = {
    resolving: false,
    selected: null,
    pendingResize: null,
    state: { board, movesLeft: 20, target: { candies: { berry: 99 } }, score: 0, status: 'playing' },
    rng: (() => { let value = 0; return () => (value = (value + 0.173) % 1) })(),
    boardView: {
      setSelected() {},
      setInputEnabled: (value) => enabled.push(value),
      animateSwap: () => swapGate.promise,
      animateResolution: () => { resolutionStarted = true; return resolutionGate.promise },
    },
    updateHud() {},
    layoutViews() {},
  }

  const pending = LevelScene.prototype.attemptSwap.call(scene, move.from, move.to)
  assert.equal(scene.resolving, true)
  assert.deepEqual(enabled, [false])

  swapGate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(resolutionStarted, true)
  assert.deepEqual(enabled, [false])

  resolutionGate.resolve()
  await pending
  assert.equal(scene.resolving, false)
  assert.deepEqual(enabled, [false, true])
})

test('rejected turn keeps input locked until rebound completes', async () => {
  const board = createBoard({ seed: 7 })
  let rejectedMove
  for (let row = 0; row < 8 && !rejectedMove; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const from = { row, col }
      const to = { row, col: col + 1 }
      if (!isPlayableSwap(board, from, to)) { rejectedMove = { from, to }; break }
    }
  }
  const reboundGate = deferred()
  const enabled = []
  const scene = {
    resolving: false,
    selected: null,
    pendingResize: null,
    state: { board, movesLeft: 20, target: { candies: { berry: 99 } }, score: 0, status: 'playing' },
    boardView: {
      setSelected() {},
      setInputEnabled: (value) => enabled.push(value),
      animateRejectedSwap: () => reboundGate.promise,
    },
    layoutViews() {},
  }

  const pending = LevelScene.prototype.attemptSwap.call(scene, rejectedMove.from, rejectedMove.to)
  assert.equal(scene.resolving, true)
  assert.deepEqual(enabled, [false])
  reboundGate.resolve()
  await pending
  assert.equal(scene.resolving, false)
  assert.deepEqual(enabled, [false, true])
})

test('map selection permits unlocked levels and rejects locked levels', () => {
  const save = { unlockedLevel: 3 }

  assert.equal(canSelectLevel(3, save), true)
  assert.equal(canSelectLevel(4, save), false)
  assert.equal(canSelectLevel(0, save), false)
})

test('playable swap mirrors the engine color-bomb rule', () => {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null))
  board[2][2] = { id: 'berry', special: 'color-bomb', jelly: false, frosting: 0 }
  board[2][3] = { id: 'lemon', special: null, jelly: false, frosting: 0 }

  assert.equal(isPlayableSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 }), true)
  board[2][3].special = 'striped-h'
  assert.equal(isPlayableSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 }), true)
  board[2][3].special = 'color-bomb'
  assert.equal(isPlayableSwap(board, { row: 2, col: 2 }, { row: 2, col: 3 }), false)
})
