const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api", {
  sqliteTest: () => ipcRenderer.invoke("sqlite-test"),
});
