// V07/A-07：窗口安全开关的唯一正本——主窗口与其快照同源，不留第二套真值。
// 渲染进程当不可信：contextIsolation 隔离、nodeIntegration 关死、sandbox 开到最严。
// Electron 对开了 sandbox 的渲染层允许 preload 只用 ipcRenderer/contextBridge/webUtils——
// preload.js 恰好只用这三样（逐条核对过），renderer/index.html 无 require/process/Buffer（grep 实测）。
function hardenedWebPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function webPreferencesSnapshot() {
  return hardenedWebPreferences();
}

module.exports = { hardenedWebPreferences, webPreferencesSnapshot };
