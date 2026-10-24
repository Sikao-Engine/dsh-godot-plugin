import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const source = resolve(process.env.DSH_SOURCE_DIR ?? [resolve(root, '../deepseek-harness-3d'), resolve(root, '../../ai/deepseek-harness')].find(candidate => existsSync(join(candidate, 'package.json'))) ?? resolve(root, '../deepseek-harness-3d'))
const files = ['graphics101.exe', 'shaders/triangle.vert.spv', 'shaders/triangle.frag.spv']
const hashes = {}
for (const file of files) {
  const target = `native/win32-x64/${file}`
  mkdirSync(resolve(root, target, '..'), { recursive: true })
  copyFileSync(resolve(root, 'native/graphics101/build/Release', file), resolve(root, target))
  hashes[target] = createHash('sha256').update(readFileSync(resolve(root, target))).digest('hex')
}
const commit = directory => execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
writeFileSync(resolve(root, 'runtime-manifest.json'), JSON.stringify({
  protocol: 2, platform: 'win32-x64', backend: 'vulkan', electron: '44.7.0', dsh: '0.2.1-rc.3',
  requiredCapability: 'dshDesktop.nativeViewports/v2 (experimental fork)', executable: 'native/win32-x64/graphics101.exe',
  runtimeCpuReadbacks: 0, exportGpuCopies: 0, pluginCommit: commit(root), dshCommit: commit(source),
  toolchain: JSON.parse(readFileSync(resolve(root, 'native/graphics101/build/build-toolchain.json'), 'utf8')),
  requirements: ['Windows x64', 'Vulkan driver with D3D11_TEXTURE external memory import', 'Vulkan loader supplied by GPU driver'], files: hashes,
}, null, 2) + '\n')
console.log('Release runtime staged; no SDK, compiler, or validation layer required at runtime.')
