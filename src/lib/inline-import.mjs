// 行级清洗产物入库（inline 链路落库端）：把 buildInlinePlan 的计划落进书库——
//   L1 strip 块：UPDATE text（删行后的净化版）；
//   L2 split 块：UPDATE 主帖段 + INSERT 跟帖新块（id 取 MAX+n，chapter/page 继承原块，emb 留空）；
//   每个被动过的块进隔离账 quarantine（原文+理由，可整体恢复）。
// 四道闸（全部在事务**之前**判定，一个字节都不写）：
//   ① STALE：计划 content_hash ≠ 库内现算 → 书被改过，整单拒收；
//   ② STALE_STRUCT：chunk_fp 不符 → 切片结构变了，按 id 硬套会改错块；
//   ③ GATE（I4）：净化率 > 硬线 疑似规则抽风整单拒收（--force-gate 逃生）；黄线警告入库；
//   ④ TAMPER：逐块 text_hash 复核——「净化的就是计划时看的那块」，有任何一块变过整单拒收。
// 落库单事务（顺序关键）：隔离账先落 → UPDATE strips → UPDATE+INSERT splits → FTS rebuild →
//   悬空边清理 → 作废下游（emb 置 NULL + 删 catalog meta：块集合变了，向量和编目必须重做）→
//   inline meta 键 → syncBookMeta 四本账。
// 恢复（restoreInline）：quarantine 里 inline: 记录的原块全文写回 + 删切出的新块，同事务回涨四本账。
import fs from "node:fs";
import { createRequire } from "node:module";
import { buildCleanTasks, textHash16 as _th } from "./clean.mjs";
import { INLINE_VERSION, checkInlineGate } from "./inline-clean.mjs";
import { rebuildFts, purgeDanglingRuleEdges, syncBookMeta } from "./clean-import.mjs";

const require = createRequire(import.meta.url);
const textHash16 = _th;

// quarantine 扩展列（幂等 ALTER；clean 链路原表不加此列也兼容）
function ensureInlineSchema(db) {
  const cols = db.prepare("PRAGMA table_info(quarantine)").all().map(c => c.name);
  if (!cols.length) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quarantine(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER NOT NULL,
        chapter TEXT, chapter_path TEXT, page INTEGER,
        text TEXT NOT NULL,
        reason TEXT NOT NULL,
        cat TEXT NOT NULL,
        book_title TEXT,
        profile_mode TEXT,
        content_hash TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quarantine_chunk ON quarantine(chunk_id);
    `);
  }
  if (!cols.includes("split_json")) {
    db.exec("ALTER TABLE quarantine ADD COLUMN split_json TEXT");
  }
}

// 作废下游：块集合变了 → emb 列置 NULL + catalog_* meta 删除（重跑 embed-book + catalog-import 补齐）。
// 返回 { embCleared, catalogCleared }。探测式：无 emb 列/无 catalog meta 时零开销。
function invalidateDownstream(db, touchedIds) {
  let embCleared = 0, catalogCleared = 0;
  const cols = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
  if (cols.includes("emb")) {
    const stmt = db.prepare("UPDATE chunks SET emb = NULL WHERE id = ? AND emb IS NOT NULL");
    for (const id of touchedIds) embCleared += stmt.run(id).changes;
  }
  for (const k of ["catalog_at", "catalog_themes", "catalog_persons", "catalog_chunk_count", "catalog_text_bytes", "catalog_model", "catalog_relations"]) {
    const r = db.prepare("DELETE FROM meta WHERE key = ?").run(k);
    catalogCleared += r.changes;
  }
  return { embCleared, catalogCleared };
}

// 主入口：dbPath 书库，plan 由 buildInlinePlan(db) 产出（同进程直传，不走文件——规则确定性产物）。
// opts: { forceGate, dryRun }。返回 { ok, code?, stats, gate?, message }；绝不抛异常穿层。
export function importInline(dbPath, plan, opts = {}) {
  const forceGate = opts.forceGate === true;
  if (!plan || plan.ok !== true) return { ok: false, code: "BADPLAN", message: "计划无效（buildInlinePlan 失败）" };
  if (!fs.existsSync(dbPath)) return { ok: false, code: "NOBOOK", message: `找不到书库 ${dbPath}` };

  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath); }
  catch (e) { return { ok: false, code: "DBBROKEN", message: `书库打不开：${e.message}` }; }
  try {
    let task;
    try { task = buildCleanTasks(db); }
    catch (e) { return { ok: false, code: "DBBROKEN", message: `书库读不了（缺 chunks 表？）：${e?.message || e}` }; }

    // ① STALE：书被重建过（content_hash 是切片文本指纹，与 clean 链路同尺）
    const nowHash = task.book.content_hash;
    const planHash = plan.book?.content_hash;
    if (planHash && nowHash && planHash !== nowHash) {
      return { ok: false, code: "STALE", message: `计划 content_hash ${planHash} ≠ 书库 ${nowHash}——书被重建过，请重跑行级清洗` };
    }
    // ② STALE_STRUCT：切片结构变了
    const artFp = plan.book?.chunk_fp || null;
    if (artFp && task.book.chunk_fp && artFp !== task.book.chunk_fp) {
      return { ok: false, code: "STALE_STRUCT", message: `这本书重新加工过，切片结构变了（${artFp} → ${task.book.chunk_fp}）——旧计划作废，请重跑行级清洗` };
    }
    if (!artFp && plan.stats.total !== task.chunks.length) {
      return { ok: false, code: "STALE_STRUCT", message: `块数 ${plan.stats.total} → ${task.chunks.length} 不一致——切片结构变了，请重跑行级清洗` };
    }
    // ④ TAMPER：逐块复核「净化的就是计划时看的那块」
    const chunkById = new Map(task.chunks.map(c => [c.idx, c]));
    const touched = plan.blocks.filter(b => b.action !== "keep");
    for (const b of touched) {
      const c = chunkById.get(b.id);
      if (!c || textHash16(c.text) !== b.text_hash) {
        return { ok: false, code: "TAMPER", message: `块 ${b.id} 的内容与计划时不一致（text_hash 对不上）——书被改过，请重跑行级清洗` };
      }
    }
    // ③ GATE（I4 双档）：硬线在事务与 schema 之前拒收
    const gateCheck = checkInlineGate(plan.stats, forceGate);
    if (!gateCheck.ok) return { ok: false, code: "GATE", gate: gateCheck.gate, message: gateCheck.message };
    const gate = gateCheck.gate;

    if (opts.dryRun) {
      return { ok: true, dryRun: true, gate, stats: plan.stats, message: "（dry-run 不落库）" };
    }

    ensureInlineSchema(db);
    const now = new Date().toISOString();
    let purgedEdges = 0, embCleared = 0, catalogCleared = 0;
    const tx = db.transaction(() => {
      const insQ = db.prepare(`INSERT INTO quarantine(chunk_id, chapter, chapter_path, page, text, reason, cat, book_title, profile_mode, content_hash, quarantined_at, split_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      const upd = db.prepare("UPDATE chunks SET text = ? WHERE id = ?");
      const maxId = db.prepare("SELECT MAX(id) m FROM chunks").get().m || 0;
      let nextId = maxId;
      const newIds = [];
      for (const b of touched) {
        const c = chunkById.get(b.id);
        const reasons = b.removed.map(r => `${r.cat}:${r.chars}`).join(",");
        let splitJson = null;
        if (b.action === "split") {
          splitJson = JSON.stringify(b.replies.map(t => ({ id: ++nextId, chars: t.length })));
          for (let i = 0; i < b.replies.length; i++) {
            newIds.push(nextId - b.replies.length + 1 + i);
          }
        }
        // 隔离账：原文 + 净化明细（split 记录新块 id 供恢复时删除）
        insQ.run(b.id, c.chapter || null, c.chapter_path ?? null, c.page ?? null, c.text,
          `inline:v${INLINE_VERSION}:${b.action}:${reasons}`, "inline", task.book.title || null,
          null, textHash16(c.text), now, splitJson);
        upd.run(b.after, b.id);
        if (b.action === "split") {
          const insC = db.prepare("INSERT INTO chunks(id, chapter, chapter_path, page, text) VALUES (?,?,?,?,?)");
          let nid = nextId - b.replies.length + 1;
          for (const rt of b.replies) {
            insC.run(nid, c.chapter || null, c.chapter_path ?? null, c.page ?? null, rt);
            nid++;
          }
        }
      }
      rebuildFts(db);
      if (newIds.length) purgedEdges = purgeDanglingRuleEdges(db, newIds);
      const inv = invalidateDownstream(db, [...touched.map(b => b.id), ...newIds]);
      embCleared = inv.embCleared; catalogCleared = inv.catalogCleared;
      const setMeta = db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)");
      setMeta.run("inline_at", now);
      setMeta.run("inline_report", JSON.stringify({
        version: INLINE_VERSION, total: plan.stats.total, keep: plan.stats.keep,
        strip: plan.stats.strip, split: plan.stats.split, guardedI1: plan.stats.guardedI1,
        removedLines: plan.stats.removedLines, removedChars: plan.stats.removedChars,
        newChunks: plan.stats.newChunks, cleanRatio: plan.stats.cleanRatio,
        beforeChars: plan.stats.beforeChars, afterChars: plan.stats.afterChars,
        purgedEdges,
        gate: { verdict: gate.verdict, ratio: gate.ratio }, restored: false, at: now,
      }));
      setMeta.run("inline_chunk_fp", task.book.chunk_fp);
      setMeta.run("inline_content_hash", task.book.content_hash);
      setMeta.run("inline_version", String(INLINE_VERSION));
      syncBookMeta(db);
    });
    try { tx(); }
    catch (e) {
      return { ok: false, code: "DBBROKEN", message: `落库写库失败（已整单回滚，一个块都没动）：${e?.message || e}` };
    }
    return {
      ok: true, code: "OK", gate,
      message: `净化 ${touched.length} 块（strip ${plan.stats.strip} / split ${plan.stats.split}）| 切出新块 ${plan.stats.newChunks} | 删行 ${plan.stats.removedLines} 行 ${plan.stats.removedChars} 字（${(plan.stats.cleanRatio * 100).toFixed(1)}%）`
        + (purgedEdges ? ` | 清悬挂规则边 ${purgedEdges} 条` : "")
        + (embCleared || catalogCleared ? ` | 已作废向量 ${embCleared} 条与编目 ${catalogCleared} 键（块集合变了，重跑 embed-book + catalog-import 补齐）` : ""),
      stats: { ...plan.stats, embCleared, catalogCleared, purgedEdges },
    };
  } finally {
    db.close();
  }
}

// 库侧复查（只读）：inline_report、quarantine inline 计数、账目相符。
export function auditInline(dbPath) {
  if (!fs.existsSync(dbPath)) return { ready: false, code: "NOBOOK", message: `找不到书库 ${dbPath}` };
  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath, { readonly: true }); }
  catch (e) { return { ready: false, code: "DBBROKEN", message: `书库打不开：${e.message}` }; }
  try {
    const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
    if (!meta.inline_at) return { ready: false, code: "NOSCHEMA", message: "书库没跑过行级清洗（无 inline meta）" };
    const hasQ = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quarantine'").get();
    const inlineQ = hasQ ? db.prepare("SELECT COUNT(*) c FROM quarantine WHERE cat='inline'").get().c : 0;
    const chunks = db.prepare("SELECT COUNT(*) c FROM chunks").get().c;
    let fts = null;
    try { fts = db.prepare("SELECT COUNT(*) c FROM chunks_fts").get().c; } catch { /* 无 FTS 表 */ }
    return {
      ready: true, inlineQuarantined: inlineQ, chunks, fts,
      ftsAligned: fts == null ? null : fts === chunks,
      metaAligned: Number(meta.chunk_count) === chunks,
      report: meta.inline_report ? JSON.parse(meta.inline_report) : null,
    };
  } finally {
    db.close();
  }
}

// ---------- 隔离账恢复（G5 安全网） ----------
// 把 quarantine 里 cat='inline' 的记录按原 id/文本写回主库，并删掉当时切出的新块（split_json 记了 id）。
// opts.ids 指定 chunk_id / opts.all 全部 / opts.dryRun 只看不改。返回 { ok, restored, deletedNew, conflicts }。
export function restoreInline(dbPath, opts = {}) {
  if (!fs.existsSync(dbPath)) return { ok: false, code: "NOBOOK", message: `找不到书库 ${dbPath}` };
  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath); }
  catch (e) { return { ok: false, code: "DBBROKEN", message: `书库打不开：${e.message}` }; }
  try {
    const hasQ = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quarantine'").get();
    if (!hasQ) return { ok: false, code: "NOSCHEMA", message: "书库没有隔离账，没有可恢复的行级净化" };
    const rows = opts.all || !opts.ids
      ? db.prepare("SELECT * FROM quarantine WHERE cat='inline' ORDER BY chunk_id").all()
      : db.prepare(`SELECT * FROM quarantine WHERE cat='inline' AND chunk_id IN (${opts.ids.map(() => "?").join(",")}) ORDER BY chunk_id`).all(...opts.ids);
    if (opts.dryRun) {
      return { ok: true, dryRun: true, candidates: rows.map(r => ({ chunk_id: r.chunk_id, reason: r.reason, chars: r.text.length, split: r.split_json ? JSON.parse(r.split_json).length : 0 })) };
    }
    if (!rows.length) return { ok: true, restored: 0, deletedNew: 0, conflicts: [], message: "没有匹配的行级净化记录" };
    const now = new Date().toISOString();
    let restored = 0, deletedNew = 0;
    const conflicts = [];
    const tx = db.transaction(() => {
      const upd = db.prepare("UPDATE chunks SET text = ? WHERE id = ?");
      const delNew = db.prepare("DELETE FROM chunks WHERE id = ?");
      const delQ = db.prepare("DELETE FROM quarantine WHERE chunk_id = ? AND cat='inline'");
      for (const r of rows) {
        const cur = db.prepare("SELECT text FROM chunks WHERE id = ?").get(r.chunk_id);
        if (!cur) { conflicts.push(r.chunk_id); continue; }   // 原块没了（书重建过）→ 跳过不硬塞
        upd.run(r.text, r.chunk_id);
        if (r.split_json) {
          for (const s of JSON.parse(r.split_json)) { deletedNew += delNew.run(s.id).changes; }
        }
        delQ.run(r.chunk_id);
        restored++;
      }
      rebuildFts(db);
      const prev = (() => { try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key='inline_restore_log'").get()?.value || "[]"); } catch { return []; } })();
      prev.push({ at: now, restored, deletedNew, conflicts: [...conflicts], ids: rows.map(r => r.chunk_id) });
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('inline_restore_log',?)").run(JSON.stringify(prev.slice(-20)));
      syncBookMeta(db);
    });
    try { tx(); }
    catch (e) { return { ok: false, code: "DBBROKEN", message: `恢复写库失败（已整单回滚）：${e?.message || e}` }; }
    return {
      ok: true, restored, deletedNew, conflicts,
      message: `恢复 ${restored} 块原文、删除 ${deletedNew} 个切出的跟帖新块${conflicts.length ? `（${conflicts.length} 个原块已不在，跳过）` : ""}；这些块还没有向量，重跑「开始加工」即可补齐`,
    };
  } finally {
    db.close();
  }
}
