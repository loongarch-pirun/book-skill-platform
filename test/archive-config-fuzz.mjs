// 终期暴力测试 P1：存档/配置/删书联动爆破（V2 融合轮）。
// 攻击面：src/desktop/chat-archive.mjs（并发写/上限/坏行/limit/purge 语义）、
//   src/desktop/llm-config.mjs（坏 JSON/坏 base64/数字 key/尾号）、
//   src/desktop/chat.mjs（未初始化退化/testConnection 误报）、books:delete 联动。
// 铁律：纯 fs + spawn 子进程 + 假 ipcMain + tmp 自建最小库——不碰真 library、
//   不碰真网络、不碰 safeStorage（假加密器注入）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const Database = require("better-sqlite3");

const { appendArchive, listArchive, purgeBook, clearArchive } = await import("../src/desktop/chat-archive.mjs");
const { configureLlmConfig, loadLlmConfig, readLlmKey, saveLlmConfig } = await import("../src/desktop/llm-config.mjs");

let pass = 0, fail = 0, observe = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};
const obs = (cond, name, note = "") => {
  if (cond) { observe++; console.log(`OBSERVE - ${name}${note ? " | " + note : ""}`); }
  else { fail++; console.log(`FAIL - ${name}（OBSERVE 条件不成立）${note}`); }
};

const entry = (q, bookId = "a.docx") => ({
  question: q, answer: "答", mode: "book", book: "书", model: "m", segments: 1, dropped: 0,
  citations: [{ n: 1, book: "书", bookId, id: 1, loc: "第一章", quote: "引", text: "整段原文" }],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ========== P1-A chat-archive 存档爆破 ==========
console.log("\n--- P1-A chat-archive ---");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p1a-"));
  const libDir = path.join(tmp, "library");
  fs.mkdirSync(libDir, { recursive: true });
  for (let i = 0; i < 40; i++) appendArchive(libDir, entry(`预置${i}`)); // 预置 40 条

  // A1（V2-D04）：多进程并发追加——read-modify-write 全量重写，后写覆盖先写
  const goFile = path.join(tmp, "go");
  const N = 4, PER = 25;
  const children = [];
  for (let c = 0; c < N; c++) {
    children.push(new Promise((resolve, reject) => {
      const readyFile = path.join(tmp, `ready-${c}`);
      const child = spawn(process.execPath, ["-e", `
        import fs from "node:fs";
        const { pathToFileURL } = await import("node:url");
        const U = (p) => pathToFileURL(p).href; // Windows 下 import() 不吃 C:/ 绝对路径，必须转 file:// URL
        const libDir = ${JSON.stringify(libDir)};
        const readyFile = ${JSON.stringify(readyFile)};
        const goFile = ${JSON.stringify(goFile)};
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        (async () => {
          const { appendArchive } = await import(U(${JSON.stringify(path.join(ROOT, "src/desktop/chat-archive.mjs"))}));
          fs.writeFileSync(readyFile, "ready");
          let guard = 0;
          while (!fs.existsSync(goFile) && guard++ < 2000) await sleep(5); // GO 屏障：4 子进程齐发
          for (let i = 0; i < ${PER}; i++) {
            appendArchive(libDir, { question: "c${c}-" + i, answer: "答", mode: "book", book: "书", model: "m", segments: 1, dropped: 0, citations: [{ n: 1, book: "书", bookId: "a.docx", id: 1, loc: "第一章", quote: "引", text: "整段原文" }] });
          }
          process.exit(0);
        })().catch(e => { console.error(e.message); process.exit(1); });
      `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`子进程 ${c} 退出码 ${code}`))));
    }));
  }
  // 等 4 个 ready 都出现再放 GO（保证真正并发）
  for (let w = 0; w < 200 && fs.readdirSync(tmp).filter((f) => f.startsWith("ready-")).length < N; w++) await sleep(50);
  fs.writeFileSync(goFile, "go");
  await Promise.all(children);
  const total = listArchive(libDir, { limit: 1000 }).length;
  ok(total === 40 + N * PER,
    `P1-A1 D04: 4 子进程×25 条并发追加零丢失（期望 ${40 + N * PER}，实测 ${total}）`);

  // A2：同进程串行追加 100 次不丢（证明竞态仅多进程可达）
  for (let i = 0; i < 100; i++) appendArchive(libDir, entry(`串行${i}`));
  ok(listArchive(libDir, { limit: 1000 }).length === 40 + N * PER + 100,
    "P1-A2: 同进程串行 100 次追加不丢（竞态仅多进程可达，产品单主进程不可达）");

  // A4：并发 600 条仍 ≤500 封顶
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p1a4-"));
  const lib4 = path.join(tmp4, "library");
  fs.mkdirSync(lib4, { recursive: true });
  const go4 = path.join(tmp4, "go");
  const ch4 = [];
  for (let c = 0; c < 4; c++) {
    ch4.push(new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", `
        import fs from "node:fs";
        const { pathToFileURL } = await import("node:url");
        const U = (p) => pathToFileURL(p).href;
        const libDir = ${JSON.stringify(lib4)};
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        (async () => {
          const { appendArchive } = await import(U(${JSON.stringify(path.join(ROOT, "src/desktop/chat-archive.mjs"))}));
          let guard = 0;
          while (!fs.existsSync(${JSON.stringify(go4)}) && guard++ < 2000) await sleep(5);
          for (let i = 0; i < 150; i++) appendArchive(libDir, { question: "x${c}-" + i, answer: "答", mode: "book", book: "书", model: "m", segments: 1, dropped: 0, citations: [] });
          process.exit(0);
        })().catch(() => process.exit(1));
      `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
      child.on("close", () => resolve());
    }));
  }
  fs.writeFileSync(go4, "go");
  await Promise.all(ch4);
  const total4 = listArchive(lib4, { limit: 1000 }).length;
  ok(total4 <= 500, `P1-A4: 并发 600 条仍 ≤500 封顶（实测 ${total4}）`);
  obs(total4 < 600, "P1-A4 登记: 超上限砍最旧（read-modify-write 重写）与并发追加存在交叠窗口", `并发600条实测剩 ${total4} 条——修 D04 快路后仅超上限那一次重写仍可能互覆，上界 500 守住`);

  // A5：半文件状态（模拟崩溃留下无换行结尾的半行）再 append
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p1a5-"));
  const lib5 = path.join(tmp5, "library");
  fs.mkdirSync(path.join(lib5, "chat-archive"), { recursive: true });
  fs.writeFileSync(path.join(lib5, "chat-archive", "archive.jsonl"),
    JSON.stringify(entry("好行1")) + "\n" + '{"question":"半行', "utf8"); // 第二行无换行结尾
  appendArchive(lib5, entry("新行"));
  const after5 = listArchive(lib5);
  ok(after5.some((e) => e.question === "好行1") && after5.some((e) => e.question === "新行"),
    "P1-A5: 半文件状态下好行与新行都不丢（半行独立成坏行被容忍，不粘连新行）");

  // A6：limit 矩阵
  const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p1a6-"));
  const lib6 = path.join(tmp6, "library");
  fs.mkdirSync(lib6, { recursive: true });
  for (let i = 0; i < 5; i++) appendArchive(lib6, entry(`q${i}`));
  ok(listArchive(lib6, { limit: 0 }).length === 0, "P1-A6: limit=0 → 空");
  ok(listArchive(lib6, { limit: -1 }).length === 0, "P1-A6: limit=-1 → 空");
  ok(listArchive(lib6).length === 5, "P1-A6: limit 缺省 → 全量（5<100）");
  obs(listArchive(lib6, { limit: 2.5 }).length === 3, "P1-A6 登记: limit=2.5 浮点比较 → 返回 3 条", "非整数宽松放行（可选 Math.floor）");
  ok(listArchive(lib6, { limit: NaN }).length === 0, "P1-A6: limit=NaN → 空（比较恒假）");
  // 新→旧顺序
  ok(listArchive(lib6)[0].question === "q4", "P1-A6: 列表新→旧（q4 在首位）");

  // A7（V2-D07 族）：purgeBook(undefined) 误删无 bookId 条目
  const tmp7 = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p1a7-"));
  const lib7 = path.join(tmp7, "library");
  fs.mkdirSync(lib7, { recursive: true });
  appendArchive(lib7, entry("有bookId", "a.docx"));
  appendArchive(lib7, { question: "无bookId", answer: "答", mode: "book", book: "书", model: "m", segments: 1, dropped: 0, citations: [{ n: 1, book: "书", id: 1, loc: "x", quote: "q", text: "t" }] });
  appendArchive(lib7, entry("另一本", "b.docx"));
  const removed7 = purgeBook(lib7, undefined);
  ok(removed7 === 0 && listArchive(lib7, { limit: 100 }).length === 3,
    "P1-A7 D07族: purgeBook(undefined) 不动任何条目（老逻辑 c.bookId===undefined 误删无 bookId 条目）");
  const removed7b = purgeBook(lib7, "a.docx");
  ok(removed7b === 1 && listArchive(lib7, { limit: 100 }).length === 2,
    "P1-A7: purgeBook('a.docx') 精确清 1 条");
  // A8：purgeBook(null) 被 D07 族修复一并挡下（非非空字符串直接返回 0）——
  // explicit bookId:null 的畸形条目保守保留：留着比误删安全（登记）
  const tmp8 = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p1a8-"));
  const lib8 = path.join(tmp8, "library");
  fs.mkdirSync(lib8, { recursive: true });
  appendArchive(lib8, { question: "显式null", answer: "答", mode: "book", book: "书", model: "m", segments: 1, dropped: 0, citations: [{ n: 1, book: "书", bookId: null, id: 1, loc: "x", quote: "q", text: "t" }] });
  appendArchive(lib8, entry("正常", "a.docx"));
  const removed8 = purgeBook(lib8, null);
  ok(removed8 === 0 && listArchive(lib8, { limit: 100 }).length === 2,
    "P1-A8: purgeBook(null) → 0（D07 族修复连带挡下；畸形条目保守保留比误删安全）");
  obs(true, "P1-A8 登记: explicit bookId:null 的存档条目将永远保留（正常链路不会产出此形态）", "");
  // A9：clearArchive 留空目录不炸；重复清空不炸
  clearArchive(lib8); clearArchive(lib8);
  ok(listArchive(lib8).length === 0, "P1-A9: 清空后列表空，重复清空不炸");
  obs(fs.existsSync(path.join(lib8, "chat-archive")), "P1-A9 登记: clearArchive 只删文件留空目录（无害）", "");
  // A3：坏行容忍与并发独立
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p1a3-"));
  const lib3 = path.join(tmp3, "library");
  fs.mkdirSync(path.join(lib3, "chat-archive"), { recursive: true });
  fs.writeFileSync(path.join(lib3, "chat-archive", "archive.jsonl"), "坏行{{{\n" + JSON.stringify(entry("好行")) + "\n", "utf8");
  ok(listArchive(lib3).length === 1, "P1-A3: 坏行跳过，好行照常列出");
  const removed3 = purgeBook(lib3, "a.docx");
  ok(removed3 === 1 && fs.readFileSync(path.join(lib3, "chat-archive", "archive.jsonl"), "utf8").includes("坏行"),
    "P1-A3: purgeBook 坏行保守保留（解析不了的不敢删）");
  for (const d of [tmp, tmp4, tmp5, tmp6, tmp7, tmp8, tmp3]) fs.rmSync(d, { recursive: true, force: true });
}

// ========== P1-B llm-config 配置存储爆破 ==========
console.log("\n--- P1-B llm-config ---");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p1b-"));
  const fakeEnc = {
    available: true,
    encrypt: (s) => Buffer.from("ENC:" + s, "utf8"),
    decrypt: (b) => { const t = b.toString("utf8"); return t.startsWith("ENC:") ? t.slice(4) : null; },
  };
  configureLlmConfig({ userData: tmp, ...fakeEnc });
  const cfgFile = path.join(tmp, "llm.json");

  // B1（V2-D07）：坏 JSON 字符串——老逻辑 readRaw catch 吞成 {}，用户看到「没配置」而非「配置坏了」
  fs.writeFileSync(cfgFile, "{不是JSON", "utf8");
  let c1 = loadLlmConfig();
  ok(c1.hasKey === false && c1.baseUrl === "" && !!c1.warning,
    "P1-B1 D07: 坏 JSON → 按未配置走但带 warning（「配置坏了」不再伪装成「没配置」）");
  // B2：顶层数组（typeof 检查漏网）
  fs.writeFileSync(cfgFile, "[1,2]", "utf8");
  let c2 = loadLlmConfig();
  ok(c2.hasKey === false && !!c2.warning, "P1-B2 D07: 顶层数组 → 按损坏处理带 warning");
  // B3：null
  fs.writeFileSync(cfgFile, "null", "utf8");
  let c3 = loadLlmConfig();
  ok(c3.hasKey === false && !!c3.warning, "P1-B3 D07: JSON null → 按损坏处理带 warning");
  // 修复路径：坏配置上重新保存三件套能覆盖修复
  const fix = saveLlmConfig({ baseUrl: "https://a.com", model: "m", apiKey: "sk-good1234" });
  ok(fix.ok === true && loadLlmConfig().warning === null, "P1-B3b: 坏配置上重新保存 → 覆盖修复且 warning 清除");

  // B4（V2-D09）：坏 base64 的 plain: 串——Buffer.from 宽容解出垃圾，hasKey:true 但 key 无效
  fs.writeFileSync(cfgFile, JSON.stringify({ baseUrl: "https://a.com", model: "m", apiKeyEnc: "plain:!!!@#$" }), "utf8");
  let c4 = loadLlmConfig();
  ok(c4.hasKey === false,
    "P1-B4 D09: plain: 坏 base64 → 往返校验拒收（老逻辑解出垃圾串 hasKey:true）");
  // 合法 plain: 往返仍正常
  fs.writeFileSync(cfgFile, JSON.stringify({ baseUrl: "https://a.com", model: "m", apiKeyEnc: "plain:" + Buffer.from("sk-ok9999", "utf8").toString("base64") }), "utf8");
  ok(loadLlmConfig().hasKey === true && readLlmKey() === "sk-ok9999", "P1-B4b: 合法 plain: 往返正确（校验不误伤）");
  // B5：enc: 坏数据 → decrypt 抛 → null → hasKey:false（安全侧）
  fs.writeFileSync(cfgFile, JSON.stringify({ baseUrl: "https://a.com", model: "m", apiKeyEnc: "enc:坏数据" }), "utf8");
  ok(loadLlmConfig().hasKey === false, "P1-B5: enc: 解密失败 → 按无 key 处理（安全侧）");

  // B6（V2-D08）：数字 apiKey——typeof 检查静默忽略，返回 ok:true 但 key 没存
  fs.rmSync(cfgFile, { force: true });
  saveLlmConfig({ baseUrl: "https://a.com", model: "m", apiKey: "sk-keep0001" });
  const before6 = readLlmKey();
  const r6 = saveLlmConfig({ apiKey: 123 });
  ok(r6.ok === false,
    "P1-B6 D08: apiKey=123（非字符串）→ 显式拒收（老逻辑 ok:true 但 key 没存，调用方以为存了）");
  ok(readLlmKey() === before6, "P1-B6b: 拒收后旧 key 原样不动");
  // B7：空/纯空白 apiKey = 不改 key（防误清，文档行为）
  const r7 = saveLlmConfig({ apiKey: "" });
  ok(r7.ok === true && readLlmKey() === before6, "P1-B7: apiKey 空串 = 不改 key（防误清设计）");
  const r7b = saveLlmConfig({ apiKey: "   " });
  ok(r7b.ok === true && readLlmKey() === before6, "P1-B7: apiKey 纯空白 = 不改 key");
  // B8：keyTail 尾 4 位
  saveLlmConfig({ apiKey: "sk-0123456789abcdef" });
  ok(loadLlmConfig().keyTail === "…cdef", "P1-B8: keyTail 只回显尾 4 位");
  obs(loadLlmConfig().keyTail.length === 5, "P1-B8 登记: ≤4 位的短 key 尾号即全文（真 key 不会短）", "");
  // B9：未 configureLlmConfig（新进程侧测，见 C 组）；此处测注入后可用
  ok(loadLlmConfig().encryption === "safeStorage", "P1-B9: 注入假加密器 → encryption=safeStorage");
  // B10：userData 目录不存在 → mkdirSync recursive 自建
  const deep = path.join(tmp, "不存在", "嵌套");
  configureLlmConfig({ userData: deep, ...fakeEnc });
  ok(saveLlmConfig({ baseUrl: "https://a.com", model: "m", apiKey: "sk-deep0001" }).ok === true,
    "P1-B10: userData 嵌套目录不存在 → 自动创建后保存成功");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ========== P1-C chat.mjs 未初始化退化（新进程 import 不 init） ==========
console.log("\n--- P1-C chat.mjs 未初始化退化 ---");
{
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", `
      (async () => {
        const { pathToFileURL } = await import("node:url");
        const U = (p) => pathToFileURL(p).href; // Windows 下 import() 不吃 C:/ 绝对路径
        const chat = await import(U(${JSON.stringify(path.join(ROOT, "src/desktop/chat.mjs"))}));
        const res = {};
        res.list = JSON.stringify(chat.archiveList({}));
        res.clear = JSON.stringify(chat.archiveClear());
        res.purge = String(chat.purgeArchives("a.docx"));
        try { await chat.testConnection(); res.test = "no-throw"; }
        catch (e) { res.test = "UserError:" + e.message; }
        try { chat.configSet({}); res.set = "no-throw"; }
        catch (e) { res.set = "UserError:" + e.message; }
        console.log("RESULT " + JSON.stringify(res));
      })().catch(e => { console.log("CRASH " + e.message); process.exit(1); });
    `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
    let o = "";
    child.stdout.on("data", (d) => (o += d));
    child.on("close", () => resolve(o));
  });
  const m = out.match(/RESULT (\{.*\})/);
  const r = m ? JSON.parse(m[1]) : {};
  ok(r.list === "[]", "P1-C1: 未 init 时 archiveList → []（不抛）");
  ok(r.clear === '{"cleared":true}', "P1-C2: 未 init 时 archiveClear → {cleared:true}（不抛）");
  ok(r.purge === "0", "P1-C3: 未 init 时 purgeArchives → 0（不抛）");
  ok(r.test?.startsWith("UserError:"), "P1-C4: 未 init 时 testConnection → UserError 人话（不抛裸栈）");
  ok(r.set?.startsWith("UserError:"), "P1-C5: 未 init 时 configSet({}) → UserError 人话（不抛裸栈）");
  obs(r.list === "[]", "P1-C1 登记: archiveList 空列表与「真空存档」不可区分（退化安全优先）", "dirs() 为 null 时静默返 []");
}

// ========== P1-D books:delete 删书联动（假 ipcMain + tmp 自建库） ==========
console.log("\n--- P1-D books:delete 联动 ---");
{
  const { registerIpc } = await import("../src/desktop/ipc.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p1d-"));
  const libDir = path.join(tmp, "library");
  fs.mkdirSync(libDir, { recursive: true });
  process.env.BSP_LIB_DIR = libDir; // env 层优先：dirs 全指 tmp，真 library 零风险

  // tmp 内自建最小 .db（meta 表即可，deleteBook 只删文件不读内容）
  const dbPath = path.join(libDir, "t.docx.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('model','e5')").run();
  db.close();

  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const engine = await registerIpc({ ipcMain, app: { isPackaged: false, getPath: () => null }, dialog: {}, getWin: () => null });
  engine.init({ packaged: false });
  const invoke = async (ch, ...args) => handlers.get(ch)({}, ...args);

  // 预置 2 条引用 t.docx 的存档 + 1 条引用别的书
  const { appendArchive } = await import("../src/desktop/chat-archive.mjs");
  appendArchive(libDir, entry("问1", "t.docx"));
  appendArchive(libDir, entry("问2", "t.docx"));
  appendArchive(libDir, entry("问别的书", "other.docx"));

  // D1：正常删书——删库文件 + 清开关记录 + purge 条数进 note
  const del = await invoke("books:delete", "t.docx");
  ok(del.ok === true && !fs.existsSync(dbPath), "P1-D1: books:delete 删掉 .db 文件");
  ok(typeof del.data.note === "string" && del.data.note.includes("2") && del.data.note.includes("存档"),
    `P1-D1: 删书 note 明示连 N 条存档一起清（实测 note=${JSON.stringify(del.data.note)}）`);
  const left = (await import("../src/desktop/chat-archive.mjs")).listArchive(libDir, { limit: 100 });
  ok(left.length === 1 && left[0].question === "问别的书", "P1-D1: 存档只剩引用别的书的条目");

  // D2：purge 通道被堵（chat-archive 被换成文件）→ readLines ENOTDIR → removed=0 → 删书仍成功
  const dbPath2 = path.join(libDir, "t2.docx.db");
  const db2 = new Database(dbPath2);
  db2.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db2.close();
  appendArchive(libDir, entry("问t2", "t2.docx")); // 先正常写一条引用 t2 的存档
  fs.rmSync(path.join(libDir, "chat-archive"), { recursive: true, force: true });
  fs.writeFileSync(path.join(libDir, "chat-archive"), "我是文件不是目录", "utf8"); // 堵住 purge 读路径
  const del2 = await invoke("books:delete", "t2.docx");
  ok(del2?.ok === true && !fs.existsSync(dbPath2),
    "P1-D2: purge 通道被堵（chat-archive 是文件）→ 删书本体仍成功（try 兜底不挡删书）");
  obs(del2?.data?.note === undefined || !String(del2.data.note).includes("存档"),
    "P1-D2 登记: purge 失败时 note 不带存档条数（返回 0，不谎报）", "");

  // D3（V2-D15）：llm.json 空 baseUrl + 合法 key → testConnection 当前误报 NETWORK
  const userData = path.join(tmp, "userData");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "llm.json"), JSON.stringify({
    baseUrl: "", model: "m", apiKeyEnc: "plain:" + Buffer.from("sk-test0001", "utf8").toString("base64"),
  }), "utf8");
  const { configureLlmConfig } = await import("../src/desktop/llm-config.mjs");
  configureLlmConfig({ userData, available: false, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() });
  let test3;
  test3 = await invoke("llm:test"); // IPC 层统一包装：UserError → {ok:false,error}，不抛
  ok(test3?.ok === false && String(test3?.error?.message || "").includes("接口地址"),
    `P1-D3 D15: 空 baseUrl 测连接 → 人话「接口地址没配」（老逻辑 fetch 相对 URL 抛 TypeError 误报 NETWORK，实测: ${test3?.ok ? "成功" : test3?.error?.message}）`);

  // D4：archiveList limit 透传
  const { appendArchive: app4 } = await import("../src/desktop/chat-archive.mjs");
  fs.rmSync(path.join(libDir, "chat-archive"), { recursive: true, force: true });
  for (let i = 0; i < 3; i++) app4(libDir, entry(`l${i}`, "z.docx"));
  const lst = await invoke("chat:archiveList", { limit: 2 });
  ok(lst.ok === true && lst.data.length === 2, "P1-D4: chat:archiveList limit=2 → 透传生效（2 条）");

  delete process.env.BSP_LIB_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log();
console.log(`=== archive-config-fuzz(P1): ${pass} pass / ${fail} fail / ${observe} observe ===`);
process.exit(fail > 0 ? 1 : 0);
