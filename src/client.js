import { createElement as h, useEffect, useRef, useState } from 'react'
import {
  FEATURE_DROP,
  FEATURE_IME,
  FEATURE_MAP_V2,
  FEATURE_POINTER_LOCK,
  FEATURE_TEXT,
  FEATURE_WINDOWS_MULTI,
  computeResize,
  createResizeScheduler,
  engineMapFactors,
  engineRectToLayerCss,
  hasFeature,
  reduceWindowEvent,
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
    style.textContent = `.g101-root{height:100%;min-height:0;display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box}.g101-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.g101-canvas{width:100%;height:100%;min-height:100px;display:block;background:#10131b;outline-offset:-3px;user-select:none;-webkit-user-select:none;touch-action:none}.g101-wrap{flex:1;min-height:0;position:relative;overflow:visible}.g101-status{font:12px monospace;overflow-wrap:anywhere}.g101-root button{padding:4px 10px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.g101-tools select{padding:3px 6px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit}.g101-help{font-size:12px;opacity:.7}.g101-canvas.g101-drag{outline:2px dashed currentColor;outline-offset:-3px}.g101-wrap:fullscreen{background:#10131b}.g101-layer{position:absolute;display:block;user-select:none;-webkit-user-select:none;touch-action:none}`
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
      .then(list => {
        if (!active) return
        const available = list.filter(producer => producer.extensions.includes('godot.demo.v1')).map(producer => producer.id)
        setProducers(available)
        if (available.length > 0) setProducerId(current => available.includes(current) ? current : available[0])
      })
      .catch(() => {})
    return () => { active = false }
  }, [api])
  useEffect(() => {
    if (!enabled || !api?.capabilities.supported || !navigator.gpu) return
    let active = true
    const report = value => { if (active) setStatus(value) }
    const capabilities = features => { if (active) setLockable(hasFeature(features, FEATURE_POINTER_LOCK)) }
    const pointerLock = value => { if (active) setLocked(value) }
    const controller = mountViewport(api, canvas.current, wrap.current, tab.signal, report, producerId, capabilities, pointerLock, dropToGodot)
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

function mountViewport(api, canvas, wrap, signal, status, producerId, onCapabilities, onPointerLock, initialDropPreference) {
  let generation, device, context, canceled = false, seq = 0, shown = true
  let frames = 0, removeFrame, removeEvent, resizeObserver, cleanupPromise
  let mainPresentQueue = Promise.resolve()
  let features = [], appliedSurface = null, lastDpr = 1
  let factors = { mapScaleX: 1, mapScaleY: 1 }
  let imeElement = null, imeActive = false, composing = false, compositionCancelled = false
  let focusedWindow = 0
  const layers = new Map() // Protocol v2.1: window id -> sub-window layer state.
  const unknownWindowFrames = new Map() // Debug: window id -> dropped frame count.
  let layerStates = new Map() // Pure reducer state feeding the layer manager.
  let gameSession = null // Protocol v2.1: game overlay session spawned through godot.editor.v1.
  let gameTeardown = Promise.resolve()
  let dropEnabled = initialDropPreference !== false // 默认开:文件拖入视口 = 导入 Godot
  const listeners = []
  // ---- debug instrumentation (black-screen investigation) ----
  // console.log reaches the terminal/desktop log via ELECTRON_ENABLE_LOGGING=1;
  // the ring buffer survives for later retrieval via globalThis.__GODOT_WIN_LOG.
  const debugLog = globalThis.__GODOT_WIN_LOG ??= []
  const dlog = (...args) => {
    const line = `${new Date().toISOString().slice(11, 23)} ${args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')}`
    debugLog.push(line)
    if (debugLog.length > 800) debugLog.shift()
    console.log('[godot-win]', line)
  }
  const on = (target, event, callback, options) => { target.addEventListener(event, callback, options); listeners.push(() => target.removeEventListener(event, callback, options)) }
  const control = data => { if (generation) api.control(generation, data) }
  const input = event => control({ kind: 'input', seq: ++seq, event })
  const extension = (name, payload = null) => control({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name, payload })
  const viewportExtension = (name, payload = null) => control({ kind: 'extension', seq: ++seq, namespace: 'godot.viewport.v1', name, payload })
  const multiWindow = () => hasFeature(features, FEATURE_WINDOWS_MULTI)
  // Window-tagged input is gated on the negotiated capability everywhere.
  const withWindow = (event, window) => (multiWindow() ? { ...event, window } : event)
  const focusLost = (window = 0) => input(withWindow({ type: 'focus', focused: false }, window))
  const visible = value => {
    shown = value
    dlog('visible', { value, producerId })
    control({ kind: 'visible', value })
    if (gameSession?.generation) api.control(gameSession.generation, { kind: 'visible', value })
    if (!value) focusLost(focusedWindow)
  }
  const mapV2 = () => hasFeature(features, FEATURE_MAP_V2)
  // Resize goes through a trailing-debounce scheduler: continuous stretching
  // coalesces into one engine resize per pause instead of a resize storm.
  const resizeScheduler = createResizeScheduler({
    send: geom => {
      dlog('resize send', { width: geom.width, height: geom.height, scale: geom.scale, cssWidth: geom.cssWidth, cssHeight: geom.cssHeight })
      control({
        kind: 'resize',
        width: geom.width,
        height: geom.height,
        scale: geom.scale,
        // interaction.map.v2 only: without the negotiated feature the upstream
        // validator rejects the unknown fields (graphics101 fallback behavior).
        ...(mapV2() && geom.cssWidth > 0 && geom.cssHeight > 0 ? { cssWidth: geom.cssWidth, cssHeight: geom.cssHeight } : {}),
      })
    },
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
  // A self-contained WebGPU presenter for one canvas (main surface or a
  // protocol v2.1 window layer). Layers sample alpha so popups can composite
  // rounded corners/shadows over the main surface.
  const createLayerRenderer = async (target, { transparent = false } = {}) => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) { dlog('webgpu adapter unavailable', { transparent }); throw new Error('WebGPU adapter unavailable') }
    const layerDevice = await adapter.requestDevice()
    const layerContext = target.getContext('webgpu')
    const format = navigator.gpu.getPreferredCanvasFormat()
    layerContext.configure({ device: layerDevice, format, alphaMode: transparent ? 'premultiplied' : 'opaque' })
    layerDevice.lost.then(info => { if (!canceled) dlog('webgpu device lost', { transparent, message: info.message, reason: info.reason }) })
    const module = layerDevice.createShaderModule({ code: transparent ? `
struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
 let p = array<vec2<f32>,3>(vec2(-1,-1),vec2(3,-1),vec2(-1,3));
 var o: Out; o.position = vec4(p[i],0,1); o.uv = vec2(p[i].x*0.5+0.5,0.5-p[i].y*0.5); return o;
}
@group(0) @binding(0) var tex: texture_external;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(o: Out) -> @location(0) vec4<f32> { let c = textureSampleBaseClampToEdge(tex,smp,o.uv); return vec4(c.rgb * c.a, c.a); }` : `
struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
 let p = array<vec2<f32>,3>(vec2(-1,-1),vec2(3,-1),vec2(-1,3));
 var o: Out; o.position = vec4(p[i],0,1); o.uv = vec2(p[i].x*0.5+0.5,0.5-p[i].y*0.5); return o;
}
@group(0) @binding(0) var tex: texture_external;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(o: Out) -> @location(0) vec4<f32> { return vec4(textureSampleBaseClampToEdge(tex,smp,o.uv).rgb,1); }` })
    const layout = layerDevice.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] })
    const pipeline = layerDevice.createRenderPipeline({ layout: layerDevice.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } })
    const sampler = layerDevice.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    return {
      device: layerDevice,
      render: async frame => {
        const bind = layerDevice.createBindGroup({ layout, entries: [{ binding: 0, resource: layerDevice.importExternalTexture({ source: frame }) }, { binding: 1, resource: sampler }] })
        const encoder = layerDevice.createCommandEncoder()
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: layerContext.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: transparent ? [0, 0, 0, 0] : [0, 0, 0, 1] }] })
        pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end()
        layerDevice.queue.submit([encoder.finish()])
        await layerDevice.queue.onSubmittedWorkDone().catch(error => { dlog('render submit error', { transparent, message: error?.message ?? String(error) }); throw error })
      },
    }
  }
  const reportGameLifecycle = (running, code = undefined) => {
    control({ kind: 'extension', seq: ++seq, namespace: 'godot.editor.v1', name: 'gameLifecycle', payload: code === undefined ? { running } : { running, code } })
  }
  const stopGame = (code = 0) => {
    const session = gameSession
    if (!session) return gameTeardown
    gameSession = null
    session.disposed = true
    session.element.remove()
    return gameTeardown = (async () => {
      await session.boot?.catch(() => {})
      await session.presentQueue
      if (session.gpu) await session.gpu.device.queue.onSubmittedWorkDone().catch(() => {})
      if (session.generation) await api.dispose(session.generation)
      session.gpu?.device.destroy()
      reportGameLifecycle(false, code)
    })()
  }
  let startPromise
  const start = () => startPromise ??= (async () => {
    status('Vulkan · sharedTexture · starting')
    const mainRenderer = await createLayerRenderer(canvas)
    device = mainRenderer.device
    context = canvas.getContext('webgpu')
    if (canceled) return
    device.lost.then(info => { if (!canceled) { status(`WebGPU lost: ${info.message}`); dispose() } })
    if (api.capabilities.protocol !== 2) throw new Error('Native viewport protocol 2 required')
    const producers = await api.list()
    if (!producers.some(producer => producer.id === producerId && producer.extensions.includes('godot.demo.v1'))) throw new Error(`Producer unavailable: ${producerId}`)
    const session = await api.attach(producerId)
    generation = session.generation
    dlog('attached', { producerId, generation, protocol: api.capabilities?.protocol })
    features = Array.isArray(session.features) ? session.features : []
    onCapabilities?.(features)
    if (canceled) return
    removeFrame = api.onFrame(generation, async (frame, ticket) => {
      if (canceled || ticket.generation !== generation) return
      const window = ticket.window ?? 0
      if (window !== 0) {
        const layer = layers.get(window)
        if (!layer) {
          unknownWindowFrames.set(window, (unknownWindowFrames.get(window) ?? 0) + 1)
          if (unknownWindowFrames.get(window) === 1 || unknownWindowFrames.get(window) % 100 === 0) dlog('frame for unknown window (dropped)', { window, drops: unknownWindowFrames.get(window), known: [...layers.keys()] })
          return
        }
        if (layer.frames === 0) dlog('layer first frame', { window, w: ticket.width, h: ticket.height, epoch: ticket.epoch })
        await layer.present(frame, ticket).catch(error => dlog('layer present error', { window, message: error?.message ?? String(error) }))
        return
      }
      const present = mainPresentQueue.then(async () => {
        if (canceled) return
        if (canvas.width !== ticket.width) canvas.width = ticket.width
        if (canvas.height !== ticket.height) canvas.height = ticket.height
        await mainRenderer.render(frame).catch(error => { dlog('main render error', { message: error?.message ?? String(error), frames }); throw error })
        frames++
        canvas.dataset.frames = String(frames); canvas.dataset.inputSeq = String(ticket.inputSeq); canvas.dataset.epoch = String(ticket.epoch)
        if (frames === 1 || frames % 60 === 0) { status(`${session.backend} · ${frames} frames · inputSeq ${ticket.inputSeq}`); dlog('main frames', { frames, inputSeq: ticket.inputSeq, epoch: ticket.epoch, w: ticket.width, h: ticket.height, layers: layers.size }) }
      })
      mainPresentQueue = present.catch(() => {})
      await present
    })
    // ---- protocol v2.1 game overlay (second session spawned by the editor) ----
    const handleEditorEvent = (name, payload) => {
      if (!multiWindow()) return
      if (name === 'gameRect') {
        if (gameSession && payload?.rect) {
          gameSession.rect = payload.rect
          gameSession.applyGeometry()
        }
        return
      }
      if (name === 'gameClose') {
        void stopGame().catch(error => status(error.message))
        return
      }
      if (name !== 'spawnGame') return
      if (gameSession) {
        // v1: one game instance at a time (plan risk table).
        reportGameLifecycle(false, -1)
        return
      }
      const rect = payload?.rect ?? { x: 0, y: 0, width: 320, height: 240 }
      const args = Array.isArray(payload?.args) ? payload.args.filter(arg => typeof arg === 'string' && arg.length <= 1024).slice(0, 64) : []
      const element = document.createElement('canvas')
      element.className = 'g101-layer'
      element.tabIndex = 0
      element.dataset.game = 'true'
      wrap.appendChild(element)
      const session = { generation: null, gpu: null, element, frames: 0, disposed: false, rect, applyGeometry: null, boot: null, presentQueue: Promise.resolve(), lastResize: null }
      gameSession = session
      const ginput = event => { if (session.generation) api.control(session.generation, { kind: 'input', seq: ++seq, event }) }
      const gposition = e => {
        const box = element.getBoundingClientRect()
        return { x: e.clientX - box.left, y: e.clientY - box.top }
      }
      on(element, 'contextmenu', e => { e.preventDefault(); e.stopPropagation() })
      on(element, 'selectstart', e => { e.preventDefault(); e.stopPropagation() })
      on(element, 'pointerdown', e => { e.stopPropagation(); element.focus(); ginput({ type: 'pointer', phase: 'down', pointerId: e.pointerId, pointerType: e.pointerType, ...gposition(e), buttons: e.buttons, button: e.button, modifiers: modifiers(e) }); element.setPointerCapture(e.pointerId) })
      on(element, 'pointermove', e => ginput({ type: 'pointer', phase: 'move', pointerId: e.pointerId, pointerType: e.pointerType, ...gposition(e), buttons: e.buttons, button: e.button, modifiers: modifiers(e) }))
      on(element, 'pointerup', e => { e.stopPropagation(); ginput({ type: 'pointer', phase: 'up', pointerId: e.pointerId, pointerType: e.pointerType, ...gposition(e), buttons: e.buttons, button: e.button, modifiers: modifiers(e) }); if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId) })
      on(element, 'pointercancel', e => ginput({ type: 'pointer', phase: 'cancel', pointerId: e.pointerId, pointerType: e.pointerType, ...gposition(e), buttons: e.buttons, button: e.button, modifiers: modifiers(e) }))
      on(element, 'wheel', e => {
        e.preventDefault()
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? element.clientHeight : 1
        ginput({ type: 'wheel', ...gposition(e), deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, modifiers: modifiers(e) })
      }, { passive: false })
      on(element, 'keydown', e => { e.preventDefault(); e.stopPropagation(); ginput({ type: 'key', code: e.code, down: true, repeat: e.repeat, modifiers: modifiers(e) }) })
      on(element, 'keyup', e => { e.preventDefault(); e.stopPropagation(); ginput({ type: 'key', code: e.code, down: false, repeat: false, modifiers: modifiers(e) }) })
      on(element, 'focus', () => ginput({ type: 'focus', focused: true }))
      on(element, 'blur', () => ginput({ type: 'focus', focused: false }))
      const applyGeometry = () => {
        const css = engineRectToLayerCss(session.rect, { x: 0, y: 0 }, factors)
        element.style.left = `${css.x}px`
        element.style.top = `${css.y}px`
        element.style.width = `${css.width}px`
        element.style.height = `${css.height}px`
        element.style.zIndex = '1000' // above every engine layer
        if (session.generation && !session.disposed) {
          const geom = computeResize(element.getBoundingClientRect(), globalThis.devicePixelRatio ?? 1)
          const resize = { kind: 'resize', width: geom.width, height: geom.height, scale: geom.scale,
            ...(hasFeature(session.features, FEATURE_MAP_V2) && geom.cssWidth > 0 && geom.cssHeight > 0 ? { cssWidth: geom.cssWidth, cssHeight: geom.cssHeight } : {}) }
          const key = JSON.stringify(resize)
          if (key !== session.lastResize) {
            session.lastResize = key
            api.control(session.generation, resize)
          }
        }
      }
      session.applyGeometry = applyGeometry
      applyGeometry()
      const boot = (async () => {
        await gameTeardown
        if (session.disposed) return
        session.gpu = await createLayerRenderer(element)
        if (session.disposed) return
        const spawned = await api.spawn({ producerId: EDITOR_PRODUCER, args })
        if (session.disposed) { await api.dispose(spawned.generation); return }
        session.generation = spawned.generation
        session.features = spawned.features
        api.onFrame(spawned.generation, (frame, ticket) => {
          const present = session.presentQueue.then(async () => {
            if (session.disposed || (ticket.window ?? 0) !== 0) return
            if (element.width !== ticket.width) element.width = ticket.width
            if (element.height !== ticket.height) element.height = ticket.height
            await session.gpu.render(frame)
            session.frames++
            element.dataset.frames = String(session.frames)
            if (session.frames === 1) reportGameLifecycle(true) // the game window is live
          })
          session.presentQueue = present.catch(() => {})
          return present
        })
        api.onEvent(spawned.generation, event => {
          if (session.disposed) return
          if (event.type === 'surface' && (event.window ?? 0) === 0) applyGeometry()
          if (event.type === 'disposed' || event.type === 'error') {
            void stopGame(event.type === 'error' ? 1 : 0).catch(error => status(error.message))
          }
        })
        applyGeometry()
        api.control(spawned.generation, { kind: 'visible', value: shown && !document.hidden })
      })()
      session.boot = boot
      boot.catch(error => {
        if (session.disposed) return
        status(`Game spawn failed: ${error.message}`)
        void stopGame(1).catch(error => status(error.message))
      })
    }
    // ---- protocol v2.1 window layer manager ----
    const applyLayerGeometry = layer => {
      const css = engineRectToLayerCss(layer.state.rect, { x: 0, y: 0 }, factors)
      layer.cssRect = css
      layer.canvas.style.left = `${css.x}px`
      layer.canvas.style.top = `${css.y}px`
      layer.canvas.style.width = `${css.width}px`
      layer.canvas.style.height = `${css.height}px`
      layer.canvas.style.zIndex = String(layer.state.z)
      layer.canvas.style.display = layer.state.visible ? '' : 'none'
    }
    const syncLayer = state => {
      let layer = layers.get(state.window)
      if (!layer) {
        dlog('layer create', { window: state.window, rect: state.rect, z: state.z, visible: state.visible, transparent: state.transparent })
        const element = document.createElement('canvas')
        element.className = 'g101-layer'
        element.tabIndex = 0
        element.dataset.window = String(state.window)
        wrap.appendChild(element)
        layer = {
          window: state.window, canvas: element, state, gpu: null, appliedSurface: null,
          frames: 0, presentQueue: Promise.resolve(),
          present: null,
        }
        layer.present = (frame, ticket) => {
          const run = layer.presentQueue.then(async () => {
            await layer.ready
            if (canceled || layers.get(state.window) !== layer || !layer.gpu) return
            if (element.width !== ticket.width) element.width = ticket.width
            if (element.height !== ticket.height) element.height = ticket.height
            await layer.gpu.render(frame)
            layer.frames++
            element.dataset.frames = String(layer.frames)
          })
          layer.presentQueue = run.catch(() => {})
          return run
        }
        layer.ready = createLayerRenderer(element, { transparent: state.transparent === true })
          .then(renderer => {
            if (!canceled && layers.get(state.window) === layer) { layer.gpu = renderer; dlog('layer gpu ready', { window: state.window }) }
            else renderer.device.destroy()
          })
        layer.ready.catch(error => { status(`Layer ${state.window}: ${error.message}`); dlog('layer gpu error', { window: state.window, message: error?.message ?? String(error) }) })
        bindLayerInput(layer)
        layers.set(state.window, layer)
      }
      layer.state = state
      const prevCss = layer.cssRect
      applyLayerGeometry(layer)
      if (!prevCss || prevCss.x !== layer.cssRect.x || prevCss.y !== layer.cssRect.y || prevCss.width !== layer.cssRect.width || prevCss.height !== layer.cssRect.height || layer.canvas.style.display !== (state.visible ? '' : 'none')) {
        dlog('layer geometry', { window: state.window, css: layer.cssRect, z: state.z, visible: state.visible, frames: layer.frames })
      }
      return layer
    }
    const destroyLayer = window => {
      const layer = layers.get(window)
      if (!layer) { dlog('layer destroy (no layer)', { window }); return }
      dlog('layer destroy', { window, frames: layer.frames, css: layer.cssRect })
      layers.delete(window)
      layer.presentQueue = layer.presentQueue.then(() => { layer.gpu?.device.destroy() })
      layer.canvas.remove()
    }
    // ---- shared input plumbing ----
    const modifiers = e => Number(e.shiftKey) | Number(e.ctrlKey) << 1 | Number(e.altKey) << 2 | Number(e.metaKey) << 3
    const positionOn = (target, getSurface, getPending) => e => {
      const rect = target.getBoundingClientRect()
      let x = e.clientX - rect.left
      let y = e.clientY - rect.top
      const surface = getSurface?.()
      if (mapV2() && getPending?.() && surface) {
        // Stretch-in-progress: the presented frame is the applied surface
        // stretched to the current rect, so re-express the point against the
        // applied CSS geometry (identity once the surface receipt lands).
        ;({ x, y } = transientRemap(x, y, surface, rect))
      }
      return { x, y }
    }
    const pointerOn = (target, getSurface, getPending, window) => (e, phase) => input(withWindow({
      type: 'pointer', phase, pointerId: e.pointerId, pointerType: e.pointerType, ...positionOn(target, getSurface, getPending)(e),
      buttons: e.buttons, button: e.button, modifiers: modifiers(e),
      ...(document.pointerLockElement === canvas ? { movementX: e.movementX, movementY: e.movementY } : {}),
    }, window))
    const dropSupported = () => hasFeature(features, FEATURE_DROP) && typeof globalThis.dshDesktop?.fileDrag?.getPathForFile === 'function'
    const hasFileDrag = e => e.dataTransfer?.types?.includes('Files') === true
    const bindDrop = (target, position, pointer, window) => {
      on(target, 'dragenter', e => {
        if (!dropEnabled || !dropSupported() || !hasFileDrag(e)) return
        e.preventDefault(); e.stopPropagation()
        target.classList.add('g101-drag')
      })
      on(target, 'dragover', e => {
        if (!dropEnabled || !dropSupported() || !hasFileDrag(e)) return
        e.preventDefault(); e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
      })
      on(target, 'dragleave', e => {
        if (!hasFileDrag(e)) return
        target.classList.remove('g101-drag')
      })
      on(target, 'drop', e => {
        target.classList.remove('g101-drag')
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
        if (paths.length > 0) input(withWindow({ type: 'drop', ...position(e), paths }, window))
      })
    }
    const bindLayerInput = layer => {
      const element = layer.canvas
      const position = positionOn(element, () => layer.appliedSurface, () => false)
      const pointer = pointerOn(element, () => layer.appliedSurface, () => false, layer.window)
      // The host UI must not interpret gestures that start inside the layer.
      on(element, 'contextmenu', e => { e.preventDefault(); e.stopPropagation() })
      on(element, 'selectstart', e => { e.preventDefault(); e.stopPropagation() })
      on(element, 'dragstart', e => { e.preventDefault(); e.stopPropagation() })
      on(element, 'pointerdown', e => {
        e.stopPropagation()
        focusedWindow = layer.window
        element.focus()
        pointer(e, 'down')
        element.setPointerCapture(e.pointerId)
        pushClipboard() // warm the engine-side clipboard cache for paste
      })
      on(element, 'focus', () => { focusedWindow = layer.window; input(withWindow({ type: 'focus', focused: true }, layer.window)) })
      on(element, 'blur', () => { if (document.activeElement !== imeElement) focusLost(layer.window) })
      on(element, 'pointermove', e => pointer(e, 'move'))
      on(element, 'pointerup', e => { e.stopPropagation(); pointer(e, 'up'); if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId) })
      on(element, 'pointercancel', e => pointer(e, 'cancel'))
      on(element, 'lostpointercapture', e => { if (e.buttons !== 0) pointer(e, 'cancel') })
      on(element, 'wheel', e => {
        e.preventDefault()
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? element.clientHeight : 1
        input(withWindow({ type: 'wheel', ...position(e), deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, modifiers: modifiers(e) }, layer.window))
      }, { passive: false })
      bindKeyboard(element)
      bindDrop(element, position, pointer, layer.window)
    }
    // Key/text/IME handlers route to the currently focused engine window.
    const key = (e, down) => {
      e.preventDefault(); e.stopPropagation()
      if (down && composing && e.key === 'Escape') compositionCancelled = true
      if (e.keyCode === 229 || composing) return // IME owns the keystroke
      const printable = down && !e.repeat && e.key?.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
      input(withWindow({
        type: 'key', code: e.code, down, repeat: e.repeat, modifiers: modifiers(e),
        ...(hasFeature(features, FEATURE_TEXT) && printable ? { key: e.key } : {}),
      }, focusedWindow))
    }
    const handleCompositionStart = () => { composing = true; compositionCancelled = false; input(withWindow({ type: 'ime', state: 'start', text: '' }, focusedWindow)) }
    const handleCompositionUpdate = e => input(withWindow({ type: 'ime', state: 'update', text: e.data ?? '' }, focusedWindow))
    const handleCompositionEnd = e => {
      composing = false
      input(withWindow({ type: 'ime', state: compositionCancelled ? 'cancel' : 'commit', text: e.data ?? '' }, focusedWindow))
      compositionCancelled = false
      if (imeElement) imeElement.value = ''
    }
    const handleBeforeInput = e => {
      if (e.isComposing || typeof e.data !== 'string' || e.data.length === 0) return
      if (!e.inputType?.startsWith('insert')) return
      input(withWindow({ type: 'text', text: e.data }, focusedWindow))
    }
    const bindKeyboard = target => {
      on(target, 'keydown', e => key(e, true)); on(target, 'keyup', e => key(e, false))
      if (textIme) {
        on(target, 'compositionstart', handleCompositionStart)
        on(target, 'compositionupdate', handleCompositionUpdate)
        on(target, 'compositionend', handleCompositionEnd)
        on(target, 'beforeinput', handleBeforeInput)
      }
    }
    const textIme = hasFeature(features, FEATURE_TEXT) && hasFeature(features, FEATURE_IME)
    const pointer = pointerOn(canvas, () => appliedSurface, () => resizeScheduler.hasPending(), 0)
    // The host UI must not interpret gestures that start inside the viewport:
    // kill the browser's own context menu/text selection/drag and keep the
    // events from reaching sidebar splitters etc.
    on(canvas, 'contextmenu', e => { e.preventDefault(); e.stopPropagation() })
    on(canvas, 'selectstart', e => { e.preventDefault(); e.stopPropagation() })
    on(canvas, 'dragstart', e => { e.preventDefault(); e.stopPropagation() })
    on(canvas, 'pointerdown', e => {
      e.stopPropagation()
      focusedWindow = 0
      canvas.focus()
      pointer(e, 'down')
      canvas.setPointerCapture(e.pointerId)
      pushClipboard() // warm the engine-side clipboard cache for paste
    })
    on(canvas, 'pointermove', e => pointer(e, 'move'))
    on(canvas, 'pointerup', e => { e.stopPropagation(); pointer(e, 'up'); if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId) })
    on(canvas, 'pointercancel', e => pointer(e, 'cancel'))
    on(canvas, 'lostpointercapture', e => { if (e.buttons !== 0) pointer(e, 'cancel') })
    on(canvas, 'wheel', e => {
      e.preventDefault()
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1
      input({ type: 'wheel', ...positionOn(canvas, () => appliedSurface, () => resizeScheduler.hasPending())(e), deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, modifiers: modifiers(e) })
    }, { passive: false })
    // File-drop intent routing (default-on option): while enabled, a file
    // drag over the viewport is claimed for Godot — the surrounding DSH app
    // (document-level drop listeners) never sees it. When disabled, drops
    // fall through to the host import flow unchanged.
    bindDrop(canvas, positionOn(canvas, () => appliedSurface, () => resizeScheduler.hasPending()), pointer, 0)
    bindKeyboard(canvas)
    // ---- clipboard bridge (protocol v2.1) ----
    const pushClipboard = () => {
      if (!multiWindow()) return
      navigator.clipboard?.readText?.()
        .then(text => viewportExtension('clipboard', { text }))
        .catch(() => {}) // permission denied or no clipboard yet: keep the cache
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
    // Engine-physical px -> css px against the applied surface, then positioned
    // inside the canvas parent so the OS composition window anchors at the
    // engine caret (the same trick Godot's own web export uses). Protocol
    // v2.1: coordinates are window-local; add the owning layer's offset.
    const handleImeState = payload => {
      if (typeof payload?.active !== 'boolean') return
      imeActive = payload.active
      if (!imeActive) {
        composing = false
        if (imeElement) { imeElement.style.display = 'none'; imeElement.value = '' }
        return
      }
      const window = payload.window ?? 0
      const layer = window !== 0 ? layers.get(window) : undefined
      const target = window !== 0 ? layer?.canvas : canvas
      if (!target) return
      const host = ensureImeElement()
      if (!host.isConnected) return
      const surface = window !== 0 ? layer.appliedSurface : appliedSurface
      const cssX = surface ? payload.x * (surface.cssWidth / surface.width) : payload.x / factors.mapScaleX
      const cssY = surface ? payload.y * (surface.cssHeight / surface.height) : payload.y / factors.mapScaleY
      host.style.display = ''
      host.style.left = `${target.offsetLeft + cssX}px`
      host.style.top = `${target.offsetTop + cssY}px`
      if (document.activeElement !== host) host.focus({ preventScroll: true })
    }
    removeEvent = api.onEvent(generation, event => {
      if (event.type === 'extension' && event.namespace === 'godot.viewport.v1' && event.name === 'imeState') {
        handleImeState(event.payload)
        return
      }
      if (event.type === 'extension' && event.namespace === 'godot.viewport.v1' && event.name === 'clipboardWrite') {
        const text = event.payload?.text
        if (typeof text === 'string' && navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {})
        return
      }
      if (event.type === 'extension' && event.namespace === 'godot.viewport.v1' && event.name === 'clipboardRead') {
        pushClipboard()
        return
      }
      if (event.type === 'extension' && event.namespace === 'godot.window.v1') {
        dlog('event window.' + event.name, event.payload)
        if (!multiWindow()) return
        const payload = event.payload ?? {}
        if (event.name === 'focus' && typeof payload.window === 'number') {
          focusedWindow = payload.focused ? payload.window : (focusedWindow === payload.window ? 0 : focusedWindow)
        }
        layerStates = reduceWindowEvent(layerStates, event.name, payload)
        if (event.name === 'destroyed') {
          destroyLayer(payload.window)
          return
        }
        const state = layerStates.get(payload.window)
        if (state) syncLayer(state)
        return
      }
      if (event.type === 'extension' && event.namespace === 'godot.editor.v1') {
        dlog('event editor.' + event.name, event.payload)
        handleEditorEvent(event.name, event.payload)
        return
      }
      if (event.type === 'surface') {
        // The applied-geometry receipt: while a resize is pending the engine
        // still renders the old surface; transientRemap keeps hits correct
        // against the stretched presentation. css fields ride along with
        // interaction.map.v2; without them the surface is physical-only.
        const window = event.window ?? 0
        if (window !== 0) {
          dlog('surface receipt', { window, width: event.width, height: event.height, cssWidth: event.cssWidth, cssHeight: event.cssHeight })
          const layer = layers.get(window)
          if (layer && event.width > 0 && event.height > 0) {
            layer.appliedSurface = { width: event.width, height: event.height, cssWidth: event.width, cssHeight: event.height }
          }
          return
        }
        dlog('surface receipt', { window: 0, width: event.width, height: event.height, cssWidth: event.cssWidth, cssHeight: event.cssHeight, scale: event.scale, epoch: event.epoch })
        resizeScheduler.acknowledge(event)
        if (event.width > 0 && event.height > 0) {
          factors = engineMapFactors({ width: event.width, height: event.height,
            cssWidth: event.cssWidth, cssHeight: event.cssHeight, scale: event.scale })
          for (const layer of layers.values()) applyLayerGeometry(layer)
          gameSession?.applyGeometry()
        }
        appliedSurface = mapV2() && event.width > 0 && event.height > 0
          ? { width: event.width, height: event.height, cssWidth: event.cssWidth ?? event.width, cssHeight: event.cssHeight ?? event.height }
          : null
        return
      }
      if (event.type === 'error') { dlog('session error', { message: event.message }); status(event.message); dispose().catch(error => status(error.message)) }
      if (event.type === 'disposed' && !canceled) { dlog('session disposed', { generation: event.generation }); status('Native viewport disposed'); dispose().catch(error => status(error.message)) }
    })
    on(canvas, 'focus', () => { focusedWindow = 0; input(withWindow({ type: 'focus', focused: true }, 0)) })
    on(canvas, 'blur', () => { if (document.activeElement !== imeElement) focusLost(focusedWindow) })
    on(window, 'blur', () => focusLost(focusedWindow))
    on(document, 'visibilitychange', () => {
      const value = shown && !document.hidden
      control({ kind: 'visible', value })
      if (gameSession?.generation) api.control(gameSession.generation, { kind: 'visible', value })
      if (document.hidden) focusLost(focusedWindow)
    })
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
    if (!canceled) dlog('dispose', { producerId, frames, layers: [...layers.keys()] })
    canceled = true
    signal.removeEventListener('abort', abort)
    resizeScheduler.cancel()
    if (imeElement) { imeElement.blur(); imeElement.remove(); imeElement = null }
    if (document.pointerLockElement === canvas) document.exitPointerLock?.()
    listeners.forEach(remove => remove()); resizeObserver?.disconnect()
    await stopGame()
    const retiringLayers = [...layers.values()]
    layers.clear()
    for (const layer of retiringLayers) {
      await layer.presentQueue
      if (layer.gpu) await layer.gpu.device.queue.onSubmittedWorkDone().catch(() => {})
      layer.gpu?.device.destroy()
      layer.canvas.remove()
    }
    await startPromise?.catch(() => {})
    await mainPresentQueue
    if (device) await device.queue.onSubmittedWorkDone().catch(() => {})
    if (generation) await api.dispose(generation)
    removeFrame?.(); removeEvent?.(); context?.unconfigure(); device?.destroy()
  })()
  const abort = () => { dispose().catch(error => status(error.message)) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) canceled = true
  return { start, dispose, extension, visible, lock: setRelativeMouseMode, features: () => features, setDropPreference: value => { dropEnabled = value !== false } }
}
