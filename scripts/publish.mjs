// Packaging + publishing for dsh-godot-plugin:
//   pack    - produce dist/dsh-godot-plugin-<version>.tgz (npm tarball)
//   npm     - publish to an npm registry from a cleaned staging copy
//   github  - create a GitHub Release and attach the tarball (gh CLI)
//   all     - pack, then npm + github
// Prerelease safety: dev `link:` dependencies are stripped in the npm staging
// copy; GitHub publishing requires a clean git state and a version tag.
// Usage: node scripts/publish.mjs pack|npm|github|all [--dry-run] [--tag <npm-tag>]
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const mode = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
const tagIndex = process.argv.indexOf('--tag')
const npmTag = tagIndex > 0 ? process.argv[tagIndex + 1] : undefined
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarball = join(root, 'dist', `${pkg.name}-${pkg.version}.tgz`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], ...options })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.error?.message ?? output}`)
  return output.trim()
}
// Run npm through its CLI entrypoint with the current Node interpreter:
// .cmd shims need a shell and POSIX shims lack an extension on Windows.
function npmArgs(args) {
  const probe = spawnSync('where', ['npm'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const dir = probe.stdout.trim().split('\n').map(line => line.trim()).filter(Boolean)[0]
    if (dir) {
      const base = dir.replace(/[^\\/]+$/, '')
      for (const candidate of [join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(base, 'npm-cli.js')]) {
        if (existsSync(candidate)) return { command: process.execPath, args: [candidate, ...args] }
      }
    }
  }
  return { command: 'npm', args }
}
function runNpm(args, options = {}) {
  const resolved = npmArgs(args)
  return run(resolved.command, resolved.args, options)
}
const log = message => console.log(`[publish] ${message}`)

function ensureReleaseReady() {
  for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'runtime-manifest.json', 'runtime-manifest.editor.json',
    join('native/win32-x64', 'dsh-godot-worker.exe'), join('native/win32-x64', 'dsh-godot-editor.exe')]) {
    if (!existsSync(join(root, required))) throw new Error(`Missing ${required}. Run: pnpm run release:stage`)
  }
  const devLinks = Object.entries(pkg.devDependencies ?? {}).filter(([, version]) => String(version).startsWith('link:'))
  if (devLinks.length) log(`note: devDependencies use local link: entries (${devLinks.map(([name]) => name).join(', ')}); they are excluded from the published package.`)
}

function pack() {
  ensureReleaseReady()
  mkdirSync(join(root, 'dist'), { recursive: true })
  rmSync(tarball, { force: true })
  log(`packing ${pkg.name}@${pkg.version} …`)
  const out = runNpm(['pack', '--pack-destination', 'dist'])
  if (!existsSync(tarball)) {
    const produced = out.split('\n').pop().trim()
    if (produced && existsSync(join(root, produced))) rmSync(join(root, produced), { force: true })
    throw new Error(`npm pack did not produce ${tarball}: ${out}`)
  }
  log(`wrote ${tarball} (${(statSyncSafe(tarball) / 1024 / 1024).toFixed(1)} MiB)`)
  log('tarball contents (must include lib/, cordis.patch.yml, locale/, native/win32-x64/, runtime-manifest.json):')
  const listing = run('tar', ['-tzf', `dist/${pkg.name}-${pkg.version}.tgz`])
  for (const entry of listing.split('\n').slice(0, 40)) console.log(`  ${entry}`)
  return tarball
}
function statSyncSafe(path) { return existsSync(path) ? readFileSync(path).byteLength : 0 }

function publishNpm() {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-godot-plugin-publish-'))
  try {
    for (const entry of ['lib', 'locale', 'cordis.patch.yml', 'runtime-manifest.json', 'runtime-manifest.editor.json', 'README.md', 'native/editor-project']) {
      cpSync(join(root, entry), join(staging, entry), { recursive: true,
        filter: source => !source.split(/[\\/]/u).includes('.godot') })
    }
    mkdirSync(join(staging, 'godot'), { recursive: true })
    for (const name of ['LICENSE.txt', 'COPYRIGHT.txt']) cpSync(join(root, 'godot', name), join(staging, 'godot', name))
    mkdirSync(join(staging, 'native/win32-x64'), { recursive: true })
    for (const name of ['dsh-godot-worker.exe', 'dsh-godot-editor.exe']) {
      cpSync(join(root, 'native/win32-x64', name), join(staging, 'native/win32-x64', name))
    }
    const publishPkg = { ...pkg }
    delete publishPkg.devDependencies // never ship local link: dependencies
    delete publishPkg.scripts // build scripts are irrelevant to consumers
    publishPkg.files = pkg.files
    writeFileSync(join(staging, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n')
    writeFileSync(join(staging, '.npmignore'), '')
    log(`publishing ${pkg.name}@${pkg.version} to npm ${npmTag ? `with tag '${npmTag}' ` : ''}(registry: ${process.env.npm_config_registry ?? 'https://registry.npmjs.org'})…`)
    if (dryRun) { log('dry-run: skipping npm publish'); return }
    const args = ['publish', staging, '--access', 'public']
    if (npmTag) args.push('--tag', npmTag)
    runNpm(args)
    log('npm publish complete')
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function publishGithub(tarballPath) {
  const remote = run('git', ['-C', root, 'remote', 'get-url', 'origin'])
  const repoMatch = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)
  if (!repoMatch) throw new Error(`origin is not a GitHub remote: ${remote}`)
  run('gh', ['auth', 'status'])
  const dirty = run('git', ['-C', root, 'status', '--porcelain'])
  if (dirty) throw new Error('Working tree is dirty; commit everything before creating a release.')
  run('git', ['-C', root, 'rev-parse', `v${pkg.version}`]) // fails when the tag is missing
  const releaseTag = `v${pkg.version}`
  log(`creating GitHub release ${releaseTag} in ${repoMatch[1]} …`)
  if (dryRun) { log(`dry-run: gh release create ${releaseTag} ${tarballPath}`); return }
  run('gh', ['release', 'create', releaseTag, tarballPath, '--repo', repoMatch[1], '--title', `dsh-godot-plugin ${pkg.version}`, '--notes-file', join(root, 'doc/acceptance/build-and-package.zh.md')])
  log(`GitHub release published: ${repoMatch[1]}/releases/tag/${releaseTag}`)
}

try {
  if (mode === 'pack') pack()
  else if (mode === 'npm') { ensureReleaseReady(); publishNpm() }
  else if (mode === 'github') publishGithub(existsSync(tarball) ? tarball : pack())
  else if (mode === 'all') { publishNpm(); publishGithub(pack()) }
  else throw new Error('Usage: node scripts/publish.mjs pack|npm|github|all [--dry-run] [--tag <npm-dist-tag>]')
} catch (error) {
  console.error(`[publish] failed: ${error.message}`)
  process.exitCode = 1
}
