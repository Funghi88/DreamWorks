const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  getSettings: () => ipcRenderer.invoke("getSettings"),
  saveSettings: (settings) => ipcRenderer.invoke("saveSettings", settings),
  setCompactMode: (position, width, height) =>
    ipcRenderer.invoke("setCompactMode", position, width, height),
  setNormalMode: () => ipcRenderer.invoke("setNormalMode"),
  openHelperWindow: (kind) => ipcRenderer.invoke("openHelperWindow", kind),
  closeHelperByLabel: (label) => ipcRenderer.invoke("closeHelperByLabel", label),
  setWindowIcon: (buffer) => ipcRenderer.invoke("setWindowIcon", buffer),
  startEmbeddedSignaling: () => ipcRenderer.invoke("startEmbeddedSignaling"),
  stopEmbeddedSignaling: () => ipcRenderer.invoke("stopEmbeddedSignaling"),
});
