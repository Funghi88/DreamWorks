const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  getHardwareModel: () => ipcRenderer.invoke("getHardwareModel"),
  getSettings: () => ipcRenderer.invoke("getSettings"),
  saveSettings: (settings) => ipcRenderer.invoke("saveSettings", settings),
  setCompactMode: (position, width, height) =>
    ipcRenderer.invoke("setCompactMode", position, width, height),
  setNormalMode: () => ipcRenderer.invoke("setNormalMode"),
  setBackgroundThrottling: (throttlingEnabled) =>
    ipcRenderer.invoke("setBackgroundThrottling", throttlingEnabled),
  openHelperWindow: (kind) => ipcRenderer.invoke("openHelperWindow", kind),
  openTeleprompterSlimWindow: () => ipcRenderer.invoke("openTeleprompterSlimWindow"),
  closeHelperByLabel: (label) => ipcRenderer.invoke("closeHelperByLabel", label),
  getHelperWindowBounds: (label) => ipcRenderer.invoke("getHelperWindowBounds", label),
  setHelperWindowBounds: (label, bounds) => ipcRenderer.invoke("setHelperWindowBounds", label, bounds),
  setWindowIcon: (buffer) => ipcRenderer.invoke("setWindowIcon", buffer),
  setWindowTitle: (title) => ipcRenderer.invoke("setWindowTitle", title),
  openFile: (filters) => ipcRenderer.invoke("openFile", filters),
  openTextFiles: (options) => ipcRenderer.invoke("openTextFiles", options),
  saveFile: (content, defaultName, filters, existingPath) =>
    ipcRenderer.invoke("saveFile", content, defaultName, filters, existingPath),
  getDefaultSavePath: () => ipcRenderer.invoke("getDefaultSavePath"),
  saveImage: (base64, defaultName) =>
    ipcRenderer.invoke("saveImage", base64, defaultName),
  startEmbeddedSignaling: () => ipcRenderer.invoke("startEmbeddedSignaling"),
  stopEmbeddedSignaling: () => ipcRenderer.invoke("stopEmbeddedSignaling"),
  requestCameraAccess: () => ipcRenderer.invoke("requestCameraAccess"),
  onDisplayMediaPicker: (handler) => {
    const ch = "display-media-picker";
    const listener = (_event, sources) => handler(sources);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
  },
  displayMediaPick: (sourceId) => ipcRenderer.invoke("displayMediaPick", sourceId),
  displayMediaCancel: () => ipcRenderer.invoke("displayMediaCancel"),
  voskModelPath: (lang) => ipcRenderer.invoke("vosk:modelPath", lang),
  voskInit: (modelPath) => ipcRenderer.invoke("vosk:init", modelPath),
  /* ArrayBuffer slice is a copy; main does Buffer.from(ab) — reliable across IPC. */
  voskFeed: (int16) => {
    const ab = int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength);
    return ipcRenderer.invoke("vosk:feed", ab);
  },
  voskReset: () => ipcRenderer.invoke("vosk:reset"),
  voskRelease: () => ipcRenderer.invoke("vosk:release"),
});
