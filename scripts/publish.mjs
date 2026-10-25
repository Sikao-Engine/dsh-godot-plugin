// Packaging + publishing for dsh-godot-plugin:
//   pack         - produce dist/dsh-godot-plugin-<version>.tgz (npm tarball)
//   npm          - publish to an npm registry from a cleaned staging copy
//   github       - create a GitHub Release (tarball + SHA256SUMS.txt) via gh CLI
//   all          - pack, then npm + github
//   version <v>  - bump package.json version (semver or patch|minor|major),
//                  then remind about CHANGELOG / tag / push follow-ups
// Prerelease safety: dev `link:` dependencies are stripped in the npm staging
// copy; GitHub publishing requires a clean git state and a version tag.
// Usage: node scripts/publish.mjs pack|npm|github|all|version [...] [--dry-run] [--tag <npm-tag>]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
function parseSemver(version) {
  const match = SEMVER.exec(version)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] }
}
function compareSemver(a, b) {
  const left = parseSemver(a); const right = parseSemver(b)
  if (!left || !right) return NaN
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  // A version without prerelease outranks the same version with one.
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === undefined) return 1
  if (right.prerelease === undefined) return -1
  return left.prerelease < right.prerelease ? -1 : 1
}
function bumpVersion(current, spec) {
  const parsed = parseSemver(current)
  if (!parsed) throw new Error(`Current package.json version is not semver: ${current}`)
  if (SEMVER.test(spec)) return spec
  const level = { major: 'major', minor: 'minor', patch: 'patch' }[spec]
  if (!level) throw new Error(`Usage: version <semver|patch|minor|major>, got: ${spec}`)
  // Incrementing on a prerelease (e.g. 0.2.1-rc.3) promotes it; on a release it
  // bumps the requested component and resets everything below it.
  const next = { ...parsed }
  if (next.prerelease !== undefined) next.prerelease = undefined
  else if (level === 'major') { next.major += 1; next.minor = 0; next.patch = 0 }
  else if (level === 'minor') { next.minor += 1; next.patch = 0 }
  else next.patch += 1
  return `${next.major}.${next.minor}.${next.patch}`
}
function writeVersion(version) {
  const updated = { ...pkg, version }
  writeFileSync(join(root, 'package.json'), JSON.stringify(updated, null, 2) + '\n')
}
function changelogPath() { return join(root, 'CHANGELOG.md') }
function changelogHasEntry(version) {
  if (!existsSync(changelogPath())) return false
  return readFileSync(changelogPath(), 'utf8').includes(`## [${version}]`)
}
function releaseNotes(version) {
  // Prefer the CHANGELOG section for this version; fall back to the acceptance doc.
  if (existsSync(changelogPath())) {
    const text = readFileSync(changelogPath(), 'utf8')
    // Keep a Changelog heading: `## [1.2.3] - 2026-10-25` (date optional).
    const match = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\](?:\\s*-\\s*\\d{4}-\\d{2}-\\d{2})?\\s*$`, 'm').exec(text)
    if (match) {
      const rest = text.slice(match.index + match[0].length)
      const end = rest.search(/^## \[/m)
      let lines = (end === -1 ? rest : rest.slice(0, end)).trim().split('\n')
      // Strip the Keep-a-Changelog link reference definitions trailing the file
      // (e.g. `[0.2.0]: https://...`) — they belong to the document, not the notes.
      while (lines.length && (/^\s*$/u.test(lines[lines.length - 1]) || /^\[[^\]]+\]:\s*\S+$/u.test(lines[lines.length - 1]))) lines.pop()
      const section = lines.join('\n').trim()
      if (section) return { body: section, source: 'CHANGELOG.md' }
    }
  }
  return { body: readFileSync(join(root, 'doc/acceptance/build-and-package.zh.md'), 'utf8'), source: 'doc/acceptance/build-and-package.zh.md' }
}

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
  // Ship a checksum file next to the tarball so installs can be verified
  // (runtime-manifest.json also embeds per-file SHA-256, but only for the worker).
  const checksums = join(root, 'dist', 'SHA256SUMS.txt')
  const digest = createHash('sha256').update(readFileSync(tarballPath)).digest('hex')
  const tarballName = tarballPath.split(/[\\/]/).pop()
  writeFileSync(checksums, `${digest}  ${tarballName}\n`)
  log(`checksums: ${digest}  ${tarballName}`)
  const notes = releaseNotes(pkg.version)
  log(`release notes source: ${notes.source}`)
  const notesFile = join(tmpdir(), `dsh-godot-plugin-notes-${pkg.version}.md`)
  writeFileSync(notesFile, notes.body + '\n')
  log(`creating GitHub release ${releaseTag} in ${repoMatch[1]} …`)
  if (dryRun) { log(`dry-run: gh release create ${releaseTag} ${tarballPath} ${checksums}`); rmSync(notesFile, { force: true }); return }
  try {
    run('gh', ['release', 'create', releaseTag, tarballPath, checksums, '--repo', repoMatch[1], '--title', `dsh-godot-plugin ${pkg.version}`, '--notes-file', notesFile])
  } finally {
    rmSync(notesFile, { force: true })
  }
  log(`GitHub release published: ${repoMatch[1]}/releases/tag/${releaseTag}`)
}

function bumpCommand() {
  const spec = process.argv[3]
  if (!spec) throw new Error('Usage: node scripts/publish.mjs version <semver|patch|minor|major>')
  const next = bumpVersion(pkg.version, spec)
  if (compareSemver(next, pkg.version) <= 0) throw new Error(`Refusing to bump ${pkg.version} -> ${next} (must increase)`)
  log(`bumping ${pkg.name} ${pkg.version} -> ${next}`)
  if (dryRun) { log('dry-run: package.json unchanged'); return }
  writeVersion(next)
  if (!changelogHasEntry(next)) {
    log(`note: CHANGELOG.md has no [${next}] section yet — add one before tagging.`)
  }
  log('next steps:')
  log(`  1. pnpm run check && pnpm run godot:verify   (runtime gates)`)
  log(`  2. commit + push, then: git tag v${next} && git push origin v${next}`)
  log(`     (pushing the tag triggers .github/workflows/release.yml)`)
  log(`  3. or publish manually: pnpm run release:pack && node scripts/publish.mjs github`)
}

try {
  if (mode === 'pack') pack()
  else if (mode === 'npm') { ensureReleaseReady(); publishNpm() }
  else if (mode === 'github') publishGithub(existsSync(tarball) ? tarball : pack())
  else if (mode === 'all') { publishNpm(); publishGithub(pack()) }
  else if (mode === 'version') bumpCommand()
  else throw new Error('Usage: node scripts/publish.mjs pack|npm|github|all|version [...] [--dry-run] [--tag <npm-dist-tag>]')
} catch (error) {
  console.error(`[publish] failed: ${error.message}`)
  process.exitCode = 1
}
