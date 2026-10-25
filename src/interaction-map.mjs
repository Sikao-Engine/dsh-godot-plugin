// Pure interaction-mapping helpers for the DSH Godot viewport (interaction
// protocol v2). No DOM access: src/client.js imports these at runtime and
// tests/interaction-map.test.mjs exercises them directly.
//
// Coordinate conventions:
// - pointer/wheel event positions are viewport-local CSS px (top-left origin);
// - resize width/height are physical render px (0..2048, 0 suspends);
// - optional resize cssWidth/cssHeight (the viewport CSS size at send time)
//   enable exact per-axis mapping; without them the legacy single `scale`
//   applies to both axes (graphics101 behavior).

export const MAX_VIEWPORT_DIMENSION = 2048
export const MAX_CSS_DIMENSION = 16384
export const RESIZE_DEBOUNCE_MS = 120

// Feature names announced by the worker hello and negotiated through attach().
export const FEATURE_MAP_V2 = 'interaction.map.v2'
export const FEATURE_TEXT = 'input.text'
export const FEATURE_IME = 'input.ime'
export const FEATURE_POINTER_LOCK = 'pointer.lock'
export const FEATURE_WINDOWS_MULTI = 'windows.multi.v1'
export const FEATURE_DROP = 'input.drop'

/** Protocol v2.1: at most 16 windows per session (ids 0..15, 0 = main). */
export const MAX_WINDOWS = 16

export function hasFeature(features, name) {
  return Array.isArray(features) && features.includes(name)
}

/** Legacy clamp: never exceed the 2048 physical quota, never upscale beyond the device DPR. */
export function clampScale(cssWidth, cssHeight, dpr, maxDimension = MAX_VIEWPORT_DIMENSION) {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  return Math.min(d, maxDimension / Math.max(1, cssWidth, cssHeight))
}

/**
 * Physical resize geometry for a viewport CSS rect. Rounding happens exactly
 * here (client and tests share the same rounding, so the worker receives the
 * same integers the scheduler deduplicates against).
 */
export function computeResize(rect, dpr, { maxDimension = MAX_VIEWPORT_DIMENSION } = {}) {
  const cssWidth = rect.width
  const cssHeight = rect.height
  if (!(cssWidth > 0) || !(cssHeight > 0)) {
    return { width: 0, height: 0, scale: 1, cssWidth, cssHeight }
  }
  const scale = clampScale(cssWidth, cssHeight, dpr, maxDimension)
  return {
    width: Math.max(0, Math.min(maxDimension, Math.round(cssWidth * scale))),
    height: Math.max(0, Math.min(maxDimension, Math.round(cssHeight * scale))),
    scale,
    cssWidth,
    cssHeight,
  }
}

/**
 * The per-axis factors the engine locks when it applies this resize. This is
 * the exact formula dsh_viewport_worker.cpp::_apply_pending_resize() uses, so
 * client and worker agree bit for bit.
 */
export function engineMapFactors({ width, height, cssWidth, cssHeight, scale }) {
  if (Number.isFinite(cssWidth) && Number.isFinite(cssHeight) && cssWidth > 0 && cssHeight > 0) {
    return { mapScaleX: width / cssWidth, mapScaleY: height / cssHeight }
  }
  const legacy = Number.isFinite(scale) && scale > 0 ? scale : 1
  return { mapScaleX: legacy, mapScaleY: legacy }
}

/** Steady-state CSS -> physical point mapping (mirrors the engine-side multiply). */
export function mapCssToPhysical(x, y, factors) {
  return { x: x * factors.mapScaleX, y: y * factors.mapScaleY }
}

/**
 * Transient remap while a resize is pending: the engine still renders the
 * applied (old) physical geometry, stretched to the current CSS rect, so a
 * current-rect CSS point must be re-expressed against the applied CSS
 * geometry. The engine then multiplies by its (stale) locked factors, and the
 * composition lands on the visually correct point:
 *   remap(x) * appliedPhys/appliedCss === x * appliedPhys/currentCss.
 * Identity once the pending resize is acknowledged by a surface receipt.
 */
export function transientRemap(x, y, appliedSurface, rect) {
  if (!appliedSurface || !(rect.width > 0) || !(rect.height > 0)) return { x, y }
  return {
    x: x * (appliedSurface.cssWidth / rect.width),
    y: y * (appliedSurface.cssHeight / rect.height),
  }
}

/**
 * Protocol v2.1 window geometry: engine rects live in the virtual screen's
 * physical pixels (main window origin at (0,0)); a layer is positioned inside
 * the viewport wrap in CSS px. The session-level map factors (physical px per
 * CSS px, locked by the main-window resize) convert both axes.
 */
export function engineRectToLayerCss(rect, mainPosition, factors) {
  const mapScaleX = Number.isFinite(factors?.mapScaleX) && factors.mapScaleX > 0 ? factors.mapScaleX : 1
  const mapScaleY = Number.isFinite(factors?.mapScaleY) && factors.mapScaleY > 0 ? factors.mapScaleY : 1
  const mainX = Number.isFinite(mainPosition?.x) ? mainPosition.x : 0
  const mainY = Number.isFinite(mainPosition?.y) ? mainPosition.y : 0
  return {
    x: (rect.x - mainX) / mapScaleX,
    y: (rect.y - mainY) / mapScaleY,
    width: rect.width / mapScaleX,
    height: rect.height / mapScaleY,
  }
}

/**
 * Pure reducer for the godot.window.v1 lifecycle events. `layers` is a Map of
 * window id -> layer state {window, rect, z, visible, focused, title}; the
 * reducer returns a new Map (never mutates). Unknown windows on rect/focus
 * events are ignored until their `created` arrives (eventual order safety).
 */
export function reduceWindowEvent(layers, name, payload) {
  const next = new Map(layers)
  const window = payload?.window
  if (!Number.isInteger(window) || window < 0 || window >= MAX_WINDOWS) return next
  const current = next.get(window)
  switch (name) {
    case 'created': {
      next.set(window, {
        window,
        rect: payload.rect ?? { x: 0, y: 0, width: 0, height: 0 },
        z: Number.isInteger(payload.z) ? payload.z : window,
        visible: false,
        focused: false,
        title: typeof payload.title === 'string' ? payload.title : '',
        transparent: payload.transparent === true,
      })
      return next
    }
    case 'destroyed':
      next.delete(window)
      return next
    case 'rect':
      if (current) next.set(window, { ...current, rect: payload.rect ?? current.rect })
      return next
    case 'visibility':
      if (current) next.set(window, { ...current, visible: payload.visible === true })
      return next
    case 'title':
      if (current) next.set(window, { ...current, title: typeof payload.title === 'string' ? payload.title : current.title })
      return next
    case 'focus':
      if (current) next.set(window, { ...current, focused: payload.focused === true })
      return next
    case 'raised':
      if (current) next.set(window, { ...current, z: Number.isInteger(payload.z) ? payload.z : current.z })
      return next
    default:
      return next
  }
}

/**
 * Trailing-debounce scheduler for resize control messages.
 * - the first schedule() sends immediately (fast first surface);
 * - later schedules coalesce with a trailing `debounceMs` window;
 * - schedule(geom, {force:true}) bypasses the debounce (DPR changes);
 * - acknowledge(surface) cancels a pending send the moment the worker reports
 *   the matching surface, so steady state never waits for the timer.
 */
export function createResizeScheduler({
  send,
  debounceMs = RESIZE_DEBOUNCE_MS,
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  if (typeof send !== 'function') throw new TypeError('createResizeScheduler requires a send(geom) function')
  let sentOnce = false
  let lastSent = null
  let pending = null
  let timer = null

  const sameGeometry = (a, b) => a !== null && b !== null
    && a.width === b.width && a.height === b.height
    && a.cssWidth === b.cssWidth && a.cssHeight === b.cssHeight

  const flush = () => {
    timer = null
    const geom = pending
    pending = null
    if (!geom) return
    lastSent = geom
    send(geom)
  }

  return {
    /** @returns true when a send happened or is scheduled. */
    schedule(geometry, { force = false } = {}) {
      const next = { ...geometry, width: Math.round(geometry.width), height: Math.round(geometry.height) }
      if (sameGeometry(next, lastSent) && !pending) return false
      if (sameGeometry(next, lastSent)) {
        // Back to the applied geometry: the pending storm is moot.
        pending = null
        if (timer !== null) { clearTimer(timer); timer = null }
        return false
      }
      if (!sentOnce || force) {
        if (timer !== null) { clearTimer(timer); timer = null }
        pending = null
        sentOnce = true
        lastSent = next
        send(next)
        return true
      }
      pending = next
      if (timer !== null) clearTimer(timer)
      timer = setTimer(flush, debounceMs)
      return true
    },
    /** Surface receipt: drop a pending send whose geometry the worker just applied. */
    acknowledge({ width, height, cssWidth, cssHeight }) {
      if (!pending) return false
      const applied = { width, height, cssWidth, cssHeight }
      const matches = cssWidth === undefined || cssHeight === undefined
        ? pending.width === Math.round(width) && pending.height === Math.round(height)
        : sameGeometry(pending, applied)
      if (!matches) return false
      pending = null
      if (timer !== null) { clearTimer(timer); timer = null }
      return true
    },
    hasPending() { return pending !== null },
    pending() { return pending },
    lastSent() { return lastSent },
    cancel() {
      pending = null
      if (timer !== null) { clearTimer(timer); timer = null }
    },
  }
}
