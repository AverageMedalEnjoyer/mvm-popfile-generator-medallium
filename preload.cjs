const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mpcFs", {
  ensureDirs: () => ipcRenderer.invoke("mpc:ensureDirs"),
  listSaves: () => ipcRenderer.invoke("mpc:listSaves"),
  writeSave: (filename, content) => ipcRenderer.invoke("mpc:writeSave", filename, content),
  readSave: (filename) => ipcRenderer.invoke("mpc:readSave", filename),
  // debug helper so you can confirm the bridge is live
  getRoot: () => ipcRenderer.invoke("mpc:getRoot"),
});
