// 我的书房：Electron 主进程（窗口 + 启动编排）
// 架构：主进程 CJS → 动态 import ipc.mjs（注册全部通道）→ engine.mjs（ESM 桥接层）→ lib 引擎库。
// STONE3 环境变量 = 试金石自检模式（打包冒烟用，勿删）。
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 780,
    backgroundColor: "#f5f1e8", // 书房纸色，避免启动白闪
    title: "我的书房",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile("index.html");
}

async function boot() {
  const { registerIpc } = await import(pathToFileURL(path.join(__dirname, "desktop", "ipc.mjs")).href);
  const engine = await registerIpc({ ipcMain, app, dialog, getWin: () => win });
  // 引擎初始化（三层目录解析 → 注入 lib）；模型下载进度 → 渲染进程
  engine.init({ packaged: app.isPackaged, userData: app.getPath("userData") });
  engine.onModelProgress((e) => {
    if (win && !win.isDestroyed()) win.webContents.send("model:progress", e);
  });
  return engine;
}

app.whenReady().then(async () => {
  if (process.env.STONE3) {
    // 试金石自检模式：跑完测试写结果文件后自动退出
    const fs = require("fs");
    let result;
    try {
      const db = new (require("better-sqlite3"))(":memory:");
      const ver = db.prepare("select sqlite_version() v").get().v;
      db.exec(`CREATE TABLE chunks(id INTEGER PRIMARY KEY, page INTEGER, text TEXT);
        CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
      const ins = db.prepare("INSERT INTO chunks(page,text) VALUES (?,?)");
      for (const [p, t] of [[1, "學而時習之"], [2, "檢索增強生成讓回答錨定原文"]]) {
        ins.run(p, t);
        db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES ((select id from chunks where text=?), ?)").run(t, t);
      }
      const hit = db.prepare(`SELECT c.page FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?`).all('"檢索增強生成"');
      db.close();
      result = { ok: hit.length === 1 && hit[0].page === 2, sqlite: ver };
    } catch (e) { result = { ok: false, error: e.message }; }
    fs.writeFileSync(path.join(app.getPath("temp"), "stone3-result.json"), JSON.stringify(result));
    app.quit();
    return;
  }

  // 引擎初始化失败也要把窗口开起来（UI 会显示错误，不是白屏）
  let engine = null;
  try { engine = await boot(); }
  catch (e) { console.error("[boot] 引擎初始化失败：", e); }
  createWindow();
  // 后台预热嵌入模型（不阻塞窗口；就绪/失败都推到渲染进程）
  if (engine) {
    engine.warmup()
      .then((r) => { if (win && !win.isDestroyed()) win.webContents.send("engine:ready", r); })
      .catch((e) => { if (win && !win.isDestroyed()) win.webContents.send("engine:error", engine.humanizeError(e)); });
  }
});

app.on("window-all-closed", () => app.quit());
