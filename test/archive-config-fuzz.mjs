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
  const engine = await registerIpc({ ipcMain, app: { isPackaged: false, getPath: () => null }, dialog: {}, shell: { openPath: async () => "" }, getWin: () => null });
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

  // ========== P1-E 两档删除（V3 第四波 #168：移出书架 / 彻底删除） ==========
  // D2 把 chat-archive 堵成文件过——purge 双清前先恢复目录，否则存档通道被 try 兜底成 0
  fs.rmSync(path.join(libDir, "chat-archive"), { recursive: true, force: true });
  const booksDir = path.join(tmp, "books");
  fs.mkdirSync(booksDir, { recursive: true });
  const mkBook = (id, withAsset = true) => {
    const dbPath = path.join(libDir, id + ".db");
    const d = new Database(dbPath);
    d.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    d.prepare("INSERT OR REPLACE INTO meta VALUES ('model','e5')").run();
    d.close();
    if (withAsset) fs.writeFileSync(path.join(booksDir, id), "原件内容", "utf8");
    return dbPath;
  };

  // P5：派生六落点种子（编目任务书/提示词/结果 + 洗数据任务书/产物/缓存），
  // 与 derived.mjs 候选表逐字对齐——这里故意用真实路径形状，锁「删的是不是这六个」
  const seedDerived = (id) => {
    const root = path.join(libDir, "..");
    const rel = [
      `catalog-tasks/${id}.json`,
      `catalog-tasks/${id}.prompt.md`,
      `catalog-results/${id}.json`,
      `enrich-tasks/${id}.json`,
      `enrich-results/${id}.json`,
      `enrich-results/${id}.jsonl`,
    ];
    for (const r of rel) {
      fs.mkdirSync(path.dirname(path.join(root, r)), { recursive: true });
      fs.writeFileSync(path.join(root, r), `fixture:${r}`, "utf8");
    }
    return rel.map((r) => path.join(root, r));
  };

  // E1：彻底删除 processed 书（有原件）——库 + 原件 + 存档/反馈一体删，note 带条数
  const dbE1 = mkBook("t3.docx");
  const derivedE1 = seedDerived("t3.docx");
  const decoyE1 = seedDerived("t3-other.docx"); // 前缀同名诱饵：前缀匹配会误删它
  appendArchive(libDir, entry("问t3-1", "t3.docx"));
  appendArchive(libDir, entry("问t3-2", "t3.docx"));
  appendArchive(libDir, entry("问别的书2", "other.docx")); // 别人的存档不能动
  const { appendFeedback } = await import("../src/desktop/feedback-pool.mjs");
  appendFeedback(libDir, { kind: "no-results", question: "q", book: "t3", bookId: "t3.docx", mode: "book" });
  const pur = await invoke("books:purge", "t3.docx");
  ok(pur.ok === true && !fs.existsSync(dbE1) && !fs.existsSync(path.join(booksDir, "t3.docx")),
    "P1-E1: books:purge 删掉书库 + books/ 原件（一体全删）");
  ok(pur.data.removedAsset === true && String(pur.data.note).includes("彻底删除"),
    `P1-E1: purge 回执 removedAsset + 彻底删除措辞（实测 note=${JSON.stringify(pur.data.note)}）`);
  ok(String(pur.data.note).includes("3") && String(pur.data.note).includes("存档"),
    "P1-E1: purge note 明示连 3 条（2 存档 + 1 反馈）引用一起清");
  const leftE1 = listArchive(libDir, { limit: 100 });
  ok(leftE1.length === 1 && leftE1[0].question === "问别的书2", "P1-E1: 只剩引用别的书的存档（不误伤）");
  // P5：派生六落点全清 + 前缀诱饵零误伤（回执实数）
  ok(pur.data.removedDerived === 6 && derivedE1.every((f) => !fs.existsSync(f)),
    `P1-E1: 派生六落点全清（removedDerived=${pur.data.removedDerived}）`);
  ok(decoyE1.every((f) => fs.existsSync(f)), "P1-E1: 前缀同名的另一本书派生一格不动（精确拼接，不做前缀匹配）");
  ok(String(pur.data.note).includes("派生文件已清 6 项"),
    `P1-E1: note 明示清了几项（实测 ${JSON.stringify(pur.data.note)}）`);

  // E2：移出书架 processed 书（第一档）——库删了，原件留，书架回 raw 态
  const dbE2 = mkBook("t4.docx");
  const derivedE2 = seedDerived("t4.docx");
  const delE2 = await invoke("books:delete", "t4.docx");
  ok(delE2.ok === true && !fs.existsSync(dbE2) && fs.existsSync(path.join(booksDir, "t4.docx")),
    "P1-E2: books:delete 只删库、books/ 原件保留（第一档=删库留原件）");
  // P5 拍板（2026-10-18）：移出书架**不清派生**——原件还在、重建后块号可复用，
  // 留着能省一次云端洗数据的钱；只有彻底删除才承诺清全部六落点
  ok(derivedE2.every((f) => fs.existsSync(f)) && delE2.data.removedDerived === undefined,
    "P1-E2: 移出书架不清派生（六项全在，回执无 removedDerived）");
  const shelfE2 = await invoke("books:list");
  const rowE2 = shelfE2.data.find((b) => b.id === "t4.docx");
  ok(!!rowE2 && rowE2.status === "raw" && rowE2.asset?.exists === true,
    "P1-E2: 移出书架后书架显示 raw（点「开始加工」可重建，不用重新拖文件）");

  // E3：彻底删除 raw-only 书（只有原件没库）——原件删掉，书架不再显示
  fs.writeFileSync(path.join(booksDir, "rawonly.txt"), "只有原件的书", "utf8");
  const derivedE3 = seedDerived("rawonly.docx");
  const purRaw = await invoke("books:purge", "rawonly.docx");
  ok(purRaw.ok === true && !fs.existsSync(path.join(booksDir, "rawonly.txt")),
    "P1-E3: raw 书（无库）也能彻底删除——删 books/ 原件");
  ok(purRaw.data.removedDerived === 6 && derivedE3.every((f) => !fs.existsSync(f)),
    `P1-E3: raw-only 书（无库）照清派生六落点（removedDerived=${purRaw.data.removedDerived}）`);
  const shelfE3 = await invoke("books:list");
  ok(!shelfE3.data.some((b) => b.id === "rawonly.docx"), "P1-E3: 删完书架不再显示该书");

  // E4：错误路径——两档都不许碰不存在的书；第一档对 raw-only 书给人话（没有库可移出）
  const noBook = await invoke("books:purge", "不存在的书xyz");
  ok(noBook.ok === false && noBook.error.code === "user", "P1-E4: books:purge 坏书名 → {ok:false,user}");
  fs.writeFileSync(path.join(booksDir, "rawonly2.txt"), "x", "utf8");
  const delRaw = await invoke("books:delete", "rawonly2.docx");
  ok(delRaw.ok === false && String(delRaw.error?.message || "").includes("彻底删除"),
    `P1-E4: books:delete 对 raw-only 书 → 人话指路彻底删除（实测: ${delRaw.ok ? "成功" : delRaw.error?.message}）`);
  ok(fs.existsSync(path.join(booksDir, "rawonly2.txt")), "P1-E4: 指路报错不动文件（原件还在）");

  // E5：大小写/空白变体的彻底删除（C20 同款，P5 自审实测坐实的 #168 遗留缺陷）
  // 严格相等 find 会漏掉库 → 只删原件、库还留在架上，回执却说「已彻底删除」。
  // 归一后必须三处（库 / 原件 / 派生）全清，任意一处漏掉就是半截态。
  const dbE5 = mkBook("Case5.docx");
  const derivedE5 = seedDerived("Case5.docx");
  const purCase = await invoke("books:purge", "case5.docx");
  ok(purCase.ok === true && purCase.data.purged === "Case5.docx",
    `P1-E5: 大小写变体归一到真实 id（实测 purged=${purCase.data.purged}）`);
  ok(!fs.existsSync(dbE5) && !fs.existsSync(path.join(booksDir, "Case5.docx")),
    "P1-E5: 大小写变体彻底删除 → 库与原件都清（不再只删原件留库）");
  ok(purCase.data.removedDerived === 6 && derivedE5.every((f) => !fs.existsSync(f)),
    "P1-E5: 派生六落点跟着归一后的 id 一起清（三处口径一致）");

  // E5b：首尾空白**必须拒绝**，不许归一——前导空格可能是另一本书名的一部分。
  // 早先这条断言写的是「空白归一成功」，等于把数据丢失的假设写进了测试
  // （评审对抗官 FAIL-1 实测：`" foo.docx"` 归一成 `foo.docx` 会删掉隔壁正常书）。
  const dbE5b = mkBook("Space6.docx");
  const purSpace = await invoke("books:purge", "  Space6.docx  ");
  ok(purSpace.ok === false && String(purSpace.error?.message || "").includes("空白"),
    `P1-E5b: 首尾空白 → 人话拒绝（实测 ${purSpace.ok ? "成功(!)" : purSpace.error?.message}）`);
  ok(fs.existsSync(dbE5b), "P1-E5b: 拒绝时库一格不动");

  // E5c：兄弟书零触碰——真有 " foo5.docx" 与 "foo5.docx" 两本时，对前导空格那本
  // 调 purge 绝不能删到正常那本（数据丢失路径的回归锁，比 E5b 的拒绝断言更硬）
  const dbE5c = mkBook("foo5.docx");
  fs.writeFileSync(path.join(booksDir, " foo5.docx"), "前导空格的另一本", "utf8");
  fs.writeFileSync(path.join(booksDir, "foo5.docx"), "正常那本", "utf8");
  const purLead = await invoke("books:purge", " foo5.docx");
  ok(purLead.ok === false, "P1-E5c: 前导空格书名 → 拒绝（不猜是哪本）");
  ok(fs.existsSync(dbE5c) && fs.existsSync(path.join(booksDir, "foo5.docx")),
    "P1-E5c: 正常书 foo5.docx 的库与原件一格不动（数据丢失路径堵死）");
  ok(fs.existsSync(path.join(booksDir, " foo5.docx")), "P1-E5c: 前导空格那本的原件也没动（拒绝=零副作用）");

  // E6：删库失败时派生必须原样——顺序契约（先库后派生）的机器证明。
  // 反序实现（先清派生再删库）会在这里变红：库删不掉但派生已清 = 半截态，
  // 用户重试时还以为产物丢了（陆回测 OBSERVE-2 指出此前无任何顺序断言）。
  const dbE6 = mkBook("order6.docx");
  const derivedE6 = seedDerived("order6.docx");
  const realRmE6 = fs.rmSync;
  fs.rmSync = (p, o) => {
    if (String(p).endsWith("order6.docx.db")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return realRmE6(p, o);
  };
  let orderRes;
  try { orderRes = await invoke("books:purge", "order6.docx"); }
  finally { fs.rmSync = realRmE6; }
  ok(orderRes.ok === false, "P1-E6: 删库失败 → 整单报错，不谎报「已彻底删除」");
  ok(fs.existsSync(dbE6), "P1-E6: 库确实还在（注入点生效）");
  ok(derivedE6.every((f) => fs.existsSync(f)),
    "P1-E6: 删库失败时派生六项原样——顺序契约（先库后派生）有了机器断言");

  // E7：补刀路——库与原件都没了、派生还留着（上次删到一半/被占用）。
  // 再点一次「彻底删除」必须能清掉残留，而不是只回「找不到」（评审 OBSERVE-1）
  const derivedE7 = seedDerived("orphan7.docx"); // 只有派生，无库无原件
  const purOrphan = await invoke("books:purge", "orphan7.docx");
  ok(purOrphan.ok === true && purOrphan.data.removedDerived === 6,
    `P1-E7: 无库无原件但派生还在 → 补刀清掉（实测 ${purOrphan.ok ? `removedDerived=${purOrphan.data.removedDerived}` : "报错"}）`);
  ok(derivedE7.every((f) => !fs.existsSync(f)), "P1-E7: 残留六项确实没了");
  ok(String(purOrphan.data.note).includes("残留派生"), "P1-E7: note 明说清的是残留派生（不冒充删了书）");
  const purOrphan2 = await invoke("books:purge", "orphan7.docx");
  ok(purOrphan2.ok === false && String(purOrphan2.error?.message || "").includes("找不到"),
    "P1-E7: 补刀完再点 → 回到「找不到」（清干净了就不谎报）");

  // E8：Unicode case-fold 不许删错书——K（U+212A KELVIN SIGN）与 ASCII "k" 在 NTFS
  // 上是两个不同文件，但 JS 的 toLowerCase 会把它们折叠成同一个字符串。用字符串
  // 证明「同一本」会删错书（实测：purge("k.docx") 删掉了 K.docx 那本）。
  // 注意语义：k.docx 自己在 books/ 里有原件，删它是**正确**的；要证明的是
  // 「删自己的同时没顺手删掉隔壁」。
  const dbE8 = mkBook("\u212a.docx"); // Kelvin 那本（库里只有它）
  fs.writeFileSync(path.join(booksDir, "k.docx"), "ASCII k 的原件", "utf8");
  const purK = await invoke("books:purge", "k.docx");
  ok(purK.ok === true && !fs.existsSync(path.join(booksDir, "k.docx")),
    "P1-E8: k.docx 自己的原件正常删掉（它确实存在，删它是对的）");
  ok(fs.existsSync(dbE8), "P1-E8: K.docx 的库一格不动（字符串小写会误删它，这是风险点）");
  ok(purK.data?.removedDerived === 0, "P1-E8: 没有清掉 K 的派生（它不在候选名上）");
  // 若 books/ 里没有 k.docx，则应当干脆报「找不到」，而不是顺着 Unicode 折叠去删 K
  const dbE8b = mkBook("\u212b.docx", false); // Å（U+212B），与 ASCII "Å" 同理
  const purKb = await invoke("books:purge", "\u00e5.docx");
  ok(purKb.ok === false, "P1-E8b: 无原件的近似书名 → 拒绝（不折叠、不猜）");
  ok(fs.existsSync(dbE8b), "P1-E8b: Å.docx 的库一格不动");

  // E9：跨扩展兜底不许删隔壁的原件——foo9.pdf 的库没有自己的 books/ 原件时，
  // resolveAsset 会兜到 books/foo9.docx（阅读场景是容错，删除场景就是误删）。
  const dbE9pdf = mkBook("foo9.pdf", false);
  const dbE9docx = mkBook("foo9.docx", false);
  fs.writeFileSync(path.join(booksDir, "foo9.docx"), "另一本的原件", "utf8");
  const purPdf = await invoke("books:purge", "foo9.pdf");
  ok(purPdf.ok === true && !fs.existsSync(dbE9pdf), "P1-E9: foo9.pdf 的库正常删掉");
  ok(fs.existsSync(dbE9docx) && fs.existsSync(path.join(booksDir, "foo9.docx")),
    "P1-E9: 隔壁 foo9.docx 的库与原件一格不动（跨扩展兜底不许进删除路径）");

  delete process.env.BSP_LIB_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log();
console.log(`=== archive-config-fuzz(P1): ${pass} pass / ${fail} fail / ${observe} observe ===`);
process.exit(fail > 0 ? 1 : 0);
