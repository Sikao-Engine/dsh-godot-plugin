const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const root = path.resolve(__dirname, '../..')
const smoke = process.argv.includes('--smoke')
const generation = require('node:crypto').randomUUID()
const pagePath = path.resolve(__dirname, 'index.html').toLowerCase()
let win, worker, ready = false, closing = false, queued = null, failed = false
let inputSeq = 0, activeGPU, engine, surface, stopped, workerExit
const leases = new Map()
const stats = { offered: 0, delivered: 0, released: 0, dropped: 0, leaseTimeouts: 0, gpuExits: 0, validationErrors: 0, runtimeCpuReadbacks: 0, exportGpuCopies: 0 }
let summary, drainResolve
app.setPath('userData', path.join(root, '.graphics101-results/electron-profile'))
function event(type, data) { if (win && !win.isDestroyed()) win.webContents.send('g101:event', { type, ...data }) }
function send(line) { if (worker?.stdin.writable) worker.stdin.write(line + '\n') }
function key(frame) { return `${generation}:${frame.epoch}:${frame.slot}:${frame.frameId}` }
function trusted(e) {
  if (e.sender !== win?.webContents || e.senderFrame !== win.webContents.mainFrame) return false
  try {
    const url = new URL(e.senderFrame.url)
    return url.protocol === 'file:' && !url.search && !url.hash && path.resolve(fileURLToPath(url)).toLowerCase() === pagePath
  } catch { return false }
}
function release(frame) { send(JSON.stringify({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId })) }
function fail(error) {
  if (failed || closing) return
  failed = true; ready = false
  console.error(error)
  event('error', { message: String(error.message ?? error) })
  if (queued) { release(queued); queued = null }
  send(JSON.stringify({ kind: 'visible', value: false }))
  drainResolve?.()
  if (smoke) shutdown(1)
}
function deliver(frame) {
  let imported
  try {
    const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(frame.handle))
    imported = sharedTexture.subtle.importSharedTexture({ pixelFormat: 'rgba', codedSize: { width: frame.width, height: frame.height }, timestamp: frame.timestampUs, handle: { ntHandle: handle } })
    if (typeof imported.startTransferSharedTexture !== 'function') throw new Error('Imported texture has no startTransferSharedTexture')
    const transfer = imported.startTransferSharedTexture()
    const ticket = { generation, epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId, width: frame.width, height: frame.height, inputSeq: frame.inputSeq }
    const timer = setTimeout(() => { stats.leaseTimeouts++; fail(new Error('GPU lease timeout; texture will not be reused')) }, 5000)
    leases.set(key(frame), { frame, imported, timer })
    win.webContents.send('g101:frame', ticket, transfer)
    stats.delivered++
  } catch (error) {
    imported?.release()
    fail(error)
  }
}
function offer(frame) {
  stats.offered++
  if (!ready || failed || closing) { release(frame); stats.dropped++; return }
  if (leases.size >= 2) {
    if (queued) { release(queued); stats.dropped++ }
    queued = frame
  } else deliver(frame)
}
async function shutdown(code = 0) {
  if (closing) return
  closing = true; ready = false
  console.log(`[graphics101] stopping: code=${code} frames=${stats.delivered}`)
  clearTimeout(smokeTimeout)
  if (queued) { release(queued); queued = null }
  send(JSON.stringify({ kind: 'visible', value: false }))
  if (!failed && leases.size) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1500)
      drainResolve = () => { clearTimeout(timer); resolve() }
    })
    drainResolve = null
  }
  if (win && !win.isDestroyed()) win.destroy()
  for (const rec of leases.values()) { clearTimeout(rec.timer); rec.imported.release() }
  leases.clear()
  send(JSON.stringify({ kind: 'stop' }))
  worker?.stdin.end()
  const killTimer = setTimeout(() => worker?.kill(), 3000)
  if (stopped) await stopped
  clearTimeout(killTimer)
  if (worker && (!workerExit || workerExit.code !== 0 || stats.validationErrors || stats.released !== stats.delivered)) code = 1
  if (smoke) {
    mkdirSync(path.join(root, '.graphics101-results'), { recursive: true })
    const report = { electron: process.versions.electron, generation, engine, surface, stats, summary, workerExit, exitCode: code }
    writeFileSync(path.join(root, '.graphics101-results/electron-smoke.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  }
  app.exit(code)
}
let smokeTimeout
app.on('child-process-gone', (_e, details) => { if (details.type === 'GPU') { stats.gpuExits++; fail(new Error(`GPU process gone: ${details.reason}`)) } })
app.on('window-all-closed', () => {})
app.on('before-quit', e => { if (!closing) { e.preventDefault(); shutdown(failed ? 1 : 0) } })
ipcMain.handle('g101:hello', async (e, caps) => {
  if (!trusted(e)) throw new Error('Untrusted viewport sender')
  if (ready || worker) throw new Error('Session already attached')
  if (!caps.webgpu || !caps.sharedTexture || !caps.sandboxed || !caps.contextIsolated || process.versions.electron !== '44.7.0') throw new Error('Required sandbox/WebGPU/Electron 44.7.0 capabilities absent')
  ready = true
  const gpu = await app.getGPUInfo('complete')
  activeGPU = gpu.gpuDevice.find(x => x.active)
  worker = spawn(path.join(root, 'native/graphics101/build/Release/graphics101.exe'), ['--shared-output', '--broker-pid', String(process.pid), '--validation'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  stopped = new Promise(resolve => {
    worker.once('error', resolve)
    worker.once('exit', (code, signal) => {
      workerExit = { code, signal }
      if (!closing) fail(new Error(`Native worker exited: ${code ?? signal}`))
      resolve()
    })
  })
  worker.once('error', fail)
  worker.stderr.on('data', data => { console.error(String(data)); event('log', { message: String(data) }) })
  createInterface({ input: worker.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line)
      if (message.type === 'hello') {
        engine = message
        if (activeGPU && (activeGPU.vendorId !== message.vendorId || activeGPU.deviceId !== message.deviceId)) throw new Error('Chromium/Vulkan adapter IDs differ; no silent fallback')
        event('engine', message)
      } else if (message.type === 'frame') offer(message)
      else if (message.type === 'surface') { surface = message; event('surface', message) }
      else if (message.type === 'stats' || message.type === 'stopped') { stats.validationErrors = message.validationErrors; event('stats', { ...stats, inputSeq: message.inputSeq }); if (message.validationErrors) fail(new Error('Vulkan validation error')) }
    } catch (error) { fail(error) }
  })
  return { generation, electron: process.versions.electron, backend: 'Vulkan → D3D11 NT texture → sharedTexture → VideoFrame → WebGPU', adapterMatch: 'vendor/device IDs checked; Chromium LUID unavailable', smoke }
})
ipcMain.on('g101:control', (e, data) => {
  if (!trusted(e) || !worker || failed || closing) return
  if (data.kind === 'input' || data.kind === 'extension') {
    if (!Number.isSafeInteger(data.seq) || data.seq <= inputSeq) return
    inputSeq = data.seq
  }
  send(JSON.stringify(data))
})
ipcMain.on('g101:done', (e, ticket) => {
  if (!trusted(e) || ticket.generation !== generation) return
  const rec = leases.get(key(ticket))
  if (!rec) return
  leases.delete(key(ticket)); clearTimeout(rec.timer)
  rec.imported.release(); release(rec.frame); stats.released++
  if (!leases.size) drainResolve?.()
  if (queued && ready && !failed) { const next = queued; queued = null; deliver(next) }
})
ipcMain.on('g101:error', (e, message) => { if (trusted(e)) fail(new Error(String(message))) })
ipcMain.on('g101:smoke', (e, report) => {
  if (!trusted(e) || !smoke) return
  summary = report
  shutdown(report.frames >= 1500 && report.rgbPixels > 100 && report.dominantPixels?.every(count => count > 100) && report.resizeRequests === 100 && report.epochs > 1 && report.inputApplied && !stats.validationErrors && !stats.gpuExits && !stats.leaseTimeouts ? 0 : 1)
})
app.whenReady().then(async () => {
  console.log(`[graphics101] Electron ${process.versions.electron}; smoke=${smoke}`)
  win = new BrowserWindow({ width: 1200, height: 800, minWidth: 760, minHeight: 520, backgroundColor: '#10131b', title: 'Graphics101 · Electron native viewport', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.on('render-process-gone', (_e, details) => fail(new Error(`Renderer gone: ${details.reason}`)))
  win.on('close', e => { if (!closing) { e.preventDefault(); shutdown(failed ? 1 : 0) } })
  win.on('minimize', () => send(JSON.stringify({ kind: 'visible', value: false })))
  win.on('restore', () => send(JSON.stringify({ kind: 'visible', value: true })))
  if (smoke) smokeTimeout = setTimeout(() => fail(new Error('Electron smoke timeout')), 120000)
  await win.loadFile(path.join(__dirname, 'index.html'))
}).catch(fail)
