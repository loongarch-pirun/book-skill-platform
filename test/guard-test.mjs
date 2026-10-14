// 防线包验收：引擎一致性卫兵 / LIKE 通配符转义 / topN 上限 / 错误路径关库
// 跑法: node test/guard-test.mjs   （在临时目录做破坏性实验，不碰真库）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { hybridSearch, routeAndSearch } from "../src/lib/search.mjs";
import { assertEngine, DEFAULT_EMBED } from "../src/lib/models.mjs";
import { importCatalog } from "../src/lib/catalog.mjs";
import { registerServerTools, TOPN_SCHEMA, clampTopN } from "../src/lib/register-tools.mjs";

const LIB = path.join(import.meta.dirname, "..", "library");
const GOOD = path.join(LIB, "lunyu-xueer-zh.docx.db");      // 16 块，小而全（有向量/FTS/编目）

let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name} ${extra}`); }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-guard-"));

// 复制一份真库到临时目录（只读实验永远不动真库）
const copyDb = (src) => {
  const dst = path.join(tmp, path.basename(src));
  fs.copyFileSync(src, dst);
  return dst;
};

// ========== 1) assertEngine：标记不匹配 → 拒跑 ==========
{
  const dbPath = copyDb(GOOD);
  const db = new Database(dbPath);
  db.prepare("UPDATE meta SET value='zh-small' WHERE key='model'").run();
  let threw = null;
  try { assertEngine(db, DEFAULT_EMBED); } catch (e) { threw = e; }
  db.close();
  ok(threw && /引擎不一致/.test(threw.message), "卫兵: meta.model 标记不匹配被拒", threw?.message || "未抛错");
  ok(threw && /重灌|BSP_EMBED_MODEL/.test(threw.message), "卫兵: 报错信息带修复路径");
}

// ========== 2) assertEngine：旧库无标记 → 只验维度；维度不符 → 拒跑 ==========
{
  const dbPath = copyDb(GOOD);
  const db = new Database(dbPath);
  db.prepare("DELETE FROM meta WHERE key='model'").run();          // 伪装 v1 旧库
  let threw = null;
  try { assertEngine(db, DEFAULT_EMBED); } catch (e) { threw = e; } // 真向量 384 维 == e5 → 应放行
  ok(!threw, "卫兵: 无标记旧库按维度放行（384 维匹配）", threw?.message || "");
  db.prepare("UPDATE chunks SET emb=randomblob(2048)").run();      // 全部改成 512 维假向量
  threw = null;
  try { assertEngine(db, DEFAULT_EMBED); } catch (e) { threw = e; }
  db.close();
  ok(threw && /维度不一致/.test(threw.message), "卫兵: 无标记旧库维度不符被拒", threw?.message || "未抛错");
}

// ========== 3) hybridSearch 入口挂卫兵：引擎不匹配整体拒跑 ==========
{
  const dbPath = copyDb(GOOD);
  const db = new Database(dbPath);
  db.prepare("UPDATE meta SET value='m3' WHERE key='model'").run();
  db.close();
  let threw = null;
  try { await hybridSearch(dbPath, "学习", 3, { rerank: false }); } catch (e) { threw = e; }
  ok(threw && /引擎不一致/.test(threw.message), "卫兵: hybridSearch 对引擎不匹配的库拒跑");
}

// ========== 4) 错误路径关库：拒跑之后文件句柄已释放（能立刻以写模式打开=没泄漏） ==========
{
  const dbPath = copyDb(GOOD);
  const db = new Database(dbPath);
  db.prepare("UPDATE meta SET value='m3' WHERE key='model'").run();
  db.close();
  try { await hybridSearch(dbPath, "学习", 3, { rerank: false }); } catch { /* 预期拒跑 */ }
  let closed = true;
  try { const d = new Database(dbPath); d.exec("CREATE TABLE IF NOT EXISTS _probe(x)"); d.close(); }
  catch { closed = false; }
  ok(closed, "卫兵: 拒跑后 db 已在 finally 关闭（写模式能立即打开）");
}

// ========== 5) LIKE 通配符转义：% _ 不再是通配符 ==========
{
  // "%%%" 不含任何真实字面：FTS 腿 0 命中 → 落 LIKE 腿。转义后匹配字面 "%%%"（文中不存在）
  // → 字面腿贡献 0。旧实现 LIKE '%%%%' 会命中全书、把所有块的 fts 归一化成 1（字面腿假高潮）
  const rs = await hybridSearch(GOOD, "%%%", 5, { rerank: false });
  ok(Array.isArray(rs) && rs.length > 0 && rs.every(r => r.fts === 0),
    `LIKE转义: 纯通配符查询字面腿贡献 0（${rs.length} 块全来自语义腿，fts 全 ${rs.map(r => r.fts).join(",")}）`);
  const rs2 = await hybridSearch(GOOD, "学习后100%_开心吗", 3, { rerank: false });
  ok(Array.isArray(rs2), "LIKE转义: 混合通配符问题不崩溃（数组返回）");
}

// ========== 6) topN 上限：zod 层 + 夹取函数 ==========
{
  ok(!TOPN_SCHEMA.safeParse(999).success, "topN: zod 拒收 999");
  ok(!TOPN_SCHEMA.safeParse(0).success, "topN: zod 拒收 0");
  ok(TOPN_SCHEMA.safeParse(7).success, "topN: zod 放行 7");
  ok(clampTopN(999) === 20 && clampTopN(-3) === 1 && clampTopN(undefined) === 4 && clampTopN("abc") === 4,
    `topN: 夹取函数边界（999→${clampTopN(999)} -3→${clampTopN(-3)} undefined→${clampTopN(undefined)} "abc"→${clampTopN("abc")}）`);
}

// ========== 7) MCP 处理器端到端：topN=999 实际只返回 ≤20 条 ==========
{
  // 夹具：用户在客户端可能把书收起 skill（H3 过滤会让 query_book 查不到）——测试临时开启，finally 还原
  const { loadSkillState, setSkillEnabled } = await import("../src/lib/skill-state.mjs");
  const beforeOn = loadSkillState(LIB)["attention-is-all-you-need-en.pdf"];
  setSkillEnabled(LIB, "attention-is-all-you-need-en.pdf", true);
  try {
    const handlers = new Map();
    const mockServer = { registerTool: (name, spec, fn) => handlers.set(name, fn) };
    registerServerTools(mockServer);
    const resp = await handlers.get("query_book")({ book: "attention", question: "what BLEU score did the big model get on english to german", topN: 999 });
    const out = JSON.parse(resp.content[0].text);
    ok(out.results.length <= 20 && out.results.length > 0, `topN: 处理器端到端 999 被夹取（实际返回 ${out.results.length} 条）`);
    ok(out.results[0].text.toLowerCase().includes("28.4"), "topN: 夹取后检索质量不劣化（28.4 仍在首位）");
  } finally {
    setSkillEnabled(LIB, "attention-is-all-you-need-en.pdf", beforeOn !== false);
  }
}

// ========== 8) importCatalog 挂卫兵：库引擎不匹配时入库前就拦 ==========
{
  const dbPath = copyDb(GOOD);
  const db = new Database(dbPath);
  db.prepare("UPDATE meta SET value='m3' WHERE key='model'").run();
  let threw = null;
  // 空任务空结果：若卫兵生效，报错必须是引擎不一致而不是校验失败（卫兵在 validateResult 之前）
  try { await importCatalog(db, {}, {}); } catch (e) { threw = e; }
  db.close();
  ok(threw && /引擎不一致/.test(threw.message), "卫兵: importCatalog 引擎不匹配在入库前拦截", threw?.message?.slice(0, 60) || "未抛错");
}

// ========== 9) routeAndSearch：混引擎书库 → 坏书跳过并声明，好书照常命中 ==========
{
  const libDir = path.join(tmp, "lib");
  fs.mkdirSync(libDir);
  const bad = copyDb(path.join(LIB, "lunyu-xueer-zh.pdf.db"));  // 4 块小书
  const dbBad = new Database(bad);
  dbBad.prepare("UPDATE meta SET value='zh-small' WHERE key='model'").run();
  dbBad.close();
  fs.copyFileSync(bad, path.join(libDir, "bad-book.db"));
  fs.copyFileSync(GOOD, path.join(libDir, "good-book.db"));
  const out = await routeAndSearch("学习之后经常温习会怎么样", { libDir, topN: 3 });
  // 库里只有两本：坏书被跳过后，入选的必然是那本好书（书名取自 meta.title，不查文件名）
  ok(out.routed_books.length === 1 && out.skipped_books?.length === 1, "路由: 混引擎书库只选中未跳过的好书", JSON.stringify({ routed: out.routed_books, skipped: out.skipped_books }));
  ok(Array.isArray(out.skipped_books) && out.skipped_books.length === 1 && /引擎不一致/.test(out.skipped_books[0].reason),
    "路由: 坏书被跳过且带原因声明", JSON.stringify(out.skipped_books || []));
  ok(out.results.length > 0 && /不亦說乎|不亦说乎/.test(out.results[0].text), "路由: 好书结果正常返回");
}

// ========== 10) 静态防回归：真机拖拽/导入链路的三处已修缺陷不许复活 ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");

  // G-01：packaged 态 execPath 是 exe——凡 spawn 必须经 nodeEnv() 补 ELECTRON_RUN_AS_NODE
  const jobsSrc = readSrc("src", "desktop", "jobs.mjs");
  const spawnLines = jobsSrc.split("\n").filter((l) => /\bspawn\(/.test(l) && !l.trimStart().startsWith("//"));
  ok(spawnLines.length >= 2 && spawnLines.every((l) => l.includes("nodeEnv()")),
    `静态: jobs.mjs 每处 spawn 都带 nodeEnv()（防 G-01 复活；实际 ${spawnLines.length} 处：${spawnLines.length}/${spawnLines.length}）`);

  // G-02：Electron 32+ 已移除 File.path——渲染层禁止直接读，必须走 preload 的 filePathOf
  // （只查代码行，注释里说明性提到的字样不算——历史上就是注释先踩了这个假阳性）
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  const viewsSrc = readSrc("src", "renderer", "views.js");
  ok(!/\bf\.path\b/.test(stripComments(viewsSrc)), "静态: 渲染层无 File.path 直读（防 G-02 复活）");
  ok(viewsSrc.includes("filePathOf"), "静态: 渲染层拖拽经 study.filePathOf 取路径");
  const preloadSrc = readSrc("src", "preload.js");
  ok(preloadSrc.includes("getPathForFile"), "静态: preload 暴露 webUtils.getPathForFile");

  // G-03：拖拽拦在 document 级（防浏览器把文件当页面打开 / 落空区静默）
  ok(viewsSrc.includes('document.addEventListener("drop"') && viewsSrc.includes('document.addEventListener("dragover"'),
    "静态: 拖拽监听在 document 级（防 G-03 复活）");

  // G-04：preload 暴露 scanPending；boot 时序在 createWindow 之后
  ok(preloadSrc.includes("jobsScanPending"), "静态: preload 暴露 jobsScanPending（G-04）");
  const mainSrc = readSrc("src", "main.js");
  const callWin = mainSrc.indexOf("createWindow();");
  const scanAt = mainSrc.indexOf("booted?.jobs.scanPending()");
  ok(callWin > -1 && scanAt > callWin, "静态: main.js 启动扫待编目在 createWindow 之后（G-04 时序）");
}

// ========== 11) 静态防回归：V2 云端问答接线契约（P2） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  // ① 渲染层禁止直连外部 API——网络调用只能经 IPC → 主进程（云端问答上线后的新红线）
  const hits = ["views.js", "views-ask.js", "views-chat.js", "views-reader.js", "app.js"]
    .filter((f) => /\bfetch\s*\(/.test(stripComments(readSrc("src", "renderer", f))));
  ok(hits.length === 0, `静态: 渲染层无直连 fetch（防绕过 IPC 调外部 API；命中: ${hits.join(",") || "无"}）`);

  // ② chat.mjs 必须复用 ask() 检索（同一条路径），生成走 askCloud——不许自己重写检索
  const chatSrc = readSrc("src", "desktop", "chat.mjs");
  ok(/await ask\(\{/.test(chatSrc) && chatSrc.includes("askCloud"), "静态: chat.mjs 复用 ask() + askCloud（检索路径唯一）");

  // ③ main.js 必须注入 safeStorage（llm-config 的加密来源，缺了 key 会退化成明文）
  ok(readSrc("src", "main.js").includes("safeStorage"), "静态: main.js 注入 safeStorage（key 加密链）");

  // ④ B1：渲染层检索段数三处同源——问一问/对话两页只许引用 app.js 的 RETRIEVE_TOPN，不许字面量漂移
  const askViewSrc = readSrc("src", "renderer", "views-ask.js");
  const chatViewSrc = readSrc("src", "renderer", "views-chat.js");
  ok(askViewSrc.includes("RETRIEVE_TOPN") && chatViewSrc.includes("RETRIEVE_TOPN")
    && !/topN:\s*\d/.test(stripComments(askViewSrc)) && !/topN:\s*\d/.test(stripComments(chatViewSrc)),
    "静态: 渲染层 topN 统一走 RETRIEVE_TOPN（B1，两页同段数）");
}

// ========== 收尾 ==========
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== 防线包验收结果 =====`);
if (fail) { console.error(`${fail} 项 FAIL`); process.exit(1); }
console.log(`全部 PASS：引擎卫兵/维度兜底/LIKE转义/topN上限/错误路径关库/混引擎路由 ${pass} 项全过`);
