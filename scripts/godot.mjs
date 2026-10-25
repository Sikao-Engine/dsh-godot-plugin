// DSH Godot worker toolchain:
//   build   - compile the forked engine with scons (dsh_viewport=yes)
//   stage   - post-process: copy the worker binary into native/win32-x64 and
//             regenerate runtime-manifest.json (SHA-256, toolchain, protocol)
//   verify  - run the staged worker against an in-process fake broker that
//             speaks wire protocol 2 over stdin/stdout (no Electron needed)
//   doctor  - report toolchain availability
// Usage: node scripts/godot.mjs build|stage|verify|doctor [-- <extra scons args>]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const godotDir = join(root, 'godot')
const outDir = join(root, 'native/win32-x64')
const workerName = 'dsh-godot-worker.exe'
const editorWorkerName = 'dsh-godot-editor.exe'
const target = process.env.DSH_GODOT_TARGET ?? 'template_release'
const editorMode = process.argv.includes('--editor')
const activeTarget = editorMode || process.env.DSH_GODOT_TARGET === 'editor' ? 'editor' : target
const binaryFor = t => join(godotDir, 'bin', `godot.windows.${t}.x86_64.exe`)
const binary = binaryFor(target)
const manifestPath = join(root, editorMode ? 'runtime-manifest.editor.json' : 'runtime-manifest.json')
const action = process.argv[2]
const extraArgs = process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : []
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, ...options })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.error?.message ?? output}`)
  return output.trim()
}
const git = (...args) => run('git', ['-C', godotDir, ...args])
const json = file => JSON.parse(readFileSync(file, 'utf8'))

function sconsCommand() {
  const probe = spawnSync('python', ['-m', 'SCons', '--version'], { encoding: 'utf8' })
  if (!probe.error && probe.status === 0) return { command: 'python', args: ['-m', 'SCons'] }
  const prefix = spawnSync('python', ['-c', 'import sys, os; print(os.path.join(os.path.dirname(sys.executable), "Scripts"))'], { encoding: 'utf8' })
  if (!prefix.error && prefix.status === 0) {
    const candidate = join(prefix.stdout.trim(), 'scons.exe')
    if (existsSync(candidate)) return { command: candidate, args: [] }
  }
  const direct = spawnSync('scons', ['--version'], { encoding: 'utf8' })
  if (!direct.error && direct.status === 0) return { command: 'scons', args: [] }
  return null
}

function doctor() {
  const report = { platform: process.platform, arch: process.arch, node: process.version }
  report.python = run('python', ['--version']).split('\n').pop()
  const scons = sconsCommand()
  report.scons = scons ? run(scons.command, [...scons.args, '--version']).split('\n')[0] : 'MISSING (python -m pip install scons)'
  const cl = spawnSync('where', ['cl'], { encoding: 'utf8' })
  report.msvc = cl.status === 0 ? cl.stdout.trim().split('\n')[0] : 'not on PATH (scons locates MSVC itself; needs VS 2022+ Build Tools + Windows SDK)'
  report.windowsSdk = existsSync('C:/Program Files (x86)/Windows Kits/10/bin') ? 'present' : 'MISSING'
  report.godotCommit = git('rev-parse', 'HEAD')
  report.godotBranch = git('branch', '--show-current')
  report.workerBinary = existsSync(binary) ? `${binary} (${(statSync(binary).size / 1024 / 1024).toFixed(1)} MiB)` : 'not built yet'
  report.stagedWorker = existsSync(join(outDir, workerName)) ? 'staged' : 'not staged'
  console.log(JSON.stringify(report, null, 2))
  if (!scons) process.exitCode = 1
}

function build() {
  const scons = sconsCommand()
  if (!scons) throw new Error('scons not found. Install it first: python -m pip install scons')
  const jobs = process.env.DSH_SCONS_JOBS ?? String(Math.max(4, Math.min(32, (env.NUMBER_OF_PROCESSORS ? +env.NUMBER_OF_PROCESSORS : 8) - 2)))
  const args = [...scons.args, 'platform=windows', `target=${activeTarget}`, 'arch=x86_64', 'dsh_viewport=yes', 'lto=none', 'production=no', 'optimize=speed', 'trace_dev=no', 'accesskit=no', 'd3d12=no', `-j${jobs}`, ...extraArgs]
  console.log(`$ ${scons.command} ${args.join(' ')}`)
  const result = spawnSync(scons.command, args, { cwd: godotDir, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`scons exited with code ${result.status}`)
  const builtBinary = binaryFor(activeTarget)
  if (!existsSync(builtBinary)) throw new Error(`scons finished but ${builtBinary} is missing`)
  console.log(`Built ${builtBinary}`)
}

function stage() {
  const sourceBinary = binaryFor(activeTarget)
  if (!existsSync(sourceBinary)) {
    throw new Error(`Worker binary not found: ${sourceBinary}\nRun the engine build first: ${editorMode ? 'pnpm run godot:build:editor' : 'pnpm run godot:build'}`)
  }
  const stagedName = editorMode ? editorWorkerName : workerName
  mkdirSync(outDir, { recursive: true })
  const targetPath = join(outDir, stagedName)
  copyFileSync(sourceBinary, targetPath)
  const hash = createHash('sha256').update(readFileSync(targetPath)).digest('hex')
  const scons = sconsCommand()
  const pluginPkg = json(join(root, 'package.json'))
  const manifest = {
    protocol: 2,
    platform: 'win32-x64',
    backend: 'godot-vulkan',
    producer: editorMode ? 'dsh-godot-plugin/godot-editor' : 'dsh-godot-plugin/godot',
    worker: `native/win32-x64/${stagedName}`,
    extensions: ['godot.demo.v1', 'godot.viewport.v1', 'godot.window.v1', 'godot.editor.v1'],
    electron: '44.7.0',
    dsh: pluginPkg.engines.dsh,
    requiredCapability: 'dshDesktop.nativeViewports/v2 (experimental fork)',
    executable: `native/win32-x64/${stagedName}`,
    runtimeCpuReadbacks: 0,
    exportGpuCopies: 0,
    editorMode,
    projectDir: editorMode ? 'native/editor-project' : undefined, // Resolved against packageRoot at registration time.
    pluginCommit: run('git', ['-C', root, 'rev-parse', 'HEAD']),
    godotCommit: git('rev-parse', 'HEAD'),
    toolchain: {
      scons: scons ? run(scons.command, [...scons.args, '--version']).split('\n')[0] : 'unknown',
      python: run('python', ['--version']).split('\n').pop(),
      target: editorMode ? 'editor' : 'template_release',
      arch: 'x86_64',
      dshViewport: true,
    },
    requirements: [
      'Windows x64',
      'Vulkan driver with D3D11_TEXTURE external memory import',
      'Vulkan loader supplied by GPU driver',
      'DSH native viewport preview fork (protocol 2, Windows x64, Electron 44.7.0)',
      ...(editorMode ? [
        'Text input/IME provided through protocol v2 input.text/input.ime (composition preedit + commit)',
        'Clipboard ride-along not yet provided (long-tail)',
      ] : []),
    ],
    files: { [`native/win32-x64/${stagedName}`]: hash },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Staged ${stagedName} (${(statSync(targetPath).size / 1024 / 1024).toFixed(1)} MiB, sha256 ${hash.slice(0, 12)}…)`)
  console.log(`Wrote ${basename(manifestPath)}`)
  console.log('Next: install the plugin into DSH from the repository root (see doc/acceptance/build-and-package.zh.md).')
}

async function verify() {
  const worker = editorMode ? join(outDir, editorWorkerName) : join(outDir, workerName)
  if (!existsSync(worker)) throw new Error(`Staged worker missing: ${worker}. Run: pnpm run godot:stage${editorMode ? ' -- --editor' : ''}`)
  const manifest = json(manifestPath)
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { createInterface } = await import('node:readline')

  // Editor mode edits a real (minimal) project from its own argument slot;
  // runtime mode renders the built-in demo scene.
  let projectDir = null
  const workerArgs = ['--dsh-viewport-protocol', '2', '--broker-pid', String(process.pid)]
  if (editorMode) {
    projectDir = join(root, '.dsh-dev/editor-smoke-project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="DSH Editor Smoke"\n')
    workerArgs.unshift('-e', '--path', projectDir)
  }
  // Editor first paint compiles the editor theme shader set; allow generous
  // deadlines where runtime expects immediacy.
  const budget = editorMode ? { hello: 20000, surface: 90000, frame: 60000, frames: 12 } : { hello: 15000, surface: 20000, frame: 15000, frames: 40 }
  const size = editorMode ? { width: 960, height: 600 } : { width: 320, height: 240 }
  const secondSize = editorMode ? { width: 720, height: 480 } : { width: 200, height: 150 }
  // The resize sends cssWidth/cssHeight = 2x physical (factors 0.5): aim input
  // at the physical center expressed in css coordinates so editor hover/wheel
  // land on the 3D viewport and drive demand redraws.
  const aim = editorMode ? { x: size.width, y: size.height } : { x: 480, y: 300 }

  const report = { timestamp: new Date().toISOString(), worker, steps: {}, metrics: { frames: 0, released: 0, surfaces: 0, maxInputSeq: 0 } }
  let failed = false
  const step = (name, fn) => Promise.resolve()
    .then(fn)
    .then(result => { report.steps[name] = { status: 'passed', ...(result ? { result } : {}) } })
    .catch(error => { failed = true; report.steps[name] = { status: 'failed', error: error.message } })

  const child = spawn(worker, workerArgs, {
    cwd: outDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const rl = createInterface({ input: child.stdout })
  const pendingLines = []
  let lineWaiter = null
  // Protocol v2.1 sub-window traffic is routed to dedicated queues so the
  // main-stream frame/surface assertions below never see a window-tagged
  // message (and vice versa).
  const windowFrameLines = []
  const windowSurfaceLines = []
  rl.on('line', line => {
    if (process.env.DSH_VERIFY_DEBUG) console.log(`[verify:line] ${line}`)
    let message = null
    try { message = JSON.parse(line) } catch { message = null }
    if (message?.type === 'frame' && (message.window ?? 0) !== 0) { windowFrameLines.push(line); return }
    if (message?.type === 'surface' && (message.window ?? 0) !== 0) { windowSurfaceLines.push(line); return }
    if (lineWaiter) {
      const receive = lineWaiter
      lineWaiter = null
      receive(line)
    } else pendingLines.push(line)
  })
  const nextLine = (timeoutMs = 15000) => {
    if (pendingLines.length) return Promise.resolve(pendingLines.shift())
    return new Promise((resolveLine, reject) => {
      const receive = line => { clearTimeout(timer); resolveLine(line) }
      const timer = setTimeout(() => {
        if (lineWaiter === receive) lineWaiter = null
        reject(new Error('Timed out waiting for a protocol line'))
      }, timeoutMs)
      lineWaiter = receive
    })
  }
  const nextWindowFrame = async (window, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = windowFrameLines.findIndex(raw => (JSON.parse(raw).window ?? 0) === window)
      if (index >= 0) return JSON.parse(windowFrameLines.splice(index, 1)[0])
      for (let i = pendingLines.length - 1; i >= 0; i--) {
        const message = JSON.parse(pendingLines[i])
        if (message.type === 'frame') { releaseFrame(message); pendingLines.splice(i, 1) }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for a window ${window} frame`)
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }
  const nextWindowSurface = async (window, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = windowSurfaceLines.findIndex(raw => (JSON.parse(raw).window ?? 0) === window)
      if (index >= 0) return JSON.parse(windowSurfaceLines.splice(index, 1)[0])
      for (let i = windowFrameLines.length - 1; i >= 0; i--) {
        const frame = JSON.parse(windowFrameLines[i])
        if (frame.window === window) {
          send({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId, window })
          windowFrameLines.splice(i, 1)
          report.metrics.released++
        }
      }
      for (let i = pendingLines.length - 1; i >= 0; i--) {
        const message = JSON.parse(pendingLines[i])
        if (message.type === 'frame') { releaseFrame(message); pendingLines.splice(i, 1) }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for a window ${window} surface`)
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }
  const send = message => child.stdin.write(JSON.stringify(message) + '\n')
  let seq = 0 // Shared input/extension sequence across steps (the worker drops stale seqs).
  const extensionEvents = [] // Worker extension events (demo state replies) seen at any point.
  const expectFrame = async (timeoutMs = budget.frame) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const line = await nextLine(deadline - Date.now())
      const message = JSON.parse(line)
      if (message.type === 'frame') return message
      if (message.type === 'extension') { extensionEvents.push(message); continue }
      if (message.type === 'stats') continue
      if (message.type === 'surface') { report.metrics.surfaces++; pendingLines.unshift(line); return expectFrame(deadline - Date.now()) }
      throw new Error(`Unexpected protocol message while waiting for a frame: ${line}`)
    }
  }
  const releaseFrame = frame => { send({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId }); report.metrics.released++ }
  // Worker extension events arrive interleaved with frames; frames still hold
  // slot leases, so drain them (releasing each) while waiting for the reply.
  const nextExtensionEvent = async (name, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = extensionEvents.findIndex(event => event.name === name)
      if (index >= 0) return extensionEvents.splice(index, 1)[0]
      const line = await nextLine(Math.max(20, deadline - Date.now()))
      const message = JSON.parse(line)
      if (message.type === 'extension') { extensionEvents.push(message); continue }
      if (message.type === 'frame') { releaseFrame(message); continue }
      if (message.type === 'stats') continue
      if (message.type === 'surface') { report.metrics.surfaces++; continue }
      throw new Error(`Unexpected protocol message while waiting for an extension event: ${line}`)
    }
  }
  const waitSurface = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const line = JSON.parse(await nextLine(Math.max(1000, deadline - Date.now())))
      if (line.type === 'surface') { report.metrics.surfaces++; return line }
      if (line.type === 'frame') releaseFrame(line)
      if (line.type === 'extension') extensionEvents.push(line)
      if (line.type === 'stats') continue
    }
  }

  await step('hello', async () => {
    const hello = JSON.parse(await nextLine(budget.hello))
    if (hello.type !== 'hello') throw new Error(`First line is not hello: ${JSON.stringify(hello)}`)
    if (hello.protocol !== 2 || hello.transport !== 'd3d11-nt-rgba8') throw new Error(`Bad protocol/transport: ${JSON.stringify(hello)}`)
    if (JSON.stringify(hello.extensions) !== JSON.stringify(manifest.extensions)) throw new Error(`Extension mismatch: ${JSON.stringify(hello.extensions)}`)
    if (!Number.isInteger(hello.vendorId) || !Number.isInteger(hello.deviceId)) throw new Error('Missing GPU adapter IDs')
    const features = hello.features
    if (!Array.isArray(features) || !features.includes('interaction.map.v2') || !features.includes('input.text')
      || !features.includes('input.ime') || !features.includes('pointer.lock')) throw new Error(`Missing v2 features: ${JSON.stringify(features)}`)
    return { gpu: hello.gpu, vendorId: hello.vendorId, deviceId: hello.deviceId, features }
  })

  await step('surfaceAfterResize', async () => {
    // Physical 320x240 (runtime) for a 640x480 css viewport: per-axis factors 0.5.
    send({ kind: 'resize', width: size.width, height: size.height, scale: 0.5, cssWidth: size.width * 2, cssHeight: size.height * 2 })
    const surface = await waitSurface(budget.surface)
    if (surface.width !== size.width || surface.height !== size.height || surface.slots !== 4) throw new Error(`Bad surface: ${JSON.stringify(surface)}`)
    if (surface.cssWidth !== size.width * 2 || surface.cssHeight !== size.height * 2) throw new Error(`Surface missing css echo: ${JSON.stringify(surface)}`)
    report.firstEpoch = surface.epoch
  })

  await step('framesAndReleases', async () => {
    const frames = []
    for (let i = 0; i < budget.frames; i++) {
      if (editorMode) {
        // The editor is demand-driven: it only redraws on interaction, so
        // drive damage with wheel zoom + hover over the viewport (also
        // exercises editor input delivery).
        send({ kind: 'input', seq: ++seq, event: { type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: aim.x, y: aim.y, buttons: 0, button: -1, modifiers: 0 } })
        send({ kind: 'input', seq: ++seq, event: { type: 'wheel', x: aim.x, y: aim.y, deltaX: 0, deltaY: (i % 2 === 0 ? 120 : -120), modifiers: 0 } })
        send({ kind: 'input', seq: ++seq, event: { type: 'wheel', x: aim.x, y: aim.y, deltaX: 0, deltaY: (i % 2 === 0 ? -60 : 60), modifiers: 0 } })
      }
      const frame = await expectFrame()
      frames.push(frame)
      // Release immediately: the worker only has 4 slots and blocks until
      // the broker returns each lease (same as the real desktop broker).
      send({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId })
      report.metrics.released++
    }
    const ids = frames.map(f => f.frameId)
    if (new Set(ids).size !== ids.length || ids.some((id, i) => i > 0 && id <= ids[i - 1])) throw new Error('frameId not strictly increasing')
    for (const frame of frames) {
      if (!/^\d{1,20}$/.test(frame.handle) || BigInt(frame.handle) === 0n) throw new Error(`Bad NT handle: ${frame.handle}`)
      if (frame.width !== size.width || frame.height !== size.height) throw new Error(`Bad frame size: ${JSON.stringify(frame)}`)
      report.metrics.maxInputSeq = Math.max(report.metrics.maxInputSeq, frame.inputSeq)
    }
    report.metrics.frames += frames.length
  })

  await step('inputAndExtension', async () => {
    // Drain stale pre-input frames first (release each) so the assertion sees
    // a frame rendered after the inputs were applied.
    const drain = async (windowMs) => {
      const end = Date.now() + windowMs
      while (Date.now() < end) {
        try {
          const frame = await expectFrame(Math.max(20, end - Date.now()))
          send({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId })
          report.metrics.released++
        } catch { break }
      }
    }
    await drain(250)
    const input = event => send({ kind: 'input', seq: ++seq, event })
    // Editor mode: clicks/wheels drive redraws; runtime mode: the demo scene
    // rotates continuously on its own.
    const nudge = i => {
      input({ type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: aim.x, y: aim.y, buttons: 0, button: -1, modifiers: 0 })
      input({ type: 'wheel', x: aim.x, y: aim.y, deltaX: 0, deltaY: i % 2 ? 90 : -90, modifiers: 0 })
    }
    input({ type: 'pointer', phase: 'down', pointerId: 1, pointerType: 'mouse', x: 100, y: 80, buttons: 1, button: 0, modifiers: 0 })
    input({ type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: 140, y: 90, buttons: 1, button: -1, modifiers: 0 })
    input({ type: 'pointer', phase: 'up', pointerId: 1, pointerType: 'mouse', x: 140, y: 90, buttons: 0, button: 0, modifiers: 0 })
    input({ type: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: 120, modifiers: 0 })
    input({ type: 'key', code: 'KeyW', down: true, repeat: false, modifiers: 0 })
    input({ type: 'key', code: 'KeyW', down: false, repeat: false, modifiers: 0 })
    // Text/IME pipeline (input.text / input.ime capabilities): the worker must
    // accept and apply these without breaking the input sequence.
    input({ type: 'drop', x: 160, y: 120, paths: ['/tmp/asset.glb'] })
    input({ type: 'key', code: 'KeyF', down: true, repeat: false, modifiers: 0, key: 'f' })
    input({ type: 'key', code: 'KeyF', down: false, repeat: false, modifiers: 0 })
    input({ type: 'text', text: 'a' })
    input({ type: 'ime', state: 'start', text: '' })
    input({ type: 'ime', state: 'update', text: 'nǐ', cursorStart: 0, cursorEnd: 2 })
    input({ type: 'ime', state: 'commit', text: '你' })
    input({ type: 'focus', focused: false })
    send({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name: 'rotate', payload: { value: false } })
    send({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name: 'reset', payload: null })
    const deadline = Date.now() + budget.frame * 2
    let frame
    do {
      nudge(seq)
      frame = await expectFrame(deadline - Date.now())
      send({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId })
      report.metrics.released++
    } while (frame.inputSeq < seq && Date.now() < deadline)
    if (frame.inputSeq < seq) throw new Error(`Frame inputSeq ${frame.inputSeq} did not reach ${seq}`)
    report.metrics.maxInputSeq = Math.max(report.metrics.maxInputSeq, frame.inputSeq)
    report.metrics.frames++
  })

  await step('coordinateMapping', async () => {
    // Runtime-only: the editor scene has no demo controller to observe. The
    // demo controller answers `query` extension messages with its state, which
    // turns coordinate mapping, button semantics and focus cleanup into
    // black-box assertions.
    if (editorMode) return { skipped: 'editor scene has no demo controller' }
    const input = event => send({ kind: 'input', seq: ++seq, event })
    const query = async () => {
      send({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name: 'query', payload: null })
      const event = await nextExtensionEvent('state')
      if (event.namespace !== 'godot.demo.v1' || typeof event.payload !== 'object' || event.payload === null) throw new Error(`Bad state event: ${JSON.stringify(event)}`)
      return event.payload
    }
    const near = (actual, expected) => Math.abs(actual - expected) <= 0.51
    // Horizontal pan magnitude in world units (target y never changes).
    const panned = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2])
    const pointer = (phase, x, y, buttons, button, extra = {}) => input({ type: 'pointer', phase, pointerId: 1, pointerType: 'mouse', x, y, buttons, button, modifiers: 0, ...extra })

    // Geometry: 320x240 physical serving a 640x480 css viewport -> factors 0.5.
    send({ kind: 'resize', width: size.width, height: size.height, scale: 0.5, cssWidth: 640, cssHeight: 480 })
    const mapped = await waitSurface(budget.surface)
    if (mapped.cssWidth !== 640 || mapped.cssHeight !== 480) throw new Error(`Bad mapped surface: ${JSON.stringify(mapped)}`)
    send({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name: 'reset', payload: null })

    // CSS (100,100) must land on engine (50,50) exactly (tolerance < 1px).
    pointer('move', 100, 100, 0, -1)
    let state = await query()
    if (!near(state.lastPointer[0], 50) || !near(state.lastPointer[1], 50)) throw new Error(`CSS(100,100) did not map to engine (50,50): ${JSON.stringify(state)}`)
    if (!near(state.mouse[0], 50) || !near(state.mouse[1], 50)) throw new Error(`Mouse position not mapped: ${JSON.stringify(state)}`)

    // Right-drag pans: the pan target must move while yaw stays untouched.
    pointer('down', 100, 100, 2, 2)
    pointer('move', 200, 100, 2, -1)
    state = await query()
    if (!state.dragging || state.buttons !== 2) throw new Error(`Right-drag not detected: ${JSON.stringify(state)}`)
    if (!near(state.lastPointer[0], 100) || !near(state.lastPointer[1], 50)) throw new Error(`Right-drag position not mapped: ${JSON.stringify(state)}`)
    // 50 engine px * distance 4 * 0.0016 ~= 0.32 world units expected.
    if (!panned(state.target, [0, 0, 0])) throw new Error(`Right-drag did not pan the target: ${JSON.stringify(state)}`)
    const panTarget = [...state.target]
    pointer('up', 200, 100, 0, 2)
    state = await query()
    if (state.dragging || state.buttons !== 0) throw new Error(`Button mask outlived the right-drag release: ${JSON.stringify(state)}`)

    // Shift+left-drag pans too.
    pointer('down', 100, 100, 1, 0, { modifiers: 1 })
    pointer('move', 160, 100, 1, -1, { modifiers: 1 })
    state = await query()
    if (!panned(state.target, panTarget)) throw new Error(`Shift+left-drag did not pan: ${JSON.stringify(state)}`)
    pointer('up', 160, 100, 0, 0)

    // Left-drag orbits; a pointer-lock style movementX/Y delta overrides the
    // (frozen) OS position: 200 css px -> 100 engine px -> 0.6 rad at 0.006.
    pointer('down', 100, 100, 1, 0)
    pointer('move', 300, 100, 1, -1, { movementX: 200, movementY: 0 })
    state = await query()
    if (!near(state.yaw, 0.35 - 0.6)) throw new Error(`movementX orbit mismatch: yaw ${state.yaw}, expected ${0.35 - 0.6}`)
    if (!near(state.lastPointer[0], 150) || !near(state.lastPointer[1], 50)) throw new Error(`movementX position mismatch: ${JSON.stringify(state)}`)
    pointer('up', 300, 100, 0, 0)

    // The wheel uses its own event coordinates (mapped) and dollies the camera.
    input({ type: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: 120, modifiers: 0 })
    state = await query()
    if (!near(state.mouse[0], 5) || !near(state.mouse[1], 5)) throw new Error(`Wheel coordinates not mapped: ${JSON.stringify(state)}`)
    if (!near(state.distance, 4.0 + 0.35 * 1.2)) throw new Error(`Wheel dolly mismatch: ${JSON.stringify(state)}`)

    // Focus loss releases pressed buttons: no stale drag may survive an unfocus.
    pointer('down', 100, 100, 1, 0)
    state = await query()
    if (!state.dragging) throw new Error(`Left-drag not detected before focus loss: ${JSON.stringify(state)}`)
    input({ type: 'focus', focused: false })
    state = await query()
    if (state.dragging || state.buttons !== 0) throw new Error(`Focus loss did not clear the drag: ${JSON.stringify(state)}`)

    // A cancel phase never carries a button value (regression: early return on
    // button == NONE left the drag stuck before).
    pointer('down', 100, 100, 2, 2)
    state = await query()
    if (!state.dragging) throw new Error(`Right-drag not detected before cancel: ${JSON.stringify(state)}`)
    pointer('cancel', 100, 100, 0, -1)
    state = await query()
    if (state.dragging || state.buttons !== 0) throw new Error(`Cancel did not release the drag: ${JSON.stringify(state)}`)
    const baselineTarget = [...state.target]

    // godot.viewport.v1 setRightDrag switches the right button off; the camera
    // must not pan while it is disabled.
    send({ kind: 'extension', seq: ++seq, namespace: 'godot.viewport.v1', name: 'setRightDrag', payload: { value: 'none' } })
    pointer('down', 100, 100, 2, 2)
    pointer('move', 220, 100, 2, -1)
    state = await query()
    if (panned(state.target, baselineTarget)) throw new Error(`setRightDrag 'none' still panned: ${JSON.stringify(state)}`)
    pointer('up', 220, 100, 0, 2)
    send({ kind: 'extension', seq: ++seq, namespace: 'godot.viewport.v1', name: 'setRightDrag', payload: { value: 'pan' } })

    // Printable keys arrive as unicode (text fields insert from it); keys
    // without a character stay unicode-free so shortcuts can't double-act.
    input({ type: 'key', code: 'KeyN', down: true, repeat: false, modifiers: 0, key: 'n' })
    input({ type: 'key', code: 'KeyN', down: false, repeat: false, modifiers: 0 })
    state = await query()
    if (state.lastUnicode !== 110) throw new Error(`Key character not delivered as unicode: ${JSON.stringify(state)}`)
    input({ type: 'key', code: 'KeyW', down: true, repeat: false, modifiers: 0 })
    input({ type: 'key', code: 'KeyW', down: false, repeat: false, modifiers: 0 })
    state = await query()
    if (state.lastUnicode !== 0) throw new Error(`Key without a character must stay unicode-free: ${JSON.stringify(state)}`)

    // OS file drops reach the engine's files-dropped notification with the
    // full path list (the create-node/import path in the editor).
    input({ type: 'drop', x: 50, y: 40, paths: ['/tmp/a.glb', '/tmp/b.png'] })
    state = await query()
    if (JSON.stringify(state.lastDropPaths) !== JSON.stringify(['/tmp/a.glb', '/tmp/b.png'])) {
      throw new Error(`Drop paths mismatch: ${JSON.stringify(state.lastDropPaths)}`)
    }

    // Legacy fallback (graphics101): a resize without css fields keeps the
    // single-scale behavior and the surface carries no css echo.
    send({ kind: 'resize', width: 200, height: 150, scale: 1 })
    const legacy = await waitSurface(budget.surface)
    if (legacy.cssWidth !== undefined || legacy.cssHeight !== undefined) throw new Error(`Legacy surface must not echo css: ${JSON.stringify(legacy)}`)
    pointer('move', 100, 100, 0, -1)
    state = await query()
    if (!near(state.lastPointer[0], 100) || !near(state.lastPointer[1], 100)) throw new Error(`Legacy mapping mismatch: ${JSON.stringify(state)}`)
    return { mappedSurface: mapped.epoch, legacySurface: legacy.epoch }
  })

  await step('suspendAndResume', async () => {
    send({ kind: 'visible', value: false })
    // Hidden: the worker drops to its idle cadence (10 fps) instead of 60.
    // Bound the observed frames well above 10 fps yield and far below 60 fps
    // yield for the 700 ms window.
    const end = Date.now() + 700
    let observed = 0
    while (Date.now() < end) {
      try {
        const frame = await expectFrame(Math.max(20, end - Date.now()))
        observed++
        send({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId })
        report.metrics.released++
      } catch { /* hidden viewport: pauses are expected */ }
    }
    if (observed > 12) throw new Error(`Frames kept flowing at full rate while hidden (${observed} in 700ms)`)
    send({ kind: 'visible', value: true })
    if (editorMode) {
      send({ kind: 'input', seq: ++seq, event: { type: 'wheel', x: aim.x, y: aim.y, deltaX: 0, deltaY: 120, modifiers: 0 } })
    }
    const frame = await expectFrame(15000)
    send({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId })
    report.metrics.released++
    report.metrics.frames++
  })

  await step('resizeToSecondEpoch', async () => {
    send({ kind: 'resize', width: secondSize.width, height: secondSize.height, scale: 1 })
    const deadline = Date.now() + budget.surface
    for (;;) {
      const line = JSON.parse(await nextLine(Math.max(1000, deadline - Date.now())))
      if (line.type === 'surface') {
        if (line.epoch <= report.firstEpoch) throw new Error(`Epoch did not advance: ${JSON.stringify(line)}`)
        if (line.width !== secondSize.width || line.height !== secondSize.height) throw new Error(`Bad resize surface: ${JSON.stringify(line)}`)
        report.metrics.surfaces++
        break
      }
      if (line.type === 'frame') send({ kind: 'release', epoch: line.epoch, slot: line.slot, frameId: line.frameId })
    }
    const frame = await expectFrame()
    if (frame.width !== secondSize.width || frame.height !== secondSize.height) throw new Error(`Frame after resize has stale size: ${JSON.stringify(frame)}`)
    send({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId })
    report.metrics.frames++
  })

  await step('multiWindow', async () => {
    // Protocol v2.1: a real sub-window gets its own surface receipt, frame
    // ring (2 slots), lifecycle events and window-tagged input routing. The
    // demo stage exposes openPopup/closePopup hooks for exactly this flow.
    const input = event => send({ kind: 'input', seq: ++seq, event })
    // godot.window.v1 events travel the main stream; wait for one by name.
    const windowEvents = []
    const nextWindowEvent = async (name, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const index = windowEvents.findIndex(event => event.name === name)
        if (index >= 0) return windowEvents.splice(index, 1)[0]
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for godot.window.v1/${name}`)
        const line = JSON.parse(await nextLine(Math.max(100, deadline - Date.now())))
        if (line.type === 'extension' && line.namespace === 'godot.window.v1') { windowEvents.push(line); continue }
        if (line.type === 'frame') { releaseFrame(line); continue }
        if (line.type === 'surface') { report.metrics.surfaces++; continue }
        if (line.type === 'stats') continue
        throw new Error(`Unexpected message while waiting for a window event: ${JSON.stringify(line)}`)
      }
    }

    send({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name: 'openPopup', payload: { width: 160, height: 120, color: '#22cc88' } })
    const created = await nextWindowEvent('created')
    const window = created.payload?.window
    if (!Number.isInteger(window) || window < 1 || window > 15) throw new Error(`Bad created window id: ${JSON.stringify(created)}`)

    send({ kind: 'input', seq: ++seq, event: { type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: 20, y: 20, buttons: 0, button: -1, modifiers: 0, window } })
    const surface = await nextWindowSurface(window)
    if (surface.slots !== 2) throw new Error(`Sub-window ring must announce 2 slots: ${JSON.stringify(surface)}`)
    if (surface.width < 16 || surface.height < 16) throw new Error(`Bad sub-window surface size: ${JSON.stringify(surface)}`)
    report.metrics.surfaces++

    const rectEvent = await nextWindowEvent('rect')
    const rect = rectEvent.payload?.rect
    if (!rect || rect.width < 16 || rect.height < 16) throw new Error(`Bad sub-window rect: ${JSON.stringify(rectEvent)}`)

    const frame = await nextWindowFrame(window)
    if ((frame.window ?? 0) !== window) throw new Error(`Frame window mismatch: ${JSON.stringify(frame)}`)
    if (frame.width !== surface.width || frame.height !== surface.height) throw new Error(`Frame/surface size mismatch: ${JSON.stringify(frame)}`)
    send({ kind: 'release', epoch: frame.epoch, slot: frame.slot, frameId: frame.frameId, window })
    report.metrics.released++

    // Window-tagged focus control: the popup takes keyboard focus, reported
    // back both through the focus event and the demo query state.
    input({ type: 'focus', focused: true, window })
    const focusEvent = await nextWindowEvent('focus')
    if (focusEvent.payload?.window !== window || focusEvent.payload?.focused !== true) throw new Error(`Bad focus event: ${JSON.stringify(focusEvent)}`)
    const queryState = async () => {
      send({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name: 'query', payload: null })
      const event = await nextExtensionEvent('state')
      return event.payload
    }
    if (!editorMode) {
      const state = await queryState()
      const entry = (state.windows ?? []).find(candidate => candidate.window === window)
      if (!entry) throw new Error(`Sub-window missing from the demo query: ${JSON.stringify(state)}`)
      if (!entry.focused) throw new Error(`Sub-window did not take focus: ${JSON.stringify(state)}`)
    }

    for (let i = windowFrameLines.length - 1; i >= 0; i--) {
      const queued = JSON.parse(windowFrameLines[i])
      if (queued.window === window) {
        send({ kind: 'release', epoch: queued.epoch, slot: queued.slot, frameId: queued.frameId, window })
        windowFrameLines.splice(i, 1)
      }
    }
    send({ kind: 'resize', window, width: 192, height: 144, scale: 1 })
    const resized = await nextWindowSurface(window)
    if (resized.epoch <= surface.epoch || resized.width !== 192 || resized.height !== 144) {
      throw new Error(`Bad resized sub-window surface: ${JSON.stringify(resized)}`)
    }
    const resizedFrame = await nextWindowFrame(window)
    if (resizedFrame.epoch !== resized.epoch) throw new Error(`Stale sub-window frame after resize: ${JSON.stringify(resizedFrame)}`)
    send({ kind: 'release', epoch: resizedFrame.epoch, slot: resizedFrame.slot, frameId: resizedFrame.frameId, window })
    report.metrics.released++
    send({ kind: 'extension', seq: ++seq, namespace: 'godot.demo.v1', name: 'closePopup', payload: null })
    const destroyed = await nextWindowEvent('destroyed')
    if (destroyed.payload?.window !== window) throw new Error(`Bad destroyed event: ${JSON.stringify(destroyed)}`)
    return { window, rect }
  })

  await step('gameTab', async () => {
    // Phase 5.1: GameView state machine on the wire. The editor stage exposes a
    // debugGame hook (godot.editor.v1) that drives the same emit paths as
    // EmbeddedProcessDSH (spawnGame/gameRect/gameClose) without a Play session,
    // and echoes the client gameLifecycle report back as gameDebug so the full
    // round trip is observable by the fake broker.
    if (!editorMode) return { skipped: 'debugGame hook is only exercised against the editor stage' }
    const editorEvents = []
    const nextEditorEvent = async (name, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const index = editorEvents.findIndex(event => event.name === name)
        if (index >= 0) return editorEvents.splice(index, 1)[0]
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for godot.editor.v1/${name}`)
        const line = JSON.parse(await nextLine(Math.max(100, deadline - Date.now())))
        if (line.type === 'extension' && line.namespace === 'godot.editor.v1') { editorEvents.push(line); continue }
        if (line.type === 'frame') { releaseFrame(line); continue }
        if (line.type === 'surface') { report.metrics.surfaces++; continue }
        if (line.type === 'stats') continue
        throw new Error(`Unexpected message while waiting for an editor event: ${JSON.stringify(line)}`)
      }
    }
    const debugGame = payload => send({ kind: 'extension', seq: ++seq, namespace: 'godot.editor.v1', name: 'debugGame', payload })
    const lifecycle = (running, code = 0) => send({ kind: 'extension', seq: ++seq, namespace: 'godot.editor.v1', name: 'gameLifecycle', payload: { running, code } })
    // Play: the editor asks the client to spawn the game worker session.
    const startRect = { x: 40, y: 30, width: 320, height: 200 }
    debugGame({ phase: 'start', rect: startRect })
    const spawned = await nextEditorEvent('spawnGame')
    const args = spawned.payload?.args
    if (!Array.isArray(args) || args.length < 1 || !args.every(arg => typeof arg === 'string')) throw new Error(`Bad spawnGame args: ${JSON.stringify(spawned)}`)
    const spawnRect = spawned.payload?.rect
    if (!spawnRect || spawnRect.x !== startRect.x || spawnRect.y !== startRect.y || spawnRect.width !== startRect.width || spawnRect.height !== startRect.height) throw new Error(`Bad spawnGame rect: ${JSON.stringify(spawned)}`)
    // The client reports the game session live; the debug listener echoes it back.
    lifecycle(true)
    const live = await nextEditorEvent('gameDebug')
    if (live.payload?.running !== true) throw new Error(`Bad gameDebug live event: ${JSON.stringify(live)}`)
    // Rect follow: a GameView size change re-emits gameRect with the new rect.
    const followRect = { x: 44, y: 33, width: 400, height: 260 }
    debugGame({ phase: 'rect', rect: followRect })
    const moved = await nextEditorEvent('gameRect')
    if (moved.payload?.rect?.x !== followRect.x || moved.payload?.rect?.y !== followRect.y || moved.payload?.rect?.width !== followRect.width || moved.payload?.rect?.height !== followRect.height) throw new Error(`Bad gameRect follow event: ${JSON.stringify(moved)}`)
    // Stop: gameClose goes to the client, which disposes the session and reports exit.
    debugGame({ phase: 'stop' })
    await nextEditorEvent('gameClose')
    lifecycle(false, 0)
    const dead = await nextEditorEvent('gameDebug')
    if (dead.payload?.running !== false || dead.payload?.code !== 0) throw new Error(`Bad gameDebug exit event: ${JSON.stringify(dead)}`)
    return { spawnArgs: args.length, followed: true }
  })

  await step('stop', async () => {
    send({ kind: 'visible', value: false })
    send({ kind: 'stop' })
    child.stdin.end()
    const deadline = Date.now() + (editorMode ? 30000 : 8000)
    let sawStopped = false
    while (Date.now() < deadline) {
      try {
        const line = JSON.parse(await nextLine(deadline - Date.now()))
        if (line.type === 'stopped') { sawStopped = true; report.stoppedFrames = line.frames; break }
      } catch { break }
    }
    if (!sawStopped) throw new Error('No stopped message before exit')
    const [code] = await once(child, 'exit')
    if (code !== 0) throw new Error(`Worker exited with code ${code}`)
    if (!report.stoppedFrames || report.stoppedFrames < report.metrics.frames) throw new Error(`Stopped frame count ${report.stoppedFrames} below emitted ${report.metrics.frames}`)
  })

  if (child.exitCode === null && !child.killed) child.kill()
  report.stderrPreview = stderr.trim().slice(0, 2000)
  report.ok = !failed
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = failed ? 1 : 0
}

try {
  if (action === 'doctor') doctor()
  else if (action === 'build') build()
  else if (action === 'stage') stage()
  else if (action === 'verify') await verify()
  else throw new Error('Usage: node scripts/godot.mjs doctor|build|stage|verify [--editor] [-- <extra scons args>]  (build honors DSH_GODOT_TARGET=template_release|editor)')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
