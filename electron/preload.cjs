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
  closeHelperByLabel: (label) => ipcRenderer.invoke("closeHelperByLabel", label),
  setWindowIcon: (buffer) => ipcRenderer.invoke("setWindowIcon", buffer),
  setWindowTitle: (title) => ipcRenderer.invoke("setWindowTitle", title),
  openFile: (filters) => ipcRenderer.invoke("openFile", filters),
  saveFile: (content, defaultName, filters, existingPath) =>
    ipcRenderer.invoke("saveFile", content, defaultName, filters, existingPath),
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
});
