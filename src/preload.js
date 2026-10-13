// preload：contextBridge 把 window.study.* 暴露给渲染进程
// 铁律：只转发 IPC，不暴露任何 Node 能力（渲染进程纯前端，碰不到 fs/sqlite）
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("study", {
  // 配置 / 首启向导
  configGet: () => ipcRenderer.invoke("config:get"),
  configSet: (patch) => ipcRenderer.invoke("config:set", patch),
  pickLibDir: () => ipcRenderer.invoke("config:pickLibDir"),
  // 书架
  booksList: () => ipcRenderer.invoke("books:list"),
  bookCatalog: (bookId) => ipcRenderer.invoke("books:catalog", bookId),
  deleteBook: (bookId) => ipcRenderer.invoke("books:delete", bookId),
  // 导入管线
  importBook: (filePath) => ipcRenderer.invoke("books:import", filePath),
  // Electron 32+ 已移除 File.path（官方破坏性变更）——拖拽文件取真实路径只能走 webUtils
  // （webUtils 仅在 preload 可用，渲染层经这里转发）
  filePathOf: (file) => webUtils.getPathForFile(file),
  jobsStatus: () => ipcRenderer.invoke("jobs:status"),
  jobsCancel: (bookId) => ipcRenderer.invoke("jobs:cancel", bookId),
  jobsPickResult: () => ipcRenderer.invoke("jobs:pickResult"),
  jobsResumeCatalog: (bookId, resultPath) => ipcRenderer.invoke("jobs:resumeCatalog", bookId, resultPath || null),
  // 问一问
  ask: (payload) => ipcRenderer.invoke("ask:query", payload),
  // 翻书
  chapters: (bookId) => ipcRenderer.invoke("reader:chapters", bookId),
  block: (bookId, chapter) => ipcRenderer.invoke("reader:block", bookId, chapter),
  locate: (bookId, chunkId) => ipcRenderer.invoke("reader:locate", bookId, chunkId),
  // 翻书·编目资产
  readerThemes: (bookId) => ipcRenderer.invoke("reader:themes", bookId),
  readerThemeBlocks: (bookId, theme) => ipcRenderer.invoke("reader:themeBlocks", bookId, theme),
  readerPersons: (bookId) => ipcRenderer.invoke("reader:persons", bookId),
  readerPersonBlocks: (bookId, person) => ipcRenderer.invoke("reader:personBlocks", bookId, person),
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
  onJobsProgress: (cb) => ipcRenderer.on("jobs:progress", (_e, d) => cb(d)),
});
