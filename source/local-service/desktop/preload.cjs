const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oliviaDesktop", {
  getSettings: () => ipcRenderer.invoke("desktop:get-settings"),
  setAutoStart: enabled => ipcRenderer.invoke("desktop:set-auto-start", enabled),
  selectClient: () => ipcRenderer.invoke("client:select"),
  selectLibraryFolder: initialPath => ipcRenderer.invoke("midi:select-library", initialPath),
  openDirectory: path => ipcRenderer.invoke("desktop:open-directory", path),
  getClientStatus: () => ipcRenderer.invoke("client:get-status"),
  mountClient: port => ipcRenderer.invoke("client:mount", port),
  restoreClient: () => ipcRenderer.invoke("client:restore"),
  exportSoul: () => ipcRenderer.invoke("desktop:export-soul"),
  installUpdate: path => ipcRenderer.invoke("desktop:install-update", path),
  hideToTray: () => ipcRenderer.invoke("desktop:hide"),
});
