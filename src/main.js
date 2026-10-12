// 最小 Electron 应用：主进程跑 better-sqlite3 中文检索，把结果送到窗口显示
// 试金石 3 = 验证原生模块在打包后的 exe 里能正常工作
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 720, height: 480,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile("index.html");
}

ipcMain.handle("sqlite-test", () => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  const ver = db.prepare("select sqlite_version() v").get().v;
  db.exec(`
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, page INTEGER, text TEXT);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');
  `);
  const ins = db.prepare("INSERT INTO chunks(page,text) VALUES (?,?)");
  const rows = [[1, "學而時習之，不亦說乎"], [2, "檢索增強生成讓回答錨定原文"], [3, "减少幻覺靠原文引用"]];
  for (const [p, t] of rows) {
    ins.run(p, t);
    db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES ((select id from chunks where text=?), ?)").run(t, t);
  }
  const hit = db.prepare(`SELECT c.page, c.text FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?`).all('"檢索增強生成"');
  db.close();
  return { ok: hit.length === 1 && hit[0].page === 2, sqlite: ver, hit: hit[0] || null };
});

app.whenReady().then(() => {
  if (process.env.STONE3) {
    // 试金石自检模式：跑完测试写结果文件后自动退出
    const fs = require("fs");
    let result;
    try {
      const { ipcMain } = require("electron");
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
  createWindow();
});
app.on("window-all-closed", () => app.quit());
