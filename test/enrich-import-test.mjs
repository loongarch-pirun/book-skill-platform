// 洗数据产物入库验收（V3 第二波 #137）
// 跑法: node test/enrich-import-test.mjs   （自包含：合成夹具 + 学而库真机切片，不依赖 library/ 真库）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { ensureEnrichSchema, importEnrich, auditEnrich, defaultArtifactPath } from "../src/lib/enrich-import.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-enrich-import-"));
const SLICE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "enrich-xueer-slice.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};

// 最小夹具库：chunks + meta（导入不需要 emb/fts，fresh 库也要能入）
function makeDb(name, chunks, hash = "abc123") {
  const p = path.join(TMP, name);
  if (fs.existsSync(p)) fs.rmSync(p);
  const db = new Database(p);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
           CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);`);
  const ins = db.prepare("INSERT INTO chunks(chapter,page,text) VALUES(?,?,?)");
  const tx = db.transaction(() => { for (const c of chunks) ins.run(c.chapter, c.page ?? null, c.text); });
  tx();
  db.prepare("INSERT INTO meta(key,value) VALUES('title',?)").run(name.replace(/\.db$/, ""));
  db.prepare("INSERT INTO meta(key,value) VALUES('content_hash',?)").run(hash);
  db.close();
  return p;
}
const writeJson = (name, obj) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 1), "utf8");
  return p;
};
const rows = (dbPath, sql, ...args) => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};
const one = (dbPath, sql, ...args) => rows(dbPath, sql, ...args)[0];

// 合成语料：两章 6 块（全部 ≥40 字合格）
const CH = [
  { chapter: "第1章", text: "熔断器是一种保护电器，当电流超过额定值时自动切断电路，防止设备烧毁。断路器则兼有开关作用。" },
  { chapter: "第1章", text: "低压电器的符号在图纸上用特定图形表示，交流接触器的主触点绘制成常开触点形式，便于工程识图。" },
  { chapter: "第1章", text: "热继电器利用电流的热效应动作，双金属片受热弯曲推动触点，用于电动机的过载保护场合。" },
  { chapter: "第2章", text: "异步电动机的转子分为笼型与绕线型两类，笼型结构简单可靠，绕线型可在起动时串入电阻改善性能。" },
  { chapter: "第2章", text: "电动机的额定电压指线电压，接线时应核对铭牌标注，星形与三角形接法不可随意混用以免烧毁。" },
  { chapter: "第2章", text: "变频器通过改变电源频率调节电动机转速，调速范围宽且节能，已在风机水泵类负载中广泛替代阀门节流。" },
];
const SYN_ENTRIES = [
  { idx: 1, prefix: "介绍熔断器与断路器的保护原理。", tags: ["熔断器", "断路器", "保护电器"], questions: ["熔断器的作用是什么"], summary: "熔断器过流切断电路，断路器兼有开关作用。" },
  { idx: 2, prefix: "低压电器符号的图纸表示法。", tags: ["低压电器", "交流接触器"], questions: ["交流接触器主触点怎么画", "图纸符号表示什么"], summary: "低压电器符号用特定图形表示，交流接触器主触点绘成常开形式。" },
  { idx: 3, prefix: "热继电器的过载保护原理。", tags: ["热继电器", "双金属片", "过载保护"], questions: ["热继电器如何保护电动机"], summary: "热继电器靠双金属片受热弯曲推动触点，用于过载保护。" },
  { idx: 4, prefix: "异步电动机转子的两种结构。", tags: ["异步电动机", "笼型", "绕线型"], questions: ["笼型和绕线型转子区别"], summary: "转子分笼型与绕线型，笼型简单可靠，绕线型可串电阻起动。" },
  { idx: 5, prefix: "电动机额定电压与接线。", tags: ["额定电压", "星形", "三角形"], questions: ["星形三角形接法能混用吗"], summary: "额定电压指线电压，星形与三角形接法不可混用。" },
  { idx: 6, prefix: "变频器调速与节能应用。", tags: ["变频器", "电动机转速"], questions: ["变频器为什么节能"], summary: "变频器改变电源频率调节转速，风机水泵负载广泛替代阀门节流。" },
];
const synArtifact = (over = {}) => ({
  version: 1,
  book: { db: "syn.db", title: "syn", content_hash: "abc123", chunk_count: 6 },
  stats: {},
  entries: SYN_ENTRIES,
  failed_batches: [],
  updated_at: "2026-10-16T00:00:00.000Z",
  chapter_summaries: { "第1章": "三章合述低压电器：保护元件、图纸符号与热保护原理。", "第2章": "三章合述电动机：结构、接线与变频调速。", "第9章": "孤儿章名（书库里没有）" },
  book_summary: "全书介绍低压电器与电动机的基础知识，涵盖保护、符号、结构与调速。",
  ...over,
});

// ========== 1) ensureEnrichSchema：幂等 + 列/表/索引就位 ==========
{
  const dbPath = makeDb("schema.db", CH);
  const db = new Database(dbPath);
  ensureEnrichSchema(db);
  ensureEnrichSchema(db);   // 第二遍不炸（ALTER 先例的幂等性）
  const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
  ok(cols.includes("ctx") && cols.includes("tags") && cols.includes("questions"),
    "schema: chunks 加 ctx/tags/questions 三列", cols.join(","));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  ok(tables.includes("summaries") && tables.includes("chunk_tags"), "schema: summaries/chunk_tags 两表就位");
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chunk_tags'").all().map(r => r.name);
  ok(idx.some(n => n.includes("chunk")), "schema: chunk_tags 带 chunk_id 索引（倒排反查）");
  db.close();
}

// ========== 2) 合成产物入库全链：三列/倒排/三级摘要/meta ==========
{
  const dbPath = makeDb("syn.db", CH);
  const before = rows(dbPath, "SELECT id, text FROM chunks ORDER BY id");
  const r = importEnrich(dbPath, writeJson("syn-art.json", synArtifact()));
  ok(r.ok && r.code === "OK", "导入: 合成产物全链 OK", r.message);
  ok(r.stats.imported === 6 && r.stats.uncovered === 0 && r.stats.tagsDropped === 0,
    "导入: 6 条全入、0 未覆盖、0 标签丢弃", JSON.stringify(r.stats));
  ok(r.stats.tags === 16, "导入: 倒排写入 16 个标签", String(r.stats.tags));
  ok(r.stats.chapterSummaries === 2 && r.stats.bookSummary === true, "导入: 章摘要 2 篇（孤儿章名跳过）+ 书摘要 1 篇");
  ok(r.warnings.some(w => w.includes("第9章")), "导入: 孤儿章名给提醒", JSON.stringify(r.warnings));
  const c1 = one(dbPath, "SELECT ctx, tags, questions FROM chunks WHERE id=1");
  ok(c1.ctx === "介绍熔断器与断路器的保护原理。" && JSON.parse(c1.tags).join(",") === "熔断器,断路器,保护电器"
    && JSON.parse(c1.questions).length === 1, "导入: ctx/tags/questions 三列落值正确（tags 存 JSON 数组）");
  const tagRows = rows(dbPath, "SELECT tag FROM chunk_tags WHERE chunk_id=1 ORDER BY tag");
  ok(tagRows.length === 3 && tagRows[0].tag === "保护电器", "导入: chunk_tags 倒排行与标签一一对应");
  const sc = Object.fromEntries(rows(dbPath, "SELECT scope, COUNT(*) c FROM summaries GROUP BY scope").map(r => [r.scope, r.c]));
  ok(sc.chunk === 6 && sc.chapter === 2 && sc.book === 1, "导入: summaries 三级计数 6/2/1", JSON.stringify(sc));
  const s1 = one(dbPath, "SELECT summary FROM summaries WHERE scope='chunk' AND ref='1'");
  ok(s1.summary === "熔断器过流切断电路，断路器兼有开关作用。", "导入: 块摘要按 chunk id 入库");
  const meta = Object.fromEntries(rows(dbPath, "SELECT key,value FROM meta").map(r => [r.key, r.value]));
  ok(!!meta.enrich_at && meta.enrich_entries === "6" && meta.enrich_source === "syn-art.json", "导入: meta 打 enrich 三印记");
  const after = rows(dbPath, "SELECT id, text FROM chunks ORDER BY id");
  ok(JSON.stringify(before) === JSON.stringify(after), "导入: 原文逐字节不变（前后快照比对）");
}

// ========== 3) 真机切片（学而库实跑产物）：全链 + 繁体 + 0 丢弃 ==========
{
  const dbPath = makeDb("lunyu-xueer-zh.docx.db", SLICE.chunks, SLICE.content_hash);
  const art = {
    version: 1,
    book: { db: "lunyu-xueer-zh.docx.db", title: "lunyu-xueer-zh", content_hash: SLICE.content_hash, chunk_count: SLICE.chunks.length },
    stats: {}, entries: SLICE.entries, failed_batches: [],
    updated_at: "2026-10-15T23:00:00.000Z",
    chapter_summaries: SLICE.chapter_summaries, book_summary: SLICE.book_summary,
  };
  const r = importEnrich(dbPath, writeJson("xueer-art.json", art));
  ok(r.ok && r.stats.imported === 9 && r.stats.tagsDropped === 0,
    "真机: 学而库 9 条目全入、复验 0 丢弃（跑批时已验过的产物复验清白）", JSON.stringify(r.stats));
  ok(r.stats.eligible === 9 && r.stats.skipped === 7, "真机: 合格 9 / 跳过短块 7（与任务书一致）");
  const e1 = one(dbPath, "SELECT ctx, tags, questions FROM chunks WHERE id=1");
  ok(e1.ctx.startsWith("《論語》學而篇首章") && JSON.parse(e1.tags).includes("學而時習之"),
    "真机: 繁体保真（ctx/标签都是書中原字）", e1.ctx.slice(0, 20));
  const orig = SLICE.chunks.find(c => c.idx === 1).text;
  const nowText = one(dbPath, "SELECT text FROM chunks WHERE id=1").text;
  ok(nowText === orig, "真机: 块 1 原文与真库逐字节一致");
  const audit = auditEnrich(dbPath);
  ok(audit.ready && audit.tags.bad === 0 && audit.coverage.pct === 100,
    "真机: 库侧复查回源 0 失败、覆盖率 100%", JSON.stringify(audit.coverage));
  ok(audit.summaries.chunk === 9 && audit.summaries.chapter === 9 && audit.summaries.book === 1,
    "真机: 摘要三级 9/9/1", JSON.stringify(audit.summaries));
  ok(audit.enrichEntries === 9, "真机: meta 印记可查（enrich_entries=9）");
}

// ========== 4) 拒收：STALE / BADFILE / NOFILE / 无 entries ==========
{
  const dbPath = makeDb("stale.db", CH);
  const staleArt = synArtifact();
  staleArt.book.content_hash = "deadbeefdeadbeef";
  const r = importEnrich(dbPath, writeJson("stale-art.json", staleArt));
  ok(!r.ok && r.code === "STALE", "拒收: content_hash 不符 → STALE（书重建过）", r.message);
  const staleTables = rows(dbPath, "SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
  ok(!staleTables.includes("summaries") && !staleTables.includes("chunk_tags"),
    "拒收: STALE 后连 schema 都没建（一个字符都不写）");
  const rBad = importEnrich(dbPath, writeJson("null-art.json", null));
  ok(!rBad.ok && rBad.code === "BADFILE", "拒收: 产物是 null → BADFILE", rBad.message);
  fs.writeFileSync(path.join(TMP, "bad-art.json"), "{ 这不是 json", "utf8");
  ok(importEnrich(dbPath, path.join(TMP, "bad-art.json")).code === "BADFILE", "拒收: 手写坏 JSON → BADFILE");
  ok(importEnrich(dbPath, path.join(TMP, "no-such-file.json")).code === "NOFILE", "拒收: 文件不存在 → NOFILE");
  const noEntries = synArtifact(); delete noEntries.entries;
  ok(importEnrich(dbPath, writeJson("noent-art.json", noEntries)).code === "BADFILE", "拒收: 缺 entries → BADFILE");
  const okArt = writeJson("ok-art.json", synArtifact());
  ok(importEnrich(path.join(TMP, "no-such.db"), okArt).code === "NOBOOK", "拒收: 书库不存在 → NOBOOK（产物在位）");
}

// ========== 5) 容忍：dup / orphan / 自造标签被丢 ==========
{
  const dbPath = makeDb("flaw.db", CH);
  const art = JSON.parse(JSON.stringify(synArtifact()));   // 深拷贝：改条目不毒害共享夹具
  art.entries.push({ ...art.entries[0], prefix: "重复条目（应按首条）" });
  art.entries.push({ idx: 999, prefix: "越界条目", tags: [], questions: [], summary: "" });
  art.entries[1].tags = ["自造词并不存在", "低压电器"];   // 一个回源失败 + 一个命中
  const r = importEnrich(dbPath, writeJson("flaw-art.json", art));
  ok(r.ok && r.stats.dup === 1 && r.stats.orphan === 1, "容忍: 重复 idx 按首条、越界 idx 忽略", JSON.stringify(r.stats));
  ok(r.stats.imported === 6 && r.stats.tagsDropped === 1, "容忍: 自造标签「自造词并不存在」被丢并计数", JSON.stringify(r.stats));
  const c2 = one(dbPath, "SELECT tags FROM chunks WHERE id=2");
  ok(JSON.parse(c2.tags).join(",") === "低压电器", "容忍: 块 2 只落回源成功的标签");
  const c1 = one(dbPath, "SELECT ctx FROM chunks WHERE id=1");
  ok(c1.ctx === "介绍熔断器与断路器的保护原理。", "容忍: 重复条目按首条落库（后来的不覆盖）");
}

// ========== 6) 缺号块 uncovered + 重复导入幂等 ==========
{
  const dbPath = makeDb("partial.db", CH);
  const partial = synArtifact();
  partial.entries = SYN_ENTRIES.slice(0, 4);   // 只覆盖 4 块
  const r1 = importEnrich(dbPath, writeJson("partial-art.json", partial));
  ok(r1.ok && r1.stats.uncovered === 2 && r1.stats.imported === 4, "缺号: 4 覆盖 / 2 未覆盖", JSON.stringify(r1.stats));
  ok(r1.uncoveredIdx.join(",") === "5,6", "缺号: 报出未覆盖块号 5,6", r1.uncoveredIdx.join(","));
  ok(one(dbPath, "SELECT ctx FROM chunks WHERE id=5").ctx === null, "缺号: 未覆盖块 ctx 留 NULL（不猜）");
  const tags1 = one(dbPath, "SELECT COUNT(*) c FROM chunk_tags").c;
  const r2 = importEnrich(dbPath, path.join(TMP, "partial-art.json"));   // 原样再入一次
  ok(r2.ok && one(dbPath, "SELECT COUNT(*) c FROM chunk_tags").c === tags1, "幂等: 重复导入倒排行数不变（先删后插）");
  ok(one(dbPath, "SELECT COUNT(*) c FROM summaries").c === 4 + 2 + 1, "幂等: summaries 不翻倍（upsert）");
  // 补齐剩余 2 块后再入：覆盖变 6，原 4 条被刷新不重复
  const full = synArtifact();
  full.entries = SYN_ENTRIES.slice(4);
  const r3 = importEnrich(dbPath, writeJson("partial-art2.json", full));
  ok(r3.ok && r3.stats.imported === 2 && one(dbPath, "SELECT COUNT(*) c FROM chunks WHERE ctx IS NOT NULL").c === 6,
    "增量: 补导入剩余 2 块后全覆盖（与原 4 条共存）");
}

// ========== 7) auditEnrich：没洗过 / 洗过 / 坏路径 ==========
{
  const fresh = makeDb("fresh.db", CH);
  const a0 = auditEnrich(fresh);
  ok(!a0.ready && a0.code === "NOSCHEMA", "复查: 没洗过的库 → NOSCHEMA 不炸", a0.message);
  ok(auditEnrich(path.join(TMP, "ghost.db")).code === "NOBOOK", "复查: 库不存在 → NOBOOK");
  const enriched = makeDb("audited.db", CH);
  importEnrich(enriched, writeJson("audited-art.json", synArtifact()));
  const a = auditEnrich(enriched);
  ok(a.ready && a.tags.total === 16 && a.tags.bad === 0 && a.coverage.pct === 100,
    "复查: 标签 16 条全回源、覆盖率 100%", JSON.stringify(a.tags));
  ok(typeof a.textHash === "string" && a.textHash.length === 16, "复查: 原文指纹 16 位可对外比对");
}

// ========== 8) CLI：入库 / 复查 / 拒绝三条路 ==========
{
  const dbPath = makeDb("cli.db", CH);
  const artPath = writeJson("cli-art.json", synArtifact());
  const run = (...args) => {
    try {
      const out = execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "src", "enrich-import.mjs"), ...args], { encoding: "utf8" });
      return { code: 0, out };
    } catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
  };
  const r1 = run(dbPath, artPath);
  ok(r1.code === 0 && r1.out.includes("入库 6 条") && r1.out.includes("原文指纹"), "CLI: 正常入库退出 0 且打指纹", r1.out.slice(-120));
  const r2 = run(dbPath, "--audit");
  ok(r2.code === 0 && r2.out.includes("覆盖率 6/6") && r2.out.includes("回源失败 0"), "CLI: --audit 退出 0", r2.out.slice(-120));
  const r3 = run(dbPath, path.join(TMP, "no-such-file.json"));
  ok(r3.code === 1 && r3.out.includes("NOFILE"), "CLI: 坏产物路径退出 1 给人话");
  const staleArt = synArtifact(); staleArt.book.content_hash = "ffffffffffffffff";
  const r4 = run(dbPath, writeJson("cli-stale.json", staleArt));
  ok(r4.code === 1 && r4.out.includes("入库被拒") && r4.out.includes("STALE"), "CLI: STALE 拒收退出 1");
  const r5 = run();
  ok(r5.code === 1 && r5.out.includes("用法"), "CLI: 无参数给用法");
  const r6 = run(dbPath, artPath, "--min-chars", "40");
  ok(r6.code === 0, "CLI: --min-chars 40 位置参数解析不互相污染");
}

// ========== 9) 静态断言（判断标准①代码级盯防）+ 收尾 ==========
{
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "lib", "enrich-import.mjs"), "utf8");
  const strip = src.split("\n").filter(l => !l.trimStart().startsWith("//")).join("\n");
  ok(!/UPDATE\s+chunks\s+SET[^;]*\btext\s*=/.test(strip), "静态: 无任何 UPDATE chunks SET ...text=（原文不许被写）");
  ok(!/INSERT\s+INTO\s+chunks|DELETE\s+FROM\s+chunks/.test(strip), "静态: 不对 chunks 行本身增删");
  ok(strip.includes('[["ctx", "TEXT"], ["tags", "TEXT"], ["questions", "TEXT"]]')
    && strip.includes("ALTER TABLE chunks ADD COLUMN"),
    "静态: 三列迁移清单锁定 ctx/tags/questions（判断标准①代码级盯防）");
  ok(strip.includes("textFingerprint") && strip.includes("整单回滚"),
    "静态: 导入事务内复核原文指纹，不一致整单回滚（判断标准①运行时保险）");
  ok(/importEnrich|auditEnrich|ensureEnrichSchema|defaultArtifactPath/.test(strip), "静态: 四个导出俱在");
  ok(defaultArtifactPath("/x/y/lunyu-xueer-zh.docx.db") === path.join("enrich-results", "lunyu-xueer-zh.docx.json"),
    "收尾: 默认产物路径 enrich-results/<库名>.json", defaultArtifactPath("/x/y/lunyu-xueer-zh.docx.db"));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n===== 洗数据入库验收：${pass} PASS / ${fail} FAIL =====`);
if (fail) { console.error(`${fail} 项 FAIL`); process.exit(1); }
