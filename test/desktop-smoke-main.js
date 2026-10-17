// 桌面端全链路冒烟：preload + renderer + IPC + engine 一次跑通（约 30~60 秒，含模型加载）
// 跑法：npm run smoke:desktop（**需要能开窗口的真实桌面环境**；结果写 %TEMP%/desktop-smoke-result.json）
// 与主进程共用同一份 IPC 注册（ipc.mjs）——冒烟测的就是生产通道，不是副本。
// 已知限制：无显示器的沙箱/CI 环境里 Chromium 渲染进程起不来（连 about:blank 都崩，
// exitCode -2147483645），那种环境请用 node test/ipc-test.mjs 验通道层（同一份注册代码）。
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

// 无显示/远程桌面环境兜底（冒烟报告实测 headless 下 GPU 进程会崩，不影响主进程）
app.disableHardwareAcceleration();

const OUT = path.join(app.getPath("temp"), "desktop-smoke-result.json");
const results = [];
const ok = (name, pass, extra = "") => {
  results.push({ name, pass: !!pass, extra });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${extra ? " | " + extra : ""}`);
};

app.whenReady().then(async () => {
  let win;
  try {
    const { registerIpc } = await import(pathToFileURL(path.join(__dirname, "..", "src", "desktop", "ipc.mjs")).href);
    const engine = await registerIpc({
      ipcMain, app,
      dialog: { showOpenDialog: async () => ({ canceled: true }) }, // 冒烟不走文件对话框
      shell: { openPath: async () => "" }, // 冒烟不真开系统程序（#166 book:openExternal）
      getWin: () => win,
    });
    engine.init({ packaged: false });
    win = new BrowserWindow({
      show: false, // 无显示环境也能跑断言
      webPreferences: { preload: path.join(__dirname, "..", "src", "preload.js") },
    });
    // 诊断：加载失败/渲染进程死亡/渲染进程 console 都打出来
    win.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => console.log(`[did-fail-load] main=${isMain} ${code} ${desc} ${url}`));
    win.webContents.on("render-process-gone", (_e, d) => console.log(`[render-process-gone] ${JSON.stringify(d)}`));
    win.webContents.on("console-message", (_e, _l, msg) => console.log(`[renderer] ${msg}`));
    win.webContents.on("preload-error", (_e, p, err) => console.log(`[preload-error] ${p} ${err}`));
    await win.loadFile(path.join(__dirname, "..", "src", "index.html"));
    console.log("[smoke] index.html 加载完成");

    // 等渲染进程 boot 完（app.js 结尾置 __studyBooted，最多 20 秒）
    const booted = await win.webContents.executeJavaScript(`(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) { if (window.__studyBooted) return true; await new Promise(r => setTimeout(r, 100)); }
      return false;
    })()`);
    ok("渲染进程启动（boot 钩子）", booted);

    const shelf = await win.webContents.executeJavaScript(`(() => ({
      cards: document.querySelectorAll(".bookcard").length,
      first: (document.querySelector(".bookcard h3") || {}).textContent || "",
      tags: document.querySelectorAll(".bookcard .tag").length,
    }))()`);
    ok("书架渲染 6 张书卡", shelf.cards === 6, `实际 ${shelf.cards} 张`);
    ok("书卡有标题与编目标题签", shelf.first.length > 0 && shelf.tags > 0, `首本《${shelf.first}》`);

    const books = await win.webContents.executeJavaScript("window.study.booksList()");
    ok("IPC books:list", books.ok && books.data.length === 6);
    const bookId = books.data[0].id;

    const ch = await win.webContents.executeJavaScript(`window.study.chapters(${JSON.stringify(bookId)})`);
    ok("IPC reader:chapters", ch.ok && ch.data.chapters.length >= 1, `${ch.data.chapters.length} 章`);
    const blk = await win.webContents.executeJavaScript(`window.study.block(${JSON.stringify(bookId)}, ${JSON.stringify(ch.data.chapters[0].name)})`);
    ok("IPC reader:block", blk.ok && blk.data.blocks.length >= 1, `${blk.data.blocks.length} 块`);

    // 真问一句（模型加载 + 混合检索 + 复试官全链路）
    const t0 = Date.now();
    const ask = await win.webContents.executeJavaScript(`window.study.ask({ bookId: ${JSON.stringify(bookId)}, question: "这本书讲了什么", topN: 3 })`);
    ok("IPC ask:query 单书", ask.ok && ask.data.results.length >= 1, `${Date.now() - t0}ms，${ask.data.results.length} 条`);
    const first = ask.data.results[0];
    ok("结果带引用定位与 chunk id", !!first.loc && first.id != null, `定位=${first.loc}`);

    // 引用跳转闭环：locate → block 里找得到那一块
    const loc = await win.webContents.executeJavaScript(`window.study.locate(${JSON.stringify(bookId)}, ${first.id})`);
    ok("IPC reader:locate", loc.ok && !!loc.data.chapter, `章节=${loc.data.chapter}`);
    const blk2 = await win.webContents.executeJavaScript(`window.study.block(${JSON.stringify(bookId)}, ${JSON.stringify(loc.data.chapter)})`);
    ok("引用跳转目标块可读", blk2.ok && blk2.data.blocks.some((x) => x.id === first.id));

    // 全库模式（跨书检索入口）
    const t1 = Date.now();
    const lib = await win.webContents.executeJavaScript(`window.study.ask({ question: "什么是无为", topN: 3 })`);
    ok("IPC ask:query 全库", lib.ok && lib.data.routed_books.length >= 1, `翻了 ${lib.data.routed_books.length} 本，${Date.now() - t1}ms`);
  } catch (e) {
    ok("冒烟主流程未崩", false, e.message);
  }
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`===== desktop-smoke: ${results.filter((r) => r.pass).length} PASS / ${results.filter((r) => !r.pass).length} FAIL =====`);
  console.log(`结果已写 ${OUT}`);
  app.quit();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
});
