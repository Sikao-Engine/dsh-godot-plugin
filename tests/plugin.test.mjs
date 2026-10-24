import assert from 'node:assert/strict'
import test from 'node:test'
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

test('Cordis mounts, disposes and remounts the bootstrap service', async () => {
  const ctx = new Context()
  try {
    for (let i = 0; i < 2; i++) {
      const fiber = ctx.plugin(GodotIntegration)
      await fiber.inertia
      assert.deepEqual(ctx.godotIntegration.status(), {
        plugin: 'dsh-godot-plugin', phase: 'bootstrap', runtimeEmbedded: false,
      })
      await fiber.dispose()
      assert.equal(ctx.get('godotIntegration'), undefined)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
