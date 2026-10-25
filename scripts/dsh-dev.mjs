import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = resolve(process.env.DSH_SOURCE_DIR ?? [resolve(root, '../deepseek-harness-3d'), resolve(root, '../../ai/deepseek-harness')].find(candidate => existsSync(join(candidate, 'package.json'))) ?? resolve(root, '../deepseek-harness-3d'))
const tarball = join(root, 'dist', `${pkg.name}-${pkg.version}.tgz`)
const home = join(root, '.dsh-dev', 'home')
const userData = join(root, '.dsh-dev', 'electron-user-data')
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const packageManager = process.env.npm_execpath
const env = { ...process.env, DSH_HOME: home, DSH_DESKTOP_USER_DATA_DIR: userData }

async function run(args, cwd = source) {
  if (!packageManager) throw new Error('Run this command through pnpm run.')
  await new Promise((done, fail) => {
    const executableManager = packageManager.toLowerCase().endsWith('.exe')
    const child = spawn(executableManager ? packageManager : process.execPath, executableManager ? args : [packageManager, ...args], { cwd, env, stdio: 'inherit' })
    child.once('error', fail)
    child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`pnpm ${args.join(' ')} exited with ${code ?? signal}`)))
  })
}

const action = process.argv[2]
switch (action) {
  case 'doctor':
    console.log(JSON.stringify({
      node: process.version, source, dshVersion: manifest.version,
      requiredPackageManager: manifest.packageManager, home, userData,
      artifacts: Object.fromEntries([
        'vendor/cordis/lib/index.js', 'apps/cli/lib/bin.js',
        'apps/desktop/lib/main.js', 'apps/web/dist/index.html',
      ].map(path => [path, existsSync(join(source, path))])),
    }, null, 2))
    break
  case 'build':
    await run(['run', 'build'])
    break
  case 'web':
    await run(['run', 'start:web', '--no-open'])
    break
  case 'desktop':
    delete env.ELECTRON_RUN_AS_NODE
    await run(['run', 'start:desktop'])
    break
  case 'install-desktop':
    if (!existsSync(tarball)) throw new Error(`Missing ${tarball}. Run: pnpm run release:pack`)
    await run(['run', 'dsh', 'plugin', '--profile', 'desktop', 'add', tarball])
    break
  case 'install-web':
    await run(['run', 'dsh', 'plugin', '--profile', 'web', 'add', `link:${root.replaceAll('\\', '/')}`])
    break
  case 'dump':
    await run(['run', 'dsh', '--profile', 'web', '--dump-config'])
    break
  default:
    throw new Error(`Unknown action: ${action}`)
}
