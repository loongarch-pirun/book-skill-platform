// 编目功能验收：迁移 / 完整性 / 防幻觉 / mention / theme_vecs / 检索信号 / 保真 / 回滚
// 用法: node test/catalog-test.mjs   （回滚演练在系统临时目录副本上进行，真库只读不碰）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { validateResult, loadCatalogSignal, rollbackCatalog, importCatalog } from "../src/lib/catalog.mjs";
import { buildTask, clusterChunks } from "../src/lib/catalog.mjs";

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

const LIB = path.join(import.meta.dirname, "..", "library");
const ppDb = path.join(LIB, "pride-and-prejudice-en.epub.db");
const db = new Database(ppDb, { readonly: true });

// 1) 迁移完整性：nodes/edges 有 source/ref 列，llm 与 rule 层并存
const nodeCols = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
const edgeCols = db.prepare("PRAGMA table_info(edges)").all().map(c => c.name);
assert(nodeCols.includes("source") && edgeCols.includes("source") && edgeCols.includes("ref"),
  `迁移完整性: nodes[${nodeCols}] edges[${edgeCols}]`);
const llmNodes = db.prepare("SELECT COUNT(*) n FROM nodes WHERE source='llm'").get().n;
const ruleNodes = db.prepare("SELECT COUNT(*) n FROM nodes WHERE source='rule'").get().n;
assert(llmNodes === 37 && ruleNodes > 0, `双层图谱并存: llm 节点 ${llmNodes}(12主题+25人物) / rule 节点 ${ruleNodes}`);

// 2) 编目完整性：主题/人物/关系/边数量与 meta 溯源
const themes = db.prepare("SELECT COUNT(*) n FROM nodes WHERE type='theme' AND source='llm'").get().n;
const persons = db.prepare("SELECT COUNT(*) n FROM nodes WHERE type='person' AND source='llm'").get().n;
const relations = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='relation' AND source='llm'").get().n;
const belongs = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='belongs' AND source='llm'").get().n;
const mentions = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='mention' AND source='llm'").get().n;
const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
assert(themes === 12 && persons === 25 && relations === 26 && belongs === 1968 && mentions > 2500,
  `编目完整性: 主题${themes} 人物${persons} 关系${relations} belongs边${belongs} mention边${mentions}`);
assert(meta.catalog_model === "e5" && meta.catalog_themes === "12" && !!meta.catalog_at,
  `溯源 meta: catalog_model=${meta.catalog_model} catalog_themes=${meta.catalog_themes} catalog_at=${meta.catalog_at}`);

// 3) 防幻觉负例：假人物 match_names 必须被拒（整批拒绝）
const taskPath = path.join(import.meta.dirname, "..", "catalog-tasks", "pride-and-prejudice-en.epub.json");
const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
const fakeResult = {
  task_ref: "pride-and-prejudice-en.epub.db",
  themes: [{ id: "t1", name: "假主题" }],
  persons: [{ name: "Zaphod Beeblebrox", match_names: ["Zaphod Beeblebrox"], note: "银河总统" }],
  relations: [],
  assignments: task.clusters.map(c => ({ cluster: c.id, theme: "t1" })),
};
const vFake = validateResult(db, task, fakeResult);
assert(!vFake.ok && vFake.errors.some(e => /防幻觉/.test(e) && /Zaphod/.test(e)),
  `防幻觉负例: 假人物 Zaphod Beeblebrox 被拒（${vFake.errors[0]}）`);

// 3b) 半真半假：真人物 + 一个不存在的写法，同样整批拒绝
const halfFake = JSON.parse(JSON.stringify(fakeResult));
halfFake.persons = [{ name: "Elizabeth Bennet", match_names: ["Elizabeth", "Lizzzzy"], note: "" }];
const vHalf = validateResult(db, task, halfFake);
assert(!vHalf.ok && vHalf.errors.some(e => /Lizzzzy/.test(e)), `防幻觉负例: 真人物夹带假写法 Lizzzzy 同样被拒`);

// 4) mention 边抽查：已知含 "Caroline Bingley." 签名的块 243 必有 mention 边
const m243 = db.prepare("SELECT dst FROM edges WHERE src_type='chunk' AND src='243' AND kind='mention' AND source='llm'").all().map(r => r.dst);
assert(m243.includes("Caroline Bingley") && m243.includes("Charles Bingley"), `mention 抽查: 块243 → [${m243.join(", ")}]`);

// 5) theme_vecs：12 行、每行 384 维 float32
const tvs = db.prepare("SELECT name, vec FROM theme_vecs").all();
assert(tvs.length === 12 && tvs.every(t => t.vec.byteLength === 384 * 4), `theme_vecs: ${tvs.length} 行 × 384 维`);

// 6) 检索信号单元测试（人物路+关系扩散，无需向量）：
//    问题点名 Jane+Bingley → 直配 mention 命中；沿关系边应扩散到 Caroline（拆散关系）
const sig = loadCatalogSignal(db, "who tries to separate jane and bingley", null, null);
assert(sig.hit.size > 300, `信号命中块数 ${sig.hit.size}（Jane 237 + Bingley 256 类 mention 并集）`);
const w856 = sig.hit.get(856)?.w || 0;
assert(w856 >= 0.2 && w856 <= 0.3,
  `答案块856 信号 w=${w856.toFixed(3)}（直配 Jane+Bingley 求和 0.24，扩散默认关闭）`);
//    引擎不匹配 → 主题路跳过（catalog_model=e5，传 zh-small）
const sigZh = loadCatalogSignal(db, "彭伯利庄园", null, "zh-small");
assert(![...sigZh.hit.values()].some(s => s.tag.includes("theme")), `引擎不一致时主题路自动跳过`);
//    干净问题（不点名任何人）→ 无人物信号
const sigNone = loadCatalogSignal(db, "what is the weather today", null, null);
assert(sigNone.hit.size === 0, `无关问题零误伤: 命中 ${sigNone.hit.size} 块`);

// 7) 保真断言：chunks 数量与字节与入库基线一字不差
const now = db.prepare("SELECT COUNT(*) n, IFNULL(SUM(LENGTH(text)),0) b FROM chunks").get();
assert(now.n === +meta.catalog_chunk_count && now.b === +meta.catalog_text_bytes,
  `原文保真: ${now.n} 块 / ${now.b} 字节 == 入库基线`);
db.close();

// 8) 回滚演练（临时副本上）：rollbackCatalog 整批删 llm 层，rule 层与原文不动
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-catalog-"));
const copy = path.join(tmp, "pp-copy.db");
fs.copyFileSync(ppDb, copy);
const cdb = new Database(copy);
const before = { llm: cdb.prepare("SELECT COUNT(*) n FROM nodes WHERE source='llm'").get().n, chunks: cdb.prepare("SELECT COUNT(*) n, IFNULL(SUM(LENGTH(text)),0) b FROM chunks").get() };
rollbackCatalog(cdb);
const afterLlm = cdb.prepare("SELECT COUNT(*) n FROM nodes WHERE source='llm'").get().n;
const afterRule = cdb.prepare("SELECT COUNT(*) n FROM nodes WHERE source='rule'").get().n;
const afterChunks = cdb.prepare("SELECT COUNT(*) n, IFNULL(SUM(LENGTH(text)),0) b FROM chunks").get();
const afterMeta = cdb.prepare("SELECT COUNT(*) n FROM meta WHERE key LIKE 'catalog_%'").get().n;
const afterVecs = cdb.prepare("SELECT COUNT(*) n FROM theme_vecs").get().n;
cdb.close();
assert(before.llm > 0 && afterLlm === 0 && afterRule > 0 && afterVecs === 0 && afterMeta === 0
  && afterChunks.n === before.chunks.n && afterChunks.b === before.chunks.b,
  `回滚演练: llm ${before.llm}→${afterLlm} / rule 保留 ${afterRule} / 原文 ${afterChunks.b} 字节不动 / catalog meta 清零`);
fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n===== 编目功能验收结果 =====");
if (failed > 0) { console.log(`${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：迁移/完整性/防幻觉/mention/向量缓存/检索信号/保真/回滚 八关全过");
process.exit(0);
