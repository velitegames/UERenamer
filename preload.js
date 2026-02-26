const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("projectApi", {
  pickUproject: () => ipcRenderer.invoke("project:pick-uproject"),
  rescanProject: (payload) => ipcRenderer.invoke("project:rescan", payload),
  previewRename: (payload) => ipcRenderer.invoke("project:preview-rename", payload),
  applyRename: (payload) => ipcRenderer.invoke("project:apply-rename", payload),
});
