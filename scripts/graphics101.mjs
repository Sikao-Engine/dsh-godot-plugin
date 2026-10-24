import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = resolve(process.env.DSH_SOURCE_DIR ?? [resolve(root, '../deepseek-harness-3d'), resolve(root, '../../ai/deepseek-harness')].find(candidate => existsSync(join(candidate, 'package.json'))) ?? resolve(root, '../deepseek-harness-3d'))
const build = join(root, 'native/graphics101/build')
const results = join(root, '.graphics101-results')
const action = process.argv[2]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...options })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(output)
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error?.message ?? output}`)
  return result.stdout.trim()
}
function git(directory, ...args) { return run('git', ['-C', directory, ...args]) }
function jsonOutput(output) { return JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)) }

if (action === 'build') {
  run('cmake', ['-S', join(root, 'native/graphics101'), '-B', build, '-G', 'Visual Studio 17 2022', '-A', 'x64'])
  run('cmake', ['--build', build, '--config', 'Release'])
} else if (action === 'run') {
  run(join(build, 'Release/graphics101.exe'), ['--validation'], { timeout: 0 })
} else if (action === 'electron' || action === 'electron-smoke') {
  const directory = join(source, 'apps/desktop/node_modules/electron')
  const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version
  if (version !== '44.7.0') throw new Error(`Expected Electron 44.7.0, got ${version}`)
  const executable = join(directory, 'dist', readFileSync(join(directory, 'path.txt'), 'utf8').trim())
  const output = run(executable, [join(root, 'samples/electron-graphics101/main.cjs'), ...(action === 'electron-smoke' ? ['--smoke'] : [])], { timeout: action === 'electron-smoke' ? 150000 : 0 })
  if (action === 'electron-smoke') {
    const report = jsonOutput(output)
    if (report.exitCode !== 0 || report.summary?.frames < 1500 || !report.engine || report.stats.delivered < 1500 || report.workerExit?.code !== 0 || report.stats.released !== report.stats.delivered) throw new Error('Electron exited without successful viewport smoke result')
  }
} else if (action === 'verify') {
  mkdirSync(results, { recursive: true })
  const manifest = { timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version, steps: {}, gates: { m0a: 'not-passed: no Electron texture display test', m0b: 'not-passed: no real transfer lifecycle test', m1: 'partial: native foundation only' } }
  let failed = false
  function step(name, fn) {
    try { manifest.steps[name] = { status: 'passed', result: fn() } }
    catch (error) { failed = true; manifest.steps[name] = { status: 'failed', error: error.message } }
    writeFileSync(join(results, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  step('baseline', () => {
    const electronPackage = join(source, 'apps/desktop/node_modules/electron/package.json')
    const electron = JSON.parse(readFileSync(electronPackage, 'utf8')).version
    if (electron !== '44.7.0') throw new Error(`Expected Electron 44.7.0, got ${electron}`)
    const toolchain = JSON.parse(readFileSync(join(build, 'build-toolchain.json'), 'utf8'))
    return { pluginCommit: git(root, 'rev-parse', 'HEAD'), pluginDirty: git(root, 'status', '--porcelain') !== '', dshCommit: git(source, 'rev-parse', 'HEAD'), dshDirty: git(source, 'status', '--porcelain') !== '', dshVersion: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version, electron, cmake: run('cmake', ['--version']), glslc: run('glslc', ['--version']), toolchain, binarySha256: createHash('sha256').update(readFileSync(join(build, 'Release/graphics101.exe'))).digest('hex') }
  })
  const exe = join(build, 'Release/graphics101.exe')
  step('camera', () => jsonOutput(run(exe, ['--camera-test'])))
  step('interop', () => jsonOutput(run(exe, ['--probe'])))
  step('nativeSmoke', () => jsonOutput(run(exe, ['--validation', '--smoke', '--frames', '180'])))
  step('sandbox', () => {
    const electronDirectory = join(source, 'apps/desktop/node_modules/electron')
    const executable = join(electronDirectory, 'dist', readFileSync(join(electronDirectory, 'path.txt'), 'utf8').trim())
    if (!existsSync(executable)) throw new Error('Electron executable missing')
    return jsonOutput(run(executable, [join(root, 'samples/electron-graphics101/sandbox-main.cjs')]))
  })
  process.exitCode = failed ? 1 : 0
} else {
  throw new Error('Usage: node scripts/graphics101.mjs build|run|verify|electron|electron-smoke')
}
