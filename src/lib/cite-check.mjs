// 引文回验（V3R7-③）：把桌面 verifyAnswer 的「引用逐字回源」红线工具化——
// 智能体/模型写完带引用的答案后自检：引文是否真在书中逐字存在。
// 命中给块号/章节/页码（可直接跳原文）；未命中明确告知「不要采用」——宁可说
// 没依据，不许编造（凤凰 e2e 实测：对书中没有的「订单库分片」诚实拒答）。
// v1 两级匹配：exact（SQL instr 逐字，快路）→ normalized（空白归一后包含，
// 容忍引用时带入的换行/空格差异，level 照实标不冒充逐字）。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const openDb = (dbPath) => { try { return new Database(dbPath, { readonly: true }); } catch { return null; } };
const squash = (s) => String(s ?? "").replace(/\s+/g, "");

export function checkCitation(dbPath, quote) {
  const q = String(quote ?? "").trim();
  const db = openDb(dbPath);
  if (!db) return { error: "db-broken", hint: "书库文件损坏或无法打开——重新导入这本书" };
  try {
    if (!q) return { hit: false, error: "empty-quote", hint: "引文不能为空——把要验证的原文句子原样贴进来" };
    // 快路：整句逐字（instr 是字面子串，无通配符转义问题）
    const row = db.prepare("SELECT id, chapter, page, text FROM chunks WHERE instr(text, ?) > 0 ORDER BY id LIMIT 1").get(q);
    if (row)
      return { hit: true, level: "exact", chunk_id: row.id, chapter: row.chapter || null, page: row.page ?? null, quote_chars: q.length };
    // 慢路：空白归一（模型引用常带入换行/空格差异——照实标 normalized，不冒充逐字）
    const sq = squash(q);
    if (sq) {
      const rows = db.prepare("SELECT id, chapter, page, text FROM chunks ORDER BY id").all();
      for (const r of rows) {
        if (squash(r.text).includes(sq))
          return { hit: true, level: "normalized", chunk_id: r.id, chapter: r.chapter || null, page: r.page ?? null, quote_chars: q.length };
      }
    }
    return { hit: false, quote_chars: q.length,
      hint: "引文在本书中逐字找不到——可能是模型编造，或引用了译本/版本差异——不要采用" };
  } catch {
    return { error: "db-broken", hint: "书库文件损坏或不是有效数据库——重新导入这本书" };
  } finally { db.close(); }
}
