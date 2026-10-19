// 清洗产物入库（clean 链路落库端）：把 runClean 产物（clean-results/<书名>.json）落进书库——
// 干净块留主库，垃圾块**物理 DELETE**（检索窗口只有 topN 席位，垃圾占位就是污染——物理不在 >
// 在但靠后），同时每条删除落隔离账 quarantine（原文+理由，防误删可恢复）。
// 四道闸（全部在事务**之前**判定，一个字节都不写）：
//   ① STALE：产物 content_hash ≠ 库内 → 书被重建过，整单拒收；
//   ② STALE_STRUCT：chunk_fp 不符（老产物退化 chunk_count）→ 切片结构变了，判定按 idx 硬套会删错块；
//   ③ GATE（G4）：drop_ratio > 40% 疑似模型抽风整单拒收（--force-gate 逃生）；20-40% 黄线警告入库；
//   ④ TAMPER：逐条 drop 的块在库内现算 text_hash 必须与产物记录一致——「删的就是判定时看的那块」，
//      有任何一块变过（人工改过库/重灌）整单拒收。clean 本来就要 DELETE，不能拿全库指纹当保险丝
//      （那是 enrich 的机制），逐条复核是等价强度。
// 落库单事务（顺序关键）：quarantine 先落账 → DELETE chunks → FTS rebuild → 悬空边清理 → meta 六键。
//   FTS rebuild 是**必须**步骤：chunks_fts 是 external content FTS5 表（content='chunks'），
//   DELETE 不会自动同步索引，不 rebuild 就有幽灵索引行（检索捞出已删块）。
import fs from "node:fs";
import { createRequire } from "node:module";
import { buildCleanTasks, textHash16, CLEAN_DEFAULTS, CLEAN_VERSION } from "./clean.mjs";
const require = createRequire(import.meta.url);

// 阈值 env 可覆盖（回归对比不改代码就能调档；与 enrichGateThresholds 同款）
const gateNum = (envName, dflt) => {
  const v = process.env[envName];
  if (v == null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
export function cleanGateThresholds() {
  return { warn: gateNum("BSP_CLEAN_GATE_WARN", CLEAN_DEFAULTS.dropWarnMax), hard: gateNum("BSP_CLEAN_GATE_HARD", CLEAN_DEFAULTS.dropHardMax) };
}

export function ensureCleanSchema(db) {
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

// FTS 全量重建：external content FTS5 的标准命令，DELETE 后必须调（探索已确认适用本项目 DDL）
export function rebuildFts(db) {
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
}

// 悬空边清理：被删块的 chunk 锚定边（embed 建的 rule 层相似边/章节边，src 是 TEXT 需 CAST）。
// 探测式：标准路径（clean 在 embed 前）这些表不存在 → 零开销；对已 embed 库重跑时清悬空。
// theme_vecs/nodes 按名字锚定不锚块 id，无需清理。
export function purgeDanglingRuleEdges(db, dropIds) {
  if (!dropIds.length) return 0;
  const hasEdges = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='edges'").get();
  if (!hasEdges) return 0;
  const hasSrcType = db.prepare("PRAGMA table_info(edges)").all().map(c => c.name).includes("src_type");
  if (!hasSrcType) return 0;
  let removed = 0;
  const del = db.prepare("DELETE FROM edges WHERE src_type='chunk' AND CAST(src AS INTEGER) = ? AND source != 'llm'");
  const delDst = db.prepare("DELETE FROM edges WHERE dst_type='chunk' AND CAST(dst AS INTEGER) = ? AND source != 'llm'");
  for (const id of dropIds) {
    removed += del.run(id).changes + delDst.run(id).changes;
  }
  return removed;
}

const readArtifact = (p) => {
  if (!fs.existsSync(p)) return { ok: false, code: "NOFILE", message: `找不到产物文件 ${p}` };
  let art;
  try { art = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return { ok: false, code: "BADFILE", message: `产物不是合法 JSON：${e.message}` }; }
  if (!art || typeof art !== "object" || !Array.isArray(art.verdicts)) {
    return { ok: false, code: "BADFILE", message: "产物缺少 verdicts 数组（不是 clean 产物格式）" };
  }
  return { ok: true, artifact: art };
};

// 主入口：dbPath 书库，artifactPath 清洗产物。返回 { ok, code?, stats, gate? }；绝不抛异常穿层。
export function importClean(dbPath, artifactPath, opts = {}) {
  const forceGate = opts.forceGate === true;
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
    try { task = buildCleanTasks(db); } catch (e) {
      return { ok: false, code: "DBBROKEN", message: `书库读不了（缺 chunks 表？）：${e.message}` };
    }
    // ① STALE：书被重建过
    if (artifact.book?.content_hash && task.book.content_hash && artifact.book.content_hash !== task.book.content_hash) {
      return { ok: false, code: "STALE", message: `产物 content_hash ${artifact.book.content_hash} ≠ 书库 ${task.book.content_hash}——书被重建过，请重跑清洗再入库` };
    }
    // ② STALE_STRUCT：切片结构变了（指纹比；老产物退化 chunk_count）
    const artFp = typeof artifact.book?.chunk_fp === "string" ? artifact.book.chunk_fp : null;
    if (artFp && task.book.chunk_fp && artFp !== task.book.chunk_fp) {
      return { ok: false, code: "STALE_STRUCT", message: `这本书重新加工过，切片结构变了（${artFp} → ${task.book.chunk_fp}）——旧清洗判定作废，请重跑清洗` };
    }
    if (!artFp && Number.isFinite(artifact.book?.chunk_count) && artifact.book.chunk_count !== task.book.chunk_count) {
      return { ok: false, code: "STALE_STRUCT", message: `这本书重新加工过，切片结构变了（块数 ${artifact.book.chunk_count} → ${task.book.chunk_count}）——旧清洗判定作废，请重跑清洗` };
    }

    // drop 清单（产物只存 drop 与 guarded-keep）
    const drops = artifact.verdicts.filter(v => v.verdict === "drop" && Number.isInteger(v.idx));
    const unknownIdx = drops.filter(v => !task.chunks.some(c => c.idx === v.idx));
    if (unknownIdx.length) {
      return { ok: false, code: "STALE_STRUCT", message: `产物判定的 ${unknownIdx.length} 个块号不在当前书库（如 idx ${unknownIdx[0].idx}）——切片结构变了，请重跑清洗` };
    }
    // ④ TAMPER：逐条复核「删的就是判定时看的那块」（sha256 16hex 对账）
    const chunkById = new Map(task.chunks.map(c => [c.idx, c]));
    for (const v of drops) {
      const c = chunkById.get(v.idx);
      if (!c || textHash16(c.text) !== String(v.text_hash || "")) {
        return { ok: false, code: "TAMPER", message: `块 idx ${v.idx} 的内容与清洗判定时不一致（text_hash 对不上）——书被改过，请重跑清洗` };
      }
    }
    // ③ GATE（G4 双档）：硬线在事务与 schema 之前拒收
    const total = task.chunks.length;
    const ratio = total ? drops.length / total : 0;
    const th = cleanGateThresholds();
    const gate = { ratio: Number(ratio.toFixed(4)), warn: th.warn, hard: th.hard, verdict: "pass" };
    if (ratio > th.hard && !forceGate) {
      gate.verdict = "block";
      return {
        ok: false, code: "GATE", gate,
        message: `清洗判定要删除 ${(ratio * 100).toFixed(0)}% 的块（${drops.length}/${total}，> ${(th.hard * 100).toFixed(0)}% 硬线）——疑似模型抽风，整单拒收。判定清单在 ${artifactPath}，人工核查后可用 --force-gate 放行`,
      };
    }
    if (ratio > th.warn) gate.verdict = "warn";

    ensureCleanSchema(db);
    const now = new Date().toISOString();
    let purgedEdges = 0;
    const tx = db.transaction(() => {
      const insQ = db.prepare(`INSERT INTO quarantine(chunk_id, chapter, chapter_path, page, text, reason, cat, book_title, profile_mode, content_hash, quarantined_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const delC = db.prepare("DELETE FROM chunks WHERE id = ?");
      for (const v of drops) {
        const c = chunkById.get(v.idx);
        insQ.run(c.idx, c.chapter || null, c.chapter_path ?? null, c.page ?? null, c.text,
          String(v.reason || ""), String(v.cat || "nonsense"), task.book.title || null,
          artifact.profile_mode || null, textHash16(c.text), now);
        delC.run(c.idx);
      }
      rebuildFts(db);
      purgedEdges = purgeDanglingRuleEdges(db, drops.map(v => v.idx));
      // meta 六键落账（镜像 struct_report 模式）
      const setMeta = db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)");
      setMeta.run("clean_at", now);
      setMeta.run("clean_report", JSON.stringify({
        version: CLEAN_VERSION, total, kept: total - drops.length, dropped: drops.length,
        drop_ratio: Number(ratio.toFixed(4)), guarded_g1: artifact.stats?.guardedG1 ?? null,
        guarded_g2: artifact.stats?.guardedG2 ?? null, guarded_g3: artifact.stats?.guardedG3 ?? null,
        batches: artifact.stats?.batches ?? null, profile_mode: artifact.profile_mode ?? null,
        gate: { verdict: gate.verdict, ratio: gate.ratio }, usage: artifact.stats?.usageIn != null
          ? { in: artifact.stats.usageIn, out: artifact.stats.usageOut } : null,
        restored: false, at: now,
      }));
      if (artifact.profile) setMeta.run("clean_profile", JSON.stringify(artifact.profile));
      setMeta.run("clean_chunk_fp", task.book.chunk_fp);
      setMeta.run("clean_content_hash", task.book.content_hash);
      setMeta.run("clean_version", String(CLEAN_VERSION));
    });
    try { tx(); }
    catch (e) {
      return { ok: false, code: "DBBROKEN", message: `入库写库失败（已整单回滚，一个块都没删）：${e?.message || e}` };
    }
    return {
      ok: true, code: "OK", gate,
      message: drops.length
        ? `删除 ${drops.length} 块（隔离账留原文与理由）| 保留 ${total - drops.length} 块 | 悬空边清理 ${purgedEdges} 条`
        : "零删除——全书判定为该有的内容（零误杀）",
      stats: { total, dropped: drops.length, kept: total - drops.length, ratio: Number(ratio.toFixed(4)), purgedEdges },
      artifactPath,
    };
  } finally {
    db.close();
  }
}

// 库侧复查（只读）：quarantine 计数、clean_report、FTS 与 chunks 对账。
export function auditClean(dbPath) {
  if (!fs.existsSync(dbPath)) return { ready: false, code: "NOBOOK", message: `找不到书库 ${dbPath}` };
  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath, { readonly: true }); }
  catch (e) { return { ready: false, code: "DBBROKEN", message: `书库打不开：${e.message}` }; }
  try {
    const hasQ = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quarantine'").get();
    if (!hasQ) return { ready: false, code: "NOSCHEMA", message: "书库还没清洗过（无 quarantine 表）" };
    const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
    const quarantined = db.prepare("SELECT COUNT(*) c FROM quarantine").get().c;
    const chunks = db.prepare("SELECT COUNT(*) c FROM chunks").get().c;
    let fts = null;
    try { fts = db.prepare("SELECT COUNT(*) c FROM chunks_fts").get().c; } catch { /* 无 FTS 表 */ }
    return {
      ready: true, quarantined, chunks, fts,
      ftsAligned: fts == null ? null : fts === chunks,
      cleanAt: meta.clean_at || null,
      report: meta.clean_report ? JSON.parse(meta.clean_report) : null,
    };
  } finally {
    db.close();
  }
}

// ---------- 隔离账恢复（G5 安全网的另一半） ----------
// 把 quarantine 里的块按原 id/chapter/chapter_path/page/text 插回主库（emb 留 NULL——重跑加工补向量）。
// opts.ids 指定 chunk_id 列表 / opts.all 全部 / opts.dryRun 只看不改。返回 { ok, restored, conflicts, skipped }。
export function restoreClean(dbPath, opts = {}) {
  if (!fs.existsSync(dbPath)) return { ok: false, code: "NOBOOK", message: `找不到书库 ${dbPath}` };
  const Database = require("better-sqlite3");
  let db;
  try { db = new Database(dbPath); }
  catch (e) { return { ok: false, code: "DBBROKEN", message: `书库打不开：${e.message}` }; }
  try {
    const hasQ = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quarantine'").get();
    if (!hasQ) return { ok: false, code: "NOSCHEMA", message: "书库还没清洗过（无 quarantine 表），没有可恢复的块" };
    const rows = opts.all || !opts.ids
      ? db.prepare("SELECT * FROM quarantine ORDER BY chunk_id").all()
      : db.prepare(`SELECT * FROM quarantine WHERE chunk_id IN (${opts.ids.map(() => "?").join(",")}) ORDER BY chunk_id`).all(...opts.ids);
    if (opts.dryRun) {
      return { ok: true, dryRun: true, candidates: rows.map(r => ({ chunk_id: r.chunk_id, chapter: r.chapter, reason: r.reason, cat: r.cat, chars: r.text.length })) };
    }
    if (!rows.length) return { ok: true, restored: 0, conflicts: [], message: "没有匹配的隔离块" };
    const now = new Date().toISOString();
    let restored = 0;
    const conflicts = [];
    const tx = db.transaction(() => {
      const ins = db.prepare("INSERT INTO chunks(id, chapter, chapter_path, page, text) VALUES (?,?,?,?,?)");
      const del = db.prepare("DELETE FROM quarantine WHERE chunk_id = ?");
      for (const r of rows) {
        const occupied = db.prepare("SELECT id FROM chunks WHERE id = ?").get(r.chunk_id);
        if (occupied) { conflicts.push(r.chunk_id); continue; }   // 同 id 已被占（书重建过）→ 跳过不硬塞
        ins.run(r.chunk_id, r.chapter, r.chapter_path, r.page, r.text);
        del.run(r.chunk_id);
        restored++;
      }
      rebuildFts(db);
      // 恢复操作账（append 语义：JSON 数组尾插）
      const prev = (() => { try { return JSON.parse(db.prepare("SELECT value FROM meta WHERE key='clean_restore_log'").get()?.value || "[]"); } catch { return []; } })();
      prev.push({ at: now, restored, conflicts: [...conflicts], ids: rows.map(r => r.chunk_id) });
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('clean_restore_log',?)").run(JSON.stringify(prev.slice(-20)));
    });
    try { tx(); }
    catch (e) { return { ok: false, code: "DBBROKEN", message: `恢复写库失败（已整单回滚）：${e?.message || e}` }; }
    return { ok: true, restored, conflicts, message: `恢复 ${restored} 块${conflicts.length ? `（${conflicts.length} 个块号被占跳过）` : ""}；这些块还没有向量，重跑「开始加工」即可补齐` };
  } finally {
    db.close();
  }
}
