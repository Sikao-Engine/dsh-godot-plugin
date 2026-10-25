import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CSS_DIMENSION,
  MAX_VIEWPORT_DIMENSION,
  clampScale,
  computeResize,
  createResizeScheduler,
  engineMapFactors,
  engineRectToLayerCss,
  hasFeature,
  mapCssToPhysical,
  reduceWindowEvent,
  transientRemap,
} from '../src/interaction-map.mjs'

test('engineRectToLayerCss converts virtual-screen physical px to layer CSS px', () => {
  // Main window at origin, DPR-like factors 2: a popup at (400, 300) sized 320x240
  // physical lands at (200, 150) sized 160x120 CSS.
  const layer = engineRectToLayerCss({ x: 400, y: 300, width: 320, height: 240 }, { x: 0, y: 0 }, { mapScaleX: 2, mapScaleY: 2 })
  assert.deepEqual(layer, { x: 200, y: 150, width: 160, height: 120 })
  // Per-axis factors follow the main-window resize (interaction.map.v2).
  const aniso = engineRectToLayerCss({ x: 100, y: 100, width: 100, height: 100 }, { x: 0, y: 0 }, { mapScaleX: 2, mapScaleY: 4 })
  assert.deepEqual(aniso, { x: 50, y: 25, width: 50, height: 25 })
  // A non-origin main window shifts every layer (the wrap is relative to it).
  const shifted = engineRectToLayerCss({ x: 400, y: 300, width: 320, height: 240 }, { x: 200, y: 100 }, { mapScaleX: 2, mapScaleY: 2 })
  assert.deepEqual(shifted, { x: 100, y: 100, width: 160, height: 120 })
  // Degenerate factors never produce NaN geometry.
  const safe = engineRectToLayerCss({ x: 10, y: 10, width: 10, height: 10 }, null, null)
  assert.deepEqual(safe, { x: 10, y: 10, width: 10, height: 10 })
})

test('reduceWindowEvent tracks the layer lifecycle without mutating', () => {
  const rect = { x: 0, y: 0, width: 100, height: 80 }
  let layers = new Map()
  layers = reduceWindowEvent(layers, 'rect', { window: 3, rect }) // ignored: no created yet
  assert.equal(layers.size, 0)
  layers = reduceWindowEvent(layers, 'created', { window: 3, rect, z: 1 })
  assert.equal(layers.size, 1)
  assert.equal(layers.get(3).visible, false)
  assert.equal(layers.get(3).z, 1)
  const before = layers
  layers = reduceWindowEvent(layers, 'rect', { window: 3, rect: { x: 5, y: 6, width: 7, height: 8 } })
  assert.equal(before.get(3).rect.width, 100) // immutability
  assert.equal(layers.get(3).rect.width, 7)
  layers = reduceWindowEvent(layers, 'visibility', { window: 3, visible: true })
  assert.equal(layers.get(3).visible, true)
  layers = reduceWindowEvent(layers, 'focus', { window: 3, focused: true })
  assert.equal(layers.get(3).focused, true)
  layers = reduceWindowEvent(layers, 'raised', { window: 3, z: 9 })
  assert.equal(layers.get(3).z, 9)
  layers = reduceWindowEvent(layers, 'title', { window: 3, title: 'Advanced Import' })
  assert.equal(layers.get(3).title, 'Advanced Import')
  layers = reduceWindowEvent(layers, 'destroyed', { window: 3 })
  assert.equal(layers.size, 0)
  // Out-of-range ids never enter the map.
  layers = reduceWindowEvent(layers, 'created', { window: 16, rect })
  layers = reduceWindowEvent(layers, 'created', { window: -1, rect })
  assert.equal(layers.size, 0)
})

test('clampScale caps at the device DPR and the 2048 physical quota', () => {
  assert.equal(clampScale(800, 600, 2), 2)
  assert.equal(clampScale(800, 600, 1), 1)
  // 4096 css px on a DPR-1 display: the quota clamps below 1.
  assert.equal(clampScale(4096, 1024, 1), 2048 / 4096)
  // The largest axis decides, whatever the aspect ratio.
  assert.equal(clampScale(1024, 4096, 1), 2048 / 4096)
  // Degenerate rects keep the device DPR (physical stays 0 -> suspended).
  assert.equal(clampScale(0, 0, 2), 2)
  // Bogus DPRs fall back to 1.
  assert.equal(clampScale(800, 600, 0), 1)
  assert.equal(clampScale(800, 600, Number.NaN), 1)
})

test('computeResize reports physical pixels and the css geometry together', () => {
  assert.deepEqual(computeResize({ width: 800, height: 600 }, 1), { width: 800, height: 600, scale: 1, cssWidth: 800, cssHeight: 600 })
  assert.deepEqual(computeResize({ width: 800, height: 600 }, 2), { width: 1600, height: 1200, scale: 2, cssWidth: 800, cssHeight: 600 })
  // Beyond the quota: physical clamps to 2048 on the long axis, css rides along.
  const clamped = computeResize({ width: 4096, height: 1024 }, 2)
  assert.equal(clamped.width, 2048)
  assert.equal(clamped.height, 512)
  assert.equal(clamped.scale, 0.5)
  assert.equal(clamped.cssWidth, 4096)
  // A collapsed viewport suspends production (0 = pause) without bogus css.
  assert.deepEqual(computeResize({ width: 0, height: 0 }, 2), { width: 0, height: 0, scale: 1, cssWidth: 0, cssHeight: 0 })
  // Rounding stays inside the quota and mirrors the client's Math.round.
  const odd = computeResize({ width: 333.3, height: 222.2 }, 1.5)
  assert.equal(odd.width, Math.round(333.3 * odd.scale))
  assert.ok(odd.width <= MAX_VIEWPORT_DIMENSION && odd.height <= MAX_VIEWPORT_DIMENSION)
  assert.ok(odd.cssWidth <= MAX_CSS_DIMENSION)
})

test('engineMapFactors uses per-axis css geometry when present, legacy scale otherwise', () => {
  assert.deepEqual(engineMapFactors({ width: 320, height: 240, cssWidth: 640, cssHeight: 480, scale: 0.25 }), { mapScaleX: 0.5, mapScaleY: 0.5 })
  // Per-axis asymmetry: css 640x480 rendered into 320x120 (letterboxed axes).
  assert.deepEqual(engineMapFactors({ width: 320, height: 120, cssWidth: 640, cssHeight: 480, scale: 0.5 }), { mapScaleX: 0.5, mapScaleY: 0.25 })
  // Legacy fallback (graphics101): single scale for both axes.
  assert.deepEqual(engineMapFactors({ width: 200, height: 150, scale: 0.5 }), { mapScaleX: 0.5, mapScaleY: 0.5 })
  // Missing/zero css falls back too (e.g. suspended 0x0 resize).
  assert.deepEqual(engineMapFactors({ width: 0, height: 0, cssWidth: 0, cssHeight: 0, scale: 1 }), { mapScaleX: 1, mapScaleY: 1 })
  // Defensive: a non-finite scale must not poison the mapping.
  assert.deepEqual(engineMapFactors({ width: 100, height: 100, scale: Number.NaN }), { mapScaleX: 1, mapScaleY: 1 })
})

test('mapCssToPhysical composes with the locked factors', () => {
  const factors = { mapScaleX: 0.5, mapScaleY: 0.25 }
  const mapped = mapCssToPhysical(640, 480, factors)
  assert.equal(mapped.x, 320)
  assert.equal(mapped.y, 120)
})

test('transientRemap re-expresses points against the applied css geometry', () => {
  const applied = { width: 320, height: 240, cssWidth: 640, cssHeight: 480 }
  const currentRect = { width: 800, height: 600 }
  const remapped = transientRemap(100, 100, applied, currentRect)
  // 100 css px of an 800px-wide rect is 1/8 across; applied css is 640 wide.
  assert.equal(remapped.x, 80)
  assert.equal(remapped.y, 80)
  // Engine then multiplies by the stale factors: 80 * (320/640) = 40 physical.
  const factors = engineMapFactors(applied)
  const physical = mapCssToPhysical(remapped.x, remapped.y, factors)
  assert.equal(physical.x, 40)
  assert.equal(physical.y, 40)
  // Direct visual check: the point is 1/8 across the *stretched* 320px frame.
  assert.equal(physical.x, 320 / 8)
  // Identity when no surface is applied yet or the rect is degenerate.
  assert.deepEqual(transientRemap(1, 2, null, currentRect), { x: 1, y: 2 })
  assert.deepEqual(transientRemap(1, 2, applied, { width: 0, height: 0 }), { x: 1, y: 2 })
  // Identity once the stretch settled (rect back at the applied css size).
  assert.deepEqual(transientRemap(100, 100, applied, { width: 640, height: 480 }), { x: 100, y: 100 })
})

function makeTimers() {
  let now = 0
  const timers = new Map()
  let nextId = 1
  return {
    now: () => now,
    advance(ms) { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn() } },
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimer(id) { timers.delete(id) },
  }
}

test('resize scheduler sends the first geometry immediately, then coalesces trailing changes', () => {
  const timers = makeTimers()
  const sent = []
  const scheduler = createResizeScheduler({ send: geom => sent.push(geom), debounceMs: 120, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  const a = { width: 320, height: 240, scale: 1, cssWidth: 320, cssHeight: 240 }
  const b = { width: 400, height: 240, scale: 1, cssWidth: 400, cssHeight: 240 }
  const c = { width: 480, height: 240, scale: 1, cssWidth: 480, cssHeight: 240 }
  assert.equal(scheduler.schedule(a), true)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], a)
  // Storm: b then c within the debounce window -> only c goes out, after 120ms.
  assert.equal(scheduler.schedule(b), true)
  assert.equal(scheduler.schedule(c), true)
  assert.equal(sent.length, 1)
  timers.advance(119)
  assert.equal(sent.length, 1)
  timers.advance(1)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], c)
  assert.equal(scheduler.hasPending(), false)
})

test('resize scheduler ack drops a pending send the moment its surface lands', () => {
  const timers = makeTimers()
  const sent = []
  const scheduler = createResizeScheduler({ send: geom => sent.push(geom), debounceMs: 120, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  scheduler.schedule({ width: 320, height: 240, scale: 1, cssWidth: 320, cssHeight: 240 })
  const pending = { width: 400, height: 240, scale: 1, cssWidth: 400, cssHeight: 240 }
  scheduler.schedule(pending)
  assert.equal(scheduler.hasPending(), true)
  // The worker applied it already (fast lease release): the surface receipt
  // cancels the trailing send and the timer never fires.
  assert.equal(scheduler.acknowledge({ width: 400, height: 240, cssWidth: 400, cssHeight: 240 }), true)
  assert.equal(scheduler.hasPending(), false)
  timers.advance(500)
  assert.equal(sent.length, 1)
  // A mismatched surface (older epoch) must not clear the pending resize.
  scheduler.schedule({ width: 500, height: 240, scale: 1, cssWidth: 500, cssHeight: 240 })
  assert.equal(scheduler.acknowledge({ width: 320, height: 240, cssWidth: 320, cssHeight: 240 }), false)
  assert.equal(scheduler.hasPending(), true)
})

test('resize scheduler force bypasses the debounce and cancels on dispose', () => {
  const timers = makeTimers()
  const sent = []
  const scheduler = createResizeScheduler({ send: geom => sent.push(geom), debounceMs: 120, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  scheduler.schedule({ width: 320, height: 240, scale: 1, cssWidth: 320, cssHeight: 240 })
  scheduler.schedule({ width: 400, height: 240, scale: 1, cssWidth: 400, cssHeight: 240 })
  // DPR change: apply immediately instead of waiting out the window.
  scheduler.schedule({ width: 640, height: 480, scale: 2, cssWidth: 320, cssHeight: 240 }, { force: true })
  assert.equal(sent.length, 2)
  assert.equal(sent[1].scale, 2)
  // Returning to the last sent geometry suppresses the pending send entirely.
  scheduler.schedule({ width: 700, height: 480, scale: 2, cssWidth: 350, cssHeight: 240 })
  assert.equal(scheduler.hasPending(), true)
  scheduler.schedule({ width: 640, height: 480, scale: 2, cssWidth: 320, cssHeight: 240 })
  assert.equal(scheduler.hasPending(), false)
  timers.advance(500)
  assert.equal(sent.length, 2)
  scheduler.cancel()
  assert.equal(scheduler.hasPending(), false)
})

test('hasFeature negotiates the worker hello feature set', () => {
  const features = ['interaction.map.v2', 'input.text', 'input.ime', 'pointer.lock']
  assert.equal(hasFeature(features, 'interaction.map.v2'), true)
  assert.equal(hasFeature(features, 'pointer.lock'), true)
  assert.equal(hasFeature(features, 'gamepad'), false)
  assert.equal(hasFeature([], 'interaction.map.v2'), false)
  assert.equal(hasFeature(undefined, 'interaction.map.v2'), false)
})
