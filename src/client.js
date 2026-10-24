import { createElement as h, useEffect, useRef, useState } from 'react'

export const inject = ['slots', 'locale', 'sidebarRightTabs']
// This package can ship two producers: the runtime demo worker and the editor
// worker (`godot:stage:editor`). The panel discovers them through
// `nativeViewports.list()` and switches with the mode selector; the tab
// registration itself stays a single sidebar entry.
const RUNTIME_PRODUCER = 'dsh-godot-plugin/godot'
const EDITOR_PRODUCER = 'dsh-godot-plugin/godot-editor'
const tabId = RUNTIME_PRODUCER
const dictionaries = {
  en: { title: 'Godot viewport', description: 'Native Godot 3D viewport (Vulkan)', unsupported: 'Requires Windows x64 and DSH native viewport preview fork', start: 'Start', stop: 'Stop', reset: 'Reset camera', rotate: 'Rotation', help: 'Drag: orbit · Wheel: dolly · WASD / QE: move · R: reset · Space: rotation', starting: 'Starting', running: 'Running', stopped: 'Stopped', fullscreen: 'Fullscreen', mode: 'Mode', runtime: 'Runtime', editor: 'Editor', restartHost: 'Restart Host', restartConfirm: 'Restart the app and Host now?' },
  zh: { title: 'Godot 视口', description: '原生 Godot 3D 视口（Vulkan）', unsupported: '需要 Windows x64 与支持原生视口的 DSH 预览 fork', start: '启动', stop: '停止', reset: '重置相机', rotate: '旋转', help: '拖动环绕 · 滚轮缩放 · WASD / QE 移动 · R 重置 · Space 旋转', starting: '启动中', running: '运行中', stopped: '已停止', fullscreen: '全屏', mode: '模式', runtime: '运行时', editor: '编辑器', restartHost: '重启 Host', restartConfirm: '立即重启应用与 Host？' },
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
    style.textContent = `.g101-root{height:100%;min-height:0;display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box}.g101-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.g101-canvas{width:100%;height:100%;min-height:100px;display:block;background:#10131b;outline-offset:-3px}.g101-wrap{flex:1;min-height:0;position:relative}.g101-status{font:12px monospace;overflow-wrap:anywhere}.g101-root button{padding:4px 10px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.g101-tools select{padding:3px 6px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit}.g101-help{font-size:12px;opacity:.7}.g101-wrap:fullscreen{background:#10131b}`
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
    const controller = mountViewport(api, canvas.current, tab.signal, report, producerId)
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
      h('button', { onClick: () => wrap.current.requestFullscreen().catch(error => setStatus(error.message)) }, t('fullscreen'))),
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

function mountViewport(api, canvas, signal, status, producerId) {
  let generation, device, context, canceled = false, seq = 0, shown = true
  let frames = 0, removeFrame, removeEvent, resizeObserver, cleanupPromise
  const listeners = []
  const on = (target, event, callback, options) => { target.addEventListener(event, callback, options); listeners.push(() => target.removeEventListener(event, callback, options)) }
  const control = data => { if (generation) api.control(generation, data) }
  const input = event => control({ kind: 'input', seq: ++seq, event })
  const extension = (name, payload = null) => control({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name, payload })
  const focusLost = () => input({ type: 'focus', focused: false })
  const visible = value => { shown = value; control({ kind: 'visible', value }); if (!value) focusLost() }
  const resize = () => {
    const rect = canvas.getBoundingClientRect(), scale = Math.min(devicePixelRatio, 2048 / Math.max(1, rect.width, rect.height))
    control({ kind: 'resize', width: Math.round(rect.width * scale), height: Math.round(rect.height * scale), scale })
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
    removeEvent = api.onEvent(generation, event => {
      if (event.type === 'error') { status(event.message); dispose().catch(error => status(error.message)) }
      if (event.type === 'disposed' && !canceled) { status('Native viewport disposed'); dispose().catch(error => status(error.message)) }
    })
    const modifiers = e => Number(e.shiftKey) | Number(e.ctrlKey) << 1 | Number(e.altKey) << 2 | Number(e.metaKey) << 3
    const position = e => { const rect = canvas.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top } }
    const pointer = (e, phase) => input({ type: 'pointer', phase, pointerId: e.pointerId, pointerType: e.pointerType, ...position(e), buttons: e.buttons, button: e.button, modifiers: modifiers(e) })
    on(canvas, 'pointerdown', e => { canvas.focus(); pointer(e, 'down'); canvas.setPointerCapture(e.pointerId) })
    on(canvas, 'pointermove', e => pointer(e, 'move'))
    on(canvas, 'pointerup', e => { pointer(e, 'up'); if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId) })
    on(canvas, 'pointercancel', e => pointer(e, 'cancel'))
    on(canvas, 'lostpointercapture', e => pointer(e, 'cancel'))
    on(canvas, 'wheel', e => {
      e.preventDefault()
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1
      input({ type: 'wheel', ...position(e), deltaX: e.deltaX * scale, deltaY: e.deltaY * scale, modifiers: modifiers(e) })
    }, { passive: false })
    const key = (e, down) => {
      e.preventDefault(); e.stopPropagation()
      input({ type: 'key', code: e.code, down, repeat: e.repeat, modifiers: modifiers(e) })
    }
    on(canvas, 'keydown', e => key(e, true)); on(canvas, 'keyup', e => key(e, false))
    on(canvas, 'focus', () => input({ type: 'focus', focused: true }))
    on(canvas, 'blur', focusLost)
    on(window, 'blur', focusLost)
    on(document, 'visibilitychange', () => { control({ kind: 'visible', value: shown && !document.hidden }); if (document.hidden) focusLost() })
    resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas)
    resize(); visible(shown)
  })()
  const dispose = () => cleanupPromise ??= (async () => {
    canceled = true
    signal.removeEventListener('abort', abort)
    listeners.forEach(remove => remove()); resizeObserver?.disconnect()
    await startPromise?.catch(() => {})
    if (device) await device.queue.onSubmittedWorkDone().catch(() => {})
    if (generation) await api.dispose(generation)
    removeFrame?.(); removeEvent?.(); context?.unconfigure(); device?.destroy()
  })()
  const abort = () => { dispose().catch(error => status(error.message)) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) canceled = true
  return { start, dispose, extension, visible }
}
