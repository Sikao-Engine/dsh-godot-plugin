import { writeFileSync } from 'node:fs'
const port = process.env.DSH_DEBUG_PORT ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find(p => p.type === 'page' && p.url.startsWith('dsh-app://app')) ?? targets.find(p => p.type === 'page') ?? targets[0]
if (!target) throw new Error('Desktop page unavailable')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
let seq = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const data = JSON.parse(event.data)
  if (!data.id) return
  const task = pending.get(data.id)
  if (!task) return
  pending.delete(data.id); clearTimeout(task.timer)
  data.error ? task.reject(new Error(JSON.stringify(data.error))) : task.resolve(data.result)
})
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, 120000)
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
})
try {
  if (process.argv[2] === 'screenshot') {
    const result = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(new URL('../.graphics101-results/dsh-desktop.png', import.meta.url), Buffer.from(result.data, 'base64'))
  } else {
    const expression = process.argv[2] ?? 'JSON.stringify({url:location.href,text:document.body.innerText,buttons:[...document.querySelectorAll("button")].map(x=>({text:x.innerText,aria:x.getAttribute("aria-label")})),native:globalThis.dshDesktop?.nativeViewports?.capabilities})'
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    console.log(typeof result.result.value === 'string' ? result.result.value : JSON.stringify(result.result))
  }
} finally { socket.close() }
