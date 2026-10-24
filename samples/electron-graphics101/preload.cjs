const { contextBridge, ipcRenderer, sharedTexture } = require('electron')
let frameHandler, eventHandler
const subtle = sharedTexture?.subtle
if (process.isMainFrame && location.protocol === 'file:') {
  ipcRenderer.on('g101:frame', async (_event, meta, transfer) => {
    let imported, frame
    try {
      imported = subtle.finishTransferSharedTexture(transfer)
      if (!frameHandler) throw new Error('Presenter missing')
      frame = imported.getVideoFrame()
      await frameHandler(frame, meta)
      frame.close(); frame = null
      imported.release(() => ipcRenderer.send('g101:done', meta))
      imported = null
    } catch (error) {
      frame?.close()
      imported?.release()
      ipcRenderer.send('g101:error', error.message)
    }
  })
  ipcRenderer.on('g101:event', (_event, data) => eventHandler?.(data))
  contextBridge.exposeInMainWorld('graphics101', {
    capabilities: { sharedTexture: typeof subtle?.finishTransferSharedTexture === 'function', sandboxed: process.sandboxed, contextIsolated: process.contextIsolated },
    onFrame: callback => { frameHandler = callback },
    onEvent: callback => { eventHandler = callback },
    hello: caps => ipcRenderer.invoke('g101:hello', caps),
    control: data => ipcRenderer.send('g101:control', data),
    reportError: message => ipcRenderer.send('g101:error', String(message)),
    smokeDone: report => ipcRenderer.send('g101:smoke', report),
  })
}
