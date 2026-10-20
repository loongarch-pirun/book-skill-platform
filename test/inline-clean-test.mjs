// inline-clean 全离线测试：L1 行级噪音单元 / L2 跟帖切分单元 / planBlock 护栏 I1/I2 /
// 集成落库（strip+split / quarantine / FTS / 四本账 / emb 与 catalog 作废）/
// 恢复全对账（原文逐字回滚 + 新块删除 + 账目回涨）/ 四道闸（GATE/TAMPER/STALE_STRUCT）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import {
  stripNoiseLines, splitByReplyBoundary, planBlock, buildInlinePlan,
  checkInlineGate, estimateInline, INLINE_VERSION, textHash16,
} from "../src/lib/inline-clean.mjs";
import { importInline, restoreInline, auditInline } from "../src/lib/inline-import.mjs";

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), msg + (JSON.stringify(a) === JSON.stringify(b) ? "" : `（got ${JSON.stringify(a)} want ${JSON.stringify(b)}）`));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "inline-test-"));
function mkDb(name, blocks, { withFts = true, embCol = false, catalog = false } = {}) {
  const p = path.join(TMP, name);
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);");
  db.exec(`CREATE TABLE chunks(
    id INTEGER PRIMARY KEY, chapter TEXT, chapter_path TEXT, page INTEGER, text TEXT NOT NULL
  );`);
  if (embCol) db.exec("ALTER TABLE chunks ADD COLUMN emb BLOB;");
  if (withFts) {
    db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');`);
  }
  const ins = db.prepare("INSERT INTO chunks(chapter, chapter_path, page, text) VALUES (?,?,?,?)");
  const insFts = withFts ? db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)") : null;
  const tx = db.transaction(() => {
    blocks.forEach((b, i) => {
      const r = ins.run(b.chapter ?? null, b.chapter_path ?? null, b.page ?? null, b.text);
      if (insFts) insFts.run(r.lastInsertRowid, b.text);
    });
  });
  tx();
  if (catalog) {
    db.prepare("INSERT INTO meta(key,value) VALUES ('catalog_at','2026-10-19'),('catalog_themes','11'),('catalog_persons','19'),('catalog_chunk_count','5')").run();
  }
  db.close();
  return p;
}

// ---------- 1. stripNoiseLines 单元 ----------
{
  const text = [
    "楼主正文第一行，讲房地产调控的背景与意图，这段是干干净净的正文内容。",
    "•zhangzany2017-06-18 09:37",
    "94楼",
    "作者：sunxinmfc回复日期：2010-08-1122:45:56",
    "——————",
    "楼主说的是体制内分房逻辑，这段也是正文，必须要完整保留下来不能误删。",
    "20",
  ].join("\n");
  const s = stripNoiseLines(text);
  assert(s.removed.length === 5, `五类噪音各删一行（got ${s.removed.length}: ${s.removed.map(r => r.cat).join(",")}）`);
  assert(s.text.includes("楼主正文第一行") && s.text.includes("楼主说的是体制内"), "两段正文都保留");
  assert(!s.text.includes("zhangzany") && !s.text.includes("回复日期") && !s.text.includes("94楼"), "署名/楼层/分隔线全删");
  assert(!/\n20\n/.test("\n" + s.text + "\n"), "块尾页码删掉");
}
{
  // 块中部孤立数字是正文数据，不能删（edge 限定首尾）
  const text = "第一行正文。\n2026\n第二行正文。";
  const s = stripNoiseLines(text);
  assert(s.text === text, "块中部孤立数字保留（可能是正文数据）");
}
{
  // 「楼主」开头行是正文（kk 实测 174 行）
  const text = "楼主的意思是今后体制外的人无缘商品房。\n楼主应该加一句买质量好的商品房。";
  const s = stripNoiseLines(text);
  assert(s.text === text && s.removed.length === 0, "「楼主」开头行零误删");
}

// ---------- 2. splitByReplyBoundary 单元 ----------
{
  const text = [
    "主帖正文：分析一级市场与土地财政的关系，内容足够长。",
    "•ty_烟雨江南2882018-02-23 20:37",
    "精辟啊现在大搞拆迁，城中村改造！",
    "作者：sunxinmfc回复日期：2010-08-1122:45:56",
    "政府无需考虑民生问题么，本次号称史上最严厉的打压政策。",
  ].join("\n");
  const segs = splitByReplyBoundary(text);
  assert(segs && segs.length === 3, `按两个边界切三段（got ${segs?.length}）`);
  eq(segs.map(s => s.kind), ["main", "reply", "reply"], "段类型 main+reply+reply");
  assert(segs[1].lines.join("\n").includes("精辟啊"), "跟帖段 1 内容是跟帖正文");
  assert(!segs[1].lines.join("\n").includes("烟雨江南"), "边界行（署名）不进跟帖段");
  assert(segs[0].lines.join("\n").includes("主帖正文"), "主帖段在第一位");
}
{
  const text = "没有跟帖边值的普通正文，就是普普通通的一段话，安安静静地待在这里。";
  assert(splitByReplyBoundary(text) === null, "无边界返回 null");
}
{
  // 块首第一行是边界行也不算跟帖起点（块首必须是主帖）
  const text = "•user2020-01-01 10:00\n跟帖内容在这里，安安静静地待着就够了。";
  assert(splitByReplyBoundary(text) === null, "块首边界不算切点");
}

// ---------- 3. planBlock 单元 ----------
{
  const clean = "这是一段干干净净的正文，没有任何论坛体噪音，长度也足够超过三十个字符的红线要求。";
  const p = planBlock(clean);
  eq(p.action, "keep", "干净块 keep 零改动");
  eq(p.after, clean, "keep 的 after 等于原文");
}
{
  const text = "楼主分析调控意图的正文部分，这段内容足够长所以不会被护栏拦下来，是安全的长块。\n•user2018-02-23 20:37\n——————\n42";
  const p = planBlock(text);
  eq(p.action, "strip", "只有噪音无跟帖 → strip");
  assert(p.after.includes("楼主分析调控意图"), "strip 后正文保留");
  assert(!p.after.includes("user2018"), "strip 后署名删除");
}
{
  const text = [
    "主帖正文：分析公租房与商品房的土地性质差异，出让与划拨决定了定价逻辑，这是很长的正文。",
    "•ty_烟雨江南2882018-02-23 20:37",
    "精辟啊现在大搞拆迁，城中村改造，以后民营开发商的日子将变得越发艰难。",
    "作者：sunxinmfc回复日期：2010-08-1122:45:45",
    "政府无需考虑民生问题么，本次号称史上最严厉的打压政策再起不到一点效果。",
    "20",
  ].join("\n");
  const p = planBlock(text);
  eq(p.action, "split", "主帖+跟帖 → split");
  assert(p.after.includes("主帖正文") && !p.after.includes("精辟"), "主帖段只留主帖");
  eq(p.replies.length, 2, "切出两个跟帖段");
  assert(p.replies[0].includes("精辟") && p.replies[1].includes("政府无需考虑"), "跟帖段内容正确");
  assert(!p.after.includes("20"), "页码行删除");
}
{
  // I1：strip 后只剩「短」1 字（块被删成空气）→ 整块拒收
  const text = "短\n•a2020-01-01\n•b2020-01-02\n•c2020-01-03\n42";
  const p = planBlock(text);
  eq(p.action, "keep", "I1 拒收：删行超 30% 整块 keep");
  eq(p.guarded, "I1", "I1 护栏标记");
  eq(p.after, text, "I1 拒收后原文原样");
}
{
  // I2：主帖段太短 → 退化为 strip 不切
  const text = "主帖短。\n•user2018-02-23 20:37\n跟帖内容长度足够二十字符以上所以不会被丢弃掉。";
  const p = planBlock(text);
  assert(p.action === "strip", `主帖短不切退化为 strip（got ${p.action}）`);
}
{
  // I2：跟帖段太短 → 丢弃该跟帖
  const text = "主帖正文长度足够三十字符以上，安安静静地讲房地产与土地财政的逻辑关系。\n•user2018-02-23 20:37\n嗯\n作者：x回复日期：2010-08-11\n这段跟帖长度足够二十个字符以上所以会被保留下来。";
  const p = planBlock(text);
  eq(p.replies.length, 1, "短跟帖「嗯」被丢弃");
  assert(p.replies[0].includes("这段跟帖长度足够"), "长跟帖保留");
}

// ---------- 4. 集成：落库 ----------
const FORUM_BLOCKS = [
  {
    chapter: null, page: null, text: [
      "主帖：这次调控的真实意图是防范金融风险，让土地财政软着陆，同时试探市场反应。",
      "•zhangzany2017-06-18 09:37",
      "评论kkndme：历史总是在不断循环，利益分配的逻辑从来没有变过。",
      "作者：sunxinmfc回复日期：2010-08-1122:45:56",
      "政府无需考虑民生问题么，本次号称史上最严厉的打压政策再起不到效果。",
      "11",
    ].join("\n"),
  },
  {
    chapter: null, page: null, text: [
      "一级市场开发的最大特点是可以创造需求：你不是有房子吗，我拆掉你的房子，看你有没有刚需。",
      "•ty_烟雨江南2882018-02-23 20:37",
      "精辟啊现在大搞拆迁，城中村改造，民营开发商日子越发艰难。",
      "94楼",
      "20",
    ].join("\n"),
  },
  {
    chapter: "干净章", page: 5, text: "这一段是没有任何论坛体噪音的普通正文，安安静静地讲保障房与商品房的区别，长度足够。",
  },
];
{
  const dbPath = mkDb("forum.db", FORUM_BLOCKS, { embCol: true, catalog: true });
  const dbPre = new Database(dbPath);
  dbPre.prepare("UPDATE chunks SET emb = x'01' WHERE id IN (1,2)").run();  // 前两块已 embed
  dbPre.close();
  const db0 = new Database(dbPath, { readonly: true });
  const plan = buildInlinePlan(db0);
  db0.close();
  assert(plan.ok, "buildInlinePlan 成功");
  eq(plan.stats.split, 2, "两块 split");
  eq(plan.stats.strip, 0, "干净块 keep 不算 strip");
  eq(plan.stats.keep, 1, "一块 keep");
  eq(plan.stats.total, 3, "共三块");
  eq(plan.stats.newChunks, 3, "切出三个跟帖新块");

  const ir = importInline(dbPath, plan, {});
  assert(ir.ok, `落库成功（${ir.message}）`);
  eq(ir.stats.embCleared, 2, "改过的两块 emb 作废");
  assert(ir.stats.catalogCleared >= 3, "catalog meta 作废");

  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT id, text, emb FROM chunks ORDER BY id").all();
  eq(rows.length, 6, "块数 3 → 6（两个 split 各切 2 跟帖 + 干净块）");
  assert(!rows[0].text.includes("zhangzany") && !rows[0].text.includes("回复日期"), "块1 主帖段只留主帖");
  assert(rows[0].text.includes("这次调控的真实意图"), "块1 主帖正文保留");
  assert(rows[3].text.includes("历史总是在不断循环"), "切出的跟帖1a 存在");
  assert(rows[4].text.includes("政府无需考虑"), "切出的跟帖1b 存在");
  assert(rows[5].text.includes("精辟啊"), "切出的跟帖2 存在");
  assert(rows[0].emb === null && rows[1].emb === null, "改过的两块 emb 置 NULL");
  const q = db.prepare("SELECT COUNT(*) c FROM quarantine WHERE cat='inline'").get().c;
  eq(q, 2, "隔离账两条 inline 记录");
  const q1 = db.prepare("SELECT * FROM quarantine WHERE chunk_id=1").get();
  assert(q1.text.includes("zhangzany"), "隔离账存原文");
  assert(q1.split_json && JSON.parse(q1.split_json).length === 2, "隔离账记录切出的新块 id");
  eq(db.prepare("SELECT COUNT(*) c FROM chunks_fts").get().c, 6, "FTS 对齐 6");
  eq(db.prepare("SELECT value FROM meta WHERE key='chunk_count'").get().value, "6", "meta chunk_count = 6");
  assert(db.prepare("SELECT value FROM meta WHERE key='inline_version'").get().value === String(INLINE_VERSION), "inline_version 落账");
  assert(!db.prepare("SELECT 1 FROM meta WHERE key='catalog_themes'").get(), "catalog_themes 已删");
  db.close();

  const au = auditInline(dbPath);
  assert(au.ready && au.inlineQuarantined === 2 && au.chunks === 6 && au.metaAligned, "auditInline 账实相符");

  // 恢复：原文逐字回滚
  const before = FORUM_BLOCKS.map(b => b.text);
  const rr = restoreInline(dbPath, { all: true });
  assert(rr.ok, `恢复成功（${rr.message}）`);
  eq(rr.restored, 2, "恢复 2 块");
  eq(rr.deletedNew, 3, "删除 3 个切出的新块");
  const db2 = new Database(dbPath, { readonly: true });
  const rows2 = db2.prepare("SELECT id, text FROM chunks ORDER BY id").all();
  eq(rows2.length, 3, "恢复后回到 3 块");
  for (let i = 0; i < 3; i++) {
    eq(rows2[i].text, before[i], `块 ${i + 1} 原文逐字回滚`);
    eq(textHash16(rows2[i].text), textHash16(before[i]), `块 ${i + 1} hash 一致`);
  }
  eq(db2.prepare("SELECT COUNT(*) c FROM chunks_fts").get().c, 3, "恢复后 FTS 对齐 3");
  eq(db2.prepare("SELECT value FROM meta WHERE key='chunk_count'").get().value, "3", "恢复后 chunk_count 回涨 3");
  assert(!db2.prepare("SELECT 1 FROM meta WHERE key='inline_version'").get() === false, "inline_version 仍在（恢复不清版本标记）");
  const embLeft = db2.prepare("SELECT COUNT(*) c FROM chunks WHERE emb IS NOT NULL").get().c;
  assert(embLeft === 0, "恢复后 emb 仍是 NULL（提示重跑加工）");
  db2.close();
}

// ---------- 5. 闸门 ----------
{
  // GATE：单块删行 30% 不过 I1（>30% 才拒），但全书删字 46% 超 40% 硬线 → 拒收；--force-gate 放行
  const body = "正文内容长度十五字左右";
  const sign = "•verylongusername2018-02-2320:37";
  const noisy = Array.from({ length: 10 }, (_, i) => ({
    text: [body, body, body, body, body, body, body, sign, sign, sign].join("\n"),
  }));
  const dbPath = mkDb("gate.db", noisy);
  const db0 = new Database(dbPath, { readonly: true });
  const plan = buildInlinePlan(db0);
  db0.close();
  assert(plan.stats.cleanRatio > 0.4, `净化率超硬线（${plan.stats.cleanRatio}）`);
  assert(plan.stats.guardedI1 === 0, `单块删行 30% 不撞 I1（guarded=${plan.stats.guardedI1}）`);
  const g = importInline(dbPath, plan, {});
  assert(!g.ok && g.code === "GATE", "GATE 拒收");
  const gf = importInline(dbPath, plan, { forceGate: true });
  assert(gf.ok, "--force-gate 放行");
}
{
  // TAMPER：计划 text_hash 被篡改（模拟产物被改，库不动——改库会先撞 STALE，同 clean 链路测法）
  const dbPath = mkDb("tamper.db", [{ text: "主帖正文：分析调控意图与土地财政的关系，这段内容足够长所以是安全的。\n•user2018-02-23 20:37\n跟帖内容长度足够二十字符以上所以会被保留下来。\n20" }]);
  const db0 = new Database(dbPath, { readonly: true });
  const plan = buildInlinePlan(db0);
  db0.close();
  const touched = plan.blocks.find(b => b.action !== "keep");
  touched.text_hash = "0".repeat(16);
  const t = importInline(dbPath, plan, {});
  assert(!t.ok && t.code === "TAMPER", "TAMPER 拒收（计划 hash 被篡改）");
}
{
  // STALE：计划产出后书被改（chunk_fp 含每块文本 hash，必变）→ 拒收（fp 变撞 STALE_STRUCT，
  // content_hash 是建库 meta 值不变；两者都属「书被改过」语义，等价 clean 链路双重 stale）
  const dbPath = mkDb("stale.db", [{ text: "主帖正文：分析调控意图与土地财政的关系，这段内容足够长所以是安全的。\n•user2018-02-23 20:37\n跟帖内容长度足够二十字符以上所以会被保留下来。\n20" }]);
  const db0 = new Database(dbPath, { readonly: true });
  const plan = buildInlinePlan(db0);
  db0.close();
  const dbW = new Database(dbPath);
  dbW.prepare("UPDATE chunks SET text = ? WHERE id = 1").run("人工改过的内容。");
  dbW.close();
  const s = importInline(dbPath, plan, {});
  assert(!s.ok && (s.code === "STALE" || s.code === "STALE_STRUCT"), `STALE 拒收（书被改过，got ${s.code}）`);
}

{
  // STALE_STRUCT：块数变了 → 拒收
  const dbPath = mkDb("stale-struct.db", [{ text: "主帖正文：分析调控意图与土地财政的关系，这段内容足够长所以是安全的。\n•user2018-02-23 20:37\n跟帖内容长度足够二十字符以上所以会被保留下来。\n20" }]);
  const db0 = new Database(dbPath, { readonly: true });
  const plan = buildInlinePlan(db0);
  db0.close();
  delete plan.book.chunk_fp;
  const dbW = new Database(dbPath);
  dbW.prepare("INSERT INTO chunks(text) VALUES ('新插入的一块正文，安安静静地待着就够了。')").run();
  dbW.close();
  const s = importInline(dbPath, plan, {});
  assert(!s.ok && s.code === "STALE_STRUCT", "STALE_STRUCT 拒收（块数不符）");
}

// ---------- 6. estimateInline ----------
{
  const dbPath = mkDb("est.db", FORUM_BLOCKS);
  const db0 = new Database(dbPath, { readonly: true });
  const plan = buildInlinePlan(db0);
  db0.close();
  const est = estimateInline(plan);
  eq(est.cloudCalls, 0, "规则版零云端调用");
  assert(est.removedChars > 0 && est.newChunks > 0, "预估带删字与切块数");
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
