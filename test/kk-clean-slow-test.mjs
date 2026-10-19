// kk 脏书轻量验收（零成本零网络）——挂 test:slow。
// ① 材料存在性：kk-dirty-full.pdf（真跑验收料）/ kk-clean-louzhu.pdf（净版标准答案 552 块）
// ② 假 chatFn 回放水贴特征全链路：真 build-book 建库（解析→切片→结构化，不 embed）
//    → 预读块文本按水贴特征预判（与护栏同规则，保证回放 drop 全部能过 G1-G3）
//    → runClean 产产物 → importClean 四道闸落库 → quarantine/chunks/FTS 三对账 + 账目同步 → 恢复 dryRun + 真恢复回涨
// 真钱真网络的 LLM 验收走手动命令（docs/V3规划.md 第九节 S8）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

// ---------- ① 材料存在性 ----------
const dirty = path.join(ROOT, "books", "_work", "dirty-books", "kk-dirty-full.pdf");
const cleanVer = path.join(ROOT, "books", "_work", "dirty-books", "kk-clean-louzhu.pdf");
assert(fs.existsSync(dirty), "材料: kk-dirty-full.pdf 在位（真跑验收料）");
assert(fs.existsSync(cleanVer), "材料: kk-clean-louzhu.pdf 在位（净版标准答案）");

// ---------- ② 假 chatFn 全链路落库 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-kk-"));
  const dbPath = path.join(tmp, "kk-dirty.db");

  // 真 build-book：脏 PDF 过解析→结构化→切片（不 embed——clean 不需要向量）
  const buildBook = require("../src/build-book.js");
  const keepExit = process.exitCode;
  const captured = [];
  const origErr = console.error;
  console.error = (...a) => captured.push(a.map(String).join(" "));
  let built;
  try { built = await buildBook.main([dirty, "-o", dbPath], {}); }
  finally { console.error = origErr; process.exitCode = keepExit; }
  assert(!!built && fs.existsSync(dbPath), `kk 建库成功（${built ? `${built.chunks} 块` : `失败: ${captured.join(" / ").slice(0, 120)}`}）——脏 PDF 过真解析管线`);

  // 预读块文本，按水贴特征预判（与护栏同规则筛：短实义块/引文特征块会被 G1/G2 拦回，预判即排除）
  const { buildCleanTasks, isSubstantiveShort, hasQuotedOrCodeFeature } = await import("../src/lib/clean.mjs");
  const ro = new Database(dbPath, { readonly: true });
  const tasks = buildCleanTasks(ro);
  ro.close();
  const chunks = tasks.chunks;
  // kk 帖水贴特征：楼层时间戳开头 / 楼号行 / 纯短水贴（顶/沙发/mark/哈哈类，且无句读）
  const isShui = (t) =>
    /^\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}/.test(t.trim()) ||
    /^\d{1,5}楼\b/.test(t.trim()) ||
    (/^(顶|沙发|前排|路过|mark|MARK|帮顶|顶起|学习了|围观|留名|打卡)/.test(t.trim()) && t.length < 30);
  const shuiIdx = chunks.filter(c => isShui(c.text) && !isSubstantiveShort(c.text) && !hasQuotedOrCodeFeature(c.text)).map(c => c.idx);
  assert(shuiIdx.length > 0, `水贴特征预判命中 ${shuiIdx.length} 块（kk 脏书特征有效）`);

  // 判定脚本：预判块 → drop(timestamp)；其余 keep（mkChat 同款按 [idx N] 解析回放）
  const script = new Map(shuiIdx.map(idx => [idx, { idx, verdict: "drop", cat: "timestamp", reason: "楼层时间戳/水贴特征，与房产正文无关" }]));
  const fakeChat = async ({ messages }) => {
    const sys = messages[0]?.content || "";
    if (sys.includes("图书编辑")) {
      return { ok: true, text: '{"summary":"天涯房产帖","typical":"楼主正文与分析","pollution":["读者水贴","楼层时间戳"]}', usage: { prompt_tokens: 100, completion_tokens: 50 } };
    }
    const userMsg = messages[1]?.content || "";
    const judged = [...userMsg.matchAll(/\[idx (\d+)\]/g)].map(m => +m[1]);
    const out = judged.map(idx => script.get(idx) || { idx, verdict: "keep" });
    return { ok: true, text: JSON.stringify(out), usage: { prompt_tokens: 800, completion_tokens: 100 } };
  };

  // runClean → importClean（四道闸真事务）
  const { runClean } = await import("../src/lib/clean.mjs");
  const { importClean, restoreClean } = await import("../src/lib/clean-import.mjs");
  const resDir = fs.mkdtempSync(path.join(tmp, "res-"));
  const r = await runClean(dbPath, { chatFn: fakeChat, config: { baseUrl: "https://fake.example/v1", apiKey: "sk-test", model: "fake" }, resultsDir: resDir });
  assert(r.ok, `runClean 成功（判删 ${r.stats?.dropped} 块，护栏拦回 ${r.stats ? r.stats.guardedG1 + r.stats.guardedG2 + r.stats.guardedG3 : "-"}）`);
  assert(r.stats?.dropped === shuiIdx.length, `判删数=预判数（${r.stats?.dropped} === ${shuiIdx.length}）——回放零漂移`);

  const beforeDb = new Database(dbPath, { readonly: true });
  const before = beforeDb.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  beforeDb.close();
  const ir = importClean(dbPath, r.artifactPath, {});
  assert(ir.ok && ir.ok !== undefined, `importClean 落库成功（${ir.message?.slice(0, 60)}）`);
  const db = new Database(dbPath, { readonly: true });
  const after = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const qCount = db.prepare("SELECT COUNT(*) n FROM quarantine").get().n;
  const ftsCount = db.prepare("SELECT COUNT(*) n FROM chunks_fts").get().n;
  const report = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='clean_report'").get()?.value || "{}");
  db.close();
  assert(before - after === shuiIdx.length, `chunks ${before} → ${after}（删 ${before - after} === 预判 ${shuiIdx.length}）`);
  assert(qCount === shuiIdx.length, `隔离账 ${qCount} 行（原文+理由全留）`);
  assert(ftsCount === after, `FTS rebuild 对账（${ftsCount} === chunks ${after}——无幽灵索引）`);
  assert(report.dropped === shuiIdx.length && report.total === before, `clean_report 落账对账（dropped=${report.dropped} total=${report.total}）`);

  // 账目同步（syncBookMeta）：清洗后 meta 四本账必须等于留存实况——
  // 不清则 newbook-check「账实相符」红、list_books 虚高（kk 正式收录实测踩到）
  {
    const dbm = new Database(dbPath, { readonly: true });
    const meta = Object.fromEntries(dbm.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
    const sumChars = dbm.prepare("SELECT text FROM chunks").all().reduce((a, r) => a + r.text.length, 0);
    dbm.close();
    assert(String(after) === meta.chunk_count, `meta.chunk_count 同步（${meta.chunk_count} === 实际 ${after}）`);
    assert(String(sumChars) === meta.total_chars, `meta.total_chars 同步（${meta.total_chars} === 实际 ${sumChars}）`);
    assert(meta.total_tokens && meta.chapter_quality, `V3R7 数据层账同步（total_tokens=${meta.total_tokens} quality=${meta.chapter_quality}）`);
  }

  // 恢复链路：dryRun 列出全部隔离块，再真恢复一轮验证账目回涨（tmp 库，随便造）
  const rr = restoreClean(dbPath, { dryRun: true });
  assert(rr.ok && rr.candidates?.length === shuiIdx.length, `恢复 dryRun 列出 ${rr.candidates?.length} 候选（=隔离账）`);
  const r2 = restoreClean(dbPath, { all: true });
  assert(r2.ok && r2.restored === shuiIdx.length, `真恢复 ${r2.restored} 块回主库`);
  const db2 = new Database(dbPath, { readonly: true });
  const back = db2.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const backChars = db2.prepare("SELECT text FROM chunks").all().reduce((a, r) => a + r.text.length, 0);
  const meta2 = Object.fromEntries(db2.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
  db2.close();
  assert(back === before, `恢复后 chunks 回涨（${back} === ${before}）`);
  assert(String(back) === meta2.chunk_count && String(backChars) === meta2.total_chars, `恢复后账目回涨（chunk_count=${meta2.chunk_count} total_chars=${meta2.total_chars}）`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n===== kk 轻量验收结果 =====`);
if (failed) { console.error(`${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：材料在位 + 真建库 + 假 chatFn 全链路落库对账 + 账目同步 + 恢复 dryRun/真恢复");
