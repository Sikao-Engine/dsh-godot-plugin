import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = resolve(process.env.DSH_SOURCE_DIR ?? resolve(root, '../../ai/deepseek-harness'))
const overlay = resolve(root, '.dsh-dev/host-observer.patch.json')
await mkdir(resolve(root, '.dsh-dev'), { recursive: true })
const template = JSON.parse(await readFile(new URL('../tests/host-observer.patch.json', import.meta.url), 'utf8'))
template[0].insert[0].name = new URL('../tests/host-observer.mjs', import.meta.url).href
await writeFile(overlay, JSON.stringify(template))
const child = spawn(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--patch', overlay, '--port', '0', '--no-open',
], { cwd: source, env: { ...process.env, DSH_HOME: resolve(root, '.dsh-dev/home') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
let output = ''
const ready = Promise.withResolvers()
const mounted = Promise.withResolvers()
child.stdout.on('data', chunk => {
  output += chunk
  const url = /dsh web: (http:\/\/[^\s]+)/.exec(output)?.[1]
  if (url) ready.resolve(url)
})
child.stderr.on('data', chunk => { output += chunk })
child.on('message', message => {
  if (message.type === 'godot-bootstrap') mounted.resolve(message.status)
})
child.on('error', error => { ready.reject(error); mounted.reject(error) })
child.on('exit', code => {
  const error = new Error(`Web exited (${code}) before assertions completed`)
  ready.reject(error)
  mounted.reject(error)
})
const deadline = Promise.withResolvers()
const timer = setTimeout(() => deadline.reject(new Error('Web smoke timed out after 90 seconds')), 90000)
function get(url, cookie) {
  return new Promise((done, fail) => {
    const req = request(url, { headers: cookie ? { cookie } : {}, timeout: 15000 }, res => {
      let text = ''
      res.setEncoding('utf8').on('data', chunk => { text += chunk })
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, text }))
      res.on('error', fail)
    })
    req.on('timeout', () => req.destroy(new Error('HTTP smoke timed out')))
    req.on('error', fail)
    req.end()
  })
}
try {
  await Promise.race([(async () => {
    const [url, status] = await Promise.all([ready.promise, mounted.promise])
    assert.deepEqual(status, { plugin: 'dsh-godot-plugin', phase: 'bootstrap', runtimeEmbedded: false })
    const first = await get(url)
    const page = first.status === 303
      ? await get(new URL(first.headers.location, url), first.headers['set-cookie']?.map(value => value.split(';')[0]).join('; '))
      : first
    assert.equal(page.status, 200)
    assert.match(page.text, /<html/i)
    console.log('PASS: default Web host, authenticated HTML, and actual ctx.godotIntegration service')
  })(), deadline.promise])
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  child.kill()
}
