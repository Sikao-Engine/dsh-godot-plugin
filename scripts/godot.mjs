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
import { basename, join, resolve } from 'node:path'
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
  const probe = spawnSync('python', ['-m', 'scons', '--version'], { encoding: 'utf8' })
  if (!probe.error && probe.status === 0) return { command: 'python', args: ['-m', 'scons'] }
  // The pip layout puts a scons.exe next to the Python interpreter instead
  // of an importable __main__ module.
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
    extensions: ['godot.demo.v1'],
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
      ...(editorMode ? ['Text input/IME and clipboard ride-along not yet provided (long-tail)'] : []),
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
  rl.on('line', line => {
    if (process.env.DSH_VERIFY_DEBUG) console.log(`[verify:line] ${line}`)
    if (lineWaiter) { lineWaiter(line); lineWaiter = null } else pendingLines.push(line)
  })
  const nextLine = (timeoutMs = 15000) => {
    if (pendingLines.length) return Promise.resolve(pendingLines.shift())
    return new Promise((resolveLine, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a protocol line')), timeoutMs)
      lineWaiter = line => { clearTimeout(timer); resolveLine(line) }
    })
  }
  const send = message => child.stdin.write(JSON.stringify(message) + '\n')
  let seq = 0 // Shared input/extension sequence across steps (the worker drops stale seqs).
  const expectFrame = async (timeoutMs = budget.frame) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const line = await nextLine(deadline - Date.now())
      const message = JSON.parse(line)
      if (message.type === 'frame') return message
      if (message.type === 'stats') continue
      if (message.type === 'surface') { report.metrics.surfaces++; pendingLines.unshift(line); return expectFrame(deadline - Date.now()) }
      throw new Error(`Unexpected protocol message while waiting for a frame: ${line}`)
    }
  }

  await step('hello', async () => {
    const hello = JSON.parse(await nextLine(budget.hello))
    if (hello.type !== 'hello') throw new Error(`First line is not hello: ${JSON.stringify(hello)}`)
    if (hello.protocol !== 2 || hello.transport !== 'd3d11-nt-rgba8') throw new Error(`Bad protocol/transport: ${JSON.stringify(hello)}`)
    if (JSON.stringify(hello.extensions) !== JSON.stringify(manifest.extensions)) throw new Error(`Extension mismatch: ${JSON.stringify(hello.extensions)}`)
    if (!Number.isInteger(hello.vendorId) || !Number.isInteger(hello.deviceId)) throw new Error('Missing GPU adapter IDs')
    return { gpu: hello.gpu, vendorId: hello.vendorId, deviceId: hello.deviceId }
  })

  await step('surfaceAfterResize', async () => {
    send({ kind: 'resize', width: size.width, height: size.height, scale: 1 })
    const deadline = Date.now() + budget.surface
    let surface
    do { surface = JSON.parse(await nextLine(Math.max(1000, deadline - Date.now()))) } while (surface.type !== 'surface')
    if (surface.width !== size.width || surface.height !== size.height || surface.slots !== 4) throw new Error(`Bad surface: ${JSON.stringify(surface)}`)
    report.metrics.surfaces++
    report.firstEpoch = surface.epoch
  })

  await step('framesAndReleases', async () => {
    const frames = []
    for (let i = 0; i < budget.frames; i++) {
      if (editorMode) {
        // The editor is demand-driven: it only redraws on interaction, so
        // drive damage with wheel zoom + hover over the viewport (also
        // exercises editor input delivery).
        send({ kind: 'input', seq: ++seq, event: { type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: 480, y: 300, buttons: 0, button: -1, modifiers: 0 } })
        send({ kind: 'input', seq: ++seq, event: { type: 'wheel', x: 480, y: 300, deltaX: 0, deltaY: (i % 2 === 0 ? 120 : -120), modifiers: 0 } })
        send({ kind: 'input', seq: ++seq, event: { type: 'wheel', x: 480, y: 300, deltaX: 0, deltaY: (i % 2 === 0 ? -60 : 60), modifiers: 0 } })
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
      input({ type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: 480, y: 300, buttons: 0, button: -1, modifiers: 0 })
      input({ type: 'wheel', x: 480, y: 300, deltaX: 0, deltaY: i % 2 ? 90 : -90, modifiers: 0 })
    }
    input({ type: 'pointer', phase: 'down', pointerId: 1, pointerType: 'mouse', x: 100, y: 80, buttons: 1, button: 0, modifiers: 0 })
    input({ type: 'pointer', phase: 'move', pointerId: 1, pointerType: 'mouse', x: 140, y: 90, buttons: 1, button: -1, modifiers: 0 })
    input({ type: 'pointer', phase: 'up', pointerId: 1, pointerType: 'mouse', x: 140, y: 90, buttons: 0, button: 0, modifiers: 0 })
    input({ type: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: 120, modifiers: 0 })
    input({ type: 'key', code: 'KeyW', down: true, repeat: false, modifiers: 0 })
    input({ type: 'key', code: 'KeyW', down: false, repeat: false, modifiers: 0 })
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
      send({ kind: 'input', seq: ++seq, event: { type: 'wheel', x: 480, y: 300, deltaX: 0, deltaY: 120, modifiers: 0 } })
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
