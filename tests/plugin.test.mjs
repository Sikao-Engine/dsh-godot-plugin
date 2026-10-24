import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { runInNewContext } from 'node:vm'
import GodotIntegration from '../lib/index.js'

test('bundle points to the public plugin entry', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal(manifest.name, 'dsh-godot-plugin')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(patch, /name: dsh-godot-plugin/)
})

test('built client registers a usable plugin factory', async () => {
  let registration
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { registration = value } } } })
  assert.equal(registration.id, 'dsh-godot-plugin')
  const client = registration.factory(name => {
    assert.equal(name, 'react')
    return { createElement() {}, useEffect() {}, useRef() {}, useState() {} }
  })
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'sidebarRightTabs'])
})

test('Cordis mounts, disposes and remounts the worker service', async () => {
  const ctx = new Context()
  try {
    for (let i = 0; i < 2; i++) {
      const fiber = ctx.plugin(GodotIntegration)
      await fiber.inertia
      const status = ctx.godotIntegration.status()
      assert.equal(status.plugin, 'dsh-godot-plugin')
      assert.equal(status.phase, 'worker')
      // The status must honestly reflect which worker manifests are staged.
      const manifests = existsSync(new URL('../runtime-manifest.json', import.meta.url)) ? 1 : 0
      assert.equal(status.runtimeEmbedded, manifests > 0)
      assert.deepEqual(status.producers.slice(0, 1), manifests ? ['dsh-godot-plugin/godot'] : [])
      await fiber.dispose()
      assert.equal(ctx.get('godotIntegration'), undefined)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('staged runtime manifest matches the Godot worker contract', async () => {
  const manifestPath = new URL('../runtime-manifest.json', import.meta.url)
  if (!existsSync(manifestPath)) return // staging is a separate step; see doc/acceptance/build-and-package.zh.md
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.protocol, 2)
  assert.equal(manifest.producer, 'dsh-godot-plugin/godot')
  assert.equal(manifest.executable, 'native/win32-x64/dsh-godot-worker.exe')
  assert.deepEqual(manifest.extensions, ['godot.demo.v1'])
  assert.match(manifest.files['native/win32-x64/dsh-godot-worker.exe'], /^[a-f0-9]{64}$/)
})

test('staged editor manifest matches the editor worker contract', async () => {
  const manifestPath = new URL('../runtime-manifest.editor.json', import.meta.url)
  if (!existsSync(manifestPath)) return // requires `pnpm run godot:stage:editor`
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.protocol, 2)
  assert.equal(manifest.producer, 'dsh-godot-plugin/godot-editor')
  assert.equal(manifest.executable, 'native/win32-x64/dsh-godot-editor.exe')
  assert.equal(manifest.editorMode, true)
  assert.equal(manifest.projectDir, 'native/editor-project')
  assert.match(manifest.files['native/win32-x64/dsh-godot-editor.exe'], /^[a-f0-9]{64}$/)
})
