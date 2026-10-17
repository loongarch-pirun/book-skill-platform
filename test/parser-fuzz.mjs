// P1 文件解析 fuzz（终期暴力测试）：畸形文件弹药库炸 build-book 解析链路。
// 铁律：坏输入必须有确定性行为——A=人话干净拒绝 / B=干净成功且字符账平；
// 挂起（30s 超时）或非人话裸栈崩溃 = FAIL。宽松放行/垃圾入库只记录（OBSERVE）。
// 弹药全部运行时腐蚀生成（腐蚀产物存盘无意义），临时目录落地，不碰 library。
// 驱动方式同 jobs.mjs：build-book.main 是 CLI 出身（失败只打 console.error +
// 置 exitCode 不抛错）→ 截获输出人话化 + 还原 exitCode；txt2docx 无导出 → spawn。
// 挂载：test:fast（无模型纯解析；实测总耗时应 <60s，超了挪 test:slow）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const buildBook = require("../src/build-book.js");
const Database = require("better-sqlite3");
const AdmZip = require("adm-zip");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-fuzz-"));
const WORK = path.join(TMP, "ammo");
fs.mkdirSync(WORK, { recursive: true });
const DB = (n) => path.join(TMP, n + ".db");

let pass = 0, fail = 0, observe = 0;
const failures = [];
const notes = [];
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (cond) pass++; else { fail++; failures.push(msg); } };
const obs = (msg) => { console.log("OBSERVE - " + msg); observe++; notes.push(msg); };

// ---------- 驱动：build-book.main（截获 console.error + 还原 exitCode + 30s 护甲） ----------
async function runBuild(file, extra = [], timeoutMs = 30000) {
  const dbPath = DB(path.basename(file).replace(/\W/g, "_"));
  const keepExit = process.exitCode;
  const captured = [];
  const origErr = console.error;
  console.error = (...a) => captured.push(a.map(String).join(" "));
  let timer;
  try {
    const p = Promise.resolve(buildBook.main([file, "-o", dbPath, ...extra]));
    const r = await Promise.race([
      p,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("__TIMEOUT__")), timeoutMs); }),
    ]);
    return { kind: r && r.chunkCount > 0 ? "SUCCESS" : (r && r.skipped ? "SKIPPED" : "REJECTED"), r, stderr: captured.join(" / "), dbPath };
  } catch (e) {
    return { kind: e.message === "__TIMEOUT__" ? "TIMEOUT" : "CRASH", err: e, stderr: captured.join(" / ") };
  } finally {
    clearTimeout(timer); console.error = origErr; process.exitCode = keepExit;
    // 注：TIMEOUT 只放弃等待，底层计算仍在后台跑，其 console.error 可能污染下一轮
    // 截获——故 TIMEOUT 轮不依赖 stderr 判定（已记 FAIL），可接受。
  }
}

// ---------- 驱动：txt2docx（CLI spawn，可 kill） ----------
function runTxt2Docx(inFile, outFile, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "src/txt2docx.js"), inFile, outFile], { env: process.env });
    let out = "", err = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.on("close", code => { clearTimeout(timer); resolve({ code, out, err, killed }); });
    child.on("error", e => { clearTimeout(timer); resolve({ code: -1, out, err: String(e), killed }); });
  });
}

// ---------- 账平（与 build-book 同一把尺子：JS .length 数 UTF-16 码元） ----------
function charAccount(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT text FROM chunks").all();
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  db.close();
  const jsLen = rows.reduce((a, r) => a + r.text.length, 0);
  return { n: rows.length, jsLen, metaCount: +meta.chunk_count, metaTotal: +meta.total_chars };
}

// 判定：期望 A（拒绝）或 B（成功）；返回是否满足 + 详情
function expect(res, want, label) {
  if (res.kind === "TIMEOUT") { ok(false, `${label}：30s 超时挂起（铁律违反）`); return null; }
  if (res.kind === "CRASH") { ok(false, `${label}：裸栈崩溃而非人话拒绝 —— ${res.err?.message?.slice(0, 120)}`); return null; }
  if (want === "A") {
    const good = res.kind === "REJECTED" && res.stderr.trim().length > 0;
    ok(good, `${label}：干净拒绝且有人话（${res.stderr.slice(0, 90) || "无输出"}）`);
    return res.kind === "REJECTED" ? "REJECTED" : null;
  }
  // want === "B"
  if (res.kind !== "SUCCESS") { ok(false, `${label}：期望干净成功，实际 ${res.kind}（${res.stderr.slice(0, 90)}）`); return null; }
  const acc = charAccount(res.dbPath);
  const bal = acc.n > 0 && acc.n === acc.metaCount && acc.jsLen === acc.metaTotal;
  ok(bal, `${label}：成功且字符账平（块 ${acc.n}=${acc.metaCount}，字符 ${acc.jsLen}=${acc.metaTotal}）`);
  return bal ? acc : null;
}

// ---------- 弹药生成 ----------
const DOCX_BASE = fs.readFileSync(path.join(ROOT, "books/lunyu-xueer-zh.docx"));
const EPUB_BASE = fs.readFileSync(path.join(ROOT, "books/frankenstein-en.epub"));
const PDF_BASE = fs.readFileSync(path.join(ROOT, "books/lunyu-xueer-zh.pdf"));
const w = (name, buf) => { const p = path.join(WORK, name); fs.writeFileSync(p, buf); return p; };

const mkZipAmmo = () => {
  // 缺 word/document.xml 的合法 zip
  const z = new AdmZip();
  z.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`));
  z.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`));
  w("nodoc.docx", z.toBuffer());
  // document.xml 0 字节 / 二进制垃圾
  const z2 = new AdmZip(DOCX_BASE);
  // 直接改 zip 内容重打
  const z3 = new AdmZip();
  z3.addFile("[Content_Types].xml", z2.readFile("[Content_Types].xml"));
  z3.addFile("_rels/.rels", z2.readFile("_rels/.rels"));
  w("emptydoc.docx", z3.toBuffer());
  const z4 = new AdmZip();
  z4.addFile("[Content_Types].xml", z2.readFile("[Content_Types].xml"));
  z4.addFile("_rels/.rels", z2.readFile("_rels/.rels"));
  z4.addFile("word/document.xml", Buffer.from([0x00, 0xff, 0xfe, 0x81, 0x8f, 0x00, 0xde, 0xad, 0xbe, 0xef]));
  w("garbagedoc.docx", z4.toBuffer());
  // mimetype 错但结构完整的 epub（parseEpub 不查 mimetype → 预期宽松放行，记录）
  const epub = new AdmZip(EPUB_BASE);
  const entries = epub.getEntries();
  const z5 = new AdmZip();
  for (const e of entries) {
    if (e.entryName === "mimetype") z5.addFile("mimetype", Buffer.from("application/octet-stream"));
    else z5.addFile(e.entryName, epub.readFile(e));
  }
  w("badmime.epub", z5.toBuffer());
  // spine 炸弹：2000 个 item 全指向同一个 xhtml → 重复解析无缓存
  const real = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>炸</title></head><body><p>炸弹章节正文，重复解析两千次看会不会挂。</p></body></html>`;
  const z6 = new AdmZip();
  z6.addFile("mimetype", Buffer.from("application/epub+zip"));
  z6.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`));
  z6.addFile("real.html", Buffer.from(real));
  let items = "", refs = "";
  for (let i = 0; i < 2000; i++) { items += `<item id="i${i}" href="real.html" media-type="application/xhtml+xml"/>`; refs += `<itemref idref="i${i}"/>`; }
  z6.addFile("content.opf", Buffer.from(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><manifest>${items}</manifest><spine>${refs}</spine></package>`));
  w("spinebomb.epub", z6.toBuffer());
};

const mkTxtAmmo = () => {
  w("empty.txt", "");
  w("ws.txt", "   \n\t\n \n");
  w("sym.txt", "----\n【】〖〗\n🎉🎊\n※§¶\n");
  w("digits.txt", "第一章\n1234567890\n0987654321\n2024\n");
  // P2 结构化改造（V3 第四波）之后，小于 100 字符的夹具会被「内容太少」闸门拦下，
  // 下列小夹具统一加长过闸门——考察点（默认章/行尾/BOM/代理对/注入/超长标题）不变
  w("nohead.txt", "这是没有标题行的正文第一段，介绍基本概念与术语，长度要足够。\n第二段继续展开，把内容写得更长一些，确保全文稳过结构化改造的内容下限闸门，不被误判成不全数据。\n第三段结束，全篇归入默认的前言章节之下，考察无标题文件的默认章行为。\n第四段补充，确保总字数越过一百字符的硬线，让测试聚焦在章节归属上。\n");
  w("allhead.txt", "# 标题一\n# 标题二\n# 标题三\n# 标题四\n");
  w("nopunct.txt", "甲".repeat(100000)); // 10 万字无任何标点 → 专炸 sentenceSplit
  const s = "子曰学而时习之";
  w("utf16.txt", Buffer.from("\uFEFF" + s + "\n不亦说乎", "utf16le"));
  w("utf8bom.txt", Buffer.from("\uFEFF子曰学而时习之\n不亦说乎？有朋自远方来，不亦乐乎？人不知而不愠，不亦君子乎？\n温故而知新，可以为师矣。学而不思则罔，思而不学则殆。知之为知之，不知为不知，是知也。\n君子坦荡荡，小人长戚戚。吾日三省吾身，为人谋而不忠乎？\n三人行，必有我师焉。择其善者而从之，其不善者而改之。\n", "utf8")); // Windows 记事本产物
  w("crlf.txt", "第一段内容讲基本概念与术语，长度足够。\r\n第二段内容继续展开说明，把行尾混杂的场景写实。\n第三段内容再补充几句，确保总长度越过硬线。\r\n第四段内容收尾，确认行尾风格不影响解析结果。\n第五段内容再次确认，无论 CRLF 还是 LF 都应当一视同仁。\n");
  w("surrogate.txt", "# 罕字\n\u{2AAA6}\u{2AAA6}\u{2AAA6} 生僻字混排 \u{2AAA6}\n后面跟上正常的正文段落，让全文既包含代理对密集的罕字，也有足够多的常用字，从而稳过结构化改造的内容下限，专门考察代理对不会把管线炸掉，更不会让账目不平。再补一句，确保总长度越过硬线。\n");
  w("sqli.txt", "# '); DROP TABLE chunks;--\n正文段：'); DELETE FROM chunks WHERE 1=1;--\n后面再补一段正常正文，让全文长度稳过结构化改造的内容下限，专门考察注入串当章节名时参数化绑定无注入痕迹，表结构与数据都完好无损。\n");
  w("longhead.txt", "# " + "长".repeat(10000) + "\n正文段：这一篇的标题长达一万字，专门考察超长章节名不会把切片、编目或数据库字段撑爆，正文照常入库，字符账平，一切如常。\n第二段继续补充长度，确保全文稳过结构化改造的内容下限，让考察点集中在超长标题的容忍度上，而不是被内容太少的闸门抢走主题。\n");
  w("nullbyte.txt", "# 空字节\n正文里混\u0000入空\u0000字节会怎样。\n");
  // 5MB txt（4000 段 × 1250 字）
  const para = "厚".repeat(1200) + "。";
  const big = Array.from({ length: 4000 }, (_, i) => `# 第${i + 1}节\n${para}`).join("\n");
  w("big.txt", big);
};

// ---------- 1) zip 系弹药（docx/epub） ----------
console.log("===== 1) zip 系：docx/epub 腐蚀弹药 =====");
mkZipAmmo();
expect(await runBuild(w("trunc10.docx", DOCX_BASE.subarray(0, Math.floor(DOCX_BASE.length * 0.9)))), "A", "docx 截断 10%");
expect(await runBuild(w("trunc50.docx", DOCX_BASE.subarray(0, Math.floor(DOCX_BASE.length * 0.5)))), "A", "docx 截断 50%");
expect(await runBuild(w("empty.docx", Buffer.alloc(0))), "A", "docx 空文件");
expect(await runBuild(w("textas.docx", Buffer.from("我不是 docx，只是纯文本。"))), "A", "纯文本伪装 .docx");
expect(await runBuild(w("nodoc.docx", fs.readFileSync(path.join(WORK, "nodoc.docx")))), "A", "docx 缺 word/document.xml");
expect(await runBuild(w("emptydoc.docx", fs.readFileSync(path.join(WORK, "emptydoc.docx")))), "A", "docx document.xml 0 字节");
expect(await runBuild(w("garbagedoc.docx", fs.readFileSync(path.join(WORK, "garbagedoc.docx")))), "A", "docx document.xml 二进制垃圾");
{ // badmime：宽松放行是预期（parseEpub 不查 mimetype）——记录不判
  const r = await runBuild(w("badmime.epub", fs.readFileSync(path.join(WORK, "badmime.epub"))));
  obs(`epub mimetype 错但结构完整 → ${r.kind}${r.kind === "SUCCESS" ? "（宽松放行：parseEpub 不校验 mimetype，无害但记录）" : ""}`);
}
{ // spine 炸弹：只许限时内结束，拒绝或成功都行
  const t0 = Date.now();
  const r = await runBuild(w("spinebomb.epub", fs.readFileSync(path.join(WORK, "spinebomb.epub"))), [], 60000);
  const ms = Date.now() - t0;
  if (r.kind === "TIMEOUT") ok(false, "epub spine 炸弹（2000 重复 itemref）：60s 挂起");
  else obs(`epub spine 炸弹（2000 重复 itemref）：${r.kind}，耗时 ${ms}ms${r.kind === "SUCCESS" ? `（${r.r.chunkCount} 块/章，无缓存重复解析）` : ""}`);
}

// ---------- 2) txt 系弹药（txt2docx → docx → build-book 全链） ----------
console.log("===== 2) txt 系：畸形文本经 txt2docx 全链 =====");
mkTxtAmmo();
const TXT_CASES = [
  ["empty.txt", "A", "txt 空文件"],
  ["ws.txt", "A", "txt 纯空白"],
  ["digits.txt", "A", "txt 纯数字无文字（P2 新契约：纯符号块无检索价值 → 结构化改造拦）"],
  ["nohead.txt", "B", "txt 无章节行（默认「前言」章）"],
  ["allhead.txt", "A", "txt 每行都是 # 标题（无正文 → 0 块）"],
  ["nopunct.txt", "B", "txt 单段 10 万字无标点"],
  ["crlf.txt", "B", "txt CRLF/LF 混杂"],
  ["utf8bom.txt", "B", "txt UTF-8 BOM（记事本常见，应剥掉不是拒）"],
  ["surrogate.txt", "B", "txt 代理对密集（罕字 U+2AAA6）"],
  ["sqli.txt", "B", "txt SQL 注入串当章节名（参数化应无注入）"],
  ["longhead.txt", "B", "txt 1 万字章节标题"],
];
for (const [name, want, label] of TXT_CASES) {
  const docx = path.join(WORK, name.replace(/\.txt$/, ".docx"));
  const c = await runTxt2Docx(path.join(WORK, name), docx);
  if (c.killed) { ok(false, `${label}：txt2docx 30s 挂起`); continue; }
  if (c.code !== 0) {
    if (want === "A") ok(true, `${label}：txt2docx 干净拒绝（${c.err.trim().slice(0, 80)}）`);
    else ok(false, `${label}：txt2docx 意外失败（${c.err.trim().slice(0, 80)}）`);
    continue;
  }
  const res = await runBuild(docx);
  const acc = expect(res, want, label);
  if (acc && name === "utf16.txt") { // UTF-16 读成 utf8 的 \0 垃圾含量记录
    const db = new Database(res.dbPath, { readonly: true });
    const nul = db.prepare("SELECT COUNT(*) c FROM chunks WHERE INSTR(text, char(0)) > 0").get().c;
    db.close();
    obs(`utf16 弹药实际行为：${acc.n} 块入库，其中含 NUL 字符的块 ${nul} 个（utf8 误读 UTF-16 的确定性垃圾，非崩溃）`);
  }
  if (acc && name === "utf8bom.txt") { // UTF-8 BOM 应被剥掉：首块不以 \uFEFF 开头
    const db = new Database(res.dbPath, { readonly: true });
    const first = db.prepare("SELECT text FROM chunks ORDER BY id LIMIT 1").get().text;
    db.close();
    ok(!first.startsWith("\uFEFF"), `utf8bom：BOM 已剥（首块头字符 = ${JSON.stringify(first[0])}）`);
  }
  if (acc && name === "nopunct.txt") {
    const db = new Database(res.dbPath, { readonly: true });
    const mx = db.prepare("SELECT MAX(LENGTH(text)) m FROM chunks").get().m;
    const n = db.prepare("SELECT COUNT(*) c FROM chunks").get().c;
    db.close();
    // V3R-D08 常驻断言：无标点 10 万字不再整段直通——硬切兜底后最大块 ≤ 900（旧行为原样返 1 块 10 万字）
    ok(mx <= 900, `nopunct 10 万字无标点：最大块 ${mx} 字 ≤ 900（D08 硬切兜底生效，共 ${n} 块）`);
  }
  if (acc && name === "sqli.txt") {
    const db = new Database(res.dbPath, { readonly: true });
    const n = db.prepare("SELECT COUNT(*) c FROM chunks").get().c;
    const alive = db.prepare("SELECT COUNT(*) c FROM chunks_fts").get().c;
    db.close();
    obs(`sqli 章节名原样入库（${n} 块 / fts ${alive} 条，参数化绑定无注入痕迹）`);
  }
  if (acc && name === "big.txt") obs(`big 5MB：${acc.n} 块入库，字符账平`);
}
// UTF-16：txt2docx 转换期就该人话拒绝（P1 逮到的静默损毁，已修）
{
  const c = await runTxt2Docx(path.join(WORK, "utf16.txt"), path.join(WORK, "utf16.docx"));
  ok(!c.killed && c.code !== 0 && /UTF-16/.test(c.err), `txt UTF-16LE BOM：txt2docx 人话拒绝（${c.err.trim().slice(0, 80)}）`);
}
// 纯符号与 null 字节：行为不定（拒或收都合理），只抓崩溃/挂起/账不平
for (const [name, label] of [["sym.txt", "txt 纯符号"], ["nullbyte.txt", "txt null 字节混入"]]) {
  const docx = path.join(WORK, name.replace(/\.txt$/, ".docx"));
  const c = await runTxt2Docx(path.join(WORK, name), docx);
  if (c.killed) { ok(false, `${label}：txt2docx 30s 挂起`); continue; }
  if (c.code !== 0) { obs(`${label}：txt2docx 拒绝（${c.err.trim().slice(0, 80)}）`); continue; }
  const res = await runBuild(docx);
  if (res.kind === "TIMEOUT" || res.kind === "CRASH") { ok(false, `${label}：${res.kind}`); continue; }
  obs(`${label}：${res.kind}${res.kind === "SUCCESS" ? `（${res.r.chunkCount} 块——垃圾内容入库由 newbook-check 的纯符号块检查兜底）` : `（${res.stderr.slice(0, 70)}）`}`);
}

// ---------- 3) PDF 弹药 ----------
console.log("===== 3) pdf 弹药 =====");
expect(await runBuild(w("garbage.pdf", Buffer.from("%PDF-1.4\n" + "垃圾".repeat(500)))), "A", "pdf 伪头+垃圾");
expect(await runBuild(w("truncpdf.pdf", PDF_BASE.subarray(0, Math.floor(PDF_BASE.length * 0.5)))), "A", "pdf 截断 50%");

// ---------- 4) 既有防线回归 ----------
console.log("===== 4) 既有防线回归 =====");
{ // # 标题约定两侧证明：老格式 txt（无 # 行）→ 单「前言」章（零变化承诺）；
  // 带 # 行的新格式（孟子）→ 261 章全识别
  const docx = path.join(WORK, "lunyu.docx");
  await runTxt2Docx(path.join(ROOT, "books/lunyu-xueer-zh.txt"), docx);
  const res = await runBuild(docx, ["--force"]);
  const acc = expect(res, "B", "老格式 txt（无 # 行）→ 全进「前言」章（行为零变化）");
  if (acc) {
    const db = new Database(res.dbPath, { readonly: true });
    const chs = db.prepare("SELECT DISTINCT chapter FROM chunks").all().map(r => r.chapter);
    db.close();
    ok(chs.length === 1 && chs[0] === "前言", `老格式断言：16 块归「前言」单章（实际 ${JSON.stringify(chs)}）`);
  }
  const mzDocx = path.join(WORK, "mz.docx");
  await runTxt2Docx(path.join(ROOT, "books/mengzi-zh-raw.txt"), mzDocx);
  const res2 = await runBuild(mzDocx, ["--force"]);
  const acc2 = expect(res2, "B", "新格式 txt（# 标题行）→ Heading1 → 多章识别");
  if (acc2) {
    const db = new Database(res2.dbPath, { readonly: true });
    const chs = db.prepare("SELECT COUNT(DISTINCT chapter) c FROM chunks").get().c;
    db.close();
    ok(chs === 261, `孟子 # 标题约定 → 261 章全识别（实际 ${chs}）`);
  }
}
{ // 重灌保护：首次成功 / 同源同内容 skipped / 同源变内容拒绝 / 不同源拒绝
  const docx = path.join(WORK, "guard.docx");
  await runTxt2Docx(path.join(ROOT, "books/lunyu-xueer-zh.txt"), docx);
  const out = DB("guard");
  const keepExit = process.exitCode;
  const cap = []; const oe = console.error, ol = console.log;
  console.error = (...a) => cap.push(a.map(String).join(" "));
  console.log = (...a) => cap.push(a.map(String).join(" "));
  const r1 = await buildBook.main([docx, "-o", out]);
  const r2 = await buildBook.main([docx, "-o", out]); // 同源同内容
  const capSkip = cap.join(" / "); cap.length = 0;
  // 副本场景（P2 修复的行为）：jobs 导入会把原件复制进 books/ 再建库，源路径永远是
  // 副本路径——与库里同内容不同路径的文件必须判 skipped 而不是「另一本书」
  const copy5 = path.join(WORK, "guard-copy.docx");
  fs.copyFileSync(docx, copy5);
  // 同源变内容：同路径重打 zip（document.xml 加一段正文）——source_file 不变、hash 变
  const z = new AdmZip(docx);
  const xml = z.readAsText("word/document.xml");
  z.deleteEntry("word/document.xml");
  z.addFile("word/document.xml", Buffer.from(xml.replace("</w:body>", "<w:p><w:r><w:t>多加一句尾巴。</w:t></w:r></w:p></w:body>")));
  fs.writeFileSync(docx, z.toBuffer());
  const r3 = await buildBook.main([docx, "-o", out]);
  const capChanged = cap.join(" / "); cap.length = 0;
  // 不同源：另一个文件导到同一输出
  const mod = path.join(WORK, "other.docx");
  await runTxt2Docx(path.join(WORK, "nohead.txt"), mod);
  const r4 = await buildBook.main([mod, "-o", out]);
  const capOther = cap.join(" / ");
  const r5 = await buildBook.main([copy5, "-o", out]); // 副本：不同路径同内容
  const capCopy = cap.join(" / ");
  console.error = oe; console.log = ol; process.exitCode = keepExit;
  ok(r1 && r1.chunkCount > 0, "保护①：首次导入成功");
  ok(r2 && r2.skipped === true, "保护②：同源同内容 → skipped（不重建）");
  ok(/跳过/.test(capSkip), `保护②人话：跳过提示可读（${capSkip.slice(0, 60)}）`);
  ok(r3 === undefined && /内容已变/.test(capChanged), `保护③：同源变内容 → 拒绝（${capChanged.slice(0, 70)}）`);
  ok(r4 === undefined && /另一本书|拒绝/.test(capOther), `保护④：不同源 → 拒绝（${capOther.slice(0, 70)}）`);
  ok(r5 && r5.skipped === true && /跳过/.test(capCopy), `保护⑤：不同路径同内容（jobs 副本场景）→ skipped（${capCopy.slice(0, 60)}）`);
}

// ---------- 汇总 ----------
console.log(`\n===== P1 fuzz 汇总：${pass} PASS / ${fail} FAIL / ${observe} OBSERVE =====`);
if (failures.length) { console.log("失败项："); failures.forEach(f => console.log("  ✗ " + f)); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 沙箱 rm 被拦则留 temp */ }
process.exit(fail ? 1 : 0);
