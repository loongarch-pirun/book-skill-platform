// IPC 通道注册：主进程与端到端冒烟脚本共用同一份注册逻辑
// （与 register-tools.mjs 同一哲学：一份注册，两处消费）
// 每个 handler 返回 { ok, data } 或 { ok:false, error:{code,message} }——UI 不崩（M3）
import * as engine from "./engine.mjs";
import * as jobs from "./jobs.mjs";
import * as chat from "./chat.mjs";
import * as enrichJob from "./enrich-job.mjs";

export async function registerIpc({ ipcMain, app, dialog, shell, getWin }) {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(engine, ...args) }; }
    catch (err) { return { ok: false, error: engine.humanizeError(err) }; }
  });

  // 配置 / 首启向导
  handle("config:get", (eng) => ({ dirs: eng.dirs(), firstRun: eng.isFirstRun(), packaged: app.isPackaged }));
  handle("config:set", (eng, patch) => eng.applyConfig(patch));
  handle("config:pickLibDir", async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      properties: ["openDirectory"],
      title: "选择书库文件夹（里面有 .db 文件的那个）",
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // 书架
  handle("books:list", (eng) => eng.booksList());
  handle("books:catalog", (eng, bookId) => eng.bookCatalog(bookId));
  // 删书两档（P4 联动 + V3 第四波 #168）：
  //   第一档 books:delete「移出书架」= 只删库文件，books/ 原件保留（书架回 raw，可重新加工）；
  //   第二档 books:purge「彻底删除」= 库 + 原件一体删（渲染层确认清单先行，不可恢复）。
  // 两档都连引用这本书的云端回答存档/反馈样本一起清——不给"删除残留"添新尾巴；
  // 清了几条回进 note，UI toast 告知（清理失败不挡删书本体，purgeArchives 内部已兜底）
  handle("books:delete", async (eng, bookId) => {
    const r = eng.deleteBook(bookId);
    const purged = chat.purgeArchives(bookId);
    return purged > 0 ? { ...r, note: `${r.note}；已连 ${purged} 条引用这本书的存档/反馈样本一起删除` } : r;
  });
  handle("books:purge", async (eng, bookId) => {
    const r = eng.purgeBook(bookId);
    const purged = chat.purgeArchives(bookId);
    return purged > 0 ? { ...r, note: `${r.note}；已连 ${purged} 条引用这本书的存档/反馈样本一起删除` } : r;
  });
  // 导入管线（4.6：H1 直调 lib 四函数 / H2 require 复用 + spawn 显式传参；
  //   V3 #167 拆两段：books:import 只复制登记，jobs:start 才是切片→向量化→编目）
  handle("books:import", (eng, filePath) => jobs.startImport(filePath));
  handle("jobs:start", (eng, bookId) => jobs.startProcessing(bookId));
  handle("jobs:status", () => jobs.jobsStatus());
  handle("jobs:cancel", (eng, bookId) => jobs.cancelImport(bookId));
  handle("jobs:scanPending", () => jobs.scanPending());
  handle("jobs:pickResult", async () => {
    const r = await dialog.showOpenDialog(getWin(), {
      properties: ["openFile"],
      filters: [{ name: "编目结果 JSON", extensions: ["json"] }],
      title: "选择编目结果 JSON（catalog-results/ 里智能体产出的那个）",
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle("jobs:resumeCatalog", (eng, bookId, resultPath) => jobs.resumeCatalog(bookId, resultPath || null));
  handle("jobs:catalogPrompt", (eng, bookId) => jobs.catalogPrompt(bookId));

  // 洗数据一键入口（V3 第二波 #140）：启动/取消/状态/库侧复查（进度走 enrich:progress 事件）
  handle("enrich:start", (eng, bookId) => enrichJob.startEnrich(bookId));
  handle("enrich:cancel", (eng, bookId) => enrichJob.cancelEnrich(bookId));
  handle("enrich:status", () => enrichJob.enrichStatus());
  handle("enrich:audit", (eng, bookId) => enrichJob.enrichAudit(bookId));

  // 问一问
  handle("ask:query", (eng, payload) => eng.ask(payload));

  // 云端问答（V2 P2）：配置 / 测试连接 / 云端总结（固定管道：本地检索 → 云端生成 → 引用校验）
  handle("llm:configGet", () => chat.configGet());
  handle("llm:configSet", (eng, patch) => chat.configSet(patch));
  handle("llm:test", () => chat.testConnection());
  handle("chat:summary", (eng, payload) => chat.cloudSummary(payload));
  // 云端回答存档（V2 P4）：列表（翻历史）/ 清空；删书联动在 books:delete（连引该书存档一起清）
  handle("chat:archiveList", (eng, payload) => chat.archiveList(payload));
  handle("chat:archiveClear", () => chat.archiveClear());
  // 对话记忆压缩（V3-R6）：渲染层历史变长时调用，旧轮次 → ≤200 字要点（BSP_MEMORY=0 关）
  handle("chat:compact", (eng, payload) => chat.compactHistory(payload || {}));

  // 翻书
  handle("reader:chapters", (eng, bookId) => eng.readerChapters(bookId));
  handle("reader:block", (eng, bookId, chapter) => eng.readerBlock(bookId, chapter));
  handle("reader:locate", (eng, bookId, chunkId) => eng.locateChunk(bookId, chunkId));
  // 翻书·编目资产（主题分区 / 人物表）
  handle("reader:themes", (eng, bookId) => eng.readerThemes(bookId));
  handle("reader:themeBlocks", (eng, bookId, theme) => eng.readerThemeBlocks(bookId, theme));
  handle("reader:persons", (eng, bookId) => eng.readerPersons(bookId));
  handle("reader:personBlocks", (eng, bookId, person) => eng.readerPersonBlocks(bookId, person));

  // 原书视图（V3 #166）：book:// 协议读 books/ 原件（协议 handler 在 main.js 注册）；
  // openExternal 用系统程序打开（shell 由主进程注入，engine 不直接碰 electron）
  handle("book:original", (eng, bookId) => eng.bookOriginal(bookId));
  handle("book:openExternal", async (eng, bookId) => {
    const p = eng.bookAssetPath(bookId);
    const err = await shell.openPath(p);
    if (err) throw new engine.UserError(`系统打不开这个文件：${err}（可以手动去 books/ 文件夹找 ${p}）`);
    return { opened: p };
  });

  // 技能
  handle("skills:list", (eng) => eng.skillsList());
  handle("skills:read", (eng, slug, chapter) => eng.skillRead(slug, chapter));
  handle("skills:toggle", (eng, bookId, enabled) => eng.skillToggle(bookId, enabled));

  // 引擎
  handle("engine:status", (eng) => eng.engineStatus());
  handle("engine:warmup", (eng) => eng.warmup());

  return engine;
}
