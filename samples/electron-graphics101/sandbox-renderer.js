const report = { ...window.graphics101Probe.capabilities(), pageNode: typeof process, webgpu: Boolean(navigator.gpu) }
let received
try {
  report.callbackResult = window.graphics101Probe.checkVideoFrame(frame => {
    received = frame
    report.bridgeVideoFrame = frame instanceof VideoFrame ? 'passed' : 'wrong-type'
    report.frameWidth = frame.displayWidth
  })
  report.frameWidthAfterCallback = received.displayWidth
  report.callbackLifetime = received.displayWidth === 0 ? 'closed-by-preload-after-callback' : 'still-open'
  received.close()
} catch (error) {
  report.bridgeVideoFrame = 'failed'
  report.bridgeError = error.message
}
window.graphics101Result = report
