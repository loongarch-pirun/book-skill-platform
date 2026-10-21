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
  // 删书第二档（V3 #168 两档删除）：库 + books/ 原件一体删，不可恢复
  purgeBook: (bookId) => ipcRenderer.invoke("books:purge", bookId),
  // 导入管线（V3 #167 拆两段：importBook 只复制原件进书架；jobsStart 才是切片→向量化→编目）
  importBook: (filePath) => ipcRenderer.invoke("books:import", filePath),
  jobsStart: (bookId) => ipcRenderer.invoke("jobs:start", bookId),
  // Electron 32+ 已移除 File.path（官方破坏性变更）——拖拽文件取真实路径只能走 webUtils
  // （webUtils 仅在 preload 可用，渲染层经这里转发）
  filePathOf: (file) => webUtils.getPathForFile(file),
  jobsStatus: () => ipcRenderer.invoke("jobs:status"),
  jobsScanPending: () => ipcRenderer.invoke("jobs:scanPending"), // G-04：启动/换库后扫描「待编目」恢复横幅
  jobsCancel: (bookId) => ipcRenderer.invoke("jobs:cancel", bookId),
  jobsPickResult: () => ipcRenderer.invoke("jobs:pickResult"),
  jobsResumeCatalog: (bookId, resultPath) => ipcRenderer.invoke("jobs:resumeCatalog", bookId, resultPath || null),
  jobsCatalogPrompt: (bookId) => ipcRenderer.invoke("jobs:catalogPrompt", bookId), // 一键生成编目提示词
  // 洗数据一键入口（V3 #140）：书架卡片按钮 → 主进程跑批入库（进度走 enrich:progress 事件）
  enrichStart: (bookId) => ipcRenderer.invoke("enrich:start", bookId),
  enrichCancel: (bookId) => ipcRenderer.invoke("enrich:cancel", bookId),
  enrichStatus: () => ipcRenderer.invoke("enrich:status"),
  enrichAudit: (bookId) => ipcRenderer.invoke("enrich:audit", bookId),
  // 问一问
  ask: (payload) => ipcRenderer.invoke("ask:query", payload),
  // 云端问答（V2 P2）：配置 / 测试连接 / 云端总结
  llmConfigGet: () => ipcRenderer.invoke("llm:configGet"),
  llmConfigSet: (patch) => ipcRenderer.invoke("llm:configSet", patch),
  llmTest: () => ipcRenderer.invoke("llm:test"),
  chatSummary: (payload) => ipcRenderer.invoke("chat:summary", payload),
  // 对话记忆压缩（V3-R6）：旧轮次 → 要点记忆（渲染层持有；BSP_MEMORY=0 时主进程优雅跳过）
  chatCompact: (payload) => ipcRenderer.invoke("chat:compact", payload),
  // 云端回答存档（V2 P4）：翻历史 / 清空（删书联动走 books:delete，无需新 API）
  chatArchiveList: (payload) => ipcRenderer.invoke("chat:archiveList", payload),
  chatArchiveClear: () => ipcRenderer.invoke("chat:archiveClear"),
  // 翻书
  chapters: (bookId) => ipcRenderer.invoke("reader:chapters", bookId),
  block: (bookId, chapter) => ipcRenderer.invoke("reader:block", bookId, chapter),
  locate: (bookId, chunkId) => ipcRenderer.invoke("reader:locate", bookId, chunkId),
  // 翻书·编目资产
  readerThemes: (bookId) => ipcRenderer.invoke("reader:themes", bookId),
  readerThemeBlocks: (bookId, theme) => ipcRenderer.invoke("reader:themeBlocks", bookId, theme),
  readerPersons: (bookId) => ipcRenderer.invoke("reader:persons", bookId),
  readerPersonBlocks: (bookId, person) => ipcRenderer.invoke("reader:personBlocks", bookId, person),
  // 原书视图（V3 #166）：原件元信息 + 系统程序打开（book:// 协议内容由渲染层直接 fetch）
  bookOriginal: (bookId) => ipcRenderer.invoke("book:original", bookId),
  bookOpenExternal: (bookId) => ipcRenderer.invoke("book:openExternal", bookId),
  // 技能
  skillsList: () => ipcRenderer.invoke("skills:list"),
  skillRead: (slug, chapter) => ipcRenderer.invoke("skills:read", slug, chapter),
  skillToggle: (bookId, enabled) => ipcRenderer.invoke("skills:toggle", bookId, enabled),
  skillDelete: (slug) => ipcRenderer.invoke("skills:delete", slug),
  skillHealthCheck: () => ipcRenderer.invoke("skills:health"),
  // 对外服务用量治理（W1）：开关/定时/预算 + 当日用量
  usageGet: () => ipcRenderer.invoke("usage:get"),
  usageSet: (patch) => ipcRenderer.invoke("usage:set", patch),
  // 引擎
  engineStatus: () => ipcRenderer.invoke("engine:status"),
  warmup: () => ipcRenderer.invoke("engine:warmup"),
  // 事件（主 → 渲染）
  onModelProgress: (cb) => ipcRenderer.on("model:progress", (_e, d) => cb(d)),
  onEngineReady: (cb) => ipcRenderer.on("engine:ready", (_e, d) => cb(d)),
  onEngineError: (cb) => ipcRenderer.on("engine:error", (_e, d) => cb(d)),
  onJobsProgress: (cb) => ipcRenderer.on("jobs:progress", (_e, d) => cb(d)),
  onEnrichProgress: (cb) => ipcRenderer.on("enrich:progress", (_e, d) => cb(d)),
});
