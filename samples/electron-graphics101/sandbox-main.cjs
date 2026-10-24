const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron')
const path = require('node:path')

let window
let preloadReport
let gpuExits = 0
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU') gpuExits++
})
ipcMain.on('graphics101:preload-probe', (event, report) => {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) return
  preloadReport = report
})
app.whenReady().then(async () => {
  window = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'sandbox-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('preload-error', (_event, _file, error) => console.error(error))
  const timeout = setTimeout(() => { console.error('Sandbox probe timeout'); app.exit(1) }, 30000)
  try {
    await window.loadFile(path.join(__dirname, 'sandbox.html'))
    const renderer = await window.webContents.executeJavaScript('window.graphics101Result')
    const gpu = await app.getGPUInfo('complete')
    const result = {
      electron: process.versions.electron, chrome: process.versions.chrome,
      mainImportSharedTexture: typeof sharedTexture?.subtle?.importSharedTexture,
      mainStartTransferSharedTexture: typeof sharedTexture?.subtle?.startTransferSharedTexture,
      mainTransferSharedTexture: typeof sharedTexture?.transferSharedTexture,
      mainSubtleKeys: Object.keys(sharedTexture?.subtle ?? {}),
      preload: preloadReport, renderer, gpuExits, gpu,
      gate: 'capabilities-only; real GPU transfer not tested',
    }
    console.log(JSON.stringify(result, null, 2))
    clearTimeout(timeout)
    app.exit(renderer?.sandboxed && renderer?.contextIsolated && renderer?.pageNode === 'undefined' && gpuExits === 0 ? 0 : 1)
  } catch (error) {
    clearTimeout(timeout)
    console.error(error)
    app.exit(1)
  }
})
