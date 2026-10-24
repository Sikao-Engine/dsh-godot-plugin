const { contextBridge, ipcRenderer, sharedTexture } = require('electron')

const report = {
  sandboxed: process.sandboxed,
  contextIsolated: process.contextIsolated,
  mainFrame: process.isMainFrame,
  sharedTexture: typeof sharedTexture,
  subtle: typeof sharedTexture?.subtle,
  finishTransferSharedTexture: typeof sharedTexture?.subtle?.finishTransferSharedTexture,
  setSharedTextureReceiver: typeof sharedTexture?.setSharedTextureReceiver,
  videoFrame: typeof VideoFrame,
  bridgeVideoFrame: 'not-tested',
  transferLifecycle: 'not-tested',
}

if (process.isMainFrame && location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('graphics101Probe', {
    capabilities: () => report,
    checkVideoFrame: (callback) => {
      const canvas = new OffscreenCanvas(2, 2)
      canvas.getContext('2d').fillRect(0, 0, 2, 2)
      const frame = new VideoFrame(canvas, { timestamp: 0 })
      try {
        callback(frame)
        return { callbackReturned: true }
      } finally {
        frame.close()
      }
    },
  })
}
ipcRenderer.send('graphics101:preload-probe', report)
