// 入口链路 + 结构化改造对抗 fuzz（V3 第四波 P1+P2 标准轮 S2）：
//   A 段 structurize 纯文本层（P2 轨核心）12 发 / B 段 book-view 协议 handler 6 发 /
//   C 段 jobs 导入加工与资产入口 14 发 / D 段 engine 两档删除 4 发 /
//   E 段渲染层转义与状态 5 发 / F 段 build-book main 全链与开关矩阵 10 发。
// 自包含：tmp 目录 + 合成夹具 + 猴子补丁（fs/mammoth/build-book.main），不碰 library/ 真库、
// 不连网、不加载嵌入模型（BSP_SEMANTIC 相关排 slow，本轮 SKIP 登记）。
// 跑法: node test/entry-adversarial-fuzz.mjs
// 性质：对抗套件——部分用例在当前代码上为红（坐实缺陷，FAIL 输出即方法论 6.1 硬证据，
// 回填 ledger），修复后全绿；结论以发现清单为准。
//
// 51 发索引与 ledger 缺陷对照（红=修复前必 FAIL；绿=双态锁定；OBSERVE=行为登记；SKIP=排 slow）：
//   A1 红 P2-01 detectGarbled 权重×2 低估 3 字符签名（100 字符 15 签名真实乱码率 45% 算成 30%）
//   A2 绿 P2-G2 西里尔 mojibake 不检出（已知限制锁定不误伤）
//   A3 红 P2-02 structurizeChunks 不剥 lone surrogate、不入账
//   A4 红 P2-03 assessCleaned 对 null 元素抛 TypeError（契约不对称）
//   A5 绿 P2-07 repairMojibake 三道闸门（hints≥2 / 全 ≤0xff / 回读无 FFFD 且含文字）
//   A6 绿 先修后评顺序铁律（可修双重编码放行不拦）
//   A7 绿 字符族边界不误伤（孤立 Â/Ã 不成对、\t\n\r、BMP PUA、补充平面 PUA 已知限制）
//   A8 红 P2-01 块级 0.5 边界同样被低估（20 签名块真实 60% 算成 40% 漏丢）
//   A9 绿 P2-02 sqlite 绑定把 lone surrogate 静默转 U+FFFD（数据损坏面坐实，修复后仍是事实）
//   A10 绿 M-01 repairMojibake 单签名不修（éa：1 次签名但绕过 hints 闸门即可修——M-01 hints<1 变异立红依据）
//   A11 绿 M-07 structChanged 逐字段真值表（6 计数器各 +1→true、全零→false、null→false；F2a 同 commit 扩 7 字段）
//   A12 绿 M-04 assessCleaned 字数硬闸门边界（99 字符拦「内容太少」/ 100·101 过）
//   B1 红 C11 TOCTOU：exists 后文件被删 → readFileSync 未捕获 → 无状态码失败
//   B2 红 C12 缓存 key 无 libDir → applyConfig 换库后同名同尺寸同 mtime 串味
//   B3 绿 C13 LRU 淘汰序（8 上限砍最早）
//   B4 绿 体积闸门（txt 50MB / docx 8MB → 413）
//   B5 绿 C14 坏 URL / 非 asset 主机名 / %zz / 穿越 → 400
//   B6 观 C15 并发同 docx 双 mammoth 转换（无 in-flight 去重；F4 修后翻转登记为 1）
//   C1 红 C21 取消后 struct emit 复活（幽灵横幅）
//   C2 红 C21 取消后 failed emit 复活（持久幽灵横幅）
//   C3 红 C33 tmp 稳定路径碰撞（换源覆盖 → 重灌保护误判「另一本书」）
//   C4 观 C4/C37 Windows 保留设备名/尾空格文件名行为登记（libuv 逐字创建实证）
//   C5 绿 scanPending 畸形文件名不逃逸不崩
//   C6 红 C22 txt2docx 子进程未挂 j.child → 取消杀不到，临时 docx 仍落盘
//   C7 绿 C7 损坏 docx 双入口人话（协议 500 + 加工 failed 态）
//   C8 红 C1 safeBookId 放行 NUL（"a\0b" trim 不掉 \0 现返回原串——F3 补拒；M-10 立红依据）
//   C9 绿 C1 startProcessing NUL id 管线不崩（UserError + jobs 无残留条目；F3 后文案统一「书名不合法」）
//   C10 红 C2 resumeCatalog "../evil" 逃逸读 tasksDir 上级任务书（无 safeBookId 闸，人话不含「书名」）
//   C11 红 C2 catalogPrompt "../evil" 逃逸且 prompt.md 落上级目录（库外读 + 库外写双面）
//   C12 红 C3 导入 x..pdf 派生 id 含 ".."（现放行→永卡条目 + books/ 幽灵文件 + 书架 title "x." 怪行）
//   C13 红 C3 导入 ..txt 派生 id "..docx"、base 剥成 "."（现放行→书架 title "." 怪行 + 幽灵文件）
//   C14 红 C6 dest 大小写折叠碰撞（win32 语义：导 Book.docx 静默覆盖 books/ 已有 book.docx 内容）
//   D1 红 C16/C35 deleteBook rmSync 无 try：EBUSY → 半删 + 裸抛
//   D2 红 C17 purgeBook 第二步 db rmSync 无 try：原件已删库删失败 → 裸抛
//   D3 红 C18 setSkillEnabled writeFileSync 无兜底：删成功却整调用报错
//   D4 绿 C19 并发双 purge 终态干净（拒绝皆 UserError；拒绝计数 NOTE 登记）
//   E1 绿 esc 全字符（& < > " '）
//   E2 绿 renderShelf 书名/徽标全 esc
//   E3 红 C30 views-ask data-cid 未 esc（属性注入面）
//   E4 绿 C32 state.jobs 以 bookId 为键 spread，"__proto__" 建自有属性不污染原型
//   E5 绿 toast 走 textContent（无 HTML 注入）
//   F1 绿 build-book 导出面含 main（jobs 猴子补丁契约）
//   F2 红 P2-02 struct_report 无 strippedSurrogates 字段（a）；账平/零账/非零账锁定（b/c/d 绿）
//   F3 绿 干净 md 书全链零变化（report 全零 + 库内文本与解析产物逐字一致）
//   F4 红 P2-04 BSP_STRUCT 十值矩阵：尾空格/前导空格/制表换行/零宽空格/全角"０" 五种变体视同关（修复前全=开）
//   F5 红 P2-05 onStage("structurize") 抛错无 try → 穿出 main → 横幅卡「结构化改造中」
//   F6 红 P2-05 onStage("slice") 抛错无 try → 穿出 main（同缺陷第二触发点）
//   F7 绿 BSP_STRUCT=0 逃生开关真关（脏文本原样入库，不洗不拦）
//   F8 绿 默认开：替换符/私用区/控制符清掉 + 纯符号数字块丢 + 库内干净
//   F9 红 P2-01 main 全链 0.3 边界：100 字符 15 签名 md 书修复前隐形入库
//   F10 跳 P2-06 BSP_SEMANTIC 与结构化同开（需加载嵌入模型，排 slow 套件）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const AdmZip = require("adm-zip");
const mammoth = require("mammoth"); // 仅用于打桩 convertToHtml 计次（与 book-view 同一模块实例）

const { detectGarbled, repairMojibake, structurizeChunks, assessCleaned, structChanged, STRUCT_GARBLED_MAX } = await import("../src/lib/structurize.mjs");
const { startImport, startProcessing, cancelImport, scanPending, jobsStatus, jobDirs, onJobsProgress, resumeCatalog, catalogPrompt } = await import("../src/desktop/jobs.mjs");
const { createAssetProtocol } = await import("../src/desktop/book-view.mjs");
const { deleteBook, purgeBook, UserError } = await import("../src/desktop/engine.mjs");
const { listShelf, safeBookId } = await import("../src/lib/assets.mjs");
const { configureSearch } = await import("../src/lib/search.mjs");
const bb = require(require.resolve("../src/build-book.js"));

let pass = 0, fail = 0, obs = 0, skip = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name}${extra ? ` | ${extra}` : ""}`); }
};
// OBSERVE：行为登记（条件必须成立才记，不成立按 FAIL 算）——修复后允许翻转，注释里写明
const observe = (cond, name, n = "") => {
  if (cond) { obs++; console.log(`OBSERVE - ${name}${n ? ` | ${n}` : ""}`); }
  else { fail++; console.log(`FAIL - ${name}（OBSERVE 条件不成立）${n}`); }
};
const note = (name, text) => console.log(`NOTE - ${name} | ${text}`);

// ---------- 夹具基建 ----------
// TMP 控制：先建临时根，再把 TMP/TEMP 指过去——os.tmpdir() 跟随环境变量（libuv 每次调用重读），
// jobs 的 txtToDocx 落在 <TMP>/bsp-import，收尾可整体删、可精确断言
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-entry-adv-"));
const SAVED_TMP = process.env.TMP, SAVED_TEMP = process.env.TEMP;
process.env.TMP = TMP;
process.env.TEMP = TMP;

const LIB = path.join(TMP, "library");
fs.mkdirSync(LIB, { recursive: true });
configureSearch({ libDir: LIB });
const { booksDir, tasksDir, resultsDir } = jobDirs();
fs.mkdirSync(booksDir, { recursive: true });
fs.mkdirSync(path.join(TMP, "out"), { recursive: true });

const waitFor = async (cond, timeout = 5000, step = 20) => {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
};
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
const ebusy = (p) => Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: "EBUSY" });

// fs 猴子补丁：ESM default import 的 node:fs 与 require("node:fs") 是同一对象，
// 属性补丁对所有导入方可见（返回还原函数，调用方 finally 里收）
const patchFs = (prop, match, err) => {
  const orig = fs[prop];
  fs[prop] = function (p, ...rest) {
    const hit = typeof match === "function" ? match(p)
      : match instanceof RegExp ? match.test(String(p))
        : String(p) === match;
    if (hit) throw err;
    return orig.call(fs, p, ...rest);
  };
  return () => { fs[prop] = orig; };
};
const patchMammoth = (fn) => {
  const orig = mammoth.convertToHtml;
  mammoth.convertToHtml = fn;
  return () => { mammoth.convertToHtml = orig; };
};

// 填充到目标尺寸：EOCD 之后补零（zip 读取器无视 EOCD 尾巴；413 闸门也走不到 mammoth）。
// 不用 commentLen 补法——那是 uint16，最大 65535，9MB 直接 writeUInt16LE 越界崩
const padZipToSize = (buf, target) => {
  if (buf.length >= target) return buf;
  return Buffer.concat([buf, Buffer.alloc(target - buf.length)]);
};
const xmlEsc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// 最小合法 docx（parser-v3-test 同款三件套）；raw=true 时不过滤（&#xD800; 数字实体要原样进 XML）
const mkDocxBuf = (paras, { raw = false } = {}) => {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`));
  zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`));
  const body = paras.map((t) => `<w:p><w:r><w:t xml:space="preserve">${raw ? t : xmlEsc(t)}</w:t></w:r></w:p>`).join("");
  zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`));
  return zip.toBuffer();
};
// 读 docx 全文（txt2docx 产物：每行一段 <w:t xml:space="preserve">）
const readDocxText = (p) => {
  try {
    const xml = new AdmZip(p).getEntry("word/document.xml").getData().toString("utf8");
    return [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).join("\n");
  } catch { return ""; }
};
// 最小书库夹具（meta + chunks 一行 + books/ 原件）——engine.listBooks/getCatalogSummary/enrichSummary 全兼容
const makeBookDb = (name, title) => {
  const p = path.join(LIB, name);
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(p + s, { force: true });
  const db = new Database(p);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);`);
  db.prepare("INSERT INTO chunks(chapter,page,text) VALUES (?,?,?)").run("第1章", null, "测试原文甲乙丙");
  const sm = db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
  for (const [k, v] of Object.entries({ title, content_hash: "h-" + name, format: "docx", chunk_count: 1, total_chars: 7 })) sm.run(k, String(v));
  db.close();
  // 原件占位要用「书 id」名（d1.docx）不能用库文件名（d1.docx.db）——
  // resolveAsset 只认 ASSET_EXTS 候选，.db 尾巴的原件 purge 解析不到、删不掉，
  // D4 的终态干净断言会被这个夹具噪音搞假红
  const assetName = name.replace(/\.db$/, "");
  fs.writeFileSync(path.join(booksDir, assetName), "原件占位");
  return p;
};
const readDb = (dbPath) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      chunks: db.prepare("SELECT id, chapter, text FROM chunks ORDER BY id").all(),
      meta: Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map((r) => [r.key, r.value])),
    };
  } finally { db.close(); }
};

// =====================================================================
// A 段：structurize 纯文本层（P2 轨核心，12 发）
// =====================================================================
console.log("\n----- A 段：structurize 纯文本层 -----");

// A1（红 P2-01）：权重×2 低估 3 字符 â€ 家族签名——100 字符块 15 签名真实乱码率 45%，
// 修复前 bad=15×2=30 → ratio 0.3 ≤ 0.3 被 assessCleaned 放过（乱码隐形入库）
{
  const block = "\u00e2\u20ac\u201d".repeat(15) + "\u4e2d".repeat(55); // 100 字符：15 个 3 字符签名（45 坏）+ 55 中文
  const g = detectGarbled(block);
  ok(g.ratio > STRUCT_GARBLED_MAX,
    "A1 权重精确：15 个 3 字符签名的 100 字符块真实乱码率 45%（修复前算成 30% 放过）",
    `ratio=${g.ratio.toFixed(3)} bad=${g.bad}（真实坏字符 45）`);
}
// A2（绿 P2-G2）：西里尔 mojibake 不在拉丁系签名表——已知限制，锁定不误伤
{
  const cyr = "\u00d0\u009a\u00d1\u008f: 12345 \u00d0\u00b5\u00d1\u0081\u00d1\u0082\u00d1\u008c"; // 西里尔 UTF-8 被当 Latin-1 的身形
  const g = detectGarbled(cyr);
  ok(g.mojibake === 0, "A2 西里尔 mojibake 不检出（已知限制锁定不误伤）", `mojibake=${g.mojibake}`);
}
// A3（红 P2-02）：lone surrogate 不被剥、不入账——穿到 sqlite 绑定才静默变 U+FFFD
{
  const st = structurizeChunks([{ chapter: "x", page: null, text: "\u6b63\u5e38\u4e2d\u6587\u5185\u5bb9".repeat(20) + "\ud800" }]);
  ok(st.report.strippedSurrogates > 0 && st.chunks.length === 1 && !st.chunks[0].text.includes("\ud800"),
    "A3 lone surrogate 前置剥离 + 入账（不到 sqlite 绑定）",
    `strippedSurrogates=${st.report.strippedSurrogates} 残留=${st.chunks[0]?.text.includes("\ud800")}`);
}
// A4（红 P2-03）：assessCleaned 直取 c.text，[null] 抛 TypeError——structurizeChunks 却 c?.text ?? ""
{
  let threw = null, res = null;
  try { res = assessCleaned([null]); } catch (e) { threw = e; }
  ok(!threw && res && res.ok === false,
    "A4 assessCleaned 对 null 元素不抛（lib 层契约与 structurizeChunks 对称）",
    threw ? `抛 ${threw.constructor.name}: ${threw.message}` : JSON.stringify(res));
}
// A5（绿）：repairMojibake 三道闸门锁死（保守修复的边界）
{
  ok(repairMojibake("\u6b63\u5e38\u4e2d\u6587abc").repaired === false, "A5a 无签名不修");
  ok(repairMojibake("\u00c3\u00a9").repaired === false, "A5b 单签名不修（hints<2）");
  // French 警戒：纯 éé 回读还是 éé——无 CJK/ASCII 证据，分不清是真乱码还是法国书，
  // 闸门「回读含文字」拒修（A5d 的 ÿÿa 因回读带 ASCII a 才放行——同一闸门的正反两面）
  ok(repairMojibake("\u00c3\u00a9\u00c3\u00a9").repaired === false, "A5c éé 纯重音回读无文字证据拒修（French 警戒：不可把好文本修坏）");
  ok(repairMojibake("\u00c3\u00bf\u00c3\u00bfa").repaired === true, "A5d ÿÿa 回读含 ASCII 字母可修");
  ok(repairMojibake("\u00c3\u00bf\u00c3\u00bfa\u0101").repaired === false, "A5e 混 >0xff 字符拒修（CP1252 特俗字符警戒）");
}
// A6（绿）：先修后评顺序铁律——可修双重编码放行不拦（修前 ratio 1.0 的块修完干净）
{
  const st = structurizeChunks([{ chapter: "x", page: null, text: "\u00c3\u00a9a".repeat(60) }]); // éa 对 ×60
  const gate = assessCleaned(st.chunks, st.report);
  ok(st.report.repairedMojibake === 1 && gate.ok === true && st.chunks.length === 1,
    "A6 先修后评：可修双重编码修完放行（不误拦「可修」）",
    `repaired=${st.report.repairedMojibake} gate.ok=${gate.ok}`);
}
// A7（绿）：字符族边界不误伤 + 补充平面 PUA 已知限制锁定
{
  ok(detectGarbled("\u00c2\u00c3\u00e9\u00e8\u00e6\u00e5").mojibake === 0, "A7a 孤立 Â/Ã/é/è/æ/å 不成对不误判");
  ok(detectGarbled("a\tb\nc\rd").controls === 0, "A7b \\t\\n\\r 不判控制符");
  ok(detectGarbled("\ue000\uf8ff").pua === 2, "A7c BMP 私用区两头都命中");
  ok(detectGarbled("\u{F0000}\u{F8FFF}").pua === 0, "A7d 补充平面 PUA 不命中（已知限制锁定不误伤）");
  ok(detectGarbled("\ufffd").fffd === 1, "A7e 替换符 U+FFFD 命中");
}
// A8（红 P2-01 块级）：20 签名块真实乱码率 60% 被算成 40% ≤0.5 漏丢（垃圾块入库）
{
  // 100 字符：20 个 3 字符签名（真实坏字符 60）+ 40 中文——修复前 bad=20×2=40 → 0.4 ≤0.5 漏丢
  const st = structurizeChunks([{ chapter: "x", page: null, text: "\u00e2\u20ac\u201d".repeat(20) + "\u4e2d".repeat(40) }]);
  ok(st.report.droppedGarbage === 1 && st.chunks.length === 0,
    "A8 块级 0.5 边界：20 签名块（真实乱码率 60%）整块丢垃圾",
    `kept=${st.report.kept} droppedGarbage=${st.report.droppedGarbage}`);
}
// A9（绿，坐实面）：sqlite 绑定把 lone surrogate 静默转 U+FFFD——这就是 P2-02 的损坏机理
{
  const p = path.join(TMP, "sur-proof.db");
  const db = new Database(p);
  db.exec("CREATE TABLE t(x TEXT)");
  db.prepare("INSERT INTO t VALUES(?)").run("\u7532\uD800\u4e59");
  const back = db.prepare("SELECT x v FROM t").get().v;
  db.close();
  ok(back === "\u7532\ufffd\u4e59", "A9 sqlite 绑定把 lone surrogate 静默转 U+FFFD（坐实 P2-02 数据损坏面）", `回读=${JSON.stringify(back)}`);
}
// A10（绿 M-01）：repairMojibake 单签名不修——hints≥2 闸门行为锁。
// 身形取自 A5 夹具族但搭 ASCII 证据：若 hints 闸门被变异（M-01：hints < 2 → hints < 1），
// "éa" 会通过其余全部闸门（全 ≤0xff / 回读 éa 无 FFFD / 含 ASCII a）被修掉——本探针即 M-01 立红依据。
// （A5b 的纯 é roundtrip 恒等，fixed===s 闸门也会拦，锁不住 M-01——单签名必须搭文字证据）
{
  const src = "\u00c3\u00a9a"; // éa：é(C3A9) 恰好 1 次双重编码签名
  const rp = repairMojibake(src);
  ok(rp.repaired === false && rp.text === src,
    "A10 单签名不修（hints≥2 闸门锁定；M-01 hints<1 变异立红依据）",
    `repaired=${rp.repaired} text=${JSON.stringify(rp.text)}`);
}
// A11（绿 M-07）：structChanged 逐字段真值表——6 计数器各 +1 均 true、全零 false、null false。
// F2a（report 增 strippedSurrogates）同 commit 扩 7 字段：zero 表补该键，循环自动多断言一项。
{
  const zero = { droppedEmpty: 0, droppedGarbage: 0, repairedMojibake: 0, strippedControls: 0, strippedPua: 0, strippedFffd: 0, strippedSurrogates: 0 };
  ok(structChanged(null) === false, "A11a structChanged(null) → false（null 安全不抛）");
  ok(structChanged({ ...zero }) === false, "A11b 全零 → false（干净书零变化）");
  for (const k of Object.keys(zero)) {
    ok(structChanged({ ...zero, [k]: 1 }) === true, `A11c ${k}=1 → true（M-07 删该项求和即立红）`);
  }
}
// A12（绿 M-04）：assessCleaned 字数硬闸门边界——STRUCT_MIN_CHARS=100：99 拦「内容太少」/ 100·101 过
{
  const mk = (n) => [{ chapter: "x", page: null, text: "\u4e2d".repeat(n) }];
  const r99 = assessCleaned(mk(99));
  ok(r99.ok === false && /\u5185\u5bb9\u592a\u5c11/.test(r99.reason || ""),
    "A12a 99 干净字符 → 拦「内容太少」（100 字硬闸门下界）", String(r99.reason || JSON.stringify(r99)).slice(0, 60));
  const r100 = assessCleaned(mk(100)), r101 = assessCleaned(mk(101));
  ok(r100.ok === true && r101.ok === true,
    "A12b 100/101 干净字符 → 过闸（边界值恰放行）", `100=${r100.ok} 101=${r101.ok}`);
}

// =====================================================================
// B 段：book-view 协议 handler（6 发）
// =====================================================================
console.log("\n----- B 段：book-view 协议 handler -----");
const proto = createAssetProtocol();
const req = (url) => proto(new Request(url));
const ddjTxt = path.join(booksDir, "ddj.txt");
fs.writeFileSync(ddjTxt, "\u9053\u53ef\u9053\uff0c\u975e\u5e38\u9053\u3002".repeat(80), "utf8"); // >50MB 闸门不会碰的小文件

// B1（红 C11）：exists 后文件被删 → readFileSync 未捕获 → 协议请求无状态码失败
{
  const r1 = await req("book://asset/ddj.txt");
  ok(r1.status === 200, "B1 前置：txt 正常读 200", `status=${r1.status}`);
  const unp = patchFs("readFileSync", ddjTxt, enoent(ddjTxt));
  let r2 = null, thrown = null;
  try { r2 = await req("book://asset/ddj.txt"); } catch (e) { thrown = e; }
  unp();
  ok(r2 && [404, 500].includes(r2.status) && !thrown,
    "B1 TOCTOU：读取失败给人话状态码（不裸抛穿层）",
    thrown ? `裸抛 ${thrown.code || thrown.message}` : `status=${r2?.status}`);
  // B1b：docx 分支 statSync 的 TOCTOU 同构（C12-TOCTOU 面无独立坐证——陆回测
  // OBSERVE）。resolveAsset 内部先 statSync 一次（成功），handler 的 st0 是第二
  // 次——只让第二次抛，模拟「exists 检查后文件被删」。锁「读不出来」文案是为
  // 区分 resolveAsset 的「原件不在」404（两条 404 路径靠人话区分）
  fs.writeFileSync(path.join(booksDir, "toctou.docx"), mkDocxBuf(["\u4e34\u754c\u533a\u6d4b\u8bd5"]));
  const unp2 = patchFs("statSync", (() => { let n = 0; return () => (++n === 2); })(), enoent(path.join(booksDir, "toctou.docx")));
  let r3 = null, thrown2 = null, body3 = "";
  try { r3 = await req("book://asset/toctou.docx"); body3 = r3 ? await r3.text() : ""; } catch (e) { thrown2 = e; }
  unp2();
  ok(r3 && r3.status === 404 && body3.includes("\u8bfb\u4e0d\u51fa\u6765") && !thrown2,
    "B1b docx statSync 失败给人话 404（handler 层不裸抛；第二次 stat=st0）",
    thrown2 ? `裸抛 ${thrown2.code || thrown2.message}` : `status=${r3?.status} body=${body3.slice(0, 18)}`);
}
// B2（红 C12）：缓存 key 无 libDir → 换库后同名同尺寸同 mtime 串味
{
  const rootA = path.join(TMP, "ba"), rootB = path.join(TMP, "bb");
  const libA = path.join(rootA, "library"), libB = path.join(rootB, "library");
  fs.mkdirSync(path.join(rootA, "books"), { recursive: true });
  fs.mkdirSync(path.join(rootB, "books"), { recursive: true });
  const bufA = mkDocxBuf(["\u7532\u7532\u7532\u7532\u7532\u7532\u7532\u7532"]);
  const bufB = mkDocxBuf(["\u4e59\u4e59\u4e59\u4e59\u4e59\u4e59\u4e59\u4e59"]);
  const target = Math.max(bufA.length, bufB.length);
  fs.writeFileSync(path.join(rootA, "books", "same.docx"), padZipToSize(bufA, target));
  fs.writeFileSync(path.join(rootB, "books", "same.docx"), padZipToSize(bufB, target));
  // 对齐 mtime：两个文件都设成同一个整毫秒 Date。utimesSync 只保毫秒、而文件系统
  // mtime 带亚毫秒精度（实测两次写盘 .483/.461）——只对齐一边，两边 key 天生不同，碰撞根本复现不了
  const sameTime = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(path.join(rootA, "books", "same.docx"), sameTime, sameTime);
  fs.utimesSync(path.join(rootB, "books", "same.docx"), sameTime, sameTime);
  configureSearch({ libDir: libA });
  const h1 = await (await req("book://asset/same.docx")).text();
  configureSearch({ libDir: libB });
  const h2 = await (await req("book://asset/same.docx")).text();
  configureSearch({ libDir: LIB }); // 还原主库，别污染后续探针
  ok(h1.includes("\u7532") && h2.includes("\u4e59") && !h2.includes("\u7532"),
    "B2 换库后缓存不串味（key 含 libDir）",
    h2.includes("\u7532") ? "命中旧库缓存返回甲的 HTML" : `h1含甲=${h1.includes("\u7532")} h2含乙=${h2.includes("\u4e59")}`);
}
// B3（绿 C13）：LRU 淘汰序——8 上限砍最早（命中 delete+set 挪尾）
{
  let calls = 0;
  const unp = patchMammoth(async ({ path: p }) => { calls++; return { value: `<p>${path.basename(p)}</p>` }; });
  for (let i = 0; i < 9; i++) { // lru0..lru8：灌满后 lru0 被淘汰
    fs.writeFileSync(path.join(booksDir, `lru${i}.docx`), mkDocxBuf([`\u5185\u5bb9${i}`]));
    await req(`book://asset/lru${i}.docx`);
  }
  await req("book://asset/lru0.docx"); // 被淘汰 → 必须重转换
  unp();
  ok(calls === 10, "B3 LRU 淘汰最早条目（第 9 本进缓存时砍 lru0，再访必重转）", `convert 调用 ${calls} 次（期望 10）`);
}
// B4（绿）：体积闸门——txt 60MB 走 50MB 总闸；docx 9MB 走 8MB 转换闸
{
  // 真实大文件，不补丁 statSync：patchFs 只会抛不会返回——假 stat 抛进 resolveAsset 的
  // try/catch 会被当成「不存在」→ 404 而非 413。真实文件走闸门最保真（69MB 随 TMP 整体收）
  fs.writeFileSync(path.join(booksDir, "big.txt"), Buffer.alloc(60 * 1024 * 1024 + 1, 0x78));
  fs.writeFileSync(path.join(booksDir, "big2.docx"), padZipToSize(mkDocxBuf(["\u5185\u5bb9"]), 9 * 1024 * 1024 + 1));
  const r1 = await req("book://asset/big.txt");
  const r2 = await req("book://asset/big2.docx");
  ok(r1.status === 413 && r2.status === 413, "B4 体积闸门：60MB txt 与 9MB docx 都 413（不读不转）", `txt=${r1.status} docx=${r2.status}`);
}
// B5（绿 C14）：坏 URL / 非 asset 主机名 / %zz / 穿越 id → 400
{
  const bad = [
    ["book://other/ddj.txt", "非 asset 主机名"],
    ["book://asset/%zz", "百分号编码不合法"],
    ["book://asset/" + encodeURIComponent("../../x"), "斜杠穿越"],
    ["book://asset/" + encodeURIComponent("..\\..\\windows"), "反斜杠穿越"],
  ];
  let all400 = true; const detail = [];
  for (const [u, why] of bad) {
    const r = await req(u);
    if (r.status !== 400) { all400 = false; detail.push(`${why}=${r.status}`); }
  }
  ok(all400, "B5 坏地址全 400（主机名/编码/双分隔符穿越）", detail.join("；") || "");
}
// B6（观 C15）：并发同 docx 双转换——当前无 in-flight 去重（登记；F4 修后翻转）
{
  fs.writeFileSync(path.join(booksDir, "conc.docx"), mkDocxBuf(["\u5e76\u53d1\u8f6c\u6362\u539f\u6587"]));
  let calls = 0;
  const unp = patchMammoth(async () => { calls++; await sleep(30); return { value: "<p>conc</p>" }; });
  const [r1, r2] = await Promise.all([req("book://asset/conc.docx"), req("book://asset/conc.docx")]);
  const [t1, t2] = [await r1.text(), await r2.text()];
  unp();
  observe(calls === 1 || calls === 2,
    "B6 并发同 docx 转换次数登记（1=已有 in-flight 去重 / 2=无去重双转）",
    `convert 调用 ${calls} 次`);
  ok(r1.status === 200 && r2.status === 200 && t1 === t2 && t1.includes("conc"),
    "B6 并发同 docx 两请求都 200 且内容一致（正确性不依赖去重）", `status ${r1.status}/${r2.status}`);
  // B6b：不同 docx 并发不误去重（inflight key 含 libDir/id/mtime/ctime/size——
  // 两本不同书必须各转一次，防「去重把不同书折叠成一份」串内容）
  fs.writeFileSync(path.join(booksDir, "conc3.docx"), mkDocxBuf(["\u4e19\u4e19\u5e76\u53d1"]));
  fs.writeFileSync(path.join(booksDir, "conc4.docx"), mkDocxBuf(["\u4e01\u4e01\u5e76\u53d1"]));
  let calls2 = 0;
  const unp2 = patchMammoth(async ({ path: p }) => { calls2++; await sleep(30); return { value: `<p>${path.basename(p)}</p>` }; });
  const [s3, s4] = await Promise.all([req("book://asset/conc3.docx"), req("book://asset/conc4.docx")]);
  const [t3, t4] = [await s3.text(), await s4.text()];
  unp2();
  ok(calls2 === 2 && t3.includes("conc3.docx") && t4.includes("conc4.docx"),
    "B6b 不同 docx 并发各自转换（去重键不折叠不同书、内容不串）",
    `convert ${calls2} \u6b21\uff08\u671f\u671b 2\uff09 t3=\u4e19${t3.includes("conc3.docx")} t4=\u4e01${t4.includes("conc4.docx")}`);
}

// =====================================================================
// C 段：jobs 导入加工与资产入口（14 发）
// =====================================================================
console.log("\n----- C 段：jobs 导入加工与资产入口 -----");
const bspImport = path.join(TMP, "bsp-import");

// C1（红 C21）：取消后 main 返回 → struct emit 复活（jobs.get || 新建）→ 幽灵横幅
{
  fs.writeFileSync(path.join(TMP, "c1.txt"), "\u9053\u53ef\u9053\uff0c\u975e\u5e38\u9053\u3002\n".repeat(40), "utf8");
  await startImport(path.join(TMP, "c1.txt")); // bookId = c1.docx
  const events = [];
  const off = onJobsProgress((e) => events.push(e));
  const origMain = bb.main;
  bb.main = async () => { await sleep(600); return { struct: { repairedMojibake: 1, droppedEmpty: 0, droppedGarbage: 0, strippedControls: 0, strippedPua: 0, strippedFffd: 0, strippedSurrogates: 0 }, skipped: false }; };
  const p = settle(startProcessing("c1.docx"));
  await waitFor(() => events.some((e) => e.label === "\u7ed3\u6784\u5316\u6539\u9020\u4e2d"), 5000);
  cancelImport("c1.docx"); // 广播 cancelled + 删条目
  const idx = events.findIndex((e) => e.stage === "cancelled");
  await p;
  const ghosts = events.slice(idx + 1).filter((e) => e.stage !== "cancelled");
  bb.main = origMain;
  off();
  ok(ghosts.length === 0, "C1 取消后无复活事件（墓碑挡住 struct emit 幽灵横幅）",
    ghosts.length ? `复活 ${ghosts.length} 条：${ghosts.map((e) => `${e.stage}/${e.label}`).join("\uff1b")}` : "");
}
// C2（红 C21）：取消后 main 返 null → failed emit 复活（持久幽灵横幅，卡住重导入）
{
  fs.writeFileSync(path.join(TMP, "c2.txt"), "\u540d\u53ef\u540d\uff0c\u975e\u5e38\u540d\u3002\n".repeat(40), "utf8");
  await startImport(path.join(TMP, "c2.txt"));
  const events = [];
  const off = onJobsProgress((e) => events.push(e));
  const origMain = bb.main;
  bb.main = async () => { await sleep(600); return null; };
  const p = settle(startProcessing("c2.docx"));
  await waitFor(() => events.some((e) => e.label === "\u7ed3\u6784\u5316\u6539\u9020\u4e2d"), 5000);
  cancelImport("c2.docx");
  const idx = events.findIndex((e) => e.stage === "cancelled");
  await p;
  const ghosts = events.slice(idx + 1).filter((e) => e.stage !== "cancelled");
  bb.main = origMain;
  off();
  ok(ghosts.length === 0, "C2 取消后无复活事件（墓碑挡住 failed emit 持久幽灵）",
    ghosts.length ? `复活 ${ghosts.length} 条：${ghosts.map((e) => `${e.stage}/${e.label}`).join("\uff1b")}` : "");
}
// C3（红 C33）：tmp 稳定路径碰撞——换源重跑同名 base 覆盖 → 重灌保护误判「另一本书」
{
  fs.writeFileSync(path.join(TMP, "swap.txt"), "\u7532\u6807\u8bb0\u5185\u5bb9\uff1a\u9053\u53ef\u9053\u975e\u5e38\u9053\u3002\n".repeat(10), "utf8");
  await startImport(path.join(TMP, "swap.txt"));
  const origMain = bb.main;
  bb.main = async () => null; // 加工在 main 前失败，但 txtToDocx 已产出
  await settle(startProcessing("swap.docx"));
  fs.writeFileSync(path.join(booksDir, "swap.txt"), "\u4e59\u6807\u8bb0\u5185\u5bb9\uff1a\u540d\u53ef\u540d\u975e\u5e38\u540d\u3002\n".repeat(10), "utf8"); // 同 base 换源
  await settle(startProcessing("swap.docx"));
  bb.main = origMain;
  const files = fs.existsSync(bspImport) ? fs.readdirSync(bspImport).filter((f) => f.startsWith("swap")) : [];
  const texts = files.map((f) => readDocxText(path.join(bspImport, f)));
  const hasJia = texts.some((t) => t.includes("\u7532\u6807\u8bb0")), hasYi = texts.some((t) => t.includes("\u4e59\u6807\u8bb0"));
  ok(files.length >= 2 && hasJia && hasYi,
    "C3 tmp 转换文件按内容区分（换源不碰撞：甲/乙两份都在）",
    `swap 文件 ${files.length} 个（${files.join(",")}）；甲=${hasJia} 乙=${hasYi}`);
}
// C4（观 C4/C37）：Windows 保留设备名/尾空格文件名——libuv 逐字创建实证 + 书架层不崩
{
  const auxOk = (() => { try { fs.writeFileSync(path.join(booksDir, "aux.txt"), "x", "utf8"); return true; } catch { return false; } })();
  const trailOk = (() => { try { fs.writeFileSync(path.join(booksDir, "\u5c3e\u7a7a\u683c .txt"), "x", "utf8"); return true; } catch { return false; } })();
  observe(true, "C4 Windows 保留设备名/尾空格文件名创建行为登记（libuv \\?\\ 前缀实证）",
    `aux.txt 创建=${auxOk}；\u300c\u5c3e\u7a7a\u683c .txt\u300d创建=${trailOk}`);
  let shelf = null, shelfErr = null;
  try { shelf = listShelf(LIB); } catch (e) { shelfErr = e; }
  ok(!shelfErr && Array.isArray(shelf) && shelf.every((b) => b.id && typeof b.id === "string"),
    "C4 保留名/尾空格文件在场时书架不崩、条目 id 完好", shelfErr ? `抛 ${shelfErr.message}` : `条目 ${shelf?.length} 个`);
  for (const f of ["aux.txt", "\u5c3e\u7a7a\u683c .txt"]) { try { fs.rmSync(path.join(booksDir, f), { force: true }); } catch { /* 设备名删不掉就算了，tmp 整体收 */ } }
}
// C5（绿）：scanPending 畸形文件名（目录名 .json / ".." 基名）不逃逸不崩
{
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "legit.docx.json"), JSON.stringify({ book: { db: "legit.docx.db" } }));
  fs.writeFileSync(path.join(LIB, "legit.docx.db"), ""); // 库还在 → 该挂起
  fs.mkdirSync(path.join(tasksDir, "sub.json"), { recursive: true }); // 目录名以 .json 结尾
  fs.writeFileSync(path.join(tasksDir, "..json"), "{}"); // 基名就是 ".."
  const pending = scanPending();
  ok(pending.length === 1 && pending[0] === "legit.docx",
    "C5 scanPending 只收合法挂起项（畸形文件名不逃逸、不崩、不误挂）", `实际：${pending.join(",") || "无"}`);
  fs.rmSync(path.join(tasksDir, "sub.json"), { recursive: true, force: true });
  fs.rmSync(path.join(tasksDir, "..json"), { force: true });
  fs.rmSync(path.join(tasksDir, "legit.docx.json"), { force: true });
  fs.rmSync(path.join(LIB, "legit.docx.db"), { force: true });
}
// C6（红 C22）：txt2docx 子进程未挂 j.child → 取消杀不到 → 32MB 转换取消后仍跑完落盘
{
  const bigLine = "\u9053\u53ef\u9053\uff0c\u975e\u5e38\u9053\uff1b\u540d\u53ef\u540d\uff0c\u975e\u5e38\u540d\uff1b\u65e0\u540d\u5929\u5730\u4e4b\u59cb\uff1b\u6709\u540d\u4e07\u7269\u4e4b\u6bcd\u3002"; // 30 字 ≈ 91 字节
  fs.writeFileSync(path.join(TMP, "big.txt"), bigLine.repeat(360000), "utf8"); // ≈32MB，实测转换 ~0.9s
  await startImport(path.join(TMP, "big.txt"));
  const ev6 = [];
  const off = onJobsProgress((e) => ev6.push(e));
  const p6 = settle(startProcessing("big.docx"));
  await waitFor(() => ev6.some((e) => e.label === "\u51c6\u5907\u6587\u4ef6"), 5000);
  await sleep(120); // 转换进行中（约 0.9s 总时长）
  cancelImport("big.docx");
  await p6;
  const landed = await waitFor(() => fs.existsSync(path.join(bspImport, "big.docx")), 8000, 100);
  off();
  ok(!landed, "C6 取消杀掉 txt2docx 子进程（转换不落地）",
    landed ? "取消后转换仍跑完并落盘（子进程没挂上取消闸门）" : "");
}
// C7（绿 C7）：损坏 docx 双入口人话——协议层 500 + 加工层 failed 态
{
  fs.writeFileSync(path.join(booksDir, "corrupt.docx"), mkDocxBuf(["\u635f\u574fdocx\u6d4b\u8bd5\u539f\u6587\u7532\u4e59\u4e19\u4e01\u6208\u5df1\u5e9a\u8f9b\u58ec\u7678\uff0c\u957f\u5ea6\u8db3\u591f\u3002"]));
  const cbuf = fs.readFileSync(path.join(booksDir, "corrupt.docx"));
  cbuf[1] = 0x58; // PK → XK：本地文件头签名坏
  fs.writeFileSync(path.join(booksDir, "corrupt.docx"), cbuf);
  const r500 = await req("book://asset/corrupt.docx");
  const body500 = await r500.text();
  ok(r500.status === 500 && /\u6253\u4e0d\u5f00/.test(body500), "C7a 损坏 docx → 500 人话（协议层）", `status=${r500.status} body=${body500.slice(0, 40)}`);
  let e7 = null;
  try { await startProcessing("corrupt.docx"); } catch (e) { e7 = e; }
  ok(e7 instanceof UserError && /\u52a0\u5de5\u5931\u8d25/.test(e7.message) && jobsStatus()["corrupt.docx"]?.stage === "failed",
    "C7b 损坏 docx 加工 → failed 态人话（不卡死不裸崩）",
    e7 ? `${e7.constructor.name}: ${String(e7.message).slice(0, 60)}` : "\u7adf\u6ca1\u629b");
}
// C8（红 C1）：safeBookId 放行 NUL——"a\0b" 的 \0 不是空白（trim 不掉）、不含 / \ ..，
// 修复前返回原串。放行后果：带 NUL 的 bookId 直通 jobs Map 键与路径拼接（fs 层 ERR_INVALID_ARG_VALUE
// 或 win32 设备名/流面）——F3 补 \0 拒绝；M-10（删 NUL 拒绝）立红依据。
{
  const evil = "a" + String.fromCharCode(0) + "b";
  const id = safeBookId(evil);
  ok(id === null, "C8 safeBookId 拒 NUL（修复前放行带 NUL 的 id）", `返回=${JSON.stringify(id)}`);
  // win32 特有面（毛求疵 F3 OBSERVE-2/3）：冒号是 ADS 别名（"a:b.json" 是
  // base "a" 的隐藏流，静默产怪文件却不报错=闸门名不副实同型）；尾点被系统
  // 剥除会撞名（"a." 与 "a" 同文件）。只在 win32 拒——macOS/Linux 上冒号/
  // 尾点是合法文件名字符（书名「第1章:开始」），不许误伤。
  const win = process.platform === "win32";
  const colon = safeBookId("a:b");
  ok(colon === (win ? null : "a:b"), "C8b win32 拒冒号（ADS 别名）/ 非 win32 放行（书名合法）", `平台=${process.platform} 返回=${JSON.stringify(colon)}`);
  const dot = safeBookId("a.");
  ok(dot === (win ? null : "a."), "C8c win32 拒尾点（系统剥点会撞名）/ 非 win32 放行", `返回=${JSON.stringify(dot)}`);
}
// C9（绿 C1 行为锁）：startProcessing NUL id 管线不崩——safeBookId 修复前放行，但 resolveAsset
// 候选路径含 NUL、existsSync 全 false（stat 抛被吞）→ UserError「找不到原件」，无 jobs 残留条目。
// F3 后文案统一「书名不合法」——断言只锁 UserError + 无残留，跨修复稳定。
{
  const evil = "a" + String.fromCharCode(0) + "b";
  const r = await settle(startProcessing(evil));
  ok(!r.ok && r.e instanceof UserError && jobsStatus()[evil] === undefined,
    "C9 startProcessing NUL id 不崩（UserError + jobs 无残留条目）",
    r.ok ? `竟返回 ${JSON.stringify(r.v).slice(0, 60)}` : `${r.e?.constructor?.name}: ${String(r.e?.message).slice(0, 60)}`);
}
// C10（红 C2）：resumeCatalog "../evil" 逃逸——入口不过 safeBookId，taskPath 拼到 tasksDir 上级，
// 读取并 JSON.parse 库外文件；本次因 evil.db 不存在才停在「书库文件不见了」——若攻击者同时放了
// evil.db，importCatalog 会拿库外 task+result 真入库（任意文件读 + 编目注入面）。F3 三入口补闸。
{
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(TMP, "evil.json"), "{}", "utf8"); // tasksDir 上级的「任务书」
  const rp = path.join(TMP, "c10-result.json");
  fs.writeFileSync(rp, "{}", "utf8");
  const r = await settle(resumeCatalog("../evil", rp));
  ok(!r.ok && r.e instanceof UserError && String(r.e.message).includes("\u4e66\u540d\u4e0d\u5408\u6cd5"),
    "C10 resumeCatalog 逃逸 id → UserError「书名不合法」（修复前：读库外任务书，人话不含书名）",
    r.ok ? `竟返回 ${JSON.stringify(r.v).slice(0, 60)}` : `${r.e?.constructor?.name}: ${String(r.e?.message).slice(0, 80)}`);
  fs.rmSync(path.join(TMP, "evil.json"), { force: true });
  fs.rmSync(rp, { force: true });
}
// C11（红 C2）：catalogPrompt "../evil" 逃逸且落盘——不过闸 → 读库外任务书 + prompt.md 写到
// tasksDir 上级（任意路径写面）。双证据：人话拒 + 逃逸产物不落盘。
{
  fs.writeFileSync(path.join(TMP, "evil.json"), "{}", "utf8");
  const escaped = path.join(TMP, "evil.prompt.md");
  // catalogPrompt 是同步函数（不返 Promise）——settle 直接吃会 p.then 崩，照 D4 先例包 async IIFE
  const r = await settle((async () => catalogPrompt("../evil"))());
  ok(!r.ok && r.e instanceof UserError && String(r.e.message).includes("\u4e66\u540d\u4e0d\u5408\u6cd5") && !fs.existsSync(escaped),
    "C11 catalogPrompt 逃逸 id → UserError「书名不合法」且 prompt.md 不落上级目录",
    r.ok ? `竟返回 path=${r.v?.path}` : `${r.e?.constructor?.name}: ${String(r.e?.message).slice(0, 80)}${fs.existsSync(escaped) ? "\uff1b\u9003\u9038\u4ea7\u7269\u5df2\u843d\u76d8" : ""}`);
  fs.rmSync(path.join(TMP, "evil.json"), { force: true });
  fs.rmSync(escaped, { force: true });
}
// C12（红 C3）：导入 x..pdf——base 剥成 "x."，派生 bookId "x..pdf" 含 ".."，startImport 修复前
// 不过闸 → emit 出永卡条目（startProcessing 侧 safeBookId 才拒）、书架多一张 title "x." 的 raw 幽灵卡。
// 双证据：人话拒 + jobsStatus/书架无条目 + books/ 无幽灵文件。
{
  const src = path.join(TMP, "x..pdf");
  fs.writeFileSync(src, "\u7532\u6807\u8bb0\uff1ax..pdf \u6d4b\u8bd5\u5185\u5bb9", "utf8");
  const r = await settle(startImport(src));
  const entry = jobsStatus()["x..pdf"];
  const ghost = path.join(booksDir, "x..pdf");
  ok(!r.ok && r.e instanceof UserError && /\u4e66\u540d/.test(String(r.e.message)) && !entry && !fs.existsSync(ghost),
    "C12 导入 x..pdf → 人话拒（派生 id 含 ..；修复前放行出永卡条目 + 幽灵文件）",
    r.ok ? `竟导入 bookId=${r.v?.bookId}` : `${r.e?.constructor?.name}: ${String(r.e?.message).slice(0, 60)}`
      + `\uff1b\u6b8b\u7559\u6761\u76ee=${!!entry} \u5e7d\u7075\u6587\u4ef6=${fs.existsSync(ghost)}`);
  cancelImport("x..pdf"); // 修复前放行的残留自清，别污染后续探针的书架视图
  fs.rmSync(ghost, { force: true });
}
// C13（红 C3）：导入 ..txt——base 剥成 "."，派生 bookId "..docx"、dest books/"..txt"；
// 书架实证 title "." 怪行（listShelf）。同 C12 双证据 + 怪行断言。
{
  const src = path.join(TMP, "..txt");
  fs.writeFileSync(src, "\u4e59\u6807\u8bb0\uff1a..txt \u6d4b\u8bd5\u5185\u5bb9", "utf8");
  const r = await settle(startImport(src));
  const entry = jobsStatus()["..docx"];
  const ghost = path.join(booksDir, "..txt");
  const weird = listShelf(LIB).some((b) => b.title === ".");
  ok(!r.ok && r.e instanceof UserError && /\u4e66\u540d/.test(String(r.e.message)) && !entry && !fs.existsSync(ghost) && !weird,
    "C13 导入 ..txt → 人话拒（修复前放行 title=\".\" 怪行 + 幽灵文件）",
    r.ok ? `竟导入 bookId=${r.v?.bookId}` : `${r.e?.constructor?.name}: ${String(r.e?.message).slice(0, 60)}`
      + `\uff1b\u6b8b\u7559\u6761\u76ee=${!!entry} \u5e7d\u7075\u6587\u4ef6=${fs.existsSync(ghost)} \u602a\u884c=${weird}`);
  cancelImport("..docx");
  fs.rmSync(ghost, { force: true });
}
// C14（红 C6）：dest 大小写折叠碰撞——win32 文件系统大小写不敏感：books/ 已有 book.docx（甲），
// 再导 Book.docx（乙）→ copyFileSync 落到同一 inode，甲内容被静默覆盖（用户的书没了）。
// F6 补 dest 碰撞检测（readdir 小写相等即拒）。本机 win32 语义成立（探针注释锁定前提）。
{
  fs.writeFileSync(path.join(booksDir, "book.docx"), "\u7532\u6807\u8bb0\u539f\u4ef6\u5185\u5bb9", "utf8");
  const src = path.join(TMP, "Book.docx");
  fs.writeFileSync(src, "\u4e59\u6807\u8bb0\u65b0\u5bfc\u5165\u5185\u5bb9", "utf8");
  const r = await settle(startImport(src));
  const after = fs.readFileSync(path.join(booksDir, "book.docx"), "utf8");
  const kept = after.includes("\u7532") && !after.includes("\u4e59");
  ok(!r.ok && r.e instanceof UserError && kept,
    "C14 dest 大小写碰撞 → 人话拒且原书内容不动（win32 折叠语义：修复前静默覆盖）",
    r.ok ? `竟导入 bookId=${r.v?.bookId}` : `${r.e?.constructor?.name}: ${String(r.e?.message).slice(0, 60)}`
      + `\uff1b\u539f\u6587\u4ef6\u4ecd\u4e3a\u7532=${kept}`);
  cancelImport("Book.docx");
  fs.rmSync(path.join(booksDir, "book.docx"), { force: true });
  fs.rmSync(path.join(booksDir, "Book.docx"), { force: true });
}

// =====================================================================
// D 段：engine 两档删除（4 发）
// =====================================================================
console.log("\n----- D 段：engine 两档删除 -----");

// D1（红 C16/C35）：deleteBook rmSync 无 try——EBUSY → 半删 + 裸抛（IPC 一屏英文堆栈）
{
  const dbP = makeBookDb("d1.docx.db", "\u5220\u4e66\u4e00");
  const unp = patchFs("rmSync", dbP, ebusy(dbP));
  let e1 = null;
  try { deleteBook("d1.docx"); } catch (e) { e1 = e; }
  unp();
  ok(e1 instanceof UserError, "D1 rmSync EBUSY → UserError 人话（不半删不裸抛）",
    e1 ? `${e1.constructor.name}: ${String(e1.message).slice(0, 60)}` : "\u7adf\u6ca1\u629b");
}
// D2（红 C17）：purgeBook 第二步 db rmSync 无 try——原件已删、库删失败 → 裸抛 + 不一致态
{
  const dbP = makeBookDb("d2.docx.db", "\u5220\u4e66\u4e8c");
  const unp = patchFs("rmSync", dbP, ebusy(dbP));
  let e2 = null;
  try { purgeBook("d2.docx"); } catch (e) { e2 = e; }
  unp();
  ok(e2 instanceof UserError && fs.existsSync(dbP),
    "D2 db rmSync EBUSY → UserError 人话且库文件不动（半途失败可描述）",
    e2 ? `${e2.constructor.name}: ${String(e2.message).slice(0, 60)}` : "\u7adf\u6ca1\u629b");
}
// D3（红 C18）：setSkillEnabled writeFileSync 无兜底——删成功却整调用报错（用户见失败实则成功）
{
  const dbP = makeBookDb("d3.docx.db", "\u5220\u4e66\u4e09");
  const statePath = path.join(LIB, "skill-state.json");
  const unp = patchFs("writeFileSync", statePath, ebusy(statePath));
  let e3 = null, r3 = null;
  try { r3 = deleteBook("d3.docx"); } catch (e) { e3 = e; }
  unp();
  ok(!e3 && r3 && !fs.existsSync(dbP),
    "D3 开关状态写失败不拖垮删除（书库照删，用户不看到假失败）",
    e3 ? `\u88c5\u629b ${String(e3.message).slice(0, 60)}` : `deleted=${!!r3}`);
}
// D4（绿 C19）：并发双 purge——终态干净；任一拒绝必须是 UserError（拒绝计数 NOTE 登记）
{
  makeBookDb("d4.docx.db", "\u5220\u4e66\u56db");
  // purgeBook/deleteBook 是同步函数——裸调用会在数组参数求值时同步抛出，allSettled 包不住
  // （第一轮实战就崩在这）。async IIFE 把同步抛错转 rejection，才能观测「一成一拒」竞态终态
  const rs = await Promise.allSettled([
    (async () => purgeBook("d4.docx"))(),
    (async () => purgeBook("d4.docx"))(),
  ]);
  const rejects = rs.filter((r) => r.status === "rejected").map((r) => r.reason);
  const allUserErr = rejects.every((e) => e instanceof UserError);
  const shelfClean = listShelf(LIB).every((b) => b.id !== "d4.docx")
    && !fs.existsSync(path.join(booksDir, "d4.docx.db")) && !fs.existsSync(path.join(LIB, "d4.docx.db"));
  ok(allUserErr && shelfClean, "D4 并发双 purge 终态干净（书架无痕 + 拒绝皆 UserError）",
    `\u62d2\u7edd ${rejects.length} 个\uff1a${rejects.map((e) => e.message).join(" / ") || "\u65e0"}`);
  note("D4 \u5e76\u53d1\u53cc purge \u884c\u4e3a\u767b\u8bb0", `\u4e00\u6210\u4e00\u62d2=${rejects.length === 1} \u90fd\u6210=${rejects.length === 0} \u5171\u62d2=${rejects.length}`);
}

// =====================================================================
// E 段：渲染层转义与状态（5 发，DOM stub + 动态 import app.js）
// =====================================================================
console.log("\n----- E 段：渲染层转义与状态 -----");
{
  // 最小 DOM stub（renderer-graph-test 同款）：任意选择器回记忆化元素
  const elCache = new Map();
  const makeEl = (sel = "") => ({
    sel, innerHTML: "", textContent: "", value: "", checked: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    querySelector: (s) => getEl(s), querySelectorAll: () => [],
    closest: () => null, scrollIntoView() {}, remove() {}, focus() {},
  });
  const getEl = (s) => { if (!elCache.has(s)) elCache.set(s, makeEl(s)); return elCache.get(s); };
  const mainEl = getEl("#main");
  global.document = {
    querySelector: (s) => getEl(s),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener: () => {},
  };
  global.CustomEvent = global.CustomEvent || class CustomEvent { constructor(t) { this.type = t; } };
  global.location = { reload() {} };
  global.confirm = () => true;

  const ipcCalls = [];
  const reply = (data) => Promise.resolve({ ok: true, data });
  const studyStub = {
    configGet: () => { ipcCalls.push("configGet"); return reply({ dirs: {}, firstRun: false, packaged: false }); },
    configSet: () => reply({}),
    pickLibDir: () => reply(null),
    booksList: () => { ipcCalls.push("booksList"); return reply([]); },
    deleteBook: () => reply({}),
    purgeBook: () => reply({}),
    importBook: () => reply({}),
    jobsStart: () => reply({}),
    filePathOf: (f) => (f && (f.path || f.name)) || "",
    chatCompact: () => reply({ ok: false, skipped: true }),
    jobsStatus: () => reply({}),
    jobsScanPending: () => reply([]),
    jobsCatalogPrompt: () => reply({}),
    jobsCancel: () => reply({}),
    jobsPickResult: () => reply(null),
    jobsResumeCatalog: () => reply({}),
    enrichStart: () => reply({}),
    enrichCancel: () => reply({}),
    enrichStatus: () => reply({}),
    enrichAudit: () => reply({}),
    ask: () => reply({ mode: "book", results: [] }),
    llmConfigGet: () => reply({ baseUrl: "", model: "", hasKey: false, keyTail: null, encryption: "unknown", warning: null }),
    llmConfigSet: () => reply({}),
    llmTest: () => reply({ reply: "\u6536\u5230" }),
    chatSummary: () => reply({ answer: "\u6d4b\u8bd5\u603b\u7ed3", citations: [], dropped: 0, segments: 6, mode: "book", book: "\u6d4b\u8bd5\u4e66" }),
    chatArchiveList: () => reply([]),
    chatArchiveClear: () => reply({ cleared: true }),
    chapters: () => reply({}),
    block: () => reply({}),
    locate: () => reply({}),
    readerThemes: () => reply({}),
    readerThemeBlocks: () => reply({}),
    readerPersons: () => reply({}),
    readerPersonBlocks: () => reply({}),
    bookOriginal: () => reply({}),
    bookOpenExternal: () => reply({}),
    skillsList: () => reply([]),
    skillRead: () => reply({}),
    skillToggle: () => reply({}),
    engineStatus: () => reply({}),
    warmup: () => reply({}),
    onModelProgress: () => {}, onEngineReady: () => {}, onEngineError: () => {},
    onJobsProgress: (cb) => { studyStub.__jobsCb = cb; }, onEnrichProgress: () => {},
  };
  global.window = { study: studyStub, addEventListener() {}, dispatchEvent() {} };

  const app = await import("../src/renderer/app.js");
  await sleep(60); // boot 是异步的，等几个 IPC 往返
  const { esc } = await import("../src/renderer/views.js");

  // E1（绿）：esc 全字符（& < > " ' 一个不落）
  ok(esc('<a>&"\'') === "&lt;a&gt;&amp;&quot;&#39;", "E1 esc 全字符转义（&<>\"'）", esc('<b>'));
  // E2（绿）：renderShelf 书名/徽标全 esc（书名可合法含 < > 引号）
  {
    app.state.books = [{
      id: 'x"><img src=q onerror=alert(1)>', title: "<script>alert(1)</script>", chunks: 3,
      skillEnabled: true, status: "processed", format: "docx", asset: { exists: true },
      catalog: { cataloged: false, themes: [], persons: 0 }, enrich: { ready: false },
    }];
    app.state.jobs = {};
    app.show("shelf");
    const h = mainEl.innerHTML;
    // 断言认「穿越签名」不认「裸子串」：esc 之后 onerror=alert(1) 作为普通文本仍留在属性值里，
    // 但被 &quot; 包着、浏览器不执行——真正的注入签名是裸 "><（引号+尖号连体）；
    // 同时正向断言恶意 id 确实以 &quot;&gt;&lt;img 的转义形态在场（不是被悄悄丢掉）
    ok(!h.includes("<script>alert(1)</script>") && !h.includes('"><img')
      && h.includes("&lt;script&gt;") && h.includes("&quot;&gt;&lt;img"),
      "E2 书架书名/徽标全 esc（无裸 script、无属性穿越，恶意 id 以转义形态在场）", h.slice(0, 120));
  }
  // E3（红 C30）：views-ask data-cid 未 esc——引用徽标属性注入面（results cite + cloud citations 两处）
  {
    const EVIL = '9" onmouseover="alert(1)" data-z="';
    app.state.ask = {
      mode: "book", bookId: "evil.docx", question: "", loading: false, skillSlug: null,
      result: { mode: "book", results: [{ id: EVIL, book: "\u6d4b\u8bd5\u4e66", bookId: "evil.docx", loc: "\u7b2c\u4e00\u7ae0", text: "\u539f\u6587", rerank: 0.9 }] },
    };
    app.state.llm = {
      config: { hasKey: true, model: "m", keyTail: "\u2026x" },
      answer: { answer: "\u7b54", citations: [{ id: EVIL, book: "\u6d4b\u8bd5\u4e66", bookId: "evil.docx", loc: "\u7b2c\u4e00\u7ae0" }], dropped: 0 },
      error: null, loading: false, editing: false,
    };
    app.show("ask");
    const h = mainEl.innerHTML;
    const cites = (h.match(/data-cid="[^"]*"/g) || []).length;
    ok(!h.includes('onmouseover="alert(1)"'),
      "E3 data-cid 转义（引用徽标属性注入面，results+cloud 两处）",
      `data-cid ${cites} 处${h.includes('onmouseover="alert(1)"') ? "，含裸 onmouseover 注入" : ""}`);
  }
  // E4（绿 C32）：state.jobs 以 bookId 为键 spread——"__proto__" 计算键建自有属性不污染原型
  {
    app.state.jobs = {};
    studyStub.__jobsCb({ bookId: "__proto__", stage: "slice", label: "\u5e7d\u7075\u6a6e\u5e55" });
    const j = app.state.jobs;
    ok(Object.getPrototypeOf(j) === Object.prototype && Object.keys(j).includes("__proto__") && j["__proto__"]?.stage === "slice",
      "E4 __proto__ 键建自有属性不污染原型（spread 计算键语义锁定）",
      `keys=${Object.keys(j).join(",")}`);
  }
  // E5（绿）：toast 走 textContent（HTML 注入无效）
  {
    app.toast('<img src=x onerror=alert(1)>');
    const t = getEl("#toast");
    ok(t.textContent === '<img src=x onerror=alert(1)>' && t.innerHTML === "",
      "E5 toast 走 textContent（无 HTML 注入）", `innerHTML=${JSON.stringify(t.innerHTML)}`);
  }
}

// =====================================================================
// F 段：build-book main 全链与开关矩阵（10 发）
// =====================================================================
console.log("\n----- F 段：build-book main 全链与开关矩阵 -----");

// md 目录夹具（HEADING_MAX=30 + 短行启发式都不会误吃：行都带标点或 >20 字符或纯数字）
const fixRoot = path.join(TMP, "fix");
const cleanDir = path.join(fixRoot, "clean");
const dirtyDir = path.join(fixRoot, "dirty");
const ratioDir = path.join(fixRoot, "ratio");
fs.mkdirSync(cleanDir, { recursive: true });
fs.mkdirSync(dirtyDir, { recursive: true });
fs.mkdirSync(ratioDir, { recursive: true });
// 干净书要过 100 字符硬闸门（STRUCT_MIN_CHARS）——原文各重复 4 遍（内容零脏点，F3 逐字对拍与 parseMd 双跑都确定性成立；行仍 >20 字符带标点，不会被升标题）
fs.writeFileSync(path.join(cleanDir, "a.md"), "学而时习之，不亦说乎？有明自远方来，不亦乐乎？人不知而不愠，不亦君子乎？".repeat(4), "utf8");
fs.writeFileSync(path.join(cleanDir, "b.md"), "吾日三省吾身：为人谋而不忠乎？与朋友交而不信乎？传不习乎？".repeat(4), "utf8");
fs.writeFileSync(path.join(dirtyDir, "a.md"),
  "\u6b63\u5e38\u6587\u672c\u7b2c\u4e00\u884c\uff0c\u7528\u4e8e\u57ab\u9ad8\u5b57\u6570\u8ba9\u5168\u4e66\u8f7b\u677e\u8fc7\u4e00\u767e\u5b57\u7b26\u7684\u786c\u95f8\u95e8\uff0c\u6545\u6b64\u5904\u591a\u5199\u51e0\u53e5\u5e9f\u8bdd\u7b97\u957f\u5ea6\u3002\n"
  + "\u7532\ufffd\u4e59\ufffd\u4e19\ue000\u4e01\ue001\u5df2\ue002\u5e9a\ue003\u8f9b\ue004\u58ec\uff0c\u5e26\u66ff\u6362\u7b26\u4e0e\u79c1\u7528\u533a\u7684\u6b63\u6587\uff0c\u957f\u5ea6\u4e5f\u8db3\u591f\u6210\u5757\u3002\n"
  + "\u63a7\u5236\u7b26\u0001\u0002\u0003\u5939\u6742\u5728\u6b63\u6587\u91cc\u7684\u4e00\u53e5\u8bdd\uff0c\u540c\u6837\u8db3\u591f\u957f\u4e0d\u4f1a\u88ab\u8bef\u5224\u4e3a\u77ed\u6807\u9898\u884c\u3002\n"
  + "12345678\n\u3002\u3002\u3002\u3002\u3002\u3002\n", "utf8");
fs.writeFileSync(path.join(dirtyDir, "b.md"), "\u53c8\u4e00\u6bb5\u5e72\u51c0\u7684\u6b63\u6587\uff0c\u786e\u4fdd\u6e05\u6d17\u540e\u4fdd\u7559\u5b57\u6570\u8d85\u8fc7\u4e00\u767e\u5b57\u7b26\u7684\u786c\u95f8\u95e8\u4e0d\u4f1a\u88ab\u8bef\u62e6\u3002", "utf8");
// ratioDir：a.md = 100 字符含 15 个 3 字符 â€ 签名（真实坏字符 45）+ b.md 30 中文字 → 全文 130
fs.writeFileSync(path.join(ratioDir, "a.md"), "\u00e2\u20ac\u201d".repeat(15) + "\u4e2d".repeat(55), "utf8");
fs.writeFileSync(path.join(ratioDir, "b.md"), "\u4e2d".repeat(30), "utf8");
const surDocx = path.join(fixRoot, "sur.docx");
fs.writeFileSync(surDocx, mkDocxBuf(["甲&#xD800;乙\u6d4b\u8bd5\u6587\u672c\u8db3\u591f\u957f\u5ea6\u4ee5\u514d\u88ab\u5185\u5bb9\u592a\u5c11\u95f8\u95e8\u62e6\u4e0b\u3002".repeat(8)], { raw: true }));

// buildWith：六值开关矩阵驱动器——截获 console + 还原 exitCode/env + 回读 struct_report
const buildWith = async (flag, file, outName, opts = {}) => {
  const out = path.join(TMP, "out", outName);
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(out + s, { force: true });
  const had = Object.prototype.hasOwnProperty.call(process.env, "BSP_STRUCT");
  const keep = process.env.BSP_STRUCT;
  if (flag === undefined) delete process.env.BSP_STRUCT; else process.env.BSP_STRUCT = flag;
  const keepExit = process.exitCode;
  const cap = [];
  const ol = console.log, oe = console.error;
  console.log = (...a) => cap.push(a.map(String).join(" "));
  console.error = (...a) => cap.push(a.map(String).join(" "));
  let r = null, err = null;
  try { r = await bb.main([file, "-o", out], opts); } catch (e) { err = e; }
  finally {
    console.log = ol; console.error = oe; process.exitCode = keepExit;
    if (had) process.env.BSP_STRUCT = keep; else delete process.env.BSP_STRUCT;
  }
  let db = null, report = null;
  try { db = readDb(out); report = db.meta.struct_report ? JSON.parse(db.meta.struct_report) : null; } catch { /* 没建成库 */ }
  return { r, err, out, captured: cap.join("\n"), report, chunks: db ? db.chunks : [] };
};
const dbText = (w) => w.chunks.map((c) => c.text).join("\n");

// F1（绿）：build-book 导出面——jobs 猴子补丁契约（C1/C2/C3 依赖）
ok(typeof bb.main === "function" && typeof bb.parseDocx === "function" && typeof bb.parseMd === "function",
  "F1 build-book 导出面含 main/parseDocx/parseMd（jobs 猴子补丁契约）", Object.keys(bb).slice(0, 8).join(","));

// F2（红 P2-02 账面）：struct_report 无 strippedSurrogates 字段 + surrogate 静默穿库
{
  const w = await buildWith("1", surDocx, "f2.db");
  const t = dbText(w);
  ok(w.report && w.report.strippedSurrogates >= 1 && !t.includes("\ufffd"),
    "F2a lone surrogate 前置清洗 + 入账（不到 sqlite 绑定变 FFFD）",
    `strippedSurrogates=${w.report?.strippedSurrogates} 库内FFFD=${t.includes("\ufffd")}`);
  // F2b/c/d（绿）：账平 + 零账 + 非零账（用 F8/F3 的产物，避免重复跑）
  const w8 = await buildWith(undefined, dirtyDir, "f2-dirty.db");
  const w3 = await buildWith("1", cleanDir, "f2-clean.db");
  const r8 = w8.report, r3 = w3.report;
  ok(r8 && r8.total === r8.kept + r8.droppedEmpty + r8.droppedGarbage,
    "F2b 结构化账平：total = kept + 丢空 + 丢垃圾", `total=${r8?.total} kept=${r8?.kept} 空=${r8?.droppedEmpty} 垃圾=${r8?.droppedGarbage}`);
  ok(r3 && !structChanged(r3), "F2c 干净书账全零（structChanged=false）", JSON.stringify(r3));
  ok(r8 && structChanged(r8), "F2d 脏书账非零（structChanged=true）", JSON.stringify(r8));
}
// F3（绿）：干净 md 书全链零变化——report 全零 + 库内文本与解析产物逐字一致
{
  const w = await buildWith("1", cleanDir, "f3.db");
  const expected = bb.parseMd(cleanDir).chunks.map((c) => c.text);
  const actual = w.chunks.map((c) => c.text);
  ok(w.r && w.report && !structChanged(w.report) && actual.length === expected.length && actual.every((t, i) => t === expected[i]),
    "F3 干净 md 书全链零变化（report 全零 + 逐字对拍）",
    `\u5757\u6570 ${actual.length}/${expected.length} report=${JSON.stringify(w.report)}`);
}
// F4（红 P2-04）：BSP_STRUCT 十值矩阵——尾空格/前导空格/制表换行视同关，
// 零宽空格（trim 删不掉）与全角"０"（NFKC 归一）也须视同关（修复前全部=开）
{
  const matrix = [
    { flag: "0", off: true, name: '"0" \u7cbe\u786e\u5173' },
    { flag: "0 ", off: true, name: '"0 " \u5c3e\u7a7a\u683c\u89c6\u540c\u5173\uff08\u4fee\u590d\u524d\u5931\u7075=\u5f00\uff09' },
    { flag: " 0", off: true, name: '"\u524d\u5bfc\u7a7a\u683c 0"\u89c6\u540c\u5173' },
    { flag: "\t0\n", off: true, name: '"\u5236\u8868\u7b26+\u6362\u884c\u5305\u7684 0"\u89c6\u540c\u5173' },
    { flag: "0\u200b", off: true, name: '"\u96f6\u5bbd\u7a7a\u683c 0"\u89c6\u540c\u5173\uff08trim \u5220\u4e0d\u6389\uff0cP2-04 \u6362\u8138\uff09' },
    { flag: "\uff10", off: true, name: '\u5168\u89d2"\uff10"\u89c6\u540c\u5173\uff08NFKC \u5f52\u4e00\uff09' },
    { flag: "", off: false, name: "\u7a7a\u4e32\u9ed8\u8ba4\u5f00" },
    { flag: "1", off: false, name: '"1" \u5f00' },
    { flag: "false", off: false, name: '"false" \u5f00\uff08\u53ea\u8ba4\u7cbe\u786e "0"\uff09' },
    { flag: undefined, off: false, name: "\u672a\u8bbe\u9ed8\u8ba4\u5f00" },
  ];
  const bad = [];
  for (const [i, m] of matrix.entries()) {
    const w = await buildWith(m.flag, dirtyDir, `f4-${i}.db`);
    const ran = w.report !== null;
    if (ran === m.off) bad.push(`${m.name}\uff1a\u671f\u671b${m.off ? "\u5173" : "\u5f00"}\u5b9e\u9645${ran ? "\u5f00" : "\u5173"}`);
  }
  ok(bad.length === 0, "F4 BSP_STRUCT \u5341\u503c\u77e9\u9635\uff08\u5c3e\u7a7a\u683c/\u96f6\u5bbd/\u5168\u89d2\u4e09\u79cd\u53d8\u4f53\u4fee\u590d\u524d\u4e3a\u7ea2\uff09", bad.join("\uff1b"));
}
// F5（红 P2-05 触发点 1）：onStage("structurize") 抛错无 try → 穿出 main → 横幅卡「结构化改造中」
{
  const out = path.join(TMP, "out", "f5.db");
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(out + s, { force: true });
  const keepExit = process.exitCode;
  const seen = [];
  let err = null;
  try {
    await bb.main([cleanDir, "-o", out], { onStage: (s) => { seen.push(s); if (s === "structurize") throw new Error("boom-onstage-1"); } });
  } catch (e) { err = e; }
  finally { process.exitCode = keepExit; }
  ok(!err && fs.existsSync(out) && seen.includes("slice"),
    "F5 onStage(structurize) \u629b\u9519\u4e0d\u7a7f\u51fa main\uff08\u5305\u5e95\uff0c\u7ee7\u7eed\u5efa\u5e93\u4e14 slice \u4ecd\u6295\u9012\uff09",
    err ? `\u7a7f\u51fa\uff1a${err.message}` : (!fs.existsSync(out) ? "\u672a\u5efa\u5e93" : `slice \u672a\u6295\u9012\uff08seen=${seen.join(",")}\uff09`));
}
// F6（红 P2-05 触发点 2）：onStage("slice") 抛错无 try → 穿出 main
{
  const out = path.join(TMP, "out", "f6.db");
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(out + s, { force: true });
  const keepExit = process.exitCode;
  const seen = [];
  let err = null;
  try {
    await bb.main([cleanDir, "-o", out], { onStage: (s) => { seen.push(s); if (s === "slice") throw new Error("boom-onstage-2"); } });
  } catch (e) { err = e; }
  finally { process.exitCode = keepExit; }
  ok(!err && fs.existsSync(out) && seen.includes("structurize") && seen.includes("slice"),
    "F6 onStage(slice) \u629b\u9519\u4e0d\u7a7f\u51fa main\uff08\u5305\u5e95\uff0c\u4e24\u9636\u6bb5\u90fd\u6295\u9012\u4e14\u5efa\u5e93\u5b8c\u6210\uff09",
    err ? `\u7a7f\u51fa\uff1a${err.message}` : (!fs.existsSync(out) ? "\u672a\u5efa\u5e93" : `\u9636\u6bb5\u6295\u9012\u4e0d\u5168\uff08seen=${seen.join(",")}\uff09`));
}
// F7（绿）：BSP_STRUCT=0 逃生开关真关——脏文本原样入库（用户明确要关，就不洗不拦）
{
  const w = await buildWith("0", dirtyDir, "f7.db");
  const t = dbText(w);
  ok(w.r && t.includes("\ufffd") && t.includes("\ue000") && t.includes("\u0001"),
    "F7 BSP_STRUCT=0 \u9003\u751f\u5f00\u5173\u771f\u5173\uff08\u810f\u6587\u672c\u539f\u6837\u5165\u5e93\uff09",
    `FFFD=${t.includes("\ufffd")} PUA=${t.includes("\ue000")} \u63a7\u5236\u7b26=${t.includes("\u0001")}`);
}
// F8（绿）：默认开——替换符/私用区/控制符清掉 + 纯符号数字块丢 + 库内干净
{
  const w = await buildWith(undefined, dirtyDir, "f8.db");
  const t = dbText(w);
  const r = w.report;
  const noCtrl = [...t].every((ch) => { const c = ch.codePointAt(0); return c >= 0x20 || ch === "\n" || ch === "\t" || ch === "\r"; });
  ok(w.r && r && r.strippedFffd > 0 && r.strippedPua > 0 && r.strippedControls > 0 && r.droppedGarbage > 0
    && !t.includes("\ufffd") && !t.includes("\ue000") && noCtrl,
    "F8 \u9ed8\u8ba4\u5f00\uff1a\u66ff\u6362\u7b26/\u79c1\u7528\u533a/\u63a7\u5236\u7b26\u6e05\u6389 + \u7eaf\u7b26\u53f7\u6570\u5b57\u5757\u4e22 + \u5e93\u5185\u5e72\u51c0",
    JSON.stringify(r));
}
// F9（红 P2-01 全链）：main 全链 0.3 边界——100 字符 15 签名 md 书修复前隐形入库
{
  const w = await buildWith("1", ratioDir, "f9.db");
  ok(!w.r && !fs.existsSync(w.out) && /\u4e71\u7801/.test(w.captured),
    "F9 main \u5168\u94fe 0.3 \u8fb9\u754c\u62e6\uff08P2-01 \u5168\u94fe\u7248\uff1a\u4fee\u590d\u524d\u9690\u5f62\u5165\u5e93\uff09",
    `r=${!!w.r} \u5e93\u5b58\u5728=${fs.existsSync(w.out)} captured=${w.captured.slice(0, 60)}`);
}
// F10（跳 P2-06）：BSP_SEMANTIC 与结构化同开——要加载嵌入模型，排 slow 套件
console.log("SKIP - F10 BSP_SEMANTIC=1 \u4e0e\u7ed3\u6784\u5316\u540c\u5f00\uff08\u9700\u52a0\u8f7d\u5d4c\u5165\u6a21\u578b\uff0c\u6392 slow \u5957\u4ef6\uff0c\u672c\u8f6e\u767b\u8bb0\u4e0d\u8dd1\uff09");
skip++;

// ---------- 收尾 ----------
if (SAVED_TMP === undefined) delete process.env.TMP; else process.env.TMP = SAVED_TMP;
if (SAVED_TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = SAVED_TEMP;
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n===== entry-adversarial-fuzz: ${pass} PASS / ${fail} FAIL / ${obs} OBSERVE / ${skip} SKIP =====`);
process.exit(fail ? 1 : 0);
