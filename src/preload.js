// preload：contextBridge 把 window.study.* 暴露给渲染进程
// 铁律：只转发 IPC，不暴露任何 Node 能力（渲染进程纯前端，碰不到 fs/sqlite）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("study", {
  // 配置 / 首启向导
  configGet: () => ipcRenderer.invoke("config:get"),
  configSet: (patch) => ipcRenderer.invoke("config:set", patch),
  pickLibDir: () => ipcRenderer.invoke("config:pickLibDir"),
  // 书架
  booksList: () => ipcRenderer.invoke("books:list"),
  bookCatalog: (bookId) => ipcRenderer.invoke("books:catalog", bookId),
  deleteBook: (bookId) => ipcRenderer.invoke("books:delete", bookId),
  // 问一问
  ask: (payload) => ipcRenderer.invoke("ask:query", payload),
  // 翻书
  chapters: (bookId) => ipcRenderer.invoke("reader:chapters", bookId),
  block: (bookId, chapter) => ipcRenderer.invoke("reader:block", bookId, chapter),
  locate: (bookId, chunkId) => ipcRenderer.invoke("reader:locate", bookId, chunkId),
  // 技能
  skillsList: () => ipcRenderer.invoke("skills:list"),
  skillRead: (slug, chapter) => ipcRenderer.invoke("skills:read", slug, chapter),
  skillToggle: (bookId, enabled) => ipcRenderer.invoke("skills:toggle", bookId, enabled),
  // 引擎
  engineStatus: () => ipcRenderer.invoke("engine:status"),
  warmup: () => ipcRenderer.invoke("engine:warmup"),
  // 事件（主 → 渲染）
  onModelProgress: (cb) => ipcRenderer.on("model:progress", (_e, d) => cb(d)),
  onEngineReady: (cb) => ipcRenderer.on("engine:ready", (_e, d) => cb(d)),
  onEngineError: (cb) => ipcRenderer.on("engine:error", (_e, d) => cb(d)),
});
