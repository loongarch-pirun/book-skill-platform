// V3R7-① 存量回补：给 build-book 旧库补 total_tokens / chapter_quality 两个 meta 键。
// 只加 meta 键、不重切片——编目边不作废，不需要 --force，可反复跑（幂等：值相同不写）。
// 用法: node src/backfill-meta.mjs [库目录] [--check]
//   --check  只盘点不写（对账用）
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { bookTokenTotal, detectLang, qualityFromStats } from "./lib/token-estimate.mjs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const argDir = args.find(a => !a.startsWith("--"));
const libDir = argDir ? path.resolve(argDir) : path.join(import.meta.dirname, "..", "library");

if (!fs.existsSync(libDir) || !fs.statSync(libDir).isDirectory()) {
  console.error(`库目录不存在: ${libDir}`);
  process.exit(1);
}

const dbs = fs.readdirSync(libDir).filter(f => f.endsWith(".db")).sort();
if (!dbs.length) {
  console.error(`库目录里没有 .db: ${libDir}`);
  process.exit(1);
}

console.log(`${checkOnly ? "盘点" : "回补"} ${dbs.length} 个库: ${libDir}${checkOnly ? "（--check 只读不写）" : ""}`);
let written = 0, unchanged = 0, failed = 0;

for (const f of dbs) {
  const dbPath = path.join(libDir, f);
  let db = null;
  try {
    db = new Database(dbPath);
    const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
    const st = db.prepare("SELECT COUNT(*) total, SUM(length(text)) chars FROM chunks").get();
    const named = db.prepare("SELECT COUNT(*) n FROM chunks WHERE chapter IS NOT NULL AND chapter != ''").get().n;
    const avgLen = db.prepare("SELECT AVG(length(chapter)) a FROM chunks WHERE chapter IS NOT NULL AND chapter != ''").get().a;
    const sample = db.prepare("SELECT text FROM chunks LIMIT 50").all().map(r => r.text);
    const tokens = bookTokenTotal(st.chars || 0, detectLang(sample));
    const quality = qualityFromStats({ total: st.total || 0, withChapter: named || 0, avgNameLen: avgLen || 0 });
    const wantTokens = String(tokens);
    const wantQuality = JSON.stringify(quality);
    const same = meta.total_tokens === wantTokens && meta.chapter_quality === wantQuality;
    const label = `${f.replace(/\.db$/, "")} | ${st.total || 0} 块 | ${(st.chars || 0).toLocaleString()} 字符 ≈ ${Math.round(tokens / 1000)}K token | 章节 ${quality.verdict}（覆盖 ${Math.round(quality.coverage * 100)}%）`;
    if (same) { unchanged++; console.log(`  未变  ${label}`); continue; }
    if (checkOnly) { console.log(`  待补  ${label}`); continue; }
    const setMeta = db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    setMeta.run("total_tokens", wantTokens);
    setMeta.run("chapter_quality", wantQuality);
    written++;
    console.log(`  已补  ${label}`);
  } catch (e) {
    failed++;
    console.error(`  失败  ${f}: ${e.message}`);
  } finally {
    try { db?.close(); } catch { /* 关失败无从补救 */ }
  }
}

console.log(`\n完成: 写入 ${written} · 未变 ${unchanged} · 失败 ${failed}`);
if (failed) process.exit(1);
