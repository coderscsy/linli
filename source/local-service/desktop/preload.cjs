const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oliviaDesktop", {
  getSettings: () => ipcRenderer.invoke("desktop:get-settings"),
  setAutoStart: enabled => ipcRenderer.invoke("desktop:set-auto-start", enabled),
  selectClient: () => ipcRenderer.invoke("client:select"),
  getClientStatus: () => ipcRenderer.invoke("client:get-status"),
  mountClient: port => ipcRenderer.invoke("client:mount", port),
  restoreClient: () => ipcRenderer.invoke("client:restore"),
  exportSoul: () => ipcRenderer.invoke("desktop:export-soul"),
  hideToTray: () => ipcRenderer.invoke("desktop:hide"),
});
