// 洗数据产物入库（V3 第二波 #137）：把 enrich 产物（应用内跑批/外部智能体两通道同一格式）
// 写进书库——chunks 加 ctx/tags/questions 三列（ALTER 先例同 embed 的 emb 列），
// summaries 惰性表收块/章/书三级摘要，chunk_tags 倒排表供第三波池外提名。
// 四条判断标准脚本化：
//   ① 原文一字不改：本模块只 UPDATE ctx/tags/questions 三列（guard-test 静态断言盯死），
//      且导入事务内对全库 (id,text) 做前后 sha256 比对，不一致整单回滚；
//   ② 标签回源 100%：入库前复用 validateEnrichEntry 重跑回源验真（自造标签在这一层被丢并计数），
//      入库后 auditEnrich 可在库侧复查 chunk_tags 每个 tag 必须被该块原文包含；
//   ③ 对齐可验：artifact.book.content_hash 与库内 meta.content_hash 不符 → 整单拒收（书重建过）；
//   ④ 失败可部分：缺号块不产条目（留 NULL，audit 报覆盖率），重跑同一命令即覆盖更新。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { buildEnrichTasks, validateEnrichResult, ENRICH_DEFAULTS } from "./enrich.mjs";
const require = createRequire(import.meta.url);

// 入库 = 覆盖写（条目级）：产物覆盖的块整条刷新，缺号块保持原值不猜。
// 重复导入同一产物是幂等的（倒排先删后插，summaries 走 upsert）。
export function ensureEnrichSchema(db) {
  const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
  for (const [col, ddl] of [["ctx", "TEXT"], ["tags", "TEXT"], ["questions", "TEXT"]]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE chunks ADD COLUMN ${col} ${ddl}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries(
      scope TEXT NOT NULL,
      ref TEXT NOT NULL,
      summary TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY(scope, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_scope ON summaries(scope);
    CREATE TABLE IF NOT EXISTS chunk_tags(
      tag TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      PRIMARY KEY(tag, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_tags_chunk ON chunk_tags(chunk_id);
  `);
}

// 全库 (id,text) 指纹：导入前后比对，证明原文一个字节都没动（判断标准①运行时保险）
const textFingerprint = (db) => crypto.createHash("sha256")
  .update(db.prepare("SELECT id, text FROM chunks ORDER BY id").all()
    .map(r => JSON.stringify([r.id, r.text])).join("\n"))
  .digest("hex").slice(0, 16);

const readArtifact = (p) => {
  if (!fs.existsSync(p)) return { ok: false, code: "NOFILE", message: `找不到产物文件 ${p}` };
  let art;
  try { art = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return { ok: false, code: "BADFILE", message: `产物不是合法 JSON：${e.message}` }; }
  if (!art || typeof art !== "object" || !Array.isArray(art.entries)) {
    return { ok: false, code: "BADFILE", message: "产物缺少 entries 数组（不是 enrich 产物格式）" };
  }
  return { ok: true, artifact: art };
};

// 主入口：dbPath 书库，artifactPath 产物 JSON。返回 { ok, code, stats..., warnings[] }；绝不抛异常穿层。
export function importEnrich(dbPath, artifactPath, opts = {}) {
  const minChars = opts.minChars ?? 40;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const read = readArtifact(artifactPath);
  if (!read.ok) return read;
  const artifact = read.artifact;
  if (!fs.existsSync(dbPath)) return { ok: false, code: "NOBOOK", message: `找不到书库 ${dbPath}` };

  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath); }
  catch (e) { return { ok: false, code: "DBBROKEN", message: `书库打不开：${e.message}` }; }
  try {
    let task;
    try { task = buildEnrichTasks(db, { minChars }); } catch (e) {
      return { ok: false, code: "DBBROKEN", message: `书库读不了（缺 chunks 表？）：${e.message}` };
    }
    // ③ 对齐可验：书被重建过（content_hash 对不上）→ 整单拒收，一个字符都不写
    if (artifact.book?.content_hash && task.book.content_hash && artifact.book.content_hash !== task.book.content_hash) {
      return {
        ok: false, code: "STALE",
        message: `产物 content_hash ${artifact.book.content_hash} ≠ 书库 ${task.book.content_hash}——书被重建过，请重跑洗数据再入库`,
      };
    }
    // 入库前重跑验真（与跑批通道同一套函数）：自造标签在这层被丢并计数
    const v = validateEnrichResult(artifact, task);
    const warnings = [...v.errors];
    const covered = new Set(v.entries.map(e => e.idx));
    const uncovered = task.chunks.filter(c => !covered.has(c.idx)).map(c => c.idx);

    ensureEnrichSchema(db);
    const hashBefore = textFingerprint(db);
    const now = new Date().toISOString();
    const stamp = (scope, ref, summary) => {
      db.prepare("INSERT INTO summaries(scope,ref,summary,updated_at) VALUES(?,?,?,?) \
ON CONFLICT(scope,ref) DO UPDATE SET summary=excluded.summary, updated_at=excluded.updated_at")
        .run(scope, ref, summary, artifact.updated_at || now);
    };

    const tx = db.transaction(() => {
      const upd = db.prepare("UPDATE chunks SET ctx = ?, tags = ?, questions = ? WHERE id = ?");
      const delTags = db.prepare("DELETE FROM chunk_tags WHERE chunk_id = ?");
      const insTag = db.prepare("INSERT OR IGNORE INTO chunk_tags(tag, chunk_id) VALUES(?,?)");
      let tagsTotal = 0;
      for (const e of v.entries) {
        const tagsJson = JSON.stringify(e.tags);
        const questionsJson = JSON.stringify(e.questions);
        upd.run(e.prefix || "", tagsJson, questionsJson, e.idx);
        delTags.run(e.idx);
        for (const t of e.tags) { insTag.run(t, e.idx); tagsTotal++; }
        if (e.summary) stamp("chunk", String(e.idx), e.summary);
      }
      // 章摘要：章名必须在库内存在（产物外的章名是孤儿，跳过并警告）
      const dbChapters = new Set(task.chunks.map(c => c.chapter).filter(Boolean));
      let chapterCount = 0, bookWritten = false;
      const chapterOrphans = [];
      for (const [ch, s] of Object.entries(artifact.chapter_summaries || {})) {
        if (!dbChapters.has(ch)) { chapterOrphans.push(ch); continue; }
        stamp("chapter", ch, String(s || "").slice(0, ENRICH_DEFAULTS.chapterSummaryMax));
        chapterCount++;
      }
      if (chapterOrphans.length) warnings.push(`章摘要有 ${chapterOrphans.length} 个章名不在书库（${chapterOrphans.slice(0, 3).join("、")}，已跳过）`);
      // 书摘要：一次一份
      if (typeof artifact.book_summary === "string" && artifact.book_summary.trim()) {
        stamp("book", "book", artifact.book_summary.trim().slice(0, ENRICH_DEFAULTS.bookSummaryMax));
        bookWritten = true;
      }
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('enrich_at',?)").run(now);
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('enrich_entries',?)").run(String(v.entries.length));
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('enrich_source',?)").run(path.basename(artifactPath));
      // ① 运行时保险：事务内复核原文指纹，不一致抛错 → 整个事务回滚（一行都不留）；
      //   抛出后由 tx() 外层 catch 转 {ok:false, code:"TAMPER"} 返回（V3R-D04，绝不穿层）
      const hashAfter = textFingerprint(db);
      if (hashAfter !== hashBefore) throw new Error(`原文指纹变化（${hashBefore} → ${hashAfter}），整单回滚`);
      return { tagsTotal, chapterCount, bookWritten };
    });
    // V3R-D04（严重）：事务内抛错（指纹保险丝触发/库内既有表 schema 不兼容）→ better-sqlite3 已整单回滚；
    // lib 铁律：穿层前转 {ok:false}——CLI/桌面拿到人话而非英文栈。指纹不符单列 TAMPER 码（语义精确）。
    let written;
    try { written = tx(); }
    catch (e) {
      const tamper = String(e?.message || "").includes("原文指纹");
      return {
        ok: false,
        code: tamper ? "TAMPER" : "DBBROKEN",
        message: tamper ? e.message : `入库写库失败（已整单回滚，一行都没留）：${e?.message || e}`,
      };
    }
    onProgress({ phase: "import", done: v.entries.length, total: task.chunks.length });
    return {
      ok: true, code: "OK",
      message: v.entries.length ? `入库 ${v.entries.length} 条（覆盖 ${((v.entries.length / Math.max(1, task.chunks.length)) * 100).toFixed(0)}%）` : "产物无有效条目",
      stats: {
        eligible: task.chunks.length, skipped: task.skipped,
        imported: v.entries.length, uncovered: uncovered.length,
        tags: written.tagsTotal, tagsDropped: v.stats.tagsDropped, tagsCapped: v.stats.tagsCapped,
        dup: v.stats.dup, orphan: v.stats.orphan,
        chapterSummaries: written.chapterCount, bookSummary: written.bookWritten,
        textHash: hashBefore,
      },
      uncoveredIdx: uncovered,
      warnings,
      artifactPath,
    };
  } finally {
    db.close();  // 中途抛错不留句柄
  }
}

// 库侧复查（只读）：回源率/覆盖率/三级摘要计数/原文指纹。
// 表不存在（没洗过）→ { ready:false }，不炸。
export function auditEnrich(dbPath, { minChars = 40 } = {}) {
  if (!fs.existsSync(dbPath)) return { ready: false, code: "NOBOOK", message: `找不到书库 ${dbPath}` };
  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath, { readonly: true }); }
  catch (e) { return { ready: false, code: "DBBROKEN", message: `书库打不开：${e.message}` }; }
  try {
    const hasTable = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!hasTable("chunk_tags") || !hasTable("summaries")) {
      return { ready: false, code: "NOSCHEMA", message: "书库还没洗过（无 chunk_tags/summaries 表）" };
    }
    // ② 回源复查：库里每个倒排标签都必须能在该块原文里找到（归一化后 includes）
    const norm = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
    const rows = db.prepare("SELECT ct.tag tag, ct.chunk_id id, c.text text FROM chunk_tags ct JOIN chunks c ON c.id = ct.chunk_id").all();
    const bad = rows.filter(r => { const n = norm(r.tag); return n.length < 2 || !norm(r.text).includes(n); });
    const total = db.prepare("SELECT COUNT(*) c FROM chunks").get().c;
    const covered = db.prepare("SELECT COUNT(*) c FROM chunks WHERE ctx IS NOT NULL").get().c;
    const eligible = db.prepare("SELECT COUNT(*) c FROM chunks WHERE length(text) >= ?").get(minChars).c;
    const byScope = Object.fromEntries(db.prepare("SELECT scope, COUNT(*) c FROM summaries GROUP BY scope").all().map(r => [r.scope, r.c]));
    const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
    return {
      ready: true,
      tags: { total: rows.length, bad: bad.length, badList: bad.slice(0, 10).map(r => ({ tag: r.tag, id: r.id })) },
      coverage: { total, eligible, covered, pct: eligible ? Math.round((covered / eligible) * 100) : 0 },
      summaries: { chunk: byScope.chunk || 0, chapter: byScope.chapter || 0, book: byScope.book || 0 },
      enrichAt: meta.enrich_at || null, enrichEntries: meta.enrich_entries ? +meta.enrich_entries : null,
      textHash: textFingerprint(db),
    };
  } finally {
    db.close();
  }
}

// 默认产物路径：enrich-results/<库名去掉 .db>.json（与跑批写盘位置一致）
export function defaultArtifactPath(dbPath, resultsDir = "enrich-results") {
  return path.join(resultsDir, path.basename(dbPath).replace(/\.db$/, "") + ".json");
}
