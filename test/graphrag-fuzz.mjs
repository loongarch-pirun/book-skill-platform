// GraphRAG 演进轮对抗爆破（B1）：专攻六个 commit（P1 a87c69b / P1.5 3bd7bfa / P2 6e13420 /
// P4 a1e0900 / P5 e096ef3 / docs 5b0d1fa）+ 本轮代码检查修复的 F1/F2/D1 三个确认缺陷。
// 攻击面：
//   W1 实体链接对抗——linkEntities/entityAliasTerms/hybridSearch 集成（含中间态库 F1/F2 钉死）
//   W2 expand 对抗——expandNeighborhood 截断边界/tie 序/类型强转/口径过滤
//   W3 lookup 对抗——lookupEntry 注入安全/夹取矩阵/归一化边界/同名合并
//   W4 缓存对抗——listBooks P5 缓存多分桶/WAL 盲区/坏库过滤/删除重扫
//   W5 链路对抗——clampMaxBooks/MAXBOOKS_SCHEMA/routeAndSearch 直调/三方 clamp 家族
//   W6 D1 简繁双形——简体文档 × 中文查询的字面腿（B2 真实工作资料 E2E 结晶的修复钉死）
// 铁律：真库只读拷贝到 tmp（破坏性操作只在副本）；合成库自建；不碰 library/ 原件；
//   不动检索打分语义（本套件只做"观测+钉行为"，不引入新判分）。
// 跑法：node test/graphrag-fuzz.mjs （挂 test:fast；真库依赖，不进 test:ci——与 catalog-fuzz 同口径）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const Database = require("better-sqlite3");

const { hybridSearch, routeAndSearch, listBooks, clearListCache, listCacheStats, findBook } = await import("../src/lib/search.mjs");
const { linkEntities, entityAliasTerms, loadCatalogSignal, expandNeighborhood } = await import("../src/lib/catalog.mjs");
const { lookupEntry, MAX_BLOCKS, clampMaxBlocks } = await import("../src/lib/lookup.mjs");
const { clampMaxBooks, MAXBOOKS_SCHEMA } = await import("../src/lib/register-tools.mjs");
const { questionKeywords } = await import("../src/lib/keywords.mjs");

let pass = 0, fail = 0, observe = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};
const obs = (cond, name, note = "") => {
  if (cond) { observe++; console.log(`OBSERVE - ${name}${note ? " | " + note : ""}`); }
  else { fail++; console.log(`FAIL - ${name}（OBSERVE 条件不成立）${note}`); }
};

// Windows 文件锁滞后：sqlite 句柄关闭后立即删可能 EBUSY——清理失败不挡测试结论
const safeRm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { } };
const mkTmp = (tag) => { const t = fs.mkdtempSync(path.join(os.tmpdir(), `bsp-gf-${tag}-`)); fs.mkdirSync(path.join(t, "library"), { recursive: true }); return { tmp: t, lib: path.join(t, "library") }; };

// 合成库：默认复刻 build-book 直出形态（无 emb 列 = 本轮 F1 防护的中间态），
// 建 chunks_fts（trigram）并 rebuild——字面腿 MATCH 需要它；WAL 可选。
// meta 表必备（listBooks 对每个 .db 跑 SELECT FROM meta，没这张表的库被静默过滤）。
function makeDb(libDir, name, { chunks = [], nodes = [], edges = [], fts = true, wal = false } = {}) {
  const p = path.join(libDir, name);
  const db = new Database(p);
  if (wal) db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT);`);
  if (fts) db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
  if (nodes.length || edges.length)
    db.exec(`CREATE TABLE nodes(id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, ref TEXT, source TEXT);
      CREATE TABLE edges(src_type TEXT, src TEXT, dst_type TEXT, dst TEXT, kind TEXT, weight REAL, source TEXT, ref TEXT);`);
  db.prepare("INSERT INTO meta(key,value) VALUES('title',?)").run(name.replace(/\.db$/, ""));
  db.prepare("INSERT INTO meta(key,value) VALUES('chunk_count',?)").run(String(chunks.length));
  const ci = db.prepare("INSERT INTO chunks(id,chapter,page,text) VALUES(?,?,?,?)");
  for (const c of chunks) ci.run(c.id, c.chapter ?? null, c.page ?? null, c.text ?? "原文");
  if (fts) db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
  if (nodes.length || edges.length) {
    const ni = db.prepare("INSERT INTO nodes(type,name,ref,source) VALUES(?,?,?,?)");
    for (const n of nodes) ni.run(n.type, n.name, n.ref ? JSON.stringify(n.ref) : null, n.source || "llm");
    const ei = db.prepare("INSERT INTO edges(src_type,src,dst_type,dst,kind,weight,source,ref) VALUES(?,?,?,?,?,?,?,?)");
    for (const e of edges) ei.run(e.src_type || "chunk", String(e.src), e.dst_type || "person", e.dst, e.kind, 1, e.source || "llm", e.ref || "");
  }
  db.close();
  return p;
}

// 真库只读拷贝（破坏性实验全在副本上；原件永不触碰）
const PP_DB = path.join(ROOT, "library", "pride-and-prejudice-en.epub.db");
const MZ_DB = path.join(ROOT, "library", "mengzi-zh.docx.db");
function copyBook(src, tag) {
  const { tmp, lib } = mkTmp(tag);
  const dst = path.join(lib, path.basename(src));
  fs.copyFileSync(src, dst);
  return { tmp, lib, db: dst };
}

// ========== W1 实体链接对抗（P1 + 本轮 F1/F2 修复钉死） ==========
console.log("\n--- W1 实体链接对抗 ---");
{
  // F1 钉死（代码检查确认缺陷①）：build-book 直出库（无 emb 列/无 nodes/无 edges）——
  // 修前 hybridSearch 在 assertEngine 裸抛 "no such column: emb"，未编目工作资料的检索路径整体崩。
  // 修后语义：无向量可错配 → 豁免卫兵，字面腿照常可用（sem 恒 0）。
  const { tmp: t1, lib: l1 } = mkTmp("w1f1");
  const pBuild = makeDb(l1, "build-only.db", { chunks: [
    { id: 1, text: "The carriage stopped at the gate and Elizabeth stepped down." },
    { id: 2, text: "A letter arrived from town in the morning." },
    { id: 3, text: "治理大國要像烹小鮮。" },
  ] });
  let rsF1 = null, errF1 = null;
  try { rsF1 = await hybridSearch(pBuild, "where did the carriage stop", 5, { rerank: false }); }
  catch (e) { errF1 = e.message; }
  ok(Array.isArray(rsF1) && rsF1.length > 0 && rsF1.some(r => r.fts > 0) && rsF1.every(r => r.sem === 0),
    `W1-F1a: build-only 库（无 emb）hybridSearch 不崩且字面腿照常（${errF1 || `命中 ${rsF1?.length} 条`}；修前裸崩 no such column: emb）`,
    errF1 || "");
  // 中文简繁：简体问句 → convS2T → 繁体块 LIKE 命中（无 FTS 依赖的 cjk 腿）
  let rsF1b = null, errF1b = null;
  try { rsF1b = await hybridSearch(pBuild, "治理大国", 5, { rerank: false }); }
  catch (e) { errF1b = e.message; }
  ok(Array.isArray(rsF1b) && rsF1b.some(r => r.fts > 0 && /大國/.test(r.text)),
    `W1-F1b: build-only 库中文路径不崩且繁体块命中（${errF1b || `命中 ${rsF1b?.length} 条`}）`,
    errF1b || "");

  // F1c：routeAndSearch 对全 build-only 目录——0 分书被 routeFloor 挡在门外，不崩
  let rF1 = null, errF1c = null;
  try { rF1 = await routeAndSearch("where did the carriage stop", { libDir: l1 }); }
  catch (e) { errF1c = e.message; }
  ok(rF1 && rF1.routed_books.length === 0 && rF1.results.length === 0 && rF1.considered.length === 1 && rF1.considered[0].best_sim === 0,
    `W1-F1c: routeAndSearch 全 build-only 目录不崩、0 分书不入选（${errF1c || `considered=${JSON.stringify(rF1?.considered)}`}）`,
    errF1c || "");

  // F2 钉死（代码检查确认缺陷②）：无 edges 表的中间态库（embed 中断在 ALTER 与建表之间）——
  // 修前 loadCatalogSignal 的 mentionEdge.prepare 在 try 外，裸崩 SqliteError 穿到 hybridSearch。
  const dbF2b = new Database(pBuild, { readonly: true });
  let hitF2b = null, errF2b = null;
  try { hitF2b = loadCatalogSignal(dbF2b, "where did the carriage stop", null, null); }
  catch (e) { errF2b = e.message; }
  dbF2b.close();
  ok(hitF2b && hitF2b.hit instanceof Map && hitF2b.hit.size === 0,
    `W1-F2b: loadCatalogSignal 对无编目表库静默空（${errF2b || "hit.size=0"}；修前裸崩 no such table: edges）`,
    errF2b || "");

  // F2a：真库拷副本 DROP edges（= 有 emb 有向量、缺编目表的最坏混搭）→ hybridSearch 不崩
  const { tmp: t2, db: ppNoEdges } = copyBook(PP_DB, "w1f2");
  { const d = new Database(ppNoEdges); d.exec("DROP TABLE edges"); d.close(); }
  let rsF2 = null, errF2a = null;
  try { rsF2 = await hybridSearch(ppNoEdges, "what does darcy say about pride", 5, { rerank: false }); }
  catch (e) { errF2a = e.message; }
  ok(Array.isArray(rsF2) && rsF2.length > 0,
    `W1-F2a: 缺 edges 表但 emb 在的库 hybridSearch 不崩（${errF2a || `命中 ${rsF2?.length} 条`}）`, errF2a || "");

  // F2c：最坏组合——缺 edges + 编目模型标记在 + theme_vecs 在 + 带 qv（主题路查 belongs 必抛在 try 内被吞）
  const dF2c = new Database(ppNoEdges, { readonly: true });
  const tvRow = dF2c.prepare("SELECT vec FROM theme_vecs LIMIT 1").get();
  const qvFake = tvRow ? new Float32Array(tvRow.vec.buffer.slice(tvRow.vec.byteOffset, tvRow.vec.byteOffset + tvRow.vec.byteLength)) : new Float32Array(384);
  let hitF2c = null, errF2c = null;
  try { hitF2c = loadCatalogSignal(dF2c, "darcy", qvFake, "e5"); }
  catch (e) { errF2c = e.message; }
  dF2c.close();
  ok(hitF2c && hitF2c.hit instanceof Map,
    `W1-F2c: 缺表库 + 主题向量全路径 loadCatalogSignal 不崩（${errF2c || "hit=" + hitF2c?.hit.size}）`, errF2c || "");
  safeRm(t2);

  // —— 对抗线：正则/畸形 q ——
  const { tmp: t3, lib: l3 } = mkTmp("w1lex");
  const pLex = makeDb(l3, "lex.db", {
    chunks: [{ id: 1, text: "Eliza walked to the parsonage." }],
    nodes: [
      { type: "person", name: "Eliza (Beth)", ref: { match_names: ["Eliza (Beth)", "Eliza"], mention_count: 2 } },
      { type: "person", name: "A.B", ref: { match_names: ["A.B"], mention_count: 3 } },
      { type: "person", name: "Fitz (Will)", ref: { match_names: ["Fitz (Will)"], mention_count: 1 } },
    ],
  });
  const dbLex = new Database(pLex, { readonly: true });
  // 常规命中（\b 词边界）
  ok(linkEntities(dbLex, "hello eliza how are you").some(m => m.name === "Eliza (Beth)"),
    "W1-A1: 常规词边界命中（'eliza' → Eliza (Beth)）");
  // 正则元字符转义：'A.B' 的点不当通配——"axb" 不得命中，字面 "a.b" 命中
  const hitAxb = linkEntities(dbLex, "see axb in chapter");
  const hitAb = linkEntities(dbLex, "see a.b in chapter");
  ok(!hitAxb.some(m => m.name === "A.B") && hitAb.some(m => m.name === "A.B"),
    `W1-A2: match_name 正则元字符已转义（'.' 不当通配：'axb'→${hitAxb.length} 命中、'a.b'→命中）`);
  // 尾随非词字符（"Fitz (Will)" 的 ')' 后 \b 失配）——行为登记：括号结尾的全名不参与匹配
  const hitFitz = linkEntities(dbLex, "what does fitz (will) say");
  obs(!hitFitz.some(m => m.name === "Fitz (Will)"),
    "W1-A3 括号尾失配登记",
    "match_names 以非词字符结尾（'Fitz (Will)' 的 ')'）时 \\b 词边界无位可落 → 全名不命中；真书人名无此形态，单独写法（'Eliza'）照常兜底");
  // 超长 q（24KB）不崩
  let longHit = null, longErr = null;
  try { longHit = linkEntities(dbLex, "darcy ".repeat(4000)); } catch (e) { longErr = e.message; }
  ok(Array.isArray(longHit) && longErr === null, `W1-A4: 超长 q（24KB）不崩（${longErr || "无命中属正常（库内无 darcy）"}）`, longErr || "");
  dbLex.close();

  // 空/畸形输入空手道
  const dbLex2 = new Database(pLex, { readonly: true });
  const emptyHit = linkEntities(dbLex2, "") .length === 0 && linkEntities(dbLex2, "   ").length === 0
    && linkEntities(dbLex2, null).length === 0
    && entityAliasTerms(dbLex2, "").en.length === 0 && entityAliasTerms(dbLex2, "   ").cjk.length === 0
    && entityAliasTerms(dbLex2, null).en.length === 0;
  dbLex2.close();
  ok(emptyHit, "W1-A5: 空串/空白/null q → linkEntities 全空、entityAliasTerms 全空不崩（D01 家族守卫）");

  // 幂等：两次调用逐字节同结果
  const dbLex3 = new Database(pLex, { readonly: true });
  const idem1 = JSON.stringify(entityAliasTerms(dbLex3, "hello eliza"));
  const idem2 = JSON.stringify(entityAliasTerms(dbLex3, "hello eliza"));
  dbLex3.close();
  ok(idem1 === idem2 && idem1.includes("eliza"),
    `W1-A6: entityAliasTerms 确定性幂等（同输入同输出，含注入 ${JSON.parse(idem1).en.join(",")}）`);
  safeRm(t3);

  // —— 剪枝②代价：共享姓氏问句 0 注入（登记）——
  const { tmp: t4, lib: l4 } = mkTmp("w1prune");
  const pPrune = makeDb(l4, "prune.db", {
    chunks: [{ id: 1, text: "Mrs. Bennet spoke to Lydia Bennet." }],
    nodes: [
      { type: "person", name: "Mrs. Bennet", ref: { match_names: ["Mrs. Bennet", "Bennet"], mention_count: 40 } },
      { type: "person", name: "Lydia Bennet", ref: { match_names: ["Lydia Bennet"], mention_count: 30 } },
    ],
  });
  const dbPrune = new Database(pPrune, { readonly: true });
  const termsPrune = entityAliasTerms(dbPrune, "what does mrs. bennet say");
  const hitPrune = linkEntities(dbPrune, "what does mrs. bennet say");
  dbPrune.close();
  obs(termsPrune.en.length === 0 && hitPrune.some(m => m.name === "Mrs. Bennet"),
    "W1-B1 剪枝②代价登记",
    `点名家族姓氏人物（命中 Mrs. Bennet）时 'bennet' 因 ⊂ 'Lydia Bennet' 被跨实体遮蔽，注入 0 词——检索侧仍由 mention 边信号兜底（linkEntities 命中 ${hitPrune.map(m => m.name).join("/")}）`);
  safeRm(t4);

  // —— 混语二选一：P1 注入的英文别名让字面腿走英文 MATCH，中文 cjk 路被整体跳过（登记）——
  // 场景：中文译名（aliases_zh）链接到英文人物，注入英文 match_names → ftsQ 非空且命中 → cjk 腿不跑
  const { tmp: t5, lib: l5 } = mkTmp("w1mix");
  const pMix = makeDb(l5, "mix.db", {
    chunks: [
      { id: 1, text: "齊宣王的問政記錄在書中十分珍貴。" },          // 中文块（繁体，模拟真书）
      { id: 2, text: "Hui talked about governing in the hall." },   // 英文块（人物写作 Hui）
    ],
    nodes: [
      { type: "person", name: "Hui", ref: { match_names: ["Hui"], aliases_zh: ["齐宣王"], mention_count: 5 } },
    ],
  });
  const savedEnv = process.env.BSP_ENTITY_LINK;
  process.env.BSP_ENTITY_LINK = "0";
  const rsMixOff = await hybridSearch(pMix, "齐宣王是誰", 5, { rerank: false });
  delete process.env.BSP_ENTITY_LINK;
  const rsMixOn = await hybridSearch(pMix, "齐宣王是誰", 5, { rerank: false });
  if (savedEnv !== undefined) process.env.BSP_ENTITY_LINK = savedEnv; else delete process.env.BSP_ENTITY_LINK;
  const hasZh = (rs) => rs.some(r => /齊宣/.test(r.text) && r.fts > 0);
  ok(hasZh(rsMixOff) && !hasZh(rsMixOn),
    `W1-C1: 开关对照——旧行为中文块有字面分（${rsMixOff.length} 条），译名链接注入英文别名后 cjk 路被跳过（${rsMixOn.length} 条）`);
  obs(true,
    "W1-C2 混语二选一登记",
    "字面腿结构为 en-MATCH 优先、命中即不再跑 cjk-LIKE ——译名链接到英文人物时中文原文块失去字面分（本轮不修：改二选一=改打分结构，触检索红线）");

  // —— 单字 CJK match_name 亚串误链接（登记）——
  const { tmp: t6, lib: l6 } = mkTmp("w1one");
  const pOne = makeDb(l6, "one.db", {
    chunks: [{ id: 1, text: "达人在广场上发传单。" }],
    nodes: [{ type: "person", name: "达人", ref: { match_names: ["达"], mention_count: 2 } }],
  });
  const dbOne = new Database(pOne, { readonly: true });
  const hitOne = linkEntities(dbOne, "达尔文是谁");
  const termsOne = entityAliasTerms(dbOne, "达尔文是谁");
  dbOne.close();
  obs(hitOne.some(m => m.name === "达人") && termsOne.cjk.length === 0,
    "W1-B2 单字亚串登记",
    "'达尔文是谁' 经单字 match_name '达' 误链接『达人』（validateResult 放行单字；注入侧天然无泄漏——单字无 gram）；编目规范层面禁用单字可解");
  safeRm(t6);

  // —— 简繁方向盲区：问题繁体 → 书内简体（S2T 只做简→繁，无反向桥）（登记）——
  const { tmp: t7, lib: l7 } = mkTmp("w1dir");
  const pDir = makeDb(l7, "dir.db", {
    chunks: [{ id: 1, text: "齐宣王问政。" }],
    nodes: [{ type: "person", name: "齐宣王", ref: { match_names: ["齐宣王"], mention_count: 3 } }],
  });
  const dbDir = new Database(pDir, { readonly: true });
  const hitDirection = linkEntities(dbDir, "齊宣王是誰");
  dbDir.close();
  obs(hitDirection.length === 0,
    "W1-B3 繁体问句×简体书登记",
    "S2T_MAP 只有简→繁单向：问题繁体「齊宣王」对书内简体 match_names 两形都不中；真库中文书均为繁体（孟子/道德经），影响面=简体自建书+繁体提问组合");
  safeRm(t7);

  // —— 真库 sanity：命中 factor = IDF 衰减公式复算 ——
  const ppW1 = new Database(PP_DB, { readonly: true });
  const hitReal = linkEntities(ppW1, "what does darcy say about pride");
  const mDarcy = hitReal.find(x => /Darcy/.test(x.name));
  let factorOk = false;
  if (mDarcy) {
    const ref = JSON.parse(ppW1.prepare("SELECT ref FROM nodes WHERE type='person' AND name=?").get(mDarcy.name).ref || "{}");
    factorOk = Math.abs(mDarcy.factor - Math.min(1, 30 / Math.max(1, ref.mention_count || 1))) < 1e-12;
  }
  ppW1.close();
  ok(mDarcy && factorOk,
    `W1-D1: 真库命中 + factor=min(1,30/mention_count) 公式复算一致（${mDarcy ? `${mDarcy.name} factor=${mDarcy.factor.toFixed(4)}` : "无命中"}）`);
  safeRm(t1);
  safeRm(t5);
  safeRm(t7);
}

// ========== W2 expand 对抗 ==========
console.log("\n--- W2 expand 对抗 ---");
{
  const { tmp, lib } = mkTmp("w2");
  // 主图：甲/乙 同出场 5（tie）+ 丙 7 + 丁 0（无 mention 边）+ 戊（rule 边）+ 幽灵（悬空）
  const nodes2 = [
    { type: "person", name: "中心", ref: { match_names: ["中心"], mention_count: 1 }, source: "llm" },
    { type: "person", name: "甲", ref: { match_names: ["甲"], mention_count: 5 }, source: "llm" },
    { type: "person", name: "乙", ref: { match_names: ["乙"], mention_count: 5 }, source: "llm" },
    { type: "person", name: "丙", ref: { match_names: ["丙"], mention_count: 7 }, source: "llm" },
    { type: "person", name: "丁", ref: { match_names: ["丁"], mention_count: 0 }, source: "llm" },
    { type: "person", name: "戊", ref: { match_names: ["戊"], mention_count: 2 }, source: "llm" },
  ];
  const edges2 = [
    { src: "中心", src_type: "person", dst: "甲", kind: "relation", ref: "朋友" },
    { src: "中心", src_type: "person", dst: "乙", kind: "relation", ref: "朋友" },
    { src: "中心", src_type: "person", dst: "丙", kind: "relation", ref: "朋友" },
    { src: "中心", src_type: "person", dst: "丁", kind: "relation", ref: "点头之交" },
    { src: "中心", src_type: "person", dst: "戊", kind: "relation", ref: "rule 层边", source: "rule" },
    { src: "中心", src_type: "person", dst: "幽灵", kind: "relation", ref: "悬空" },
  ];
  for (let i = 1; i <= 6; i++) edges2.push({ src: i, dst: "乙", kind: "mention" });
  const pMain = makeDb(lib, "main.db", { chunks: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, text: `块${i + 1}` })), nodes: nodes2, edges: edges2 });

  // tie 排序确定性：丙7 > 甲5=乙5（甲边先插 → 稳定序），rule 边/悬空边/无 mention 邻居全对
  const r1 = expandNeighborhood(pMain, "中心");
  const r2 = expandNeighborhood(pMain, "中心");
  const names2 = r1.neighbors.map(n => n.name);
  ok(JSON.stringify(names2) === JSON.stringify(["丙", "甲", "乙", "丁"]) && JSON.stringify(r1) === JSON.stringify(r2),
    `W2-1: tie 按边插入序稳定 + rule 层边（戊）/悬空边（幽灵）剔除（${names2.join(",")}）`);
  const ding = r1.neighbors.find(n => n.name === "丁");
  ok(ding.mention_count === 0 && Array.isArray(ding.representative_chunks) && ding.representative_chunks.length === 0,
    "W2-2: 无 mention 边邻居 → count 0 + 代表块空数组（排尾不崩）");

  // perNeighbor 类型强转矩阵（zod 层外直调的兜底；0/NaN 落默认 3、负→1、超→5）
  // 注意扩「中心」后取「乙」的代表块（乙有 6 条 mention 边；中心的邻居才是乙）
  const perLen = (v) => expandNeighborhood(pMain, "中心", { perNeighbor: v }).neighbors.find(n => n.name === "乙").representative_chunks.length;
  ok(perLen("2") === 2 && perLen(true) === 1 && perLen(null) === 3 && perLen("abc") === 3 && perLen(-1) === 1 && perLen(99) === 5,
    `W2-3: perNeighbor 类型强转矩阵（"2"→${perLen("2")} / true→${perLen(true)} / null→${perLen(null)} / "abc"→${perLen("abc")} / -1→${perLen(-1)} / 99→${perLen(99)}）`);

  // 截断边界：恰 20 不标截断，21 才标
  const wide = (n) => {
    const ws = [{ type: "person", name: "广", ref: { match_names: ["广"], mention_count: 1 }, source: "llm" }];
    const es = [];
    for (let i = 1; i <= n; i++) {
      ws.push({ type: "person", name: `邻${String(i).padStart(2, "0")}`, ref: { match_names: [`邻${i}`], mention_count: i }, source: "llm" });
      es.push({ src: "广", src_type: "person", dst: `邻${String(i).padStart(2, "0")}`, kind: "relation", ref: `关系${i}` });
    }
    return makeDb(lib, `wide${n}.db`, { chunks: [{ id: 1, text: "占位" }], nodes: ws, edges: es });
  };
  const rW20 = expandNeighborhood(wide(20), "广");
  const rW21 = expandNeighborhood(wide(21), "广");
  ok(rW20.neighbors_total === 20 && rW20.truncated === false && rW20.note === undefined && rW20.neighbors.length === 20,
    "W2-4a: 恰 20 邻居 → 无截断标记（truncated=false、无 note）");
  ok(rW21.neighbors_total === 21 && rW21.truncated === true && rW21.neighbors.length === 20 && /共 21 个/.test(rW21.note || ""),
    `W2-4b: 21 邻居 → 截断（${rW21.note}）`);

  // 无 nodes 表的库 → no-nodes-table（catalogGuard 第一档）
  const pGone = path.join(lib, "gone.db");
  { const d = new Database(pGone); d.exec("CREATE TABLE meta(key TEXT, value TEXT); CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT);"); d.close(); }
  ok(expandNeighborhood(pGone, "谁").reason === "no-nodes-table",
    "W2-5: 无 nodes/edges 表 → reason:'no-nodes-table'（与坏库/旧 schema 三态可区分）");

  // 畸形 name：超长（8KB）/ null → person-not-found 不崩
  const longName = expandNeighborhood(pMain, "x".repeat(8192));
  const nullName = expandNeighborhood(pMain, null);
  ok(longName.error === "person-not-found" && nullName.error === "person-not-found",
    "W2-6: 超长 name（8KB）/null → person-not-found（matchNode 空名短路 + fuzzy 不误中）");
  safeRm(tmp);
}

// ========== W3 lookup 对抗 ==========
console.log("\n--- W3 lookup 对抗 ---");
{
  const { tmp, lib } = mkTmp("w3");
  const chunksL = [
    { id: 1, chapter: "E1001 连接超时", page: 3, text: "E1001：与服务器建立连接超时。" },
    { id: 2, chapter: "E1001 连接超时", page: 3, text: "处置：确认代理配置。" },
    { id: 5, chapter: "100% 可用率", page: 5, text: "% 是字面量。" },
    { id: 6, chapter: "C++ 指南", page: 6, text: "加号是名字的一部分。" },
    { id: 7, chapter: " 3.2 安装 ", page: 7, text: "两侧空格的章节名。" },
    { id: 8, chapter: "Ｅ１００１ 全角", page: 8, text: "全角错误码。" },
    { id: 9, chapter: "123 附录", page: 9, text: "数字章节。" },
    { id: 10, chapter: "概述", page: 10, text: "同名章第一处。" },
    { id: 11, chapter: "概述", page: 11, text: "同名章第二处。" },
    { id: 20, chapter: "概述", page: 20, text: "同名章第三处。" },
    { id: 21, chapter: "概述", page: 21, text: "同名章第四处。" },
  ];
  for (let i = 30; i < 75; i++) chunksL.push({ id: i, chapter: "BULK 大章", text: `批量块${i}` });
  const pL = makeDb(lib, "wk.db", { chunks: chunksL });

  // SQL 注入式 key：参数化查询必须挡住（表还在、正常查询照常）
  const injKey = "x'; DROP TABLE chunks;--";
  const rInj = lookupEntry(pL, injKey);
  const dbChk = new Database(pL, { readonly: true });
  const cnt = dbChk.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  dbChk.close();
  ok(rInj.error === "not-found" && cnt > 40 && rInj.available.length > 0,
    `W3-1: 注入式 key 无效化（表完好 ${cnt} 块、返回 not-found + 候选清单——参数化查询）`);

  // LIKE 元字符当字面量：'100%' 前缀命中 '100% 可用率'（lookup 不用 LIKE，% 无通配语义）
  const rPct = lookupEntry(pL, "100%");
  ok(rPct.matched_chapter === "100% 可用率" && rPct.match_level === "prefix",
    `W3-2: '%' 是字面量（prefix 命中 ${rPct.matched_chapter}）`);

  // 正则元字符章节名精确命中（无正则路径）
  const rCpp = lookupEntry(pL, "C++ 指南");
  ok(rCpp.matched_chapter === "C++ 指南" && rCpp.match_level === "exact",
    "W3-3: 'C++ 指南' 精确命中（章节名含正则元字符不参与任何正则）");

  // maxBlocks 类型矩阵（zod 1..40 外的直调兜底：负→1、NaN→默认20、超→40、字符串数字→可用）
  const bulkLen = (v) => lookupEntry(pL, "BULK 大章", { maxBlocks: v }).blocks.length;
  ok(bulkLen(-5) === 1 && bulkLen("abc") === 20 && bulkLen(40.9) === 40 && bulkLen("7") === 7,
    `W3-4: maxBlocks 矩阵（-5→${bulkLen(-5)} / "abc"→${bulkLen("abc")} / 40.9→${bulkLen(40.9)} / "7"→${bulkLen("7")}）`);

  // 同名章节按块合并呈现（GROUP BY chapter）——probe 发现的行为登记
  const rSame = lookupEntry(pL, "概述");
  obs(rSame.matched_chapter === "概述" && rSame.total === 4 && rSame.blocks.length === 4 && rSame.note === undefined,
    "W3-5 同名章节合并登记",
    `文档中 4 处「概述」被按块合并（total=${rSame.total}、按 id 序混合）——同名不同位置的章节不可区分；真书每章标题唯一，工作资料偶见`);
  // 空格章节名：key 已 trim、章节名未 trim → 精确级失守降级 includes（登记）
  const rSpace = lookupEntry(pL, "3.2 安装");
  obs(rSpace.matched_chapter === " 3.2 安装 " && rSpace.match_level === "includes",
    "W3-6 章节名空格登记",
    `章节名两侧带空格时精确/前缀级都失守、靠 includes 兜底命中（match_level=includes；原样保留 ' 3.2 安装 '）——PDF/Word 提取的章节名常带尾空格`);
  // 全角错误码不归一（登记）：半角 key 只中半角章、全角 key 只中全角章——无 NFKC 归一
  const rFullHalf = lookupEntry(pL, "E1001");
  const rFullWide = lookupEntry(pL, "Ｅ１００１");
  obs(rFullHalf.matched_chapter === "E1001 连接超时" && rFullWide.matched_chapter === "Ｅ１００１ 全角",
    "W3-7 全角不归一登记",
    `半角 key 'E1001' 不命中全角章节 'Ｅ１００１ 全角'（无 NFKC 归一）；错误码场景源文档全角混排会漏——各自自洽（半角中半角 / 全角中全角）`);

  // 超长 key（8KB）/null key 不崩
  const rLong = lookupEntry(pL, "x".repeat(8192));
  const rNull = lookupEntry(pL, null);
  const rNum = lookupEntry(pL, 123);
  ok(rLong.error === "not-found" && rNull.error === "not-found" && rNum.matched_chapter === "123 附录",
    "W3-8: 超长 key（8KB）/null → not-found；数字 key 123 → 前缀命中（String() 容忍）");

  // AVAILABLE_CAP=30：31 章时候选清单封顶而总数如实
  const pLot = makeDb(lib, "lot.db", { chunks: Array.from({ length: 31 }, (_, i) => ({ id: i + 1, chapter: `章${String(i + 1).padStart(2, "0")}`, text: `章${i + 1}正文` })) });
  const rLot = lookupEntry(pLot, "不存在的章");
  ok(rLot.error === "not-found" && rLot.available.length === 30 && rLot.available_total === 31,
    `W3-9: 候选清单封顶 30 而总数如实（${rLot.available.length}/${rLot.available_total}）`);

  // 空 chunks 表 → no-chapters（有表无块）
  const pEmpty = makeDb(lib, "empty.db", {});
  ok(lookupEntry(pEmpty, "任意").error === "no-chapters",
    "W3-10: 空 chunks 表 → no-chapters（与 not-found 可区分）");

  // text 为 NULL 的块 → 空串兜底不崩
  const pNullText = path.join(lib, "nulltext.db");
  {
    const d = new Database(pNullText);
    d.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT);");
    d.prepare("INSERT INTO chunks(id, chapter, text) VALUES(1, '甲章', NULL)").run();
    d.close();
  }
  const rNullText = lookupEntry(pNullText, "甲章");
  ok(rNullText.blocks.length === 1 && rNullText.blocks[0].text === "",
    "W3-11: text 为 NULL 的块 → 空串兜底（旧库半成品数据不崩）");
  safeRm(tmp);
}

// ========== W4 缓存对抗 ==========
console.log("\n--- W4 清单缓存对抗 ---");
{
  // 多 libDir 分桶：两目录独立 miss/hit，改动互不触发
  const { tmp: tA, lib: libA } = mkTmp("w4a");
  const { tmp: tB, lib: libB } = mkTmp("w4b");
  makeDb(libA, "a1.db", { chunks: [{ id: 1, text: "甲" }] });
  makeDb(libA, "a2.db", { chunks: [{ id: 1, text: "乙" }] });
  makeDb(libB, "b1.db", { chunks: [{ id: 1, text: "丙" }] });
  // 杂音文件：-wal/-shm/.txt/.tmp 及坏 .db——都不该进清单
  for (const f of ["x.db-wal", "y.db-shm", "notes.txt", "z.tmp"]) fs.writeFileSync(path.join(libA, f), "noise");
  fs.writeFileSync(path.join(libA, "bad.db"), "definitely not a sqlite database");
  clearListCache();
  const la = listBooks(libA);
  const lb = listBooks(libB);
  const s1 = listCacheStats();
  ok(la.length === 2 && lb.length === 1 && s1.misses === 2 && s1.dirs === 2,
    `W4-1a: 分桶首查（A=${la.length} 本 / B=${lb.length} 本，misses=${s1.misses} dirs=${s1.dirs}）`);
  ok(!la.some(b => /bad|x\.db-y|notes|z\.tmp/.test(b.id)),
    `W4-1b: 杂音文件全部排除（${la.map(b => b.id).join(",")}——*.db-wal/shm 后缀不匹配、坏 .db 静默过滤）`);
  const touchT = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(libA, "a1.db"), touchT, touchT);
  listBooks(libA);                       // A 重扫（miss 3）
  const s2before = listCacheStats();
  listBooks(libB);                       // B 不受 A 影响 → hit
  const s2 = listCacheStats();
  ok(s2.misses === 3 && s2.hits >= 1 && listBooks(libB).length === 1,
    `W4-2: 分桶互不触发（A touch → miss=${s2.misses}；B 查询 hit=${s2.hits}；${s2before.hits}）`);
  // 删除 .db → 文件名集合变化重扫
  fs.unlinkSync(path.join(libA, "a2.db"));
  const la3 = listBooks(libA);
  ok(la3.length === 1 && la3[0].id === "a1" && listCacheStats().misses === 4,
    "W4-3: 删除 .db → 重扫（文件名集合变化，2→1 本）");
  // findBook 走同一路径
  ok(findBook("a1", libA)?.id === "a1" && findBook("不存在zz", libA) === null,
    "W4-4: findBook 与缓存路径一致（命中/未命中语义不变）");
  // 目录不存在 → 空数组 + 不触缓存
  const beforeNoDir = listCacheStats();
  const rNoDir = listBooks(path.join(tA, "nope"));
  const afterNoDir = listCacheStats();
  ok(rNoDir.length === 0 && afterNoDir.misses === beforeNoDir.misses && afterNoDir.hits === beforeNoDir.hits,
    "W4-5: 目录不存在 → [] 且不触缓存（existsSync 早退）");
  // clearListCache 归零
  clearListCache();
  const s0 = listCacheStats();
  ok(s0.hits === 0 && s0.misses === 0 && s0.dirs === 0, "W4-6: clearListCache 计数与分桶全清");
  safeRm(tA); safeRm(tB);

  // WAL 盲区（探针实证）：写连接存续且未 checkpoint 时主库 mtime/size 不变 → 指纹不失效 → 缓存短暂僵尸；
  // 写连接 close（checkpoint+删 -wal）后主库 mtime 变 → 自动重扫自愈。登记 + 自愈硬断言。
  const { tmp: tW, lib: libW } = mkTmp("w4wal");
  const pWal = path.join(libW, "wal.db");
  const wdb = new Database(pWal);
  wdb.pragma("journal_mode = WAL");
  wdb.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE chunks(id INTEGER PRIMARY KEY, text TEXT); CREATE TABLE nodes(id INTEGER PRIMARY KEY, type TEXT, name TEXT, ref TEXT, source TEXT); CREATE TABLE edges(src_type TEXT, src TEXT, dst_type TEXT, dst TEXT, kind TEXT, weight REAL, source TEXT, ref TEXT);");
  wdb.prepare("INSERT INTO meta(key,value) VALUES('title','甲')").run();
  wdb.prepare("INSERT INTO meta(key,value) VALUES('chunk_count','1')").run();
  wdb.prepare("INSERT INTO chunks(id,text) VALUES(1,'x')").run();
  clearListCache();
  const lw1 = listBooks(libW);
  wdb.prepare("UPDATE meta SET value='乙' WHERE key='title'").run();
  const lw2 = listBooks(libW);
  const sw2 = listCacheStats();
  obs(lw1[0]?.title === "甲" && lw2[0]?.title === "甲" && sw2.hits === 1 && fs.existsSync(pWal + "-wal"),
    "W4-7 WAL 写入窗口指纹盲区登记",
    `写连接存续（-wal 有数据未 checkpoint）时主库 mtime/size 不变 → 缓存返回旧值（hit=${sw2.hits}）；编目/嵌入进程运行中的并发读取最多看到旧 meta，窗口随连接关闭≤自愈`);
  wdb.close();  // checkpoint 写回主库 + 删 -wal（实证：close 即删；随后的只读扫描会重建空 -wal，属 SQLite 行为）
  const walGoneAfterClose = !fs.existsSync(pWal + "-wal");
  const lw3 = listBooks(libW);
  ok(lw3[0]?.title === "乙" && listCacheStats().misses === 2 && walGoneAfterClose,
    `W4-8: WAL 写连接关闭后自愈（close 即删 -wal=${walGoneAfterClose}、主库 mtime 变 → 重扫拿到新值 ${lw3[0]?.title}）`);
  safeRm(tW);
}

// ========== W5 maxBooks + 链路对抗 ==========
console.log("\n--- W5 maxBooks 链路 ---");
{
  // clampMaxBooks 矩阵（0/NaN/null → 默认 2、负 → 1、超 → 8、字符串数字可用）
  ok(clampMaxBooks(0) === 2 && clampMaxBooks(undefined) === 2 && clampMaxBooks(null) === 2 && clampMaxBooks("abc") === 2
    && clampMaxBooks(-5) === 1 && clampMaxBooks(99) === 8 && clampMaxBooks(5.9) === 5 && clampMaxBooks("7") === 7 && clampMaxBooks(true) === 1,
    `W5-1: clampMaxBooks 矩阵（0→2/null→2/-5→1/99→8/5.9→5/"7"→7/true→1）`);
  // zod schema 与处理器夹取双层一致
  const zodOk = MAXBOOKS_SCHEMA.safeParse(8).success && MAXBOOKS_SCHEMA.safeParse(undefined).success
    && !MAXBOOKS_SCHEMA.safeParse(9).success && !MAXBOOKS_SCHEMA.safeParse(0).success && !MAXBOOKS_SCHEMA.safeParse(2.5).success;
  ok(zodOk, "W5-2: MAXBOOKS_SCHEMA zod 层 [1..8] 整数（8✓/undefined✓/9✗/0✗/2.5✗）");
  // 三方 clamp 家族语义一致：0→默认、负→下限 1、超→上限
  ok(clampMaxBooks(0) === 2 && clampMaxBlocks(0) === 20 && clampMaxBooks(-1) === 1 && clampMaxBlocks(-1) === 1 && MAX_BLOCKS === 40,
    "W5-3: clamp 家族一致性（maxBooks 默认2/上限8、maxBlocks 默认20/上限40、负→1 全同款语义）");
  // lookup 上限与 zod 1..40 对齐（clampMaxBlocks 夹取 = MAX_BLOCKS）
  ok(clampMaxBlocks(41) === 40 && clampMaxBlocks(MAX_BLOCKS + 1) === MAX_BLOCKS && clampMaxBlocks("39") === 39,
    "W5-4: clampMaxBlocks 上夹=MAX_BLOCKS=40（与 MCP schema 1..40 对齐）");

  // routeAndSearch 直调 maxBooks 的行为（lib 层不夹取——双层防呆守在工具层；登记 + 上界硬断言）
  const { tmp: tR, lib: libR } = mkTmp("w5r");
  fs.copyFileSync(PP_DB, path.join(libR, path.basename(PP_DB)));
  fs.copyFileSync(MZ_DB, path.join(libR, path.basename(MZ_DB)));
  const qR = "what does darcy say about pride";
  const r0 = await routeAndSearch(qR, { maxBooks: 0, libDir: libR });
  obs(r0.routed_books.length === 0 && r0.results.length === 0 && r0.considered.length === 2,
    "W5-5 直调 maxBooks=0 登记",
    `lib 层切片直通（slice(0,0)）→ 静默空结果不报错；工具层 clampMaxBooks 把 0 归一为 2，MCP 路径不暴露此口子（considered ${r0.considered.length} 本有分但 routed=0）`);
  const r1 = await routeAndSearch(qR, { maxBooks: 1, libDir: libR });
  const r8 = await routeAndSearch(qR, { maxBooks: 8, libDir: libR });
  ok(r1.routed_books.length <= 1 && r8.routed_books.length <= 2 && r8.results.every(x => x.book && x.bookId),
    `W5-6: routeAndSearch 上界契约（maxBooks=1 → routed≤1（${r1.routed_books.length}）；maxBooks=8 → routed≤书数（${r8.routed_books.length}）；结果带 book/bookId 直通字段）`);
  safeRm(tR);
}

// ========== W6 D1 简繁双形（B2 真实工作资料 E2E 结晶的修复钉死） ==========
// D1：cjk 腿把查询简转繁（为繁体书设计），对简体文档（真实工作资料）转出的繁体 gram
// 查不到 → 字面腿整体哑火（B2 实证：皮润作业「低压电器怎么分类」0 条）。修复=简繁双形
// （questionKeywords + entityAliasTerms 两处，只加词不改分：新增原形 gram 必含简形差体字，
// 对纯繁体书 df=0 被 keep 过滤天然丢弃——eval-gate 两道门守红线）。
console.log("\n--- W6 D1 简繁双形 ---");
{
  // 单元：简体问题双形；纯繁体问题零增量
  const kZh = questionKeywords("低压电器");
  ok(kZh.cjk.includes("低压") && kZh.cjk.includes("低壓"),
    `W6-1: 简体问题双形 grams（${kZh.cjk.join(" ")}）`);
  const kT = questionKeywords("齊宣王");
  ok(kT.cjk.length === 2 && kT.cjk[0] === "齊宣" && kT.cjk[1] === "宣王",
    `W6-2: 纯繁体问题零增量（${kT.cjk.join(" ")}——t===raw 不补原形、无重复）`);

  // 集成：简体库 × 简体问题 → 字面腿命中（修复前转繁形 LIKE 全落空 → 0 条）
  const { tmp, lib } = mkTmp("w6d1");
  const pS = makeDb(lib, "simp.db", { chunks: [
    { id: 1, text: "低压电器的分类：按用途分为低压配电电器和低压控制电器。" },
    { id: 2, text: "熔断器用于短路保护。" },
    { id: 3, text: "The circuit breaker is also a protective device." },
  ] });
  const rsS = await hybridSearch(pS, "低压电器是怎么分类的", 3, { rerank: false });
  ok(rsS.some(r => r.fts > 0 && /低压电器的分类/.test(r.text)),
    `W6-3: 简体库×简体问题字面腿命中（修复前 0 条 → 命中 ${rsS.length} 条）`);

  // entityAliasTerms 简体 match_names：原形在前（简体书靠原形命中；cap 截断时书内形不被丢）
  const pA = makeDb(lib, "simp2.db", {
    chunks: [{ id: 1, text: "低压断路器的选择。" }],
    nodes: [{ type: "person", name: "断路器专家", ref: { match_names: ["低压断路器"], mention_count: 2 } }],
  });
  const dbA = new Database(pA, { readonly: true });
  const termsA = entityAliasTerms(dbA, "低压断路器怎么选");
  dbA.close();
  ok(termsA.cjk.includes("低压") && termsA.cjk.indexOf("低压") < termsA.cjk.indexOf("低壓"),
    `W6-4: 别名注入原形在前（${termsA.cjk.join(" ")}）`);

  // 防回归：繁体书场景不受影响——简体问题×繁体库仍由转繁形命中
  const pT = makeDb(lib, "trad.db", { chunks: [{ id: 1, text: "低壓電器的分類：按用途分為配電與控制。" }] });
  const rsT = await hybridSearch(pT, "低压电器怎么分类", 3, { rerank: false });
  ok(rsT.some(r => r.fts > 0 && /低壓電器/.test(r.text)),
    `W6-5: 繁体库不回归（转繁形照常命中——双形的另一半）`);
  safeRm(tmp);
}

console.log();
console.log(`=== graphrag-fuzz(演进轮 P1/P2/P4/P5 + F1/F2/D1): ${pass} pass / ${fail} fail / ${observe} observe ===`);
process.exit(fail > 0 ? 1 : 0);
