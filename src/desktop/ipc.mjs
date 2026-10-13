// IPC 通道注册：主进程与端到端冒烟脚本共用同一份注册逻辑
// （与 register-tools.mjs 同一哲学：一份注册，两处消费）
// 每个 handler 返回 { ok, data } 或 { ok:false, error:{code,message} }——UI 不崩（M3）
import * as engine from "./engine.mjs";
import * as jobs from "./jobs.mjs";

export async function registerIpc({ ipcMain, app, dialog, getWin }) {
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
  handle("books:delete", (eng, bookId) => eng.deleteBook(bookId));
  // 导入管线（4.6：H1 直调 lib 四函数 / H2 require 复用 + spawn 显式传参）
  handle("books:import", (eng, filePath) => jobs.startImport(filePath));
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

  // 问一问
  handle("ask:query", (eng, payload) => eng.ask(payload));

  // 翻书
  handle("reader:chapters", (eng, bookId) => eng.readerChapters(bookId));
  handle("reader:block", (eng, bookId, chapter) => eng.readerBlock(bookId, chapter));
  handle("reader:locate", (eng, bookId, chunkId) => eng.locateChunk(bookId, chunkId));
  // 翻书·编目资产（主题分区 / 人物表）
  handle("reader:themes", (eng, bookId) => eng.readerThemes(bookId));
  handle("reader:themeBlocks", (eng, bookId, theme) => eng.readerThemeBlocks(bookId, theme));
  handle("reader:persons", (eng, bookId) => eng.readerPersons(bookId));
  handle("reader:personBlocks", (eng, bookId, person) => eng.readerPersonBlocks(bookId, person));

  // 技能
  handle("skills:list", (eng) => eng.skillsList());
  handle("skills:read", (eng, slug, chapter) => eng.skillRead(slug, chapter));
  handle("skills:toggle", (eng, bookId, enabled) => eng.skillToggle(bookId, enabled));

  // 引擎
  handle("engine:status", (eng) => eng.engineStatus());
  handle("engine:warmup", (eng) => eng.warmup());

  return engine;
}
