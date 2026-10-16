// 编目功能验收：迁移 / 完整性 / 防幻觉 / mention / theme_vecs / 检索信号 / 保真 / 回滚
// 用法: node test/catalog-test.mjs   （回滚演练在系统临时目录副本上进行，真库只读不碰）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { validateResult, loadCatalogSignal, rollbackCatalog, buildPromptText, getPersonDetail, getThemeDetail, expandNeighborhood } from "../src/lib/catalog.mjs";
import { generateSkillScaffold } from "../src/lib/catalog-skill.mjs";

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

// 任务书提前加载（belongs 边数由它派生——聚类覆盖块数，重建后动态跟随）
const taskPath = path.join(import.meta.dirname, "..", "catalog-tasks", "pride-and-prejudice-en.epub.json");
const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));

// 2) 编目完整性：主题/人物/关系/边数量与 meta 溯源
const themes = db.prepare("SELECT COUNT(*) n FROM nodes WHERE type='theme' AND source='llm'").get().n;
const persons = db.prepare("SELECT COUNT(*) n FROM nodes WHERE type='person' AND source='llm'").get().n;
const relations = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='relation' AND source='llm'").get().n;
const belongs = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='belongs' AND source='llm'").get().n;
const mentions = db.prepare("SELECT COUNT(*) n FROM edges WHERE kind='mention' AND source='llm'").get().n;
const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r => [r.key, r.value]));
// belongs 边数 == 任务书聚类覆盖块数（#58 重建：旧硬编码 1968 随语义合并作废，改动态派生）
const covered = task.clusters.reduce((s, c) => s + c.size, 0);
assert(themes === 12 && persons === 25 && relations === 26 && belongs === covered && mentions > 2500,
  `编目完整性: 主题${themes} 人物${persons} 关系${relations} belongs边${belongs}(=聚类覆盖${covered}) mention边${mentions}`);
assert(meta.catalog_model === "e5" && meta.catalog_themes === "12" && !!meta.catalog_at,
  `溯源 meta: catalog_model=${meta.catalog_model} catalog_themes=${meta.catalog_themes} catalog_at=${meta.catalog_at}`);

// 3) 防幻觉负例：假人物 match_names 必须被拒（整批拒绝）
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

// 3c) 一键提示词（buildPromptText）：instructions 原文透传 + cluster 全覆盖 + 操作说明
const promptText = buildPromptText(task);
assert(promptText.includes(task.instructions), "提示词: instructions 原文透传（唯一真源，防两端规则漂移）");
assert(task.clusters.every(c => promptText.includes(c.id)), `提示词: 覆盖全部 ${task.clusters.length} 个 cluster id`);
assert(promptText.includes("catalog-results/pride-and-prejudice-en.epub.json") && promptText.includes("导入编目结果"),
  "提示词: 末尾带操作说明（结果存哪 + 回来点哪个按钮）");

// 4) mention 边抽查：含 "Caroline Bingley." 信件签名的块必同时挂 Caroline+Charles 两人 mention 边
// （#58 重建：旧固定块 243 在语义合并后块边界变化，改按签名文本动态定位同语义块）
const sigChunk = db.prepare("SELECT id FROM chunks WHERE text LIKE '%Caroline Bingley%' ORDER BY id LIMIT 1").get();
const mSig = db.prepare("SELECT dst FROM edges WHERE src_type='chunk' AND src=? AND kind='mention' AND source='llm'")
  .all(String(sigChunk.id)).map(r => r.dst);
assert(mSig.includes("Caroline Bingley") && mSig.includes("Charles Bingley"),
  `mention 抽查: 签名块${sigChunk.id} → [${mSig.join(", ")}]`);

// 5) theme_vecs：12 行、每行 384 维 float32
const tvs = db.prepare("SELECT name, vec FROM theme_vecs").all();
assert(tvs.length === 12 && tvs.every(t => t.vec.byteLength === 384 * 4), `theme_vecs: ${tvs.length} 行 × 384 维`);

// 6) 检索信号单元测试（人物路+关系扩散，无需向量）：
//    问题点名 Jane+Bingley → 直配 mention 命中；沿关系边应扩散到 Caroline（拆散关系）
const sig = loadCatalogSignal(db, "who tries to separate jane and bingley", null, null);
assert(sig.hit.size > 300, `信号命中块数 ${sig.hit.size}（Jane+Bingley 的 mention 并集）`);
// （#58 重建：旧固定答案块 856 所在段被语义合并切到两个块——Jane 与 Bingley 分家各居一块，
// 单块再拿不到两人直配。改按「同时直配 Jane+Bingley 的块」动态取最低 id，验证同一语义：
// 直配两人求和 ≈0.24、无关系扩散）
const directChunk = db.prepare(`
  SELECT a.src FROM edges a JOIN edges b ON a.src = b.src
  WHERE a.src_type='chunk' AND b.src_type='chunk' AND a.kind='mention' AND b.kind='mention'
    AND a.source='llm' AND b.source='llm' AND a.dst='Jane Bennet' AND b.dst='Charles Bingley'
  ORDER BY CAST(a.src AS INTEGER) LIMIT 1`).get();
const wDirect = sig.hit.get(+directChunk.src)?.w || 0;
assert(wDirect >= 0.2 && wDirect <= 0.3,
  `答案块${directChunk.src} 信号 w=${wDirect.toFixed(3)}（直配 Jane+Bingley 求和 0.24，扩散默认关闭）`);
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

// 7b) 骨架自动生成（技能×编目融合 P-B）：章节表/主题/人物全从库里查出——查出来的是真值，手写的才吹牛
const realChapters = db.prepare("SELECT COUNT(*) n FROM chunks WHERE chapter IS NOT NULL AND chapter != '' GROUP BY chapter").all().length;
const scaf = generateSkillScaffold("pride");
assert(scaf.cataloged === true && scaf.chunks_total === +meta.chunk_count && scaf.chapters_total === realChapters,
  `骨架: ${scaf.chapters_total} 章 / ${scaf.chunks_total} 块 == 库里实际值（真值，不靠手写）`);
const cat = JSON.parse(scaf.files.find(f => f.path === "catalog.json").content);
assert(cat.themes.length === 12 && cat.persons.length === 25 && cat.relations.length === 26,
  `骨架 catalog.json: ${cat.themes.length} 主题 / ${cat.persons.length} 人物 / ${cat.relations.length} 关系（与库一致）`);
assert(cat.chapters.length === realChapters && cat.chapters.every(c => c.chunks > 0),
  `骨架: 章节表 ${cat.chapters.length} 行全从 chunks 查出（每章带真实块数）`);
assert(cat.chapters.every(c => /^ch\d{2}-[a-z0-9-]+\.md$/.test(c.suggested_file)), "骨架: 建议文件名合规（chNN-slug.md）");
const bigPerson = cat.persons.find(p => p.mention_count > 50);
assert(!!bigPerson && bigPerson.chunk_ids.length === 50,
  `骨架: 人物 chunk 锚点封顶 50（${bigPerson?.name} 出场 ${bigPerson?.mention_count} 块 → 只存 ${bigPerson?.chunk_ids.length} 个锚点，防撑爆包）`);
const scafMd = scaf.files.find(f => f.path === "SKILL.md").content;
assert(scafMd.includes("sources:") && scafMd.includes(scaf.book_id), "骨架 SKILL.md: frontmatter sources 填真值");
assert(!/ch\d{2}-[a-z0-9-]+\.md/.test(scafMd),
  "骨架 SKILL.md: 章节表不写 .md 文件名（否则撞 coverageCheck 的 broken-reference 校验——文件名只在 catalog.json 里）");
const scafMiss = generateSkillScaffold("不存在的书");
assert(scafMiss.error === "book-not-found" && Array.isArray(scafMiss.available), "骨架: 书名未命中返回错误 + 书目清单");

// 7c) 人物深查（P-D）：卡罗琳——身份/书中写法/关系边/提到她代表原文块
const car = getPersonDetail(ppDb, "Caroline Bingley");
assert(car.cataloged === true && car.person === "Caroline Bingley" && car.match_names.length >= 1 && car.mention_chunks > 10,
  `人物深查: ${car.person} 出场 ${car.mention_chunks} 块 / 书中写法 ${car.match_names.join("、")}`);
assert(car.relations.some(r => r.other === "Jane Bennet" && /拆散|拆开/.test(r.note)),
  `人物深查: 关系边可查（与 ${car.relations[0]?.other}：${car.relations[0]?.note}）`);
assert(car.representative_chunks.length === Math.min(5, car.mention_chunks)
  && car.representative_chunks.every(c => c.chunk && c.preview && c.loc !== undefined),
  `人物深查: 代表块 ${car.representative_chunks.map(c => "#" + c.chunk).join(",")}（均匀抽样，带定位+预览）`);
const carMiss = getPersonDetail(ppDb, "Zaphod Beeblebrox");
assert(carMiss.error === "person-not-found" && carMiss.available.length === 25, "人物深查: 名字未命中返回候选清单");

// 7d) 主题深查（P-D）
const tName = db.prepare("SELECT name FROM nodes WHERE type='theme' AND source='llm' ORDER BY rowid LIMIT 1").get().name;
const th = getThemeDetail(ppDb, tName);
assert(th.cataloged === true && th.theme === tName && th.chunks > 0 && th.chapters.length > 0,
  `主题深查: ${tName} 覆盖 ${th.chunks} 块 / 章节分布 ${th.chapters.map(c => c.chapter + "×" + c.n).join(" ")}`);
assert(th.representative_chunks.length === Math.min(5, th.chunks)
  && th.representative_chunks.every(c => c.chunk && c.preview), "主题深查: 代表块带块号与预览");
const thMiss = getThemeDetail(ppDb, "不存在的主题");
assert(thMiss.error === "theme-not-found" && thMiss.available.length === 12, "主题深查: 名字未命中返回候选清单");

// 7e) 图邻域展开（P2）：伊丽莎白一跳邻居网——8 个邻居按出场降序，每个带关系描述 + 代表块
const nb = expandNeighborhood(ppDb, "Elizabeth Bennet");
assert(nb.cataloged === true && nb.person === "Elizabeth Bennet" && nb.matched_by === "exact"
  && nb.neighbors.length === 8 && nb.neighbors[0].name === "Fitzwilliam Darcy"
  && nb.neighbors.every((n, i, a) => i === 0 || a[i - 1].mention_count >= n.mention_count)
  && nb.neighbors.every(n => n.note && n.representative_chunks.length === Math.min(3, n.mention_count)
    && n.representative_chunks.every(c => c.chunk && c.preview && c.loc !== undefined)),
  `图邻域: ${nb.person} 邻居 ${nb.neighbors.length} 个（前排 ${nb.neighbors.slice(0, 3).map(n => n.name + "×" + n.mention_count).join("、")}）`);
const nb2 = expandNeighborhood(ppDb, "Elizabeth Bennet", { perNeighbor: 2 });
assert(nb2.neighbors.every(n => n.representative_chunks.length === Math.min(2, n.mention_count)),
  `图邻域: perNeighbor=2 每邻居代表块 ≤2（抽样 ${nb2.neighbors[0].representative_chunks.map(c => "#" + c.chunk).join(",")}）`);
const nbMiss = expandNeighborhood(ppDb, "Zaphod Beeblebrox");
assert(nbMiss.error === "person-not-found" && nbMiss.available.length === 25, "图邻域: 名字未命中返回候选清单");
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
