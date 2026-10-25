// CI-only dependency pinning: replace local `link:` devDependencies (which point
// outside this repo, e.g. ../deepseek-harness-3d/vendor/cordis) with the registry
// version from peerDependencies so a fresh checkout installs standalone.
// Idempotent: running it on an already-pinned package.json is a no-op.
// Usage: node scripts/ci-pin-deps.mjs [--check]   (--check exits 1 if any link: remains)
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const path = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(path, 'utf8'))
const checkOnly = process.argv.includes('--check')

const linked = Object.entries(pkg.devDependencies ?? {})
  .filter(([, version]) => String(version).startsWith('link:'))
if (!linked.length) {
  console.log('[ci-pin-deps] no link: devDependencies; nothing to do')
  process.exit(0)
}
for (const [name, target] of linked) {
  const registry = pkg.peerDependencies?.[name] ?? pkg.dependencies?.[name]
  if (!registry) throw new Error(`Cannot pin ${name}: no peerDependencies/dependencies entry to take the registry version from (${target})`)
  console.log(`[ci-pin-deps] ${name}: ${target} -> ${registry}`)
  if (!checkOnly) pkg.devDependencies[name] = registry
}
if (checkOnly) {
  console.error('[ci-pin-deps] link: devDependencies still present (run: node scripts/ci-pin-deps.mjs)')
  process.exit(1)
}
writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
console.log('[ci-pin-deps] package.json pinned for CI')
