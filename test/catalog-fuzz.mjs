// 终期暴力测试 P2：编目深查 + 骨架生成爆破（V2 融合轮）。
// 攻击面：src/lib/catalog.mjs 的 getPersonDetail/getThemeDetail（P-D 图谱深查）、
//   src/lib/catalog-skill.mjs 的 generateSkillScaffold（P-B 骨架生成）。
// 铁律：真库只读拷贝到 tmp（注入实验全在副本）；骨架测试用 tmp 自建小库；
//   不碰检索算法、不碰真 library 原件。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const Database = require("better-sqlite3");

const { getPersonDetail, getThemeDetail, validateResult, importCatalog, linkEntities, entityAliasTerms, expandNeighborhood } = await import("../src/lib/catalog.mjs");
const { lookupEntry } = await import("../src/lib/lookup.mjs");
const { assertEngine, DEFAULT_EMBED } = await import("../src/lib/models.mjs");
const { generateSkillScaffold, MAX_CHUNK_IDS } = await import("../src/lib/catalog-skill.mjs");

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

// P&P 真库只读拷贝（注入边/改 meta 全在副本上）
const PP_DB = path.join(ROOT, "library", "pride-and-prejudice-en.epub.db");
function copyPp(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bsp-p2-${tag}-`));
  const libDir = path.join(tmp, "library");
  fs.mkdirSync(libDir, { recursive: true });
  const dst = path.join(libDir, "pride-and-prejudice-en.epub.db");
  fs.copyFileSync(PP_DB, dst);
  return { tmp, libDir, db: dst };
}
// tmp 内自建最小库（chunks/nodes/edges 三表，可控数据）
// meta 表必备：listBooks 对每个 .db 跑 SELECT FROM meta，没这张表的库被静默过滤
// （首跑 B1/B3 全落空的根因——a.db/b.db 根本没进 available，测了个寂寞）
function makeDb(libDir, name, { chunks = [], nodes = [], edges = [] } = {}) {
  const p = path.join(libDir, name);
  const db = new Database(p);
  db.exec(`CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT, emb BLOB);
    CREATE TABLE nodes(id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, ref TEXT, source TEXT);
    CREATE TABLE edges(src_type TEXT, src TEXT, dst_type TEXT, dst TEXT, kind TEXT, weight REAL, source TEXT, ref TEXT);
    CREATE TABLE meta(key TEXT, value TEXT);`);
  const ci = db.prepare("INSERT INTO chunks(id,chapter,page,text) VALUES(?,?,?,?)");
  for (const c of chunks) ci.run(c.id, c.chapter ?? null, c.page ?? null, c.text ?? "原文");
  const ni = db.prepare("INSERT INTO nodes(type,name,ref,source) VALUES(?,?,?,?)");
  for (const n of nodes) ni.run(n.type, n.name, n.ref ? JSON.stringify(n.ref) : null, n.source || "llm");
  const ei = db.prepare("INSERT INTO edges(src_type,src,dst_type,dst,kind,weight,source,ref) VALUES(?,?,?,?,?,?,?,?)");
  for (const e of edges) ei.run(e.src_type || "chunk", String(e.src), e.dst_type || "person", e.dst, e.kind, 1, e.source || "llm", e.ref || "");
  db.close();
  return p;
}

// ========== P2-A 图谱深查爆破 ==========
console.log("\n--- P2-A getPersonDetail/getThemeDetail ---");
{
  // A1（V2-D01，本轮最严重）：空名字 → matchNode 第三级 includes("") 恒真 → 返回第一个人
  const { db: pp } = copyPp("a1");
  const r = getPersonDetail(pp, "");
  ok(r.error === "person-not-found" && Array.isArray(r.available) && r.available.length > 0,
    `P2-A1 D01: get_person('') → person-not-found + 候选清单（老逻辑返回第一个人 ${r.person || "?"} 完整档案=幻觉入口）`);
  const rt = getThemeDetail(pp, "");
  ok(rt.error === "theme-not-found" && Array.isArray(rt.available),
    "P2-A1: get_theme('') → theme-not-found + 候选清单");
  // A3：纯空白 / null / undefined 三名同效
  ok(getPersonDetail(pp, "   ").error === "person-not-found"
    && getPersonDetail(pp, null).error === "person-not-found"
    && getPersonDetail(pp, undefined).error === "person-not-found",
    "P2-A3: '   '/null/undefined → 全部 person-not-found");
  ok(getThemeDetail(pp, "  ").error === "theme-not-found"
    && getThemeDetail(pp, null).error === "theme-not-found",
    "P2-A3: 主题侧三名同效");

  // A4（V2-D14）：模糊命中必须告知（注释承诺候选清单，老代码静默当精确结果返回）
  const r4 = getPersonDetail(pp, "liz");
  ok(r4.person === "Elizabeth Bennet" && r4.matched_by === "fuzzy",
    `P2-A4 D14: 模糊命中（'liz'→Elizabeth Bennet）带 matched_by:'fuzzy' 标记（老逻辑无标记，智能体以为精确命中）`);
  const r4b = getPersonDetail(pp, "ELIZABETH BENNET");
  ok(r4b.person === "Elizabeth Bennet" && r4b.matched_by === "case-insensitive",
    "P2-A4: 全小写/大写差异命中带 matched_by:'case-insensitive'");
  const r4c = getPersonDetail(pp, "Elizabeth Bennet");
  ok(r4c.person === "Elizabeth Bennet" && r4c.matched_by === "exact",
    "P2-A5: 精确命中带 matched_by:'exact'（三级降级各自可辨别）");

  // A6：{cataloged:false} 三义歧义——坏库/无表/无类型节点必须可区分
  const badPath = path.join(path.dirname(pp), "bad.db");
  fs.writeFileSync(badPath, "我不是数据库".repeat(20));
  const rBad = getPersonDetail(badPath, "x");
  ok(rBad.cataloged === false && rBad.reason === "db-broken",
    `P2-A6 D06族: 坏库 → {cataloged:false, reason:'db-broken'}（老逻辑三态同形，UI 无法区分坏文件与没编目，实测: ${JSON.stringify(rBad).slice(0, 60)}）`);
  // 无 nodes/edges 表的老库
  const { libDir: l2 } = copyPp("a6");
  const oldDbPath = path.join(l2, "old.db");
  const od = new Database(oldDbPath);
  od.exec("CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT); CREATE TABLE meta(key TEXT, value TEXT);");
  od.close();
  const rOld = getPersonDetail(oldDbPath, "x");
  ok(rOld.cataloged === false && rOld.reason === "no-nodes-table",
    "P2-A6: 无 nodes/edges 表 → reason:'no-nodes-table'（与坏库区分）");
  // 有表无 person 节点的库
  const p3 = makeDb(l2, "noperson.db", { chunks: [{ id: 1 }], nodes: [{ type: "theme", name: "T1" }] });
  const rNoP = getPersonDetail(p3, "x");
  ok(rNoP.cataloged === false && rNoP.reason === "no-such-type",
    "P2-A6: 有表无 person 节点 → reason:'no-such-type'（与没编目/坏库三态可区分）");
  safeRm(path.dirname(pp));

  // A7（V2-D11）：getThemeDetail 的 belongs 查询缺 dst_type='theme' —— 混入异类型边块数虚高
  const { db: pp7 } = copyPp("a7");
  const d7 = new Database(pp7);
  const themeName = d7.prepare("SELECT name FROM nodes WHERE type='theme' AND source='llm' LIMIT 1").get().name;
  const chunkId7 = d7.prepare("SELECT id FROM chunks LIMIT 1").get().id;
  const before7 = getThemeDetail(pp7, themeName).chunks;
  d7.prepare("INSERT INTO edges(src_type,src,dst_type,dst,kind,weight,source,ref) VALUES('chunk',?,'person',?,'belongs',1,'llm','')")
    .run(String(chunkId7), themeName); // 异类型边：dst_type=person 的 belongs 指向主题名
  d7.close();
  const after7 = getThemeDetail(pp7, themeName).chunks;
  ok(after7 === before7,
    `P2-A7 D11: 异类型 belongs 边不污染主题块数（注入前 ${before7} / 注入后 ${after7}；老逻辑虚高 +1）`);
  // A8 对称对照：mention 查询带 dst_type='person'，注入 theme 的 mention 边不涨
  const d8 = new Database(pp7);
  const personName = d8.prepare("SELECT name FROM nodes WHERE type='person' AND source='llm' LIMIT 1").get().name;
  const before8 = getPersonDetail(pp7, personName).mention_chunks;
  d8.prepare("INSERT INTO edges(src_type,src,dst_type,dst,kind,weight,source,ref) VALUES('chunk',?,'theme',?,'mention',1,'llm','')")
    .run(String(chunkId7), personName);
  d8.close();
  ok(getPersonDetail(pp7, personName).mention_chunks === before8,
    "P2-A8: mention 查询的 dst_type='person' 过滤守得住（对称对照，person 侧无此缺陷）");
  safeRm(path.dirname(pp7));

  // A9：representativeChunks 均匀抽样无重复下标——公式复算 len=6..500 + P&P 实测
  let badLens = [];
  for (let len = 6; len <= 500; len++) {
    const picks = Array.from({ length: 5 }, (_, i) => Math.round((i * (len - 1)) / 4));
    if (new Set(picks).size !== 5) badLens.push(len);
  }
  ok(badLens.length === 0, `P2-A9: 均匀抽样公式 len=6..500 全程无重复下标（len≥6 时间距≥1.25 严格递增）`);
  const { db: pp9 } = copyPp("a9");
  const bigPerson = getPersonDetail(pp9, "Elizabeth Bennet");
  const repIds = bigPerson.representative_chunks.map((c) => c.chunk);
  ok(repIds.length === 5 && new Set(repIds).size === 5,
    `P2-A9: P&P 实测 Elizabeth Bennet 代表块 5 个无重复（${repIds.join(",")}）`);
  ok(bigPerson.mention_chunks === 623 && bigPerson.mention_count > 0 && bigPerson.relations.length > 0,
    `P2-A9b: 深查数据完整（出场 ${bigPerson.mention_chunks} 块 / 关系 ${bigPerson.relations.length} 条 / match_names ${bigPerson.match_names.length} 个）`);
  const rep = bigPerson.representative_chunks[0];
  ok(rep.preview.length > 0 && rep.chapter !== undefined,
    "P2-A9c: 代表块带 chapter/page/preview（智能体可判断该不该点进去）");
  // A10：自环关系边不崩
  const { libDir: l10, db: pp10 } = copyPp("a10");
  const d10 = new Database(pp10);
  d10.prepare("INSERT INTO edges(src_type,src,dst_type,dst,kind,weight,source,ref) VALUES('person','Elizabeth Bennet','person','Elizabeth Bennet','relation',1,'llm','自环')").run();
  d10.close();
  const r10 = getPersonDetail(pp10, "Elizabeth Bennet");
  ok(r10.relations.some((x) => x.a === x.b && x.a === "Elizabeth Bennet"),
    "P2-A10: 自环关系边原样返回不崩（other 字段取到自身）");
  // A11：未编目 tmp 库 → 人话
  const p11 = makeDb(l10, "uncat.db", { chunks: [{ id: 1 }], nodes: [] });
  const r11 = getPersonDetail(p11, "x");
  ok(r11.cataloged === false && !!r11.note,
    "P2-A11: 未编目库 → {cataloged:false, note} 人话提示");
  safeRm(path.dirname(pp10));
}

// ========== P2-B 骨架生成爆破 ==========
console.log("\n--- P2-B generateSkillScaffold ---");
{
  const { configureSearch } = await import("../src/lib/search.mjs");
  // B1/B2（V2-D10）：空 query → includes("") 恒真命中全部书，matches[0] 不确定
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p2b-"));
  const libDir = path.join(tmp, "library");
  fs.mkdirSync(libDir, { recursive: true });
  makeDb(libDir, "a.db", { chunks: [{ id: 1, chapter: "第一章", text: "甲" }, { id: 2, chapter: "第二章", text: "乙" }] });
  makeDb(libDir, "b.db", { chunks: [{ id: 1, chapter: "第一章", text: "丙" }] });
  configureSearch({ libDir });
  const rB1 = generateSkillScaffold("");
  ok(rB1.error === "book-not-found" && rB1.available.length === 2,
    `P2-B1 D10: 空 query → book-not-found + 候选 2 本（老逻辑 includes("") 恒真命中全部，matches[0] 不确定）`);
  ok(generateSkillScaffold().error === "book-not-found" && generateSkillScaffold(null).error === "book-not-found",
    "P2-B2: 无参/null query → book-not-found");

  // B3（V2-D06）：坏库裸崩——new Database 在 try 外，SqliteError 英文堆栈。
  // 首跑实证出两条不同的失败路径，分别钉死：
  // ① 真·垃圾文件（无有效 sqlite 头）：listBooks 的 meta 探测先抛 → 被静默过滤 →
  //    generateSkillScaffold 根本选不中它 → book-not-found（走到不了 db 打开）
  const garbagePath = path.join(libDir, "garbage.db");
  fs.writeFileSync(garbagePath, "垃圾数据不是数据库".repeat(30));
  const rB3a = generateSkillScaffold("garbage");
  ok(rB3a.error === "book-not-found",
    `P2-B3a D06族: 垃圾 .db → book-not-found（listBooks meta 探测抛错被静默过滤，选不中它；实测: ${JSON.stringify(rB3a).slice(0, 50)}）`);
  obs(!rB3a.available.some((t) => /garbage/i.test(t)),
    "P2-B3b 坏库从书架静默消失登记",
    "listBooks catch 吞掉 meta 探测失败——损坏书库既不报错也不显示，用户视角是「书丢了」而非「书坏了」，轻微，登记不修");
  // ② 有效库头 + meta 可读 + chunks 根页损坏（部分拷贝/磁盘错误的真实形态）：
  //    listBooks 放行 → 骨架主体首次 chunks 查询抛 SQLITE_CORRUPT → 必须人话化不裸崩
  const corruptPath = path.join(libDir, "corrupt.db");
  const cd = new Database(corruptPath);
  cd.exec("CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('title','坏书');\n" +
    "CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, text TEXT); INSERT INTO chunks VALUES(1,'第一章','甲');");
  cd.close();
  const cbuf = fs.readFileSync(corruptPath);
  cbuf.fill(0x58, 8192, 12288); // 第 3 页 = chunks 根页（meta 在第 2 页仍可读，listBooks 放行）
  fs.writeFileSync(corruptPath, cbuf);
  const rB3 = generateSkillScaffold("corrupt");
  ok(rB3.error === "book-db-broken" && !!rB3.hint,
    `P2-B3 D06: chunks 页损坏 → {error:'book-db-broken', hint} 人话（老逻辑裸抛 SqliteError 英文堆栈，实测: ${JSON.stringify(rB3).slice(0, 50)}）`);
  // B4：缺 chunks 表的老库
  const oldPath = path.join(libDir, "old.db");
  const od = new Database(oldPath);
  od.exec("CREATE TABLE meta(key TEXT, value TEXT)");
  od.close();
  const rB4 = generateSkillScaffold("old");
  ok(rB4.error === "book-db-broken",
    "P2-B4 D06: 缺 chunks 表 → book-db-broken（老逻辑 SQL 裸崩）");

  // B5（V2-D12 预判复核）：规划预判「截 24 字符撞名 → 两章同一 suggested_file 互相覆盖」。
  // 实证**不成立**：chapterSlug 是 `ch${nn}-${slug}`，nn=章节下标+1（GROUP BY 后唯一），
  // 截断只会让 slug 后缀同名，文件名按构造仍唯一——同 P0-F1 预判偏差，登记不修。
  // 用前 24 字符完全相同的英文长章题（真触发截断）验证这条保证，替换原来根本没
  // 碰到截断逻辑的纯中文章节（纯中文 slugify 后为空 → 走 section-NN 兜底）。
  const long1 = "Learning Methods And Considerations For Studying Effectively At Home";
  const long2 = "Learning Methods And Considerations For Studying Effectively Abroad";
  makeDb(libDir, "slug.db", {
    chunks: [
      { id: 1, chapter: long1, text: "甲" }, { id: 2, chapter: long2, text: "乙" },
      { id: 3, chapter: "纯中文章节", text: "丙" },
    ],
  });
  const rB5 = generateSkillScaffold("slug");
  const files5 = rB5.files.find((f) => f.path === "catalog.json");
  const cat5 = JSON.parse(files5.content);
  const slugNames = cat5.chapters.map((c) => c.suggested_file);
  const suffix0 = slugNames[0].replace(/^ch\d+-/, "").replace(/\.md$/, "");
  const suffix1 = slugNames[1].replace(/^ch\d+-/, "").replace(/\.md$/, "");
  ok(new Set(slugNames).size === slugNames.length,
    `P2-B5 D12: 截断撞名后缀的两章 suggested_file 仍唯一（${slugNames.join(" / ")}）`);
  ok(suffix0 === suffix1 && suffix0.length === 24,
    `P2-B5b: 截断确实发生且后缀撞名（两章共享 24 字符 slug「${suffix0}」）——chNN 序号前缀保住文件名唯一`);
  obs(true, "P2-B5c D12 预判不成立登记",
    "规划预判「截断撞名→互相覆盖」不成立：chNN 前缀按索引构造唯一，撞的只是后缀——同 P0-F1 偏差登记不修，避免过度设计");
  ok(cat5.chapters[2].suggested_file.startsWith("ch03-section-"),
    "P2-B6: 纯中文章节 → chNN-section-NN 兜底");
  const skill5 = rB5.files.find((f) => f.path === "SKILL.md").content;
  ok(skill5.includes(slugNames[0].replace(/\.md$/, "")) && skill5.includes(slugNames[1].replace(/\.md$/, "")),
    "P2-B6b: SKILL.md 章节表与 catalog.json 建议文件名一致（两处 chapterSlug 调用不漂移）");

  // B7（V2-D13）：available 用 listBooks 不带 includeDisabled——被关书在匹配可见、建议隐身
  // state 键必须是 bookId「b」（不含 .db）——与 setSkillEnabled/ipc-test 的生产语义一致；
  // 首跑写 "b.db" 当键，与 listBooks 的 state[b.id] 过滤对不上，老代码也过滤不掉，测不住缺陷
  const statePath = path.join(libDir, "skill-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ b: false }), "utf8");
  const rB7 = generateSkillScaffold("不存在的书zzz");
  ok(rB7.error === "book-not-found" && rB7.available.includes("b.db"),
    `P2-B7 D13: available 含被关书（${rB7.available.join(",")}；老逻辑 listBooks 默认过滤，被关书隐身——与 matchBook 的 includeDisabled 自相矛盾）`);
  const rB7b = generateSkillScaffold("b.db");
  ok(rB7b.book_id === "b" && !rB7b.error,
    "P2-B7b: 被关的书仍能生成骨架（本地创作工具不受 H3 开关影响，设计行为）");
  // B7c（规划外新发现）：query「b」歧义命中多书——夹具 title 全回退成 x.db 文件名，
  // 而 ".db" 里就含字母 b，四本书全命中，matches[0] 取决于 readdir 顺序=不确定。
  // 与 D10 同族（多匹配取第一个）；真实书名撞片段时本地创作工具可能生成错书的骨架，
  // 匹配语义本身是 register-tools.matchBook 的同款设计，轻微，登记不修。
  // （query 用 "b.db" 才能唯一命中——原 B7b 用 "b" 实测被 a.db 抢了匹配；
  //   注意 book_id 是不含 .db 的 id）
  const rB7c = generateSkillScaffold("b");
  obs(["a", "b", "old", "slug"].includes(rB7c.book_id),
    "P2-B7c 歧义片段 matches[0] 顺序相关登记",
    `query「b」实测命中多书（'.db' 文件名含字母 b），matches[0] 取决于 readdir 顺序（本机 ${rB7c.book_id}）——与 D10 同族，轻微登记不修`);

  // B8：未编目书照样生成（章节表仍是真值）
  const rB8 = generateSkillScaffold("slug");
  ok(rB8.cataloged === false && rB8.files.some((f) => f.path === "SKILL.md" && f.content.includes("本书尚未编目")),
    "P2-B8: 未编目书照样生成骨架（章节表真值 + 「本书尚未编目」说明）");
  // B9：真库锚点封顶 + 章节表真值
  const { libDir: ppLib, db: ppDb } = copyPp("b9");
  configureSearch({ libDir: ppLib });
  const rB9 = generateSkillScaffold("pride");
  const cat9 = JSON.parse(rB9.files.find((f) => f.path === "catalog.json").content);
  const bigPerson9 = cat9.persons.find((p) => p.mention_count > 500);
  ok(bigPerson9 && bigPerson9.chunk_ids.length === MAX_CHUNK_IDS,
    `P2-B9: 大人物 chunk 锚点封顶 ${MAX_CHUNK_IDS}（${bigPerson9?.name} 出场 ${bigPerson9?.mention_count} 块）`);
  ok(cat9.chapters.length > 10 && cat9.chunks_total > 1000 && cat9.cataloged === true,
    `P2-B9b: 真库骨架章节表真值（${cat9.chapters.length} 章 / ${cat9.chunks_total} 块 / 编目 ${cat9.cataloged}）`);
  ok(cat9.persons.length === 25 && cat9.themes.length === 12 && cat9.relations.length > 0,
    "P2-B9c: 真库编目层齐全（25 人物 / 12 主题 / 关系边）");
  // B10：章节全空串的库 → 兜底行（B9 已把全局 libDir 重指向 ppLib，必须显式传 tmp libDir）
  makeDb(libDir, "nochap.db", { chunks: [{ id: 1, chapter: "", text: "甲" }, { id: 2, chapter: null, text: "乙" }] });
  const rB10 = generateSkillScaffold("nochap", { libDir });
  ok(rB10.chapters_total === 0 && rB10.files.find((f) => f.path === "SKILL.md").content.includes("本书无章节结构"),
    "P2-B10: 章节全空串 → 「本书无章节结构」兜底行");
  safeRm(tmp);
  safeRm(path.dirname(ppDb));
}

// ========== P1.5 中文译名 aliases_zh（渐进增强：打通"中文问英文书"） ==========
console.log("\n--- P1.5 aliases_zh ---");
{
  const tmp15 = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p15-"));
  const lib15 = path.join(tmp15, "library");
  fs.mkdirSync(lib15, { recursive: true });
  const thin = { task_ref: "p15.db", themes: [{ id: "t1", name: "Test Theme" }], assignments: [{ cluster: "c001", theme: "t1" }] };
  const task15 = { book: { db: "p15.db" }, clusters: [{ id: "c001", members: [1, 2] }] };
  const dbPath15 = makeDb(lib15, "p15.db", {
    chunks: [
      { id: 1, text: "Elizabeth walked to the parsonage in the morning." },
      { id: 2, text: "The carriage stopped at the gate." },
    ],
  });
  const db15 = new Database(dbPath15);
  // ① 空串译名 → schema 拒收（软防呆）
  const vEmpty15 = validateResult(db15, task15, { ...thin, persons: [{ name: "Elizabeth Bennet", match_names: ["Elizabeth"], aliases_zh: [""] }] });
  ok(!vEmpty15.ok && vEmpty15.errors.some(e => e.includes("aliases_zh")),
    `P1.5: aliases_zh 空串被 schema 拒收（${vEmpty15.errors[0] || "无错误？"}）`);
  // ② 省略 aliases_zh → 默认空数组（存量编目结果零影响，行为与 P1 一致）
  const vOmit15 = validateResult(db15, task15, { ...thin, persons: [{ name: "Elizabeth Bennet", match_names: ["Elizabeth"] }] });
  ok(vOmit15.ok && Array.isArray(vOmit15.data.persons[0].aliases_zh) && vOmit15.data.persons[0].aliases_zh.length === 0,
    "P1.5: 省略 aliases_zh → 默认空数组（旧任务书产物照常放行）");
  // ③ 合法译名放行：书内没有「伊丽莎白」也不拦（软字段，不做书内验真）
  const vOk15 = validateResult(db15, task15, { ...thin, persons: [{ name: "Elizabeth Bennet", match_names: ["Elizabeth"], aliases_zh: ["伊丽莎白"] }] });
  ok(vOk15.ok, `P1.5: 合法译名放行——「伊丽莎白」书内没有不拦（软字段）${vOk15.ok ? "" : "｜" + vOk15.errors[0]}`);
  db15.close();
  // OBSERVE：build 后 embed 前的半成品库（无 emb 列，非坏库）——assertEngine 对维度的
  // SELECT emb 裸抛 SqliteError（build-book 建表不带 emb，embed-book ALTER 补；导入中断即此态）。
  // 本轮登记不修（models.mjs 出计划范围）；建议修法：先 PRAGMA 查列存在再验维度。
  // 夹具手工建表复刻 build-book 形态（makeDb 现已带 emb 列，造不出此态）
  const noembPath = path.join(lib15, "noemb.db");
  const x15 = new Database(noembPath);
  x15.exec("CREATE TABLE meta(key TEXT, value TEXT); CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT NOT NULL);");
  x15.close();
  const dbNoEmb = new Database(noembPath);
  let noEmbThrew = false;
  try { assertEngine(dbNoEmb, DEFAULT_EMBED); } catch (e) { noEmbThrew = e?.name === "SqliteError" || String(e?.code || "").startsWith("SQLITE_"); }
  dbNoEmb.close();
  obs(noEmbThrew, "P1.5-OBS: 无 emb 列半成品库 assertEngine 裸抛 SqliteError（登记不修）");
  // ④ 全链闭环：importCatalog 写入节点 ref → 中文译名命中 → 注入的是书内写法（译名不进 FTS）
  const dbW15 = new Database(dbPath15);
  await importCatalog(dbW15, task15, { ...thin, persons: [{ name: "Elizabeth Bennet", match_names: ["Elizabeth"], aliases_zh: ["伊丽莎白"], note: "" }] });
  const refW15 = JSON.parse(dbW15.prepare("SELECT ref FROM nodes WHERE type='person' AND name='Elizabeth Bennet'").get().ref || "{}");
  ok(Array.isArray(refW15.aliases_zh) && refW15.aliases_zh[0] === "伊丽莎白",
    `P1.5: importCatalog 把译名写进节点 ref（${JSON.stringify(refW15.aliases_zh)}，mention_count=${refW15.mention_count}）`);
  const hitZh15 = linkEntities(dbW15, "伊丽莎白是个怎样的人");
  ok(hitZh15.some(m => m.name === "Elizabeth Bennet"), "P1.5: 中文译名命中人物（linkEntities 词表并入 aliases_zh）");
  const terms15 = entityAliasTerms(dbW15, "伊丽莎白是个怎样的人");
  ok(terms15.en.includes("elizabeth") && terms15.cjk.length === 0,
    `P1.5: 译名命中后注入 match_names 书内写法（en=${terms15.en.join(",")}；译名自身不进 FTS）`);
  dbW15.close();
  safeRm(tmp15);
}

// ========== P2-C expand 图邻域（MCP expand 工具，纯浏览不喂检索） ==========
console.log("\n--- P2-C expandNeighborhood ---");
{
  const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p2c-"));
  const libC = path.join(tmpC, "library");
  fs.mkdirSync(libC, { recursive: true });
  // 合成图：甲—乙（双描述多边）+ 甲自环 + 甲→幽灵（悬空）+ 丙—甲；乙 6 个出场块；丁 零边
  const chunksC = [];
  for (let i = 1; i <= 8; i++) chunksC.push({ id: i, chapter: `第${i}章`, text: `正文片段${i}。` });
  const edgesC = [
    { src: "甲", src_type: "person", dst: "乙", kind: "relation", ref: "同窗好友" },
    { src: "甲", src_type: "person", dst: "乙", kind: "relation", ref: "多年邻居" },
    { src: "甲", src_type: "person", dst: "甲", kind: "relation", ref: "自环" },
    { src: "甲", src_type: "person", dst: "幽灵", kind: "relation", ref: "悬空" },
    { src: "丙", src_type: "person", dst: "甲", kind: "relation", ref: "旧识" },
    { src: 1, dst: "甲", kind: "mention" },
    { src: 2, dst: "甲", kind: "mention" },
    { src: 3, dst: "丙", kind: "mention" },
  ];
  for (let i = 1; i <= 6; i++) edgesC.push({ src: i, dst: "乙", kind: "mention" });
  const pC = makeDb(libC, "graph.db", {
    chunks: chunksC,
    nodes: [
      { type: "person", name: "甲", ref: { match_names: ["甲"], mention_count: 2 }, source: "llm" },
      { type: "person", name: "乙", ref: { match_names: ["乙"], mention_count: 50 }, source: "llm" },
      { type: "person", name: "丙", ref: { match_names: ["丙"], mention_count: 5 }, source: "llm" },
      { type: "person", name: "丁", ref: { match_names: ["丁"], mention_count: 1 }, source: "llm" },
    ],
    edges: edgesC,
  });
  const rC = expandNeighborhood(pC, "甲");
  ok(rC.cataloged === true && rC.person === "甲" && rC.matched_by === "exact",
    `P2-C1: 正常展开（person=${rC.person} matched_by=${rC.matched_by}）`);
  const namesC = rC.neighbors.map(n => n.name);
  ok(namesC.length === 2 && namesC[0] === "乙" && namesC[1] === "丙" && !namesC.includes("幽灵"),
    `P2-C1: 邻居按出场数降序 + 自环/悬空边剔除（${namesC.join(",")}；乙50>丙5）`);
  ok(rC.neighbors[0].note === "同窗好友 / 多年邻居", `P2-C1b: 多边 note 合并 " / "（${rC.neighbors[0].note}）`);
  ok(rC.neighbors[0].representative_chunks.length === 3 && rC.neighbors[0].representative_chunks.every(c => c.chunk && c.preview),
    `P2-C1c: 代表块带 chunk/预览（默认 3 个：${rC.neighbors[0].representative_chunks.map(c => c.chunk).join(",")}）`);
  ok(expandNeighborhood(pC, "").error === "person-not-found" && expandNeighborhood(pC, "   ").error === "person-not-found",
    "P2-C2: 空名/空白名 → person-not-found（D01 防幻觉守卫在 expand 上不复发）");
  const rMissC = expandNeighborhood(pC, "不存在");
  ok(rMissC.error === "person-not-found" && Array.isArray(rMissC.available) && rMissC.available.length === 4,
    `P2-C3: 未命中 → person-not-found + ${rMissC.available?.length} 个候选清单`);
  ok(expandNeighborhood(pC, "丁").neighbors_total === 0 && expandNeighborhood(pC, "丁").neighbors.length === 0,
    "P2-C4: 无关系边人物 → 空邻居不崩（relation_total=0）");
  ok(expandNeighborhood(pC, "甲", { perNeighbor: 5 }).neighbors[0].representative_chunks.length === 5
    && expandNeighborhood(pC, "甲", { perNeighbor: 99 }).neighbors[0].representative_chunks.length === 5,
    "P2-C5a: perNeighbor 上夹 5（99→5）");
  ok(expandNeighborhood(pC, "甲", { perNeighbor: 0 }).neighbors[0].representative_chunks.length === 3
    && expandNeighborhood(pC, "甲", { perNeighbor: -5 }).neighbors[0].representative_chunks.length === 1,
    "P2-C5b: perNeighbor 0→默认3 / 负数→下限1（与 clampTopN 同款语义）");
  ok(expandNeighborhood(pC, "甲", { perNeighbor: 1 }).neighbors[0].representative_chunks.length === 1,
    "P2-C5c: perNeighbor=1 取 1 块（原采样公式 (n-1) 除零 → 静默空数组，已修 Math.max(1,n-1)）");
  // 坏库 / 旧 schema / 截断
  const badC = path.join(libC, "bad.db");
  fs.writeFileSync(badC, "definitely not a sqlite database");
  ok(expandNeighborhood(badC, "甲").reason === "db-broken", "P2-C6: 垃圾文件库 → db-broken（人话，不裸崩）");
  const oldC = path.join(libC, "old.db");
  const dbOld = new Database(oldC);
  dbOld.exec("CREATE TABLE nodes(id INTEGER PRIMARY KEY, type TEXT, name TEXT, ref TEXT); CREATE TABLE edges(src TEXT, dst TEXT);");
  dbOld.close();
  ok(expandNeighborhood(oldC, "甲").reason === "old-schema", "P2-C7: 旧 schema（nodes 无 source 列）→ old-schema（与坏库可区分）");
  // 截断：22 个邻居 → MAX_NB=20 + note
  const wideNodes = [{ type: "person", name: "中心", ref: { match_names: ["中心"], mention_count: 1 }, source: "llm" }];
  const wideEdges = [];
  for (let i = 1; i <= 22; i++) {
    wideNodes.push({ type: "person", name: `邻${i}`, ref: { match_names: [`邻${i}`], mention_count: i }, source: "llm" });
    wideEdges.push({ src: "中心", src_type: "person", dst: `邻${i}`, kind: "relation", ref: `关系${i}` });
  }
  const pWide = makeDb(libC, "wide.db", { chunks: [{ id: 1, text: "占位" }], nodes: wideNodes, edges: wideEdges });
  const rWide = expandNeighborhood(pWide, "中心");
  ok(rWide.neighbors_total === 22 && rWide.truncated === true && rWide.neighbors.length === 20 && !!rWide.note,
    `P2-C8: MAX_NB=20 截断带说明（共 ${rWide.neighbors_total} 显示 ${rWide.neighbors.length}：${rWide.note}）`);
  ok(rWide.neighbors[0].name === "邻22",
    `P2-C8b: 截断取"出场最多的 20 个"（首位=邻22，count=${rWide.neighbors[0].mention_count}）`);
  safeRm(tmpC);
}

// ========== P4 lookup 工作资料寻址（MCP lookup 工具，纯浏览不喂检索） ==========
console.log("\n--- P4 lookupEntry ---");
{
  const tmpL = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p4-"));
  const libL = path.join(tmpL, "library");
  fs.mkdirSync(libL, { recursive: true });
  // 合成"错误码表"：一级标题=错误码（每码 2 块），含前缀歧义对（E1001 vs E10010）+ 一个大章（截断用）
  const chunksL = [
    { id: 1, chapter: "E1001 连接超时", page: 3, text: "E1001：与服务器建立连接超时。请检查网络后重试。" },
    { id: 2, chapter: "E1001 连接超时", page: 3, text: "处置：确认代理配置；若持续超时联系运维。" },
    { id: 3, chapter: "E1002 参数缺失", page: 4, text: "E1002：请求缺少必填参数。" },
    { id: 4, chapter: "E1002 参数缺失", page: 4, text: "处置：核对接口文档的参数表。" },
    { id: 5, chapter: "E10010 连接被拒", page: 5, text: "E10010：目标端口拒绝连接。" },
    { id: 6, chapter: "3.2 安装步骤", page: 6, text: "3.2 安装步骤：先解压，再执行 setup。" },
    { id: 7, chapter: null, page: 7, text: "无章节正文。" },
    { id: 8, chapter: "", page: 8, text: "空串章节正文。" },
  ];
  for (let i = 20; i < 65; i++) chunksL.push({ id: i, chapter: "BULK 大章", text: `批量块${i}` });
  const pL = makeDb(libL, "errcodes.db", { chunks: chunksL });
  const lk1 = lookupEntry(pL, "E1001 连接超时");
  ok(lk1.matched_chapter === "E1001 连接超时" && lk1.match_level === "exact" && lk1.total === 2
    && lk1.blocks.length === 2 && lk1.blocks[0].id === 1 && lk1.blocks[1].id === 2 && lk1.blocks[0].page === 3
    && lk1.note === undefined,
    `P4-1: 精确命中（${lk1.total} 块、id 升序、page 透传、单命中无 note）`);
  const lk2 = lookupEntry(pL, "E1001");
  ok(lk2.matched_chapter === "E1001 连接超时" && lk2.match_level === "prefix" && /命中 2 个章节/.test(lk2.note || ""),
    `P4-2: 前缀命中含歧义对（E1001/E10010）→ 已选第一个 + note：${lk2.note}`);
  const lk3 = lookupEntry(pL, "安装步骤");
  ok(lk3.matched_chapter === "3.2 安装步骤" && lk3.match_level === "includes",
    "P4-3: 包含命中（'安装步骤' ⊂ '3.2 安装步骤'）");
  const lk4 = lookupEntry(pL, "e1002");
  ok(lk4.matched_chapter === "E1002 参数缺失" && lk4.match_level === "prefix",
    "P4-4: 大小写不敏感（'e1002' → 'E1002 参数缺失'，错误码场景刚需）");
  const lk5 = lookupEntry(pL, "不存在的码");
  ok(lk5.error === "not-found" && lk5.available.length === 5 && lk5.available_total === 5 && lk5.available[0] === "E1001 连接超时",
    `P4-5: 未命中 → not-found + ${lk5.available?.length} 个候选章节（目录导航，按文档序）`);
  const lk6 = lookupEntry(pL, "   ");
  ok(lk6.error === "not-found" && lk6.available.length === 5,
    "P4-6: 空白 key → not-found（D01 家族：空串 includes(\"\") 恒真守卫在 lookup 上不复发）");
  const lk7 = lookupEntry(pL, "BULK 大章");
  ok(lk7.blocks.length === 20 && lk7.total === 45 && /共 45 块/.test(lk7.note || ""),
    `P4-7: 默认 maxBlocks=20 截断带说明（45→20：${lk7.note}）`);
  ok(lookupEntry(pL, "BULK 大章", { maxBlocks: 99 }).blocks.length === 40
    && lookupEntry(pL, "BULK 大章", { maxBlocks: 0 }).blocks.length === 20,
    "P4-7b: maxBlocks 上夹 40（99→40）/ 0→默认 20（与 clampTopN 同款语义）");
  // PDF 型（chapter 全 NULL/空串）→ no-chapters 指引改走 query_book
  const pPdf = makeDb(libL, "pdf.db", { chunks: [
    { id: 1, chapter: null, page: 1, text: "PDF 页 1" },
    { id: 2, chapter: "", page: 2, text: "空串章" },
  ] });
  const lk8 = lookupEntry(pPdf, "任意");
  ok(lk8.error === "no-chapters" && /query_book/.test(lk8.hint || ""),
    `P4-8: chapter 全 NULL/空串 → no-chapters + hint（PDF 定位靠页码，指引改走 query_book）`);
  const badL = path.join(libL, "bad.db");
  fs.writeFileSync(badL, "definitely not a sqlite database");
  ok(lookupEntry(badL, "x").error === "db-broken", "P4-9: 垃圾文件库 → db-broken（人话，不裸崩）");
  // 未编目库（无 nodes/edges 表）也要能寻址——lookup 只依赖 chunks，与编目解耦
  const bareL = path.join(libL, "bare.db");
  {
    const b = new Database(bareL);
    b.exec("CREATE TABLE chunks(id INTEGER PRIMARY KEY, chapter TEXT, page INTEGER, text TEXT); CREATE TABLE meta(key TEXT, value TEXT);");
    b.prepare("INSERT INTO chunks(id, chapter, page, text) VALUES(1, '1 概述', 1, '概述正文。')").run();
    b.close();
  }
  const lk10 = lookupEntry(bareL, "1 概述");
  ok(lk10.matched_chapter === "1 概述" && lk10.blocks.length === 1 && lk10.blocks[0].text === "概述正文。",
    "P4-10: 未编目库（无 nodes/edges 表）也能寻址——lookup 只依赖 chunks（与编目解耦）");
  safeRm(tmpL);
}

console.log();
console.log(`=== catalog-fuzz(演进轮 P1.5/P2/P4): ${pass} pass / ${fail} fail / ${observe} observe ===`);
process.exit(fail > 0 ? 1 : 0);
