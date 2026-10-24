const api = window.graphics101
const $ = id => document.getElementById(id)
const canvas = $('viewport')
let seq = 0, frames = 0, session, lastApplied = 0, dragging = false, lastX = 0, lastY = 0
let smokeInput = 0, smokeFinished = false, resizeRequests = 0, smokeTimer
const epochs = new Set()
const inputTimes = new Map()
function input(command, data = {}) {
  ++seq
  inputTimes.set(seq, performance.now())
  if (inputTimes.size > 256) inputTimes.delete(inputTimes.keys().next().value)
  if (command === 'reset' || command === 'rotate') api.control({ kind: 'extension', seq, namespace: 'graphics101.camera.v1', name: command, payload: command === 'reset' ? null : data })
  else {
    const event = command === 'focus' ? { type: 'focus', focused: false }
      : command === 'key' ? { type: 'key', code: data.code === 32 ? 'Space' : `Key${String.fromCharCode(data.code)}`, down: data.down, repeat: false, modifiers: 0 }
      : command === 'dolly' ? { type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: -data.delta * 100, modifiers: 0 }
      : { type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: lastX + data.x, y: lastY + data.y, buttons: 1, button: -1, modifiers: 0 }
    if (command === 'orbit') api.control({ kind: 'input', seq: seq++, event: { ...event, phase: 'down', button: 0, x: lastX, y: lastY } })
    api.control({ kind: 'input', seq, event })
    if (command === 'orbit') api.control({ kind: 'input', seq: ++seq, event: { ...event, phase: 'up', button: 0, buttons: 0 } })
  }
  return seq
}
function log(text) { $('log').textContent = `${text}\n${$('log').textContent}`.slice(0, 2400) }
function error(message) { $('status').textContent = 'error'; $('overlay').hidden = false; $('overlay').style.display = 'grid'; $('overlay').textContent = message; api.reportError(message) }
function resize() {
  const rect = canvas.getBoundingClientRect(), scale = Math.min(devicePixelRatio, 2048 / Math.max(rect.width, rect.height))
  api.control({ kind: 'resize', width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) })
}
function visible() { api.control({ kind: 'visible', value: !document.hidden && !$('pause').checked }) }
api.onEvent(event => {
  if (event.type === 'engine') { $('gpu').textContent = event.gpu; log(`native ${event.backend}; GPU copy ${event.exportGpuCopies}`) }
  if (event.type === 'surface') { $('size').textContent = `${event.width} × ${event.height} · epoch ${event.epoch}`; log(`surface epoch ${event.epoch}`) }
  if (event.type === 'stats') $('leases').textContent = `offer ${event.offered} / release ${event.released}\n丢帧 ${event.dropped} / 超时 ${event.leaseTimeouts}\nvalidation ${event.validationErrors}`
  if (event.type === 'error') { $('status').textContent = 'error'; $('overlay').style.display = 'grid'; $('overlay').textContent = event.message; log(event.message) }
  if (event.type === 'log') log(event.message)
})
$('reset').onclick = () => { input('reset'); $('rotate').checked = true }
$('rotate').onchange = () => input('rotate', { value: $('rotate').checked })
$('pause').onchange = visible
$('fullscreen').onclick = () => $('viewport-wrap').requestFullscreen()
canvas.onpointerdown = event => { if (event.button !== 0) return; canvas.focus(); dragging = true; lastX = event.clientX; lastY = event.clientY; canvas.setPointerCapture(event.pointerId) }
canvas.onpointermove = event => { if (dragging) { input('orbit', { x: event.clientX - lastX, y: event.clientY - lastY }); lastX = event.clientX; lastY = event.clientY } }
canvas.onpointerup = event => { dragging = false; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId) }
canvas.onpointercancel = canvas.onlostpointercapture = () => { dragging = false }
canvas.onwheel = event => { event.preventDefault(); input('dolly', { delta: -event.deltaY / 100 }) }
function keyboard(event, down) {
  const code = event.code === 'Space' ? 32 : event.code.startsWith('Key') ? event.code.charCodeAt(3) : 0
  if (![32,65,68,69,81,82,83,87].includes(code) || event.repeat) return
  event.preventDefault(); input('key', { code, down })
  if (down && code === 32) $('rotate').checked = !$('rotate').checked
  if (down && code === 82) $('rotate').checked = true
}
canvas.onkeydown = event => keyboard(event, true)
canvas.onkeyup = event => keyboard(event, false)
canvas.onblur = window.onblur = () => { dragging = false; input('focus') }
document.onvisibilitychange = () => { if (document.hidden) input('focus'); visible() }
window.addEventListener('error', event => error(event.message))
window.addEventListener('unhandledrejection', event => error(String(event.reason)))

async function start() {
  if (!navigator.gpu) throw new Error('WebGPU unavailable; no CPU fallback')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('No WebGPU adapter')
  const device = await adapter.requestDevice()
  device.lost.then(info => error(`WebGPU device lost: ${info.message}`))
  device.addEventListener('uncapturederror', event => error(event.error.message))
  const context = canvas.getContext('webgpu'), format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })
  const module = device.createShaderModule({ code: `
struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let p = array<vec2<f32>, 3>(vec2(-1,-1),vec2(3,-1),vec2(-1,3));
  var o: Out; o.position = vec4(p[i],0,1); o.uv = vec2(p[i].x*0.5+0.5,0.5-p[i].y*0.5); return o;
}
@group(0) @binding(0) var tex: texture_external;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(o: Out) -> @location(0) vec4<f32> { return vec4(textureSampleBaseClampToEdge(tex,smp,o.uv).rgb,1); }` })
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] })
  const pipeline = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } })
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  api.onFrame(async (frame, meta) => {
    if (meta.generation !== session?.generation) throw new Error('Stale session generation')
    if (canvas.width !== meta.width) canvas.width = meta.width
    if (canvas.height !== meta.height) canvas.height = meta.height
    const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: device.importExternalTexture({ source: frame }) }, { binding: 1, resource: sampler }] })
    const encoder = device.createCommandEncoder()
    const texture = context.getCurrentTexture()
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0,0,0,1] }] })
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end()
    device.queue.submit([encoder.finish()])
    frames++; lastApplied = meta.inputSeq; epochs.add(meta.epoch)
    if (session.smoke && frames >= 30 && frames < 130) {
      api.control({ kind: 'resize', width: 640 + (frames % 7) * 20, height: 480 + (frames % 5) * 20 })
      resizeRequests++
    }
    if (session.smoke && frames === 130) resize()
    $('frames').textContent = `${frames} 帧 · inputSeq ${meta.inputSeq}`
    $('overlay').style.display = 'none'; $('status').textContent = 'running'
    if (inputTimes.has(meta.inputSeq)) { $('timing').textContent = `input-to-submit ${(performance.now() - inputTimes.get(meta.inputSeq)).toFixed(1)} ms`; inputTimes.delete(meta.inputSeq) }
    if (session.smoke && frames === 20) { input('rotate', { value: false }); smokeInput = input('orbit', { x: 30, y: 10 }) }
    if (session.smoke && frames >= 1500 && !smokeFinished) {
      smokeFinished = true
      clearTimeout(smokeTimer)
      const row = Math.ceil(meta.width * 4 / 256) * 256
      const buffer = device.createBuffer({ size: row * meta.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      const capture = device.createCommandEncoder()
      capture.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, { width: meta.width, height: meta.height })
      device.queue.submit([capture.finish()])
      await buffer.mapAsync(GPUMapMode.READ)
      const bytes = new Uint8Array(buffer.getMappedRange())
      let rgbPixels = 0
      const dominantPixels = [0, 0, 0]
      for (let y = 0; y < meta.height; y++) for (let x = 0; x < meta.width; x++) {
        const offset = y * row + x * 4
        if (Math.max(bytes[offset], bytes[offset+1], bytes[offset+2]) - Math.min(bytes[offset], bytes[offset+1], bytes[offset+2]) > 80) rgbPixels++
        for (let channel = 0; channel < 3; channel++) if (bytes[offset+channel] > bytes[offset+(channel+1)%3] + 30 && bytes[offset+channel] > bytes[offset+(channel+2)%3] + 30) dominantPixels[channel]++
      }
      buffer.unmap(); buffer.destroy()
      api.smokeDone({ frames, rgbPixels, dominantPixels, resizeRequests, epochs: epochs.size, inputApplied: lastApplied >= smokeInput && smokeInput > 0, diagnosticReadbacks: 1, runtimeCpuReadbacks: 0 })
    }
    await device.queue.onSubmittedWorkDone()
  })
  session = await api.hello({ ...api.capabilities, webgpu: true })
  if (session.smoke) context.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  $('backend').textContent = session.backend
  log(session.adapterMatch)
  if (session.smoke) smokeTimer = setTimeout(() => error('Renderer smoke did not reach 1500 frames'), 110000)
  new ResizeObserver(resize).observe(canvas)
  resize(); visible()
}
start().catch(e => error(e.message))
