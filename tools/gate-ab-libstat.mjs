#!/usr/bin/env node
/**
 * gate-ab-libstat.mjs —— 两份书库的「结构指纹」并排对照（只读）
 *
 * 用途：做闸门 A/B 对照之前，先证明「两个库的正文完全一样，只有编目层不同」。
 * 如果 chunks 行数或 summary 不一致，那 A/B 的差异就不能归因给编目回灌。
 *
 * 跑法：node tools/gate-ab-libstat.mjs <库目录A> <库目录B>
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const [dirA, dirB] = process.argv.slice(2);
if (!dirA || !dirB) {
  console.error("用法：node tools/gate-ab-libstat.mjs <库目录A> <库目录B>");
  process.exit(2);
}

const stat = (dir) => {
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".db")).sort()) {
    const rec = { chunks: -1, chars: -1, person: -1, theme: -1, vec: -1, model: "?", err: null };
    let db;
    try {
      db = new Database(path.join(dir, f), { readonly: true });
      rec.chunks = db.prepare("SELECT COUNT(*) c FROM chunks").get().c;
      rec.chars = db.prepare("SELECT IFNULL(SUM(LENGTH(text)),0) c FROM chunks").get().c;
      const n = (sql) => { try { return db.prepare(sql).get().c; } catch { return -1; } };
      rec.person = n("SELECT COUNT(*) c FROM nodes WHERE type='person'");
      rec.theme = n("SELECT COUNT(*) c FROM nodes WHERE type='theme'");
      rec.vec = n("SELECT COUNT(*) c FROM theme_vecs");
      try { rec.model = db.prepare("SELECT value FROM meta WHERE key='model'").get()?.value || "?"; } catch { rec.model = "?"; }
    } catch (e) {
      rec.err = e.message.split("\n")[0];
    } finally {
      try { db?.close(); } catch { /* 关失败无从补救 */ }
    }
    out.set(f, rec);
  }
  return out;
};

const A = stat(dirA);
const B = stat(dirB);
const all = [...new Set([...A.keys(), ...B.keys()])].sort();

console.log("===== 书库结构对照（只读）=====");
console.log(`A = ${path.resolve(dirA)}`);
console.log(`B = ${path.resolve(dirB)}\n`);
console.log("库".padEnd(46) + "chunks(A/B)".padEnd(16) + "正文长度一致".padEnd(14) + "person(A/B)".padEnd(14) + "theme_vecs(A/B)");
let bodyDiff = 0, missing = 0;
for (const f of all) {
  const a = A.get(f), b = B.get(f);
  if (!a || !b) {
    missing++;
    console.log(f.padEnd(46) + (a ? "只在 A" : "只在 B"));
    continue;
  }
  const sameBody = a.chunks === b.chunks && a.chars === b.chars;
  if (!sameBody) bodyDiff++;
  console.log(
    f.padEnd(46)
    + `${a.chunks}/${b.chunks}`.padEnd(16)
    + (sameBody ? "是" : "**否**").padEnd(14)
    + `${a.person}/${b.person}`.padEnd(14)
    + `${a.vec}/${b.vec}`
    + (a.err || b.err ? `  [打不开: ${a.err || b.err}]` : "")
  );
}

console.log("\n===== 结论 =====");
if (missing) console.log(`✗ 有 ${missing} 本只存在于一侧 —— 两库不是同一批书，A/B 不可比`);
if (bodyDiff) console.log(`✗ 有 ${bodyDiff} 本正文（chunks/长度）不同 —— 差异不能只归因给编目回灌`);
if (!missing && !bodyDiff) console.log("✓ 正文逐本一致（chunks 行数与总长度都相等）→ 差异可归因于编目层");
process.exit(missing || bodyDiff ? 1 : 0);
