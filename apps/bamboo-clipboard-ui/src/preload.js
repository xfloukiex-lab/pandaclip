const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lens", {
  bootstrap: () => ipcRenderer.invoke("lens:bootstrap"),
  onEvent: (fn) => ipcRenderer.on("lens:event", (_e, p) => fn(p)),
  onClipboard: (fn) => ipcRenderer.on("lens:clipboard", (_e, p) => fn(p)),
  onProjects: (fn) => ipcRenderer.on("lens:projects", (_e, p) => fn(p)),
  onStatus: (fn) => ipcRenderer.on("lens:status", (_e, p) => fn(p)),
  overlayHide: () => ipcRenderer.send("lens:overlay-hide"),
  overlayToggle: () => ipcRenderer.send("lens:overlay-toggle"),
  openMain: () => ipcRenderer.send("lens:overlay-open-main"),
});
