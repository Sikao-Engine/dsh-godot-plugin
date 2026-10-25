import { createElement as h, useEffect, useRef, useState } from 'react'
import {
  FEATURE_IME,
  FEATURE_MAP_V2,
  FEATURE_POINTER_LOCK,
  FEATURE_TEXT,
  computeResize,
  createResizeScheduler,
  hasFeature,
  transientRemap,
} from './interaction-map.mjs'

export const inject = ['slots', 'locale', 'sidebarRightTabs']
// This package can ship two producers: the runtime demo worker and the editor
// worker (`godot:stage:editor`). The panel discovers them through
// `nativeViewports.list()` and switches with the mode selector; the tab
// registration itself stays a single sidebar entry.
const RUNTIME_PRODUCER = 'dsh-godot-plugin/godot'
const EDITOR_PRODUCER = 'dsh-godot-plugin/godot-editor'
const tabId = RUNTIME_PRODUCER
const dictionaries = {
  en: { title: 'Godot viewport', description: 'Native Godot 3D viewport (Vulkan)', unsupported: 'Requires Windows x64 and DSH native viewport preview fork', start: 'Start', stop: 'Stop', reset: 'Reset camera', rotate: 'Rotation', help: 'Drag: orbit · Middle/Right/Shift+Left: pan · Wheel: dolly · WASD / QE: move · R: reset · Space: rotation', starting: 'Starting', running: 'Running', stopped: 'Stopped', fullscreen: 'Fullscreen', mode: 'Mode', runtime: 'Runtime', editor: 'Editor', restartHost: 'Restart Host', restartConfirm: 'Restart the app and Host now?', lock: 'Lock pointer', unlock: 'Unlock pointer', dragToGodot: 'File drops import into Godot' },
  zh: { title: 'Godot 视口', description: '原生 Godot 3D 视口（Vulkan）', unsupported: '需要 Windows x64 与支持原生视口的 DSH 预览 fork', start: '启动', stop: '停止', reset: '重置相机', rotate: '旋转', help: '左键拖动环绕 · 中键/右键/Shift+左键平移 · 滚轮缩放 · WASD / QE 移动 · R 重置 · Space 旋转', starting: '启动中', running: '运行中', stopped: '已停止', fullscreen: '全屏', mode: '模式', runtime: '运行时', editor: '编辑器', restartHost: '重启 Host', restartConfirm: '立即重启应用与 Host？', lock: '锁定指针', unlock: '解除锁定', dragToGodot: '拖入文件导入 Godot' },
}

const dropPreferenceKey = 'godotViewport.dragToGodot'
// Default-on: a file dropped on the viewport imports into Godot, not the host.
const loadDropPreference = () => {
  try { return globalThis.localStorage?.getItem(dropPreferenceKey) !== '0' } catch { return true }
}
const persistDropPreference = value => {
  try { globalThis.localStorage?.setItem(dropPreferenceKey, value ? '1' : '0') } catch {}
}

export function apply(ctx) {
  const api = globalThis.dshDesktop?.nativeViewports
  const t = ctx.locale.bind('godotViewport')
  ctx.effect(() => ctx.locale.register('godotViewport', dictionaries))
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: tabId, kind: 'godotViewport', title: () => t('title'), keepMounted: true,
    guide: [{ id: 'open', order: 40, title: () => t('title'), description: () => t('description') }] }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: tabId, locale: 'godotViewport', inject: () => ({ api }),
  }, Graphics101)))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = `.g101-root{height:100%;min-height:0;display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box}.g101-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.g101-canvas{width:100%;height:100%;min-height:100px;display:block;background:#10131b;outline-offset:-3px;user-select:none;-webkit-user-select:none;touch-action:none}.g101-wrap{flex:1;min-height:0;position:relative}.g101-status{font:12px monospace;overflow-wrap:anywhere}.g101-root button{padding:4px 10px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.g101-tools select{padding:3px 6px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit}.g101-help{font-size:12px;opacity:.7}.g101-canvas.g101-drag{outline:2px dashed currentColor;outline-offset:-3px}.g101-wrap:fullscreen{background:#10131b}`
    document.head.append(style)
    return () => style.remove()
  })
}

function Graphics101({ api, t, useTabInfo }) {
  const { tab } = useTabInfo()
  const canvas = useRef(null), view = useRef(null), wrap = useRef(null), teardown = useRef(Promise.resolve())
  const [enabled, setEnabled] = useState(true), [status, setStatus] = useState(''), [rotation, setRotation] = useState(true)
  const [producerId, setProducerId] = useState(RUNTIME_PRODUCER)
  const [producers, setProducers] = useState([])
  const [dropToGodot, setDropToGodot] = useState(loadDropPreference)
  const [lockable, setLockable] = useState(false)
  const [locked, setLocked] = useState(false)
  const restartHost = globalThis.dshDesktop?.app?.restart
  useEffect(() => {
    if (!api?.capabilities.supported) return
    let active = true
    api.list()
      .then(list => { if (active) setProducers(list.filter(producer => producer.extensions.includes('godot.demo.v1')).map(producer => producer.id)) })
      .catch(() => {})
    return () => { active = false }
  }, [api])
  useEffect(() => {
    if (!enabled || !api?.capabilities.supported || !navigator.gpu) return
    let active = true
    const report = value => { if (active) setStatus(value) }
    const capabilities = features => { if (active) setLockable(hasFeature(features, FEATURE_POINTER_LOCK)) }
    const pointerLock = value => { if (active) setLocked(value) }
    const controller = mountViewport(api, canvas.current, tab.signal, report, producerId, capabilities, pointerLock, dropToGodot)
    view.current = controller
    teardown.current.then(() => { if (active) return controller.start() }).catch(error => { report(error.message); controller.dispose().catch(error => report(error.message)) })
    return () => {
      active = false
      view.current = null
      teardown.current = teardown.current.then(() => controller.dispose())
      teardown.current.catch(error => console.error('Viewport teardown failed', error))
    }
  }, [api, enabled, tab.signal, producerId])
  useEffect(() => { view.current?.visible(tab.visible && !document.hidden) }, [tab.visible, enabled])
  if (!api?.capabilities.supported || !navigator.gpu) return h('section', { className: 'g101-root' }, t('unsupported'))
  return h('section', { className: 'g101-root', 'data-godot-viewport': true },
    h('div', { className: 'g101-tools' },
      h('strong', null, t('title')),
      h('button', { onClick: () => setEnabled(!enabled) }, t(enabled ? 'stop' : 'start')),
      h('button', { onClick: () => { view.current?.extension('reset'); setRotation(true) } }, t('reset')),
      h('label', null, h('input', { type: 'checkbox', checked: rotation, onChange: e => { setRotation(e.target.checked); view.current?.extension('rotate', { value: e.target.checked }) } }), t('rotate')),
      h('button', { onClick: () => wrap.current.requestFullscreen().catch(error => setStatus(error.message)) }, t('fullscreen')),
      lockable && h('button', { onClick: () => view.current?.lock(!locked) }, t(locked ? 'unlock' : 'lock')),
      h('label', { title: t('dragToGodot') }, h('input', {
        type: 'checkbox', checked: dropToGodot, onChange: e => {
          setDropToGodot(e.target.checked)
          persistDropPreference(e.target.checked)
          view.current?.setDropPreference(e.target.checked)
        },
      }), t('dragToGodot'))),
    h('div', { className: 'g101-tools' },
      h('label', null, t('mode'), ' ',
        h('select', { value: producerId, onChange: event => setProducerId(event.target.value), disabled: producers.length < 2, title: t('mode') },
          (producers.length ? producers : [producerId]).map(candidate => h('option', { key: candidate, value: candidate }, t(candidate === EDITOR_PRODUCER ? 'editor' : 'runtime'))))),
      typeof restartHost === 'function' && h('button', {
        onClick: () => {
          if (!globalThis.confirm(t('restartConfirm'))) return
          restartHost().catch(error => setStatus(error.message))
        },
      }, t('restartHost'))),
    h('div', { className: 'g101-wrap', ref: wrap }, h('canvas', { className: 'g101-canvas', ref: canvas, tabIndex: 0, 'aria-label': t('title') })),
    h('div', { className: 'g101-status', 'data-godot-viewport-status': true }, enabled ? status : t('stopped')),
    h('div', { className: 'g101-help' }, t('help')))
}

function mountViewport(api, canvas, signal, status, producerId, onCapabilities, onPointerLock, initialDropPreference) {
  let generation, device, context, canceled = false, seq = 0, shown = true
  let frames = 0, removeFrame, removeEvent, resizeObserver, cleanupPromise
  let features = [], appliedSurface = null, lastDpr = 1
  let imeElement = null, imeActive = false, composing = false, compositionCancelled = false
  let dropEnabled = initialDropPreference !== false // 默认开:文件拖入视口 = 导入 Godot
  const listeners = []
  const on = (target, event, callback, options) => { target.addEventListener(event, callback, options); listeners.push(() => target.removeEventListener(event, callback, options)) }
  const control = data => { if (generation) api.control(generation, data) }
  const input = event => control({ kind: 'input', seq: ++seq, event })
  const extension = (name, payload = null) => control({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name, payload })
  const viewportExtension = (name, payload = null) => control({ kind: 'extension', seq: ++seq, namespace: 'godot.viewport.v1', name, payload })
  const focusLost = () => input({ type: 'focus', focused: false })
  const visible = value => { shown = value; control({ kind: 'visible', value }); if (!value) focusLost() }
  const mapV2 = () => hasFeature(features, FEATURE_MAP_V2)
  // Resize goes through a trailing-debounce scheduler: continuous stretching
  // coalesces into one engine resize per pause instead of a resize storm.
  const resizeScheduler = createResizeScheduler({
    send: geom => control({
      kind: 'resize',
      width: geom.width,
      height: geom.height,
      scale: geom.scale,
      // interaction.map.v2 only: without the negotiated feature the upstream
      // validator rejects the unknown fields (graphics101 fallback behavior).
      ...(mapV2() && geom.cssWidth > 0 && geom.cssHeight > 0 ? { cssWidth: geom.cssWidth, cssHeight: geom.cssHeight } : {}),
    }),
  })
  const scheduleResize = ({ force = false } = {}) => {
    const rect = canvas.getBoundingClientRect()
    resizeScheduler.schedule(computeResize(rect, globalThis.devicePixelRatio ?? 1), { force })
  }
  const resize = () => {
    // A DPR change (browser zoom, cross-screen drag) does not always retrigger
    // layout, so observe it here as well as on window resize.
    const dpr = globalThis.devicePixelRatio ?? 1
    if (dpr !== lastDpr) {
      lastDpr = dpr
      scheduleResize({ force: true })
      return
    }
    scheduleResize()
  }
  let startPromise
  const start = () => startPromise ??= (async () => {
    status('Vulkan · sharedTexture · starting')
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('WebGPU adapter unavailable')
    device = await adapter.requestDevice()
    if (canceled) return
    device.lost.then(info => { if (!canceled) { status(`WebGPU lost: ${info.message}`); dispose() } })
    context = canvas.getContext('webgpu')
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })
    const module = device.createShaderModule({ code: `
struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
 let p = array<vec2<f32>,3>(vec2(-1,-1),vec2(3,-1),vec2(-1,3));
 var o: Out; o.position = vec4(p[i],0,1); o.uv = vec2(p[i].x*0.5+0.5,0.5-p[i].y*0.5); return o;
}
@group(0) @binding(0) var tex: texture_external;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(o: Out) -> @location(0) vec4<f32> { return vec4(textureSampleBaseClampToEdge(tex,smp,o.uv).rgb,1); }` })
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] })
    const pipeline = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } })
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    if (api.capabilities.protocol !== 2) throw new Error('Native viewport protocol 2 required')
    const producers = await api.list()
    if (!producers.some(producer => producer.id === producerId && producer.extensions.includes('godot.demo.v1'))) throw new Error(`Producer unavailable: ${producerId}`)
    const session = await api.attach(producerId)
    generation = session.generation
    features = Array.isArray(session.features) ? session.features : []
    onCapabilities?.(features)
    if (canceled) return
    removeFrame = api.onFrame(generation, async (frame, ticket) => {
      if (canceled || ticket.generation !== generation) return
      if (canvas.width !== ticket.width) canvas.width = ticket.width
      if (canvas.height !== ticket.height) canvas.height = ticket.height
      const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: device.importExternalTexture({ source: frame }) }, { binding: 1, resource: sampler }] })
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0,0,0,1] }] })
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end()
      device.queue.submit([encoder.finish()])
      frames++
      canvas.dataset.frames = String(frames); canvas.dataset.inputSeq = String(ticket.inputSeq); canvas.dataset.epoch = String(ticket.epoch)
      if (frames === 1 || frames % 60 === 0) status(`${session.backend} · ${frames} frames · inputSeq ${ticket.inputSeq}`)
      await device.queue.onSubmittedWorkDone()
    })
    // Engine-physical px -> css px against the applied surface, then positioned
    // inside the canvas parent so the OS composition window anchors at the
    // engine caret (the same trick Godot's own web export uses).
    const handleImeState = payload => {
      if (typeof payload?.active !== 'boolean') return
      imeActive = payload.active
      if (!imeActive) {
        composing = false
        if (imeElement) { imeElement.style.display = 'none'; imeElement.value = '' }
        return
      }
      const host = ensureImeElement()
      if (!host.isConnected) return
      const surface = appliedSurface
      const cssX = surface ? payload.x * (surface.cssWidth / surface.width) : 0
      const cssY = surface ? payload.y * (surface.cssHeight / surface.height) : 0
      host.style.display = ''
      host.style.left = `${canvas.offsetLeft + cssX}px`
      host.style.top = `${canvas.offsetTop + cssY}px`
      if (document.activeElement !== host) host.focus({ preventScroll: true })
    }
    removeEvent = api.onEvent(generation, event => {
      if (event.type === 'extension' && event.namespace === 'godot.viewport.v1' && event.name === 'imeState') {
        handleImeState(event.payload)
        return
      }
      if (event.type === 'surface') {
        // The applied-geometry receipt: while a resize is pending the engine
        // still renders the old surface; transientRemap keeps hits correct
        // against the stretched presentation. css fields ride along with
        // interaction.map.v2; without them the surface is physical-only.
        resizeScheduler.acknowledge(event)
        appliedSurface = mapV2() && event.width > 0 && event.height > 0
          ? { width: event.width, height: event.height, cssWidth: event.cssWidth ?? event.width, cssHeight: event.cssHeight ?? event.height }
          : null
        return
      }
      if (event.type === 'error') { status(event.message); dispose().catch(error => status(error.message)) }
      if (event.type === 'disposed' && !canceled) { status('Native viewport disposed'); dispose().catch(error => status(error.message)) }
    })
    const modifiers = e => Number(e.shiftKey) | Number(e.ctrlKey) << 1 | Number(e.altKey) << 2 | Number(e.metaKey) << 3
    const position = e => {
      const rect = canvas.getBoundingClientRect()
      let x = e.clientX - rect.left
      let y = e.clientY - rect.top
      if (mapV2() && resizeScheduler.hasPending() && appliedSurface) {
        // Stretch-in-progress: the presented frame is the applied surface
        // stretched to the current rect, so re-express the point against the
        // applied CSS geometry (identity once the surface receipt lands).
        ;({ x, y } = transientRemap(x, y, appliedSurface, rect))
      }
      return { x, y }
    }
    const pointer = (e, phase) => input({
      type: 'pointer', phase, pointerId: e.pointerId, pointerType: e.pointerType, ...position(e),
      buttons: e.buttons, button: e.button, modifiers: modifiers(e),
      ...(document.pointerLockElement === canvas ? { movementX: e.movementX, movementY: e.movementY } : {}),
    })
    // The host UI must not interpret gestures that start inside the viewport:
    // kill the browser's own context menu/text selection/drag and keep the
    // events from reaching sidebar splitters etc.
    on(canvas, 'contextmenu', e => { e.preventDefault(); e.stopPropagation() })
    on(canvas, 'selectstart', e => { e.preventDefault(); e.stopPropagation() })
    on(canvas, 'dragstart', e => { e.preventDefault(); e.stopPropagation() })
    on(canvas, 'pointerdown', e => { e.stopPropagation(); canvas.focus(); pointer(e, 'down'); canvas.setPointerCapture(e.pointerId) })
    on(canvas, 'pointermove', e => pointer(e, 'move'))
    on(canvas, 'pointerup', e => { e.stopPropagation(); pointer(e, 'up'); if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId) })
    on(canvas, 'pointercancel', e => pointer(e, 'cancel'))
    on(canvas, 'lostpointercapture', e => pointer(e, 'cancel'))
    on(canvas, 'wheel', e => {
      e.preventDefault()
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1
      input({ type: 'wheel', ...position(e), deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, modifiers: modifiers(e) })
    }, { passive: false })
    // A pressed key whose DOM `key` is a single printable character carries it
    // along (input.text capability); the worker sets InputEventKey::unicode,
    // which is what LineEdit/TextEdit insert from. Shortcuts keep unicode
    // clear so ctrl-combos don't double-act as text.
    // File-drop intent routing (default-on option): while enabled, a file
    // drag over the viewport is claimed for Godot — the surrounding DSH app
    // (document-level drop listeners) never sees it. When disabled, drops
    // fall through to the host import flow unchanged.
    const dropSupported = () => hasFeature(features, 'input.drop') && typeof globalThis.dshDesktop?.fileDrag?.getPathForFile === 'function'
    const hasFileDrag = e => e.dataTransfer?.types?.includes('Files') === true
    on(canvas, 'dragenter', e => {
      if (!dropEnabled || !dropSupported() || !hasFileDrag(e)) return
      e.preventDefault(); e.stopPropagation()
      canvas.classList.add('g101-drag')
    })
    on(canvas, 'dragover', e => {
      if (!dropEnabled || !dropSupported() || !hasFileDrag(e)) return
      e.preventDefault(); e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    })
    on(canvas, 'dragleave', e => {
      if (!hasFileDrag(e)) return
      canvas.classList.remove('g101-drag')
    })
    on(canvas, 'drop', e => {
      canvas.classList.remove('g101-drag')
      if (!dropEnabled || !dropSupported() || !hasFileDrag(e)) return
      e.preventDefault(); e.stopPropagation()
      const resolvePath = globalThis.dshDesktop.fileDrag.getPathForFile
      const paths = []
      for (const file of e.dataTransfer.files) {
        try {
          const path = resolvePath(file)
          if (typeof path === 'string' && path.length > 0) paths.push(path)
        } catch { /* path unavailable for this entry */ }
      }
      pointer(e, 'move') // land the engine cursor exactly at the drop point
      if (paths.length > 0) input({ type: 'drop', ...position(e), paths })
    })
    const key = (e, down) => {
      e.preventDefault(); e.stopPropagation()
      if (down && composing && e.key === 'Escape') compositionCancelled = true
      if (e.keyCode === 229 || composing) return // IME owns the keystroke
      const printable = down && !e.repeat && e.key?.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
      input({
        type: 'key', code: e.code, down, repeat: e.repeat, modifiers: modifiers(e),
        ...(hasFeature(features, FEATURE_TEXT) && printable ? { key: e.key } : {}),
      })
    }
    // Text/IME pipeline: composition events become ime control messages and
    // direct insertions (paste and friends) become text control messages.
    const handleCompositionStart = () => { composing = true; compositionCancelled = false; input({ type: 'ime', state: 'start', text: '' }) }
    const handleCompositionUpdate = e => input({ type: 'ime', state: 'update', text: e.data ?? '' })
    const handleCompositionEnd = e => {
      composing = false
      input({ type: 'ime', state: compositionCancelled ? 'cancel' : 'commit', text: e.data ?? '' })
      compositionCancelled = false
      if (imeElement) imeElement.value = ''
    }
    const handleBeforeInput = e => {
      if (e.isComposing || typeof e.data !== 'string' || e.data.length === 0) return
      if (!e.inputType?.startsWith('insert')) return
      input({ type: 'text', text: e.data })
    }
    const textIme = hasFeature(features, FEATURE_TEXT) && hasFeature(features, FEATURE_IME)
    on(canvas, 'keydown', e => key(e, true)); on(canvas, 'keyup', e => key(e, false))
    if (textIme) {
      on(canvas, 'compositionstart', handleCompositionStart)
      on(canvas, 'compositionupdate', handleCompositionUpdate)
      on(canvas, 'compositionend', handleCompositionEnd)
      on(canvas, 'beforeinput', handleBeforeInput)
    }
    // Hidden editable host for IME composition: Chromium only starts a system
    // IME on editable elements, so the canvas alone can never compose CJK
    // text. The worker tells us (imeState) when a text field takes/loses focus
    // and where its caret sits; we park this transparent 2px textarea there.
    const ensureImeElement = () => {
      if (imeElement) return imeElement
      imeElement = document.createElement('textarea')
      imeElement.setAttribute('aria-hidden', 'true')
      imeElement.autocapitalize = 'off'
      imeElement.autocomplete = 'off'
      imeElement.spellcheck = false
      Object.assign(imeElement.style, {
        position: 'absolute', width: '2px', height: '1em', padding: '0', border: '0', margin: '0',
        opacity: '0', background: 'transparent', color: 'transparent', caretColor: 'transparent',
        overflow: 'hidden', resize: 'none', zIndex: '1', pointerEvents: 'none', display: 'none',
      })
      canvas.parentElement?.appendChild(imeElement)
      on(imeElement, 'keydown', e => key(e, true)); on(imeElement, 'keyup', e => key(e, false))
      if (textIme) {
        on(imeElement, 'compositionstart', handleCompositionStart)
        on(imeElement, 'compositionupdate', handleCompositionUpdate)
        on(imeElement, 'compositionend', handleCompositionEnd)
        on(imeElement, 'beforeinput', handleBeforeInput)
      }
      on(imeElement, 'blur', () => { if (!imeActive && document.activeElement !== canvas) canvas.focus() })
      return imeElement
    }
    on(canvas, 'focus', () => input({ type: 'focus', focused: true }))
    on(canvas, 'blur', () => { if (document.activeElement !== imeElement) focusLost() })
    on(window, 'blur', focusLost)
    on(document, 'visibilitychange', () => { control({ kind: 'visible', value: shown && !document.hidden }); if (document.hidden) focusLost() })
    on(document, 'pointerlockchange', () => {
      const lockedNow = document.pointerLockElement === canvas
      onPointerLock?.(lockedNow)
      if (!lockedNow) viewportExtension('setRelativeMouseMode', { value: false })
    })
    resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas)
    on(window, 'resize', resize)
    resize(); visible(shown)
  })()
  const setRelativeMouseMode = value => {
    if (!hasFeature(features, FEATURE_POINTER_LOCK)) return
    viewportExtension('setRelativeMouseMode', { value })
    if (value) {
      canvas.requestPointerLock?.()
    } else if (document.pointerLockElement === canvas) {
      document.exitPointerLock?.()
    }
  }
  const dispose = () => cleanupPromise ??= (async () => {
    canceled = true
    signal.removeEventListener('abort', abort)
    resizeScheduler.cancel()
    if (imeElement) { imeElement.blur(); imeElement.remove(); imeElement = null }
    if (document.pointerLockElement === canvas) document.exitPointerLock?.()
    listeners.forEach(remove => remove()); resizeObserver?.disconnect()
    await startPromise?.catch(() => {})
    if (device) await device.queue.onSubmittedWorkDone().catch(() => {})
    if (generation) await api.dispose(generation)
    removeFrame?.(); removeEvent?.(); context?.unconfigure(); device?.destroy()
  })()
  const abort = () => { dispose().catch(error => status(error.message)) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) canceled = true
  return { start, dispose, extension, visible, lock: setRelativeMouseMode, features: () => features, setDropPreference: value => { dropEnabled = value !== false } }
}
