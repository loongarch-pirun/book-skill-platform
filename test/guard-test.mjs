// 防线包验收：引擎一致性卫兵 / LIKE 通配符转义 / topN 上限 / 错误路径关库
// 跑法: node test/guard-test.mjs   （在临时目录做破坏性实验，不碰真库）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { hybridSearch, routeAndSearch, listBooks } from "../src/lib/search.mjs";
import { assertEngine, DEFAULT_EMBED } from "../src/lib/models.mjs";
import { importCatalog } from "../src/lib/catalog.mjs";
import { registerServerTools, TOPN_SCHEMA, clampTopN } from "../src/lib/register-tools.mjs";
// 自家验收豁免对外闸机（W3.5）：本文件起 mock server 只为测工具行为，定时窗/预算/开关
// 不该左右断言（2026-10-21 18:51 主人在桌面端关闸后 CI 时段外会全红的教训；
// 对外拒收语义由 usage-gate-test 带闸直测）
const regTools = (s) => registerServerTools(s, { gate: false });

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
    regTools(mockServer);
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

// ========== 9b) D3 修复回归：坏库逐本隔离，不挂掉全库问答 ==========
// 修复前：routeAndSearch 的 new Database/fullScan 在 try 外（主扫 + 粗筛重扫 + picked 后检索），
// 一本坏库炸掉全库问答。用「向量损坏库」精确命中主扫循环（垃圾字节文件会被 scanBooks 前置
// 过滤——那是另一道既有防线；fp 缓存命中+文件原位变坏的竞态窗口 mtime 纳秒精度无法在测试还原）。
{
  const libDir = path.join(tmp, "lib-d3");
  fs.mkdirSync(libDir);
  const broken = copyDb(path.join(LIB, "lunyu-xueer-zh.pdf.db"));
  const dbB = new Database(broken);
  dbB.prepare("UPDATE chunks SET emb=X'00' WHERE emb IS NOT NULL").run();  // 1 字节假向量
  dbB.close();
  fs.copyFileSync(broken, path.join(libDir, "broken-book.db"));
  fs.copyFileSync(GOOD, path.join(libDir, "good-book.db"));
  let out = null, threw = null;
  try { out = await routeAndSearch("学习之后经常温习会怎么样", { libDir, topN: 3 }); }
  catch (e) { threw = e; }
  ok(!threw, `路由: 坏库不穿层（D3；${threw ? `仍抛: ${String(threw.message).slice(0, 60)}` : "正常返回"}）`);
  ok(Array.isArray(out?.skipped_books) && out.skipped_books.length === 1,
    "路由: 坏库进 skipped_books 记账", JSON.stringify(out?.skipped_books || []));
  ok(out?.results.length > 0 && /不亦說乎|不亦说乎/.test(out.results[0].text),
    "路由: 坏库旁边的照常好书结果正常返回");
  ok(out?.routed_books.length === 1, "路由: 只路由到好书（坏库 0 分被挡不冒充）", JSON.stringify(out?.routed_books || []));
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

  // F7 渲染转义护栏（C30 防回退）：引用徽标单点定义 renderCite（ask/chat 五处共用，
  // 「漏一处 esc」结构上不可能）；views-reader 的 data-bid/id 前缀必须 esc（自查扩面）；
  // 高亮定位走 getElementById（querySelector 拼 raw id 会因特殊字符抛选择器异常）
  const askSrc = stripComments(readSrc("src", "renderer", "views-ask.js"));
  const chatSrc = stripComments(readSrc("src", "renderer", "views-chat.js"));
  const readerSrc = stripComments(readSrc("src", "renderer", "views-reader.js"));
  ok(/export const renderCite = /.test(stripComments(viewsSrc))
    && /renderCite\(x\)/.test(askSrc) && /renderCite\(x\)/.test(chatSrc)
    && !/data-cid="\$\{x\.id/.test(askSrc) && !/data-cid="\$\{x\.id/.test(chatSrc),
    "静态: 引用徽标走 renderCite 单点（ask/chat 无裸 data-cid 拼装，C30 防回退）");
  ok(/data-bid="\$\{esc\(x\.id \?\? ""\)\}"/.test(readerSrc) && /id="blk-\$\{esc\(x\.id \?\? ""\)\}"/.test(readerSrc),
    "静态: views-reader 的 data-bid/id 前缀都过 esc（C30 同族自查扩面）");
  ok(/function scrollToHighlight[\s\S]{0,300}?getElementById/.test(readerSrc),
    "静态: 高亮定位走 getElementById（不解析选择器，id 含特殊字符不崩——F7-O4）");
  // 转义纪律通用红线（测试验证师 F7-O2）：所有渲染文件的 data-cid/data-bid/id="blk-
  // 插值必须 esc 开头——比逐处断言通用，今后新增引用徽标忘了走 renderCite 也会红
  const allRenderSrc = ["views.js", "views-ask.js", "views-chat.js", "views-reader.js", "app.js"]
    .map((f) => stripComments(readSrc("src", "renderer", f))).join("\n");
  ok(!/data-(?:cid|bid)="\$\{(?!esc\()/.test(allRenderSrc) && !/id="blk-\$\{(?!esc\()/.test(allRenderSrc),
    "静态: 渲染层 data-cid/data-bid/id 前缀插值必须 esc 开头（转义纪律通用红线）");

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

  // ⑤ P4：云端回答存档链路——成功路径落 appendArchive；删书联动必须串在 books:delete 上
  //    （删书不残留"引用了这本书"的存档——用户删书时期待的就是数据跟着没）
  ok(chatSrc.includes("appendArchive") && chatSrc.includes("purgeBook"),
    "静态: chat.mjs 接线存档（appendArchive + purgeBook）");
  const ipcRegSrc = readSrc("src", "desktop", "ipc.mjs");
  ok(ipcRegSrc.includes("chat:archiveList") && ipcRegSrc.includes("purgeArchives"),
    "静态: ipc.mjs 注册存档通道 + books:delete 删书联动（P4）");

  // ⑥ C5：云端配置卡单一实现——cloudBarHtml 只在 views-ask.js 定义，对话页必须 import 复用，
  //    不许各页复制一份（配置卡漂移=两页保存行为不一致）；且对话页不许再出现跳页配置入口
  ok(/export function cloudBarHtml/.test(askViewSrc)
    && chatViewSrc.includes("cloudBarHtml")
    && !stripComments(chatViewSrc).includes("chatcfg"),
    "静态: 配置卡单一实现（C5：对话页复用 ask 页 cloudBarHtml，无第二份）");

  // ⑦ C4：顶栏云端 chip 必须接线——boot 里 bindCloudChip + 拉配置后 paintCloudChip；
  //    chip 只回显模型名/尾号，不许回显 key 全文（llm-config 红线在 UI 侧的落点）
  const appSrc = readSrc("src", "renderer", "app.js");
  ok(appSrc.includes("bindCloudChip") && appSrc.includes("paintCloudChip")
    && /paintCloudChip\(\)/.test(appSrc),
    "静态: 顶栏云端 chip 接线（C4：bind + boot 后 paint）");
  const indexSrc = readSrc("src", "index.html");
  ok(indexSrc.includes('id="cloudChip"'), "静态: index.html 带 cloudChip 节点（C4）");

  // ⑧ 技能×编目融合：新增五工具必须注册（MCP 7→12）；新能力走独立文件，检索层不许被碰
  const toolsSrc = readSrc("src", "lib", "register-tools.mjs");
  ok(["get_person", "get_theme", "similar_chunks", "expand", "lookup"].every(t => toolsSrc.includes(`"${t}"`)),
    "静态: register-tools 注册 get_person/get_theme/similar_chunks/expand/lookup（MCP 7→12）");
  ok(readSrc("src", "lib", "skill-store.mjs").includes("catalog\\.json"),
    "静态: skill-store 白名单放行 catalog.json（P-A 皮骨同包）");
  const catSkillSrc = readSrc("src", "lib", "catalog-skill.mjs");
  const similarSrc = readSrc("src", "lib", "similar.mjs");
  ok(!/hybridSearch|loadCatalogSignal/.test(stripComments(catSkillSrc))
    && !/hybridSearch|loadCatalogSignal/.test(stripComments(similarSrc)),
    "静态: 骨架生成器/相似查询不碰检索算法（检索层零改动红线）");
  ok(catSkillSrc.includes("GROUP BY chapter") && catSkillSrc.includes("MAX_CHUNK_IDS"),
    "静态: 骨架章节表从 chunks 实查 + 锚点封顶（永不吹牛）");
}

// ========== 12) 静态防回归：洗数据一键入口接线契约（V3 第二波 #140） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  // ① 四通道注册（启动/取消/状态/复查）+ preload 暴露 + 事件订阅口
  const ipcRegSrc = readSrc("src", "desktop", "ipc.mjs");
  ok(["enrich:start", "enrich:cancel", "enrich:status", "enrich:audit"].every((ch) => ipcRegSrc.includes(`"${ch}"`)),
    "静态: ipc.mjs 注册 enrich 四通道（#140）");
  const preloadSrc = readSrc("src", "preload.js");
  ok(["enrichStart", "enrichCancel", "enrichStatus", "enrichAudit", "onEnrichProgress"].every((k) => preloadSrc.includes(k)),
    "静态: preload 暴露 enrich 五口（四调用 + 进度订阅）");

  // ② main.js 转发 enrich:progress（onEnrichProgress 注册 + send 到渲染层）
  const mainSrc = readSrc("src", "main.js");
  ok(mainSrc.includes("onEnrichProgress") && mainSrc.includes('"enrich:progress"'),
    "静态: main.js 转发 enrich:progress 事件（#140）");

  // ③ enrich-job.mjs 不碰检索算法（新能力走独立文件，检索层零改动红线）
  const ejSrc = stripComments(readSrc("src", "desktop", "enrich-job.mjs"));
  ok(!/hybridSearch|routeAndSearch|multiVariantSearch/.test(ejSrc),
    "静态: enrich-job 不碰检索算法（检索层零改动）");
  // ④ 本层不直接写库——唯一写路是 importEnrich（lib 层有指纹回滚守卫）；禁直接 SQL 写 chunks
  ok(ejSrc.includes("importEnrich") && !/UPDATE\s+chunks|INSERT\s+INTO\s+chunks/i.test(ejSrc),
    "静态: enrich-job 只经 importEnrich 写库（不直接 SQL 碰 chunks）");
  // ⑤ 跑批失败不 throw 穿层：runPipeline 内部 catch 落 failed 态（lib 层铁律同款）
  ok(/catch[\s\S]*?emit\(id, \{ stage: "failed"/.test(ejSrc),
    "静态: enrich-job 后台失败落 failed 态不穿层");

  // ⑥ 渲染层洗数据入口走 IPC：书架按钮 + 重试分支 + 汇流订阅，不许渲染层自己跑
  const viewsSrc = readSrc("src", "renderer", "views.js");
  const askSrc = readSrc("src", "renderer", "views-ask.js");
  const appSrc = readSrc("src", "renderer", "app.js");
  ok(viewsSrc.includes('data-action="enrich"') && askSrc.includes("enrichStart") && askSrc.includes("enrichretry"),
    "静态: 书架洗数据按钮经 IPC（views 按钮 + ask 页 enrichStart/enrichretry）");
  ok(appSrc.includes("onEnrichProgress") && appSrc.includes("enrichStatus"),
    "静态: app.js 汇流 enrich 进度 + boot 恢复任务态（#140）");

  // ⑦ 书架摘要挂载：booksList 带 enrich 字段（轻量只读，不做全库指纹）
  const engSrc = readSrc("src", "desktop", "engine.mjs");
  ok(/enrich: enrichSummary/.test(engSrc) && engSrc.includes("function enrichSummary"),
    "静态: booksList 挂 enrich 摘要（#140 书架徽标）");

  // ⑧ P4 洗数据闸门四件套（块结构指纹 / 双档闸门 / 前门体检 / 桌面可见性）
  // stripAll：整行+块注释+行尾注释全剔——行尾注释 `const id = bookId; // safeBookId(bookId)`
  // 能让 includes 断言假绿（P5 §15 同款教训，本节复用）
  const stripAll = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => {
    if (l.trimStart().startsWith("//")) return "";
    const i = l.indexOf("//");
    return i >= 0 && !/["'`]/.test(l.slice(0, i)) ? l.slice(0, i) : l;
  }).join("\n");
  const eiSrc = stripAll(readSrc("src", "lib", "enrich-import.mjs"));
  const enSrc = stripAll(readSrc("src", "lib", "enrich.mjs"));
  // a. 指纹：chunkFingerprint 存在且 buildEnrichTasks 带 chunk_fp/eligible 出海
  ok(/export function chunkFingerprint\(/.test(enSrc) && /chunk_fp: chunkFingerprint\(/.test(enSrc)
    && /eligible: eligible\.length/.test(enSrc),
    "静态: chunkFingerprint 存在且任务书带 chunk_fp/eligible（P4 结构判据）");
  // b. 缓存结构判据：loadEnrichCache 第三参 + STRUCT 原因
  ok(/loadEnrichCache\(jsonlPath, contentHash, chunkFp\)/.test(enSrc) && /"STRUCT"/.test(enSrc),
    "静态: loadEnrichCache 读 meta.chunk_fp，不符 → staleReason=STRUCT");
  // b2. A7 修复（毛求疵对抗审查）：调用方传了 chunkFp 而 meta 无 chunk_fp → 结构不可判同样
  // stale——「无指纹」不等于「没变过」，旧条目按 idx 硬套新块就是静默串味（同 content_hash
  // 重加工全链路实证）。两参旧调用不传 chunkFp 故不受影响（compactEnrichArtifact 重读）。
  ok(/const fpStale = !!chunkFp && \(out\.fp == null \|\| out\.fp !== chunkFp\);/.test(enSrc),
    "静态: A7 修复——无 chunk_fp 的缓存按结构不可判 stale（fpStale 含 out.fp == null）");
  ok(/缓存是旧格式（没有块结构指纹）/.test(enSrc),
    "静态: 无指纹缓存的 STALE 消息分叉说人话（不渲染 null → fp）");
  // c. 闸门：importEnrich 在事务与 schema 之前调用 evaluateEnrichGate（源码顺序断言；
  //    ensureEnrichSchema(db) 要带分号才是调用点——函数定义也在本文件里，不带会误命中定义）
  const gateCall = eiSrc.indexOf("evaluateEnrichGate({");
  const schemaCall = eiSrc.search(/ensureEnrichSchema\(db\)\s*;/);
  ok(gateCall > 0 && schemaCall > 0 && gateCall < schemaCall
    && gateCall < eiSrc.indexOf("const tx = db.transaction"),
    "静态: evaluateEnrichGate 在 ensureEnrichSchema/事务之前（block 才可能一个字符都不写）");
  // d. STALE_STRUCT 拒收码 + meta.enrich_gate 写入点
  ok(/"STALE_STRUCT"/.test(eiSrc) && /'enrich_gate'/.test(eiSrc),
    "静态: STALE_STRUCT 拒收码与 meta.enrich_gate 落账点俱在");
  // e. 前门体检：runEnrich 调 detectGarbled + DIRTY 码 + BSP_ENRICH_DIRTY 逃生
  ok(/detectGarbled\(/.test(enSrc) && /code: "DIRTY"/.test(enSrc) && /BSP_ENRICH_DIRTY/.test(enSrc),
    "静态: 脏库前门体检（detectGarbled→DIRTY→BSP_ENRICH_DIRTY 逃生）");
  ok(/detectGarbled/.test(enSrc) && enSrc.indexOf("detectGarbled(") < enSrc.indexOf("const batches = makeBatches"),
    "静态: 脏库体检在任何批次组织之前（云端调用之前拒洗）");
  // f. 桌面可见性：GATE/DIRTY 分支标签 + 徽标 warn 样式 + engine 读 enrich_gate
  const ejSrc2 = stripAll(readSrc("src", "desktop", "enrich-job.mjs"));
  ok(ejSrc2.includes('imp.code === "GATE"') && ejSrc2.includes('r.code === "DIRTY"'),
    "静态: enrich-job 分流 GATE/DIRTY（标签分开，病因不混）");
  ok(/enrichGate/.test(engSrc) && /enrich_gate/.test(engSrc),
    "静态: engine 书架摘要读 meta.enrich_gate（warn 徽标数据源）");
  const cssSrc = readSrc("src", "renderer", "app.css");
  ok(cssSrc.includes(".tag.enr.warn") && viewsSrc.includes("enr warn"),
    "静态: warn 徽标有样式且 views 认这个态（P4 书架可见性）");
}

// ========== 13) 静态防回归：原书视图接线契约（V3 第四波 #166） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  // ① 两通道注册 + preload 暴露（book:// 内容不走 IPC，渲染层直接 fetch）
  const ipcRegSrc = readSrc("src", "desktop", "ipc.mjs");
  ok(["book:original", "book:openExternal"].every((ch) => ipcRegSrc.includes(`"${ch}"`)),
    "静态: ipc.mjs 注册 book 两通道（#166）");
  const preloadSrc = readSrc("src", "preload.js");
  ok(["bookOriginal", "bookOpenExternal"].every((k) => preloadSrc.includes(k)),
    "静态: preload 暴露 book 两口（#166）");

  // ② main.js 注册协议 + shell 注入（openExternal 走主进程 shell，渲染层无 Node 能力）
  const mainSrc = readSrc("src", "main.js");
  ok(mainSrc.includes('protocol.handle("book"') && mainSrc.includes("createAssetProtocol"),
    "静态: main.js 注册 book:// 协议（#166）");
  ok(/registerIpc\(\{[^}]*shell/.test(mainSrc.replace(/\n/g, " ")),
    "静态: registerIpc 注入 shell（#166 系统打开）");

  // ③ book-view.mjs 防穿越不旁路：只经 safeBookId + resolveAsset（与 assets.mjs 同一把闸门）
  const bvSrc = stripComments(readSrc("src", "desktop", "book-view.mjs"));
  ok(bvSrc.includes("safeBookId") && bvSrc.includes("resolveAsset") && !/existsSync\(.*bookId/.test(bvSrc),
    "静态: book-view 走 safeBookId+resolveAsset（不自己拼路径）");
  // ④ 本模块零 Electron 依赖（协议 handler 可单测——book-view-test 直接调）
  ok(!/require\("electron"\)|from "electron"/.test(bvSrc),
    "静态: book-view 不 import electron（handler 可在 node 下单测）");

  // ⑤ 渲染层入口：看原件/返回块视图/系统打开三个动作 + raw 书 fallback
  const rdSrc = readSrc("src", "renderer", "views-reader.js");
  ok(["data-action=\"original\"", "data-action=\"backblocks\"", "data-action=\"openexternal\""].every((s) => rdSrc.includes(s)),
    "静态: views-reader 原书视图三动作接线（#166）");
  ok(rdSrc.includes("bookOriginal") && rdSrc.includes("bookOpenExternal") && rdSrc.includes('class="origframe"'),
    "静态: 原书视图走 IPC 取元信息 + iframe 加载 book://（不 fetch，守渲染层无直连红线）");
  ok(/status === "raw"[\s\S]{0,80}loadOriginal/.test(rdSrc),
    "静态: raw 书（无块）fallback 原书视图（#166）");
}

// ========== 14) 静态防回归：导入拆两段接线契约（V3 第四波 #167） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  // ① 两段边界：startImport 函数体不许出现切片/向量化/编目三段的调用（拆段防回退——
  //    一段只复制登记；用户先看原文，算力花不花自己定）
  const jobsSrc = stripComments(readSrc("src", "desktop", "jobs.mjs"));
  const importAt = jobsSrc.indexOf("export async function startImport(");
  const procAt = jobsSrc.indexOf("export async function startProcessing(");
  ok(importAt > -1 && procAt > importAt, "静态: jobs.mjs 导出 startImport + startProcessing 两段（#167）");
  const importBody = jobsSrc.slice(importAt, procAt);
  ok(!/buildBook\.main|runEmbed\(|clusterChunks\(|txtToDocx\(/.test(importBody),
    "静态: startImport 只复制登记（不碰切片/向量化/编目/txt转换——#167 第一段边界）");
  const procBody = jobsSrc.slice(procAt, jobsSrc.indexOf("export async function resumeCatalog("));
  ok(/buildBook\.main/.test(procBody) && /runEmbed\(/.test(procBody) && /clusterChunks\(/.test(procBody),
    "静态: startProcessing 承接四步管线（切片/向量化/编目都在第二段）");

  // ② 第二段从 books/ 定位原件：safeBookId 闸门 + resolveAsset（不认拖拽原路径）
  ok(/safeBookId\(/.test(procBody) && /resolveAsset\(/.test(procBody),
    "静态: startProcessing 经 safeBookId + resolveAsset（防穿越 + 资产层定位）");

  // ③ 三处接线：ipc 通道 / preload 暴露 / 渲染层按钮与动作
  const ipcRegSrc = readSrc("src", "desktop", "ipc.mjs");
  ok(ipcRegSrc.includes('"jobs:start"') && ipcRegSrc.includes("jobs.startProcessing"),
    "静态: ipc.mjs 注册 jobs:start → startProcessing（#167）");
  const preloadSrc = readSrc("src", "preload.js");
  ok(preloadSrc.includes("jobsStart"), "静态: preload 暴露 jobsStart（#167）");
  const viewsSrc = readSrc("src", "renderer", "views.js");
  ok(viewsSrc.includes('data-action="process"') && /raw\s*=\s*b\.status === "raw"/.test(viewsSrc),
    "静态: 书架 raw 卡片带「开始加工」按钮（#167，洗数据按钮 raw 不显示）");
  const askSrc = readSrc("src", "renderer", "views-ask.js");
  ok(askSrc.includes("jobsStart") && /act === "process"/.test(askSrc),
    "静态: views-ask 接线 process 动作 + 两段式重试（#167）");
}

// ========== 15) 静态防回归：两档删除接线契约（V3 第四波 #168） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  // ① engine 两档导出 + 边界：purgeBook 删 asset.path（一体删），deleteBook 不许碰原件
  const engSrc = stripComments(readSrc("src", "desktop", "engine.mjs"));
  ok(/export function deleteBook\(/.test(engSrc) && /export function purgeBook\(/.test(engSrc),
    "静态: engine 导出 deleteBook + purgeBook 两档（#168）");
  const purgeAt = engSrc.indexOf("export function purgeBook(");
  const purgeBody = engSrc.slice(purgeAt, engSrc.indexOf("\nexport ", purgeAt + 10));
  ok(/rmSync\(asset\.path/.test(purgeBody) && /resolveAsset\(/.test(purgeBody),
    "静态: purgeBook 删 books/ 原件（resolveAsset 定位 + rmSync(asset.path)，一体全删）");
  const delAt = engSrc.indexOf("export function deleteBook(");
  const delBody = engSrc.slice(delAt, purgeAt);
  ok(!/rmSync\(asset\.path/.test(delBody),
    "静态: deleteBook 不删 books/ 原件（第一档=删库留原件，书架回 raw 可重建）");
  // 删除顺序契约：先 wal/shm 后主库——主库是「书还在不在」的判定依据，反序会留
  // wal/shm 僵尸且「书还在却丢了未 checkpoint 写入」（F5 顺序改动锁）
  const orderHits = (engSrc.match(/\["-wal", "-shm", ""\]/g) || []).length;
  ok(orderHits === 2, "静态: 两档删除都先 wal/shm 后主库（顺序契约，命中 2 处）", `命中 ${orderHits} 处`);

  // ② 三处接线：ipc 通道 / preload 暴露 / 渲染层两档按钮与确认清单
  const ipcRegSrc = readSrc("src", "desktop", "ipc.mjs");
  ok(ipcRegSrc.includes('"books:purge"') && ipcRegSrc.includes("eng.purgeBook"),
    "静态: ipc.mjs 注册 books:purge → purgeBook（#168）");
  const preloadSrc = readSrc("src", "preload.js");
  ok(preloadSrc.includes("purgeBook"), "静态: preload 暴露 purgeBook（#168）");

  // ③ 渲染层按钮分流：raw 卡只有彻底删除；processed 卡移出书架 + 彻底删除两档
  // V4（2026-10-20）：两档收进「⋯」菜单（menuDanger），断言按分支实质校验——raw 段只许 purge、
  // processed 段 del+purge 必须都在（变量名可变，分流语义不可变）
  const viewsSrc = readSrc("src", "renderer", "views.js");
  const cardAt = viewsSrc.indexOf("function bookCard(");
  const cardBody = viewsSrc.slice(cardAt, viewsSrc.indexOf("\nfunction ", cardAt + 10));
  const menuAt = cardBody.indexOf("const menuDanger");
  const rawAt = cardBody.indexOf("? ", menuAt);
  const colonAt = cardBody.indexOf(": ", rawAt);
  const rawSeg = cardBody.slice(rawAt, colonAt);
  const procSeg = cardBody.slice(colonAt, cardBody.indexOf(";\n", colonAt));
  ok(menuAt > 0 && rawSeg.includes('data-action="purge"') && !rawSeg.includes('data-action="del"')
    && procSeg.includes('data-action="del"') && procSeg.includes('data-action="purge"'),
    "静态: raw 卡仅彻底删除 / processed 卡移出+彻底两档（#168 按钮分流，V4 收进 ⋯ 菜单）");
  // ④ 两个动作都拨通 IPC + 彻底删除带确认清单（asset/chunks 数从书架数据来）
  // 窗口 900 而非 600：P5 在确认清单里加了一行派生说明，把 purgeBook 调用点推远了——
  // 这条断言的语义是「该分支拨通的确实是 purgeBook」，不是精确距离（距离型断言本就脆）
  ok(/act === "purge"[\s\S]{0,900}window\.study\.purgeBook/.test(viewsSrc),
    "静态: 彻底删除动作拨通 purgeBook（#168）");
  ok(/act === "purge"[\s\S]{0,900}不可恢复/.test(viewsSrc) && /asset\?\.exists/.test(viewsSrc),
    "静态: 彻底删除确认清单先行（books/ 原件在不在按 asset.exists 说实情）");
  // ⑤ 通道契约同步：ipc-test EXPECTED 含 books:purge
  const ipcTestSrc = readSrc("test", "ipc-test.mjs");
  ok(ipcTestSrc.includes('"books:purge"'), "静态: ipc-test EXPECTED 含 books:purge（#168 通道对账）");

  // ⑥ P5 一体删除（2026-10-18）：派生六落点只挂在 purgeBook，deleteBook 明确不清。
  // 本节用比 stripComments 更严的剥离器：整行注释、块注释、行尾注释全剔——
  // includes/正则型断言在行尾注释面前会被骗过（陆回测 OBSERVE-4 实测：
  // `const id = bookId; // safeBookId(bookId)` 能让 §15 的闸门断言假绿）。
  const stripAll = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => {
      if (l.trimStart().startsWith("//")) return "";
      const i = l.indexOf("//");
      // 行尾注释：仅当 "//" 前没有引号时剔除（避免切坏字符串字面量里的 //）
      return i >= 0 && !/["'`]/.test(l.slice(0, i)) ? l.slice(0, i) : l;
    })
    .join("\n");
  const engStrict = stripAll(readSrc("src", "desktop", "engine.mjs"));
  const purgeAtS = engStrict.indexOf("export function purgeBook(");
  const purgeBodyS = engStrict.slice(purgeAtS, engStrict.indexOf("\nexport ", purgeAtS + 10));
  const delAtS = engStrict.indexOf("export function deleteBook(");
  const delBodyS = engStrict.slice(delAtS, purgeAtS);
  const derivedSrc = stripAll(readSrc("src", "lib", "derived.mjs"));
  // 参数名不绑死：P5 大小写归一后调用是 purgeDerived(libDir, id)，早先写死 bookId
  // 会让 guard 在「已修正」的代码上报红（本轮实测）。锁的是「传了 libDir + 一个 id 变量」
  ok(/purgeDerived\(\s*libDir\s*,\s*[A-Za-z_$][\w$]*\s*\)/.test(purgeBodyS),
    "静态: purgeBook 调 purgeDerived 清派生（参数=libDir + 归一后的 id 变量）");
  ok(!/purgeDerived\(/.test(delBodyS),
    "静态: deleteBook 不调 purgeDerived（移出书架不清派生——重建可复用，省一次云端洗数据）");
  ok(derivedSrc.includes("safeBookId(") && !/readdirSync|glob|\.match\(/.test(derivedSrc),
    "静态: derived.mjs 过 safeBookId 闸门、不 glob 不扫目录（精确拼接，防前缀误伤）");
  ok(!/recursive/.test(derivedSrc),
    "静态: derived.mjs 不递归删除（只删单个普通文件，目录/链接跳过）");
  // 六落点必须「目录↔后缀」成对且恰好 6 条：老写法分别断言「三个后缀都出现 +
  // 四个目录都出现」，互换后缀（catalog-tasks/.jsonl, enrich-results/.json）照样全绿
  const pairs = [
    ["catalog-tasks", ".json"], ["catalog-tasks", ".prompt.md"],
    ["catalog-results", ".json"], ["enrich-tasks", ".json"],
    ["enrich-results", ".json"], ["enrich-results", ".jsonl"],
  ];
  const entryLines = derivedSrc.split("\n").filter((l) => /dir:\s*"/.test(l) && /suffix:\s*"/.test(l));
  ok(entryLines.length === 6
    && pairs.every(([d, s]) => entryLines.some((l) => l.includes(`"${d}"`) && l.includes(`"${s}"`))),
    `静态: 六落点「目录↔后缀」成对且恰好 6 条（实测 ${entryLines.length} 条；互换或增删都会红）`);
  // ⑦ 防漂移：上面 ⑥ 锁的是 derived 自己写的那张表，锁错了对象照样全绿。
  // 真正的雷是「生产写入方改了文件名，derived 没跟」——直接对写入方断言命名。
  const jobsSrc = stripAll(readSrc("src", "desktop", "jobs.mjs"));
  ok(jobsSrc.includes("`${id}.json`") && jobsSrc.includes("`${id}.prompt.md`"),
    "静态: jobs.mjs 落盘命名 <id>.json / <id>.prompt.md 与 derived 候选一致（防漂移）");
  const enrichSrc = stripAll(readSrc("src", "lib", "enrich.mjs"));
  ok(enrichSrc.includes('dbName.replace(/\\.db$/, "") + ".jsonl"')
    && enrichSrc.includes('dbName.replace(/\\.db$/, "") + ".json"'),
    "静态: enrich.mjs 产物命名 <id>.json / <id>.jsonl 与 derived 候选一致（防漂移）");
}

// ========== 16) 静态防回归：结构化改造接线契约（V3 第四波 P2） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  // ① lib 层存在且导出五件套（纯函数零依赖——单测可 node 直跑的根本）
  const libSrc = readSrc("src", "lib", "structurize.mjs");
  for (const fn of ["detectGarbled", "repairMojibake", "structurizeChunks", "assessCleaned", "structChanged"]) {
    ok(new RegExp(`export function ${fn}\\(`).test(libSrc), `静态: structurize.mjs 导出 ${fn}（P2 五件套）`);
  }

  // ② build-book 顺序契约：结构化改造在语义分块之前（流程=结构化改造→切片→洗数据）
  const bbSrc = stripComments(readSrc("src", "build-book.js"));
  const structAt = bbSrc.indexOf("structurizeChunks(parsed.chunks)");
  const sliceAt = bbSrc.indexOf('process.env.BSP_SEMANTIC === "1"');
  ok(structAt > -1 && sliceAt > -1 && structAt < sliceAt,
    "静态: build-book 先结构化改造后语义分块（P2 流程顺序：结构化改造→切片→洗数据）");
  // ③ 开关 + 后置硬闸门：BSP_STRUCT=0 整段跳过；修不完的拦在烧算力之前（不建库）
  // 开关判定须归一化后与 "0" 精确比较（P2-04）——存在性判定不锁写法（?? / || 等价
  // 实现不误红），精确语义由 fuzz F4 十值矩阵行为断言兜底
  ok(/BSP_STRUCT[\s\S]{0,300}?\.trim\(\)\s*===?\s*"0"/.test(bbSrc) && /await import\("\.\/lib\/structurize\.mjs"\)/.test(bbSrc),
    "静态: BSP_STRUCT=0 逃生开关在（归一化后精确比较，语义由 F4 行为矩阵锁）");
  const gateAt = bbSrc.indexOf("assessCleaned(parsed.chunks, st.report)");
  ok(gateAt > -1 && /if \(!gate\.ok\) \{[\s\S]{0,200}?process\.exitCode = 1;[\s\S]{0,80}?return;/.test(bbSrc.slice(gateAt)),
    "静态: assessCleaned 硬闸门拦在切片前（exitCode=1 + return，不烧算力不建库）");
  // ④ 账进 meta + onStage 两段（桌面横幅据此分格；CLI 不传即静默）
  ok(/setMeta\.run\("struct_report"/.test(bbSrc), "静态: 清洗账写 meta.struct_report（可审计）");
  ok(/opts\.onStage\?\.\("structurize"\)/.test(bbSrc) && /opts\.onStage\?\.\("slice"\)/.test(bbSrc),
    "静态: onStage 两段回调 structurize → slice（P2 横幅分格）");
  // ⑤ main 返回 struct（jobs 横幅账的源头）
  ok(/struct: parsed\.struct \|\| null/.test(bbSrc), "静态: main 返回 struct（jobs 横幅清洗账源头）");

  // ⑥ jobs 横幅：结构化改造单独占一格 + 切片一格 + 真洗了才刷账
  const jobsSrc = stripComments(readSrc("src", "desktop", "jobs.mjs"));
  ok(/label: "结构化改造中"/.test(jobsSrc) && /detail: "清洗坏数据\/不全数据\/乱码符号，过了才切片"/.test(jobsSrc),
    "静态: jobs 横幅「结构化改造中」一格（P2 阶段可见）");
  ok(/onStage: \(s\) => \{[\s\S]{0,200}?if \(s === "slice"\) emitG?\((?:id, )?\{ stage: "slice", label: "切片中"/.test(jobsSrc),
    "静态: onStage slice → 横幅转「切片中」（结构化改造/切片两格分明；emit/emitG 两写法兼容）");
  ok(/const st = r\.struct;[\s\S]{0,300}?结构化改造：去空块/.test(jobsSrc),
    "静态: 真洗了东西横幅才刷账（干净的书零刷屏——存量行为零变化）");

  // ⑦ 测试挂载对账：structurize-test 进 fast（防「写了测试没挂」）
  const pkgSrc = JSON.parse(readSrc("package.json"));
  ok((pkgSrc.scripts["test:fast"] || "").includes("structurize-test"),
    "静态: package.json test:fast 含 structurize-test（P2 验收挂载）");
}

// ========== 17) 静态对账：入口对抗套件落盘 + 挂载（V3 第四波标准轮 S2） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");

  // ① 套件本体落盘在 test/ 根（57 发：A13/B6/C19/D4/E5/F10），自包含对抗套件（头部声明即身份）
  // 对账改成机械计数（毛 O/F 观察）：只锁「56」这个字面量挡不住「加了 C19 却没改头部」，
  // 声明数 != 索引行数 时必须响
  const fuzzSrc = readSrc("test", "entry-adversarial-fuzz.mjs");
  const declared = Number((/\/\/ (\d+) 发索引与 ledger 缺陷对照/.exec(fuzzSrc) || [])[1]);
  const idxCount = (fuzzSrc.match(/^\/\/ {3}[A-F]\d+[a-z]? /gm) || []).length;
  ok(fuzzSrc.includes("入口链路 + 结构化改造对抗 fuzz") && declared === idxCount && idxCount === 57,
    `静态: entry-adversarial-fuzz.mjs 落盘（头部声明 ${declared} 发 / 索引实计 ${idxCount} 条，双向对账）`);
  // ②③ 挂载对账：fast 与 ci 都含新套件（防「写了套件没挂」——S2 步骤 4 挂载的静态锁）
  const pkgSrc = JSON.parse(readSrc("package.json"));
  ok((pkgSrc.scripts["test:fast"] || "").includes("entry-adversarial-fuzz"),
    "静态: package.json test:fast 含 entry-adversarial-fuzz（对抗套件挂 fast）");
  ok((pkgSrc.scripts["test:ci"] || "").includes("entry-adversarial-fuzz"),
    "静态: package.json test:ci 含 entry-adversarial-fuzz（对抗套件挂 ci）");
}

// ========== 18) P3 切片 v4 三件套（表格整表成块 / chapter_path / 邻块扩展） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const bbSrc = readSrc("src", "build-book.js");
  const stripAll = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
  const bb = stripAll(bbSrc);
  const searchSrc = stripAll(readSrc("src", "lib", "search.mjs"));
  const llmSrc = stripAll(readSrc("src", "lib", "llm.mjs"));
  const viewsSrc = stripAll(readSrc("src", "renderer", "views.js"));
  const pkgSrc = JSON.parse(readSrc("package.json"));

  // ① 表格整表成块：合并函数在位 + 整表块跳过 sentenceSplit + 逃生开关归一化
  ok(bb.includes("function packTable") && bb.includes("function mergeTableRows"),
    "静态: packTable/mergeTableRows 落盘（P3-① 表格整表成块）");
  ok((bb.match(/if \(it\.fromTable\) \{ chunks\.push/g) || []).length === 2,
    "静态: docx/md 两路整表块都跳过 sentenceSplit（行内句号不切表）");
  ok(/BSP_TABLE \?\? ""/.test(bb) && /normalize\("NFKC"\)/.test(bb),
    "静态: BSP_TABLE=0 逃生走零宽剥离+NFKC 归一化（P2-04 同款）");
  ok(bb.includes("promotePlainHeadings(items)") || bb.includes("promotePlainHeadings("),
    "静态: 合并在 promote 之后调用序保留（防「下一段更长」误触发回归）");

  // ② chapter_path：解析器建路径 + 建库带列 + 检索探测回退 + 引用/UI 渐进采用
  ok(bb.includes("const chapterPathOf") && bb.includes("chapter_path TEXT"),
    "静态: chapterPathOf 建路径 + 建库 chunks 表带 chapter_path 列");
  ok(bb.includes("INSERT INTO chunks(chapter, chapter_path, page, text)"),
    "静态: 建库 INSERT 写 chapter_path");
  ok(searchSrc.includes("pragma_table_info('chunks')") && searchSrc.includes("chapterPath: hasPath"),
    "静态: search 探测列再取 chapter_path（老库无列回退，不做写迁移）");
  ok(llmSrc.includes("chapterPath: target.chapterPath || null"),
    "静态: 引用构造搭载 chapterPath（additive）");
  ok(/x\.chapterPath \|\| x\.loc/.test(viewsSrc),
    "静态: renderCite 有路径优先展示（老库回退 loc）");

  // ③ 邻块扩展：开关门 + 终排限定 + 衰减 + 同章判据 + 只附加 + 套件挂载
  ok(searchSrc.includes('process.env.BSP_NEIGHBOR === "1" && rerank'),
    "静态: 邻块 BSP_NEIGHBOR=1 开且只跟终排（变体快路 rerank:false 不扩）");
  ok(/\* 0\.5\)\.toFixed\(4\)/.test(searchSrc) && searchSrc.includes("added.length >= 4"),
    "静态: 邻块衰减 ×0.5 计分 + 总数 ≤4（提示词增量可控）");
  ok(searchSrc.includes("c.chapter !== s.chapter"),
    "静态: 邻块同章判据（跨章/空章不扩）");
  ok((pkgSrc.scripts["test:fast"] || "").includes("neighbor-test"),
    "静态: package.json test:fast 含 neighbor-test（P3-③ 挂载）");
}

// ========== 19) 云端清洗接线契约（clean-book） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripAll = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
  const cleanSrc = stripAll(readSrc("src", "lib", "clean.mjs"));
  const impSrc = stripAll(readSrc("src", "lib", "clean-import.mjs"));
  const cliSrc = stripAll(readSrc("src", "clean-book.mjs"));
  const restoreSrc = stripAll(readSrc("src", "clean-restore.mjs"));
  const jobsSrc = stripAll(readSrc("src", "desktop", "jobs.mjs"));
  const pkgSrc = JSON.parse(readSrc("package.json"));

  // ① 导出在位：跑批+护栏 / 落库+恢复 两条链路的关键函数（动态 import 实证）
  const clean = await import("../src/lib/clean.mjs");
  const imp = await import("../src/lib/clean-import.mjs");
  ok(typeof clean.runClean === "function" && typeof clean.applyGuards === "function"
    && typeof clean.matchVerdicts === "function" && typeof clean.isSubstantiveShort === "function",
    "静态: clean.mjs 导出 runClean/applyGuards/matchVerdicts/isSubstantiveShort（跑批+护栏链路）");
  ok(typeof imp.importClean === "function" && typeof imp.rebuildFts === "function"
    && typeof imp.restoreClean === "function" && typeof imp.auditClean === "function",
    "静态: clean-import.mjs 导出 importClean/rebuildFts/restoreClean/auditClean（落库+恢复链路）");

  // ② 检索路径零沾染：clean 四件不 import search/vec-cache（删块只动 chunks/FTS，检索层不感知）
  const allClean = cleanSrc + impSrc + cliSrc + restoreSrc;
  ok(!/search\.mjs|vec-cache|hybridSearch/.test(allClean),
    "静态: clean 四件零沾染检索路径（不 import search.mjs/vec-cache/hybridSearch）");

  // ③ lib 无裸 throw：lib 契约 {ok,code,message} 返回制——唯一穿层例外 CANCELLED（桌面取消闸门）
  ok(!/throw new/.test(cleanSrc) && !/throw new/.test(impSrc),
    "静态: clean lib 零 throw new（错误码返回制）");
  ok(/CANCELLED"\) throw e/.test(cleanSrc),
    "静态: clean.mjs CANCELLED 穿层在位（取消必须穿层，兜底 catch 不许吞）");

  // ④ 落库事务铁律：external content FTS5 表 DELETE 后必须 rebuild（幽灵索引）+ 隔离账留原文
  ok(impSrc.includes("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')"),
    "静态: FTS rebuild 命令在位（external content 表 DELETE 不同步索引）");
  ok(impSrc.includes("text TEXT NOT NULL"),
    "静态: quarantine.text NOT NULL（隔离账必须留原文，恢复才有得插）");

  // ⑤ CLI：三级配置解析 + 不落库逃生 + 恢复薄壳
  ok(cliSrc.includes("BSP_LLM_BASE") && cliSrc.includes("--no-import") && cliSrc.includes("--force-gate"),
    "静态: clean-book CLI 含 BSP_LLM_* 解析/--no-import/--force-gate");
  ok(restoreSrc.includes("restoreClean") && restoreSrc.includes("--ids") && restoreSrc.includes("--dry-run"),
    "静态: clean-restore CLI 薄壳调 restoreClean（--ids/--dry-run 在位）");

  // ⑥ jobs 接线：spawn 带 nodeEnv()（G-01 静态锁）+ enc key 主进程解出走 env + 跳过/GATE 文案
  ok(jobsSrc.includes("CLEAN_SCRIPT") && /spawn\(process\.execPath, \[CLEAN_SCRIPT[^\n]*nodeEnv\(\)/.test(jobsSrc),
    "静态: jobs clean 段 spawn 带 nodeEnv()（G-01 ELECTRON_RUN_AS_NODE 锁）");
  ok(jobsSrc.includes("readLlmKey"),
    "静态: jobs 主进程解 key 走 env（enc 加密 key 子进程解不了）");
  ok(jobsSrc.includes("跳过云端清洗") && jobsSrc.includes("--force --force-gate"),
    "静态: jobs 无配置跳过文案 + GATE 放行指引（--force --force-gate）在位");

  // ⑥b 行级净化接线：spawn 带 nodeEnv()（G-01）+ 位次在 clean 后 embed 前 + 幂等跳过
  ok(jobsSrc.includes("INLINE_SCRIPT") && /spawn\(process\.execPath, \[INLINE_SCRIPT[^\n]*nodeEnv\(\)/.test(jobsSrc),
    "静态: jobs inline 段 spawn 带 nodeEnv()（G-01 ELECTRON_RUN_AS_NODE 锁）");
  {
    const cleanIdx = jobsSrc.indexOf("runCleanBook(id, outDb");
    const inlineIdx = jobsSrc.indexOf("runInlineClean(id, outDb");
    const embedIdx = jobsSrc.indexOf("runEmbed(id, outDb");
    ok(cleanIdx > 0 && inlineIdx > cleanIdx && embedIdx > inlineIdx,
      "静态: 管线位次 clean → inline-clean → embed（块内净化必须在向量化前）");
  }
  ok(jobsSrc.includes("readInlineReport") && jobsSrc.includes("inline_report"),
    "静态: jobs 读 inline_report 拼横幅（净化明细可见）");

  // ⑦ 套件挂载
  ok((pkgSrc.scripts["test:fast"] || "").includes("clean-test"),
    "静态: package.json test:fast 含 clean-test（挂载对账）");
}

// ========== 19.5) 行级清洗接线契约（inline-clean，2026-10-20） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripAll = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
  const libSrc = stripAll(readSrc("src", "lib", "inline-clean.mjs"));
  const impSrc2 = stripAll(readSrc("src", "lib", "inline-import.mjs"));
  const cliSrc2 = stripAll(readSrc("src", "inline-clean.mjs"));
  const pkgSrc3 = JSON.parse(readSrc("package.json"));

  // ① 导出在位（动态 import 实证）：计划+护栏 / 落库+恢复 两条链路
  const lib = await import("../src/lib/inline-clean.mjs");
  const imp2 = await import("../src/lib/inline-import.mjs");
  ok(typeof lib.buildInlinePlan === "function" && typeof lib.planBlock === "function"
    && typeof lib.stripNoiseLines === "function" && typeof lib.splitByReplyBoundary === "function"
    && typeof lib.checkInlineGate === "function" && lib.INLINE_VERSION === 1,
    "静态: inline-clean.mjs 导出 buildInlinePlan/planBlock/strip*/split*/checkInlineGate + INLINE_VERSION=1");
  ok(typeof imp2.importInline === "function" && typeof imp2.restoreInline === "function"
    && typeof imp2.auditInline === "function",
    "静态: inline-import.mjs 导出 importInline/restoreInline/auditInline（落库+恢复链路）");

  // ② 行级铁律：规则全部行级 trim 整行匹配（「楼主」开头行是正文不许子串删）
  ok(libSrc.includes('"floor", re: /^\\d{1,4}楼$/') && !/replace\(.*楼.*,""\)/.test(libSrc),
    "静态: 楼层号行级整行匹配（禁子串删）");
  ok(libSrc.includes("minRemainChars") && libSrc.includes("minReplyChars") && libSrc.includes("minMainChars"),
    "静态: 护栏阈值常量在位（I1 剩余字数/I2 跟帖与主帖下限）");

  // ③ lib 无裸 throw + FTS rebuild + 作废下游（块集合变了 emb 与编目必须重做）
  ok(!/throw new/.test(libSrc) && !/throw new/.test(impSrc2),
    "静态: inline lib 零 throw new（错误码返回制）");
  ok(impSrc2.includes("rebuildFts(db)") && impSrc2.includes("invalidateDownstream"),
    "静态: inline-import FTS rebuild + 作废下游（emb 置 NULL + 删 catalog meta）");
  ok(impSrc2.includes("split_json") && impSrc2.includes("DELETE FROM chunks WHERE id = ?"),
    "静态: 隔离账记 split_json + 恢复删切出的新块（2a 切不删可逆）");

  // ④ CLI 逃生与恢复
  ok(cliSrc2.includes("--dry-run") && cliSrc2.includes("--force-gate") && cliSrc2.includes("--restore"),
    "静态: inline-clean CLI 含 --dry-run/--force-gate/--restore");

  // ⑤ 套件挂载
  ok((pkgSrc3.scripts["test:fast"] || "").includes("inline-clean-test"),
    "静态: package.json test:fast 含 inline-clean-test（挂载对账）");
}

// ========== 20) V3R7-① 数据层 + get_outline（第1批门禁） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripAll = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");
  const te = await import("../src/lib/token-estimate.mjs");
  ok(te.ZH_COEFF === 0.75 && te.EN_COEFF === 0.25 && te.bookTokenTotal(710791, "en") === Math.round(710791 * 0.25),
    "静态: token 系数校准锁（P&P 710,791 字符 × 0.25 = 177.7K 实测账）");
  const bbSrc = stripAll(readSrc("src", "build-book.js"));
  ok(bbSrc.includes("total_tokens") && bbSrc.includes("chapter_quality") && bbSrc.includes("token_meta"),
    "静态: build-book 写 total_tokens/chapter_quality meta（数据层契约在位）");
  ok(bbSrc.includes("_private"),
    "静态: build-book walkMd 拦 _private 路径段（作者简历类污染入口拦截）");
  const rtSrc = stripAll(readSrc("src", "lib", "register-tools.mjs"));
  ok(/(?:server\.registerTool|reg)\("get_outline"/.test(rtSrc),
    "静态: register-tools.mjs 注册 get_outline（MCP 契约在位）");
  const pkgSrc2 = JSON.parse(readSrc("package.json"));
  ok((pkgSrc2.scripts["test:fast"] || "").includes("outline-test"),
    "静态: package.json test:fast 含 outline-test（挂载对账）");
}
{
  const handlers = new Map();
  const mockServer = { registerTool: (name, spec, fn) => handlers.set(name, fn) };
  regTools(mockServer);
  ok(handlers.has("get_outline"), "get_outline 工具已注册（处理器在位）");
  const resp = await handlers.get("get_outline")({ book: "lunyu" });
  const out = JSON.parse(resp.content[0].text);
  ok(!out.error && out.chapters.length === 16 && out.total_blocks === 16
    && out.chapter_quality.verdict === "reliable" && out.chapters.every(c => c.tokens > 0 && c.first_id > 0),
    `get_outline 真库通（论语 ${out.chapters?.length} 章 / ${out.total_blocks} 块，带 token 账）`);
  const noMatch = JSON.parse((await handlers.get("get_outline")({ book: "不存在的书xyz" })).content[0].text);
  ok(noMatch.error && Array.isArray(noMatch.available), "get_outline 书名未命中给书目清单");
}
{
  const books = listBooks(LIB);
  ok(books.length > 0 && books.every(b => typeof b.total_tokens === "number" && b.total_tokens > 0),
    `list_books 每本带 total_tokens（新库 meta 或旧库现场估算，${books.length} 本）`);
  ok(books.every(b => b.chapter_quality && ["reliable", "messy", "none"].includes(b.chapter_quality.verdict)),
    "list_books 每本带 chapter_quality（none/messy/reliable 三态）");
}

// ========== 21) V3R7-② read_full_book + token 闸（第2批门禁） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripAll = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");
  const browseSrc = stripAll(readSrc("src", "lib", "browse.mjs"));
  ok(/export const FULL_READ_TOKEN_CAP = 10000/.test(browseSrc) && /export const CHAPTER_TOKEN_CAP = 8000/.test(browseSrc),
    "静态: FULL_READ_TOKEN_CAP=10000 / CHAPTER_TOKEN_CAP=8000 字面量在位（闸门可回退可断言）");
  ok(browseSrc.includes("takeWithTokenCap") && browseSrc.includes("estimateTokens"),
    "静态: browse token 闸走 estimateTokens（系数不散落硬编码）");
}
{
  const handlers = new Map();
  const mockServer = { registerTool: (name, spec, fn) => handlers.set(name, fn) };
  regTools(mockServer);
  ok(handlers.has("read_full_book"), "read_full_book 工具已注册");
  const small = JSON.parse((await handlers.get("read_full_book")({ book: "lunyu" })).content[0].text);
  ok(!small.error && small.blocks.length === 16 && small.total_blocks === 16 && small.tokens > 0,
    `read_full_book 小书全文（论语 ${small.blocks?.length} 块 ≈${small.tokens} token）`);
  const big = JSON.parse((await handlers.get("read_full_book")({ book: "pride" })).content[0].text);
  ok(big.error === "too-big" && big.tokens > 10000 && /get_outline/.test(big.hint || ""),
    `read_full_book 大书拒喂并指路（P&P ${big.tokens} token）`);
}

// ========== 22) V3R7-③ cite_check（第3批门禁） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripAll = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");
  const rtSrc = stripAll(readSrc("src", "lib", "register-tools.mjs"));
  ok(/(?:server\.registerTool|reg)\("cite_check"/.test(rtSrc),
    "静态: register-tools.mjs 注册 cite_check（MCP 契约在位）");
  const pkgSrc3 = JSON.parse(readSrc("package.json"));
  ok((pkgSrc3.scripts["test:fast"] || "").includes("cite-check-test"),
    "静态: package.json test:fast 含 cite-check-test（挂载对账）");
}

// ========== 22.5) 桌面 get_outline 对称（readerChapters 委托 lib 单一数据源，2026-10-20） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  // ① engine 委托 lib getOutline（MCP 与桌面同一地图，不再自建聚合两套账）
  const engSrc = stripComments(readSrc("src", "desktop", "engine.mjs"));
  ok(engSrc.includes('from "../lib/outline.mjs"') && engSrc.includes("getOutline(b.db)"),
    "静态: engine.readerChapters 委托 lib getOutline（桌面/MCP 单一数据源）");
  ok(engSrc.includes("no-chapters") && engSrc.includes("未分章"),
    "静态: readerChapters no-chapters 保底一桶「未分章」（PDF 类不丢「能翻」能力）");
  ok(engSrc.includes("quality") && engSrc.includes("totalTokens"),
    "静态: readerChapters 带 quality 三态 + totalTokens 账（对称字段）");

  // ② 渲染层：章条 token 账 + 质量徽标 + hint/notes 透传
  const rdSrc = stripComments(readSrc("src", "renderer", "views-reader.js"));
  ok(rdSrc.includes("fmtK") && rdSrc.includes("· ≈"),
    "静态: views-reader 目录章条渲染 token 账（fmtK K 记法）");
  ok(rdSrc.includes("章节名可疑") && rdSrc.includes("无章节"),
    "静态: views-reader 章节质量徽标（messy/none 两态人话）");
  ok(rdSrc.includes("c.hint") && rdSrc.includes("c.notes"),
    "静态: views-reader 透传 outline hint 与 notes（no-chapters 指路 + 覆盖率提示）");
}

// ========== 22.6) 外部智能体接入文档同步（新增 MCP 工具必须同步文档，2026-10-20） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const docPath = path.join(projRoot, "docs", "外部智能体接入文档.md");
  ok(fs.existsSync(docPath), "静态: docs/外部智能体接入文档.md 存在（联动最后一公里）");
  const doc = fs.readFileSync(docPath, "utf8");

  // 工具名动态提取自 register-tools.mjs（与 stage3-mcp-test 的 17 工具硬断言同一套事实源）——
  // 注册了新工具但文档没写 → 这里红，防文档漂移。提取兼容两种注册写法：
  // server.registerTool("x") 直写 与 reg("x") 闸机包装（W1 用量治理起统一走 reg）
  const rtSrc = fs.readFileSync(path.join(projRoot, "src", "lib", "register-tools.mjs"), "utf8");
  const toolNames = [...rtSrc.matchAll(/(?:server\.registerTool|reg)\("([a-z_]+)"/g)].map((m) => m[1]);
  ok(toolNames.length >= 17, `静态: register-tools 注册 ${toolNames.length} 个工具（≥17）`);
  const missing = toolNames.filter((n) => !doc.includes("`" + n + "`"));
  ok(missing.length === 0, `静态: 接入文档覆盖全部 ${toolNames.length} 个工具${missing.length ? "，缺: " + missing.join(",") : ""}`);
  ok(doc.includes("mcp-server.mjs") && doc.includes("BSP_LIB_DIR"),
    "静态: 接入文档含启动入口与库目录环境变量（30 秒接入的两要素）");
  ok(doc.includes("cite_check") && doc.includes("没有就明说") && doc.includes("繁体照抄"),
    "静态: 接入文档含防幻觉铁律三件套（回验/明说/照抄）");
}

// ========== 22.8) W1 用量治理：三级暴露闸机接线在位（2026-10-21） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  // ① lib 层：usage-policy.mjs 存在且导出契约函数
  const upSrc = stripComments(readSrc("src", "lib", "usage-policy.mjs"));
  ok(upSrc.includes("export function loadUsagePolicy") && upSrc.includes("export function saveUsagePolicy")
    && upSrc.includes("export function serviceStatus") && upSrc.includes("export function checkBudget")
    && upSrc.includes("export function recordUsage"),
    "静态: usage-policy.mjs 导出 load/save/serviceStatus/checkBudget/recordUsage（配置层契约）");
  ok(/usage-policy\.json/.test(upSrc) && /usage-log\.jsonl/.test(upSrc),
    "静态: 配置落 usage-policy.json + 审计落 usage-log.jsonl（与 skill-state 同目录同模式）");

  // ② MCP 闸机：register-tools 带 TOOL_TIERS 分级 + gateCall 拒收返回 {error,hint}
  const rtSrc = stripComments(readSrc("src", "lib", "register-tools.mjs"));
  ok(rtSrc.includes("TOOL_TIERS") && rtSrc.includes("gateCall"),
    "静态: register-tools 带 TOOL_TIERS 分级 + gateCall 闸机");
  ok(/list_books: "metadata"/.test(rtSrc) && /query_library: "search"/.test(rtSrc)
    && /read_full_book: "deepRead"/.test(rtSrc) && /cite_check: "metadata"/.test(rtSrc),
    "静态: 三级映射正确（元数据常开/检索受控/深读预算；cite_check 恒开不被拦）");
  ok(rtSrc.includes("recordUsage(") && rtSrc.includes("chargeUsage("),
    "static: 闸机内嵌记账与审计（放行扣预算、拒收也落日志）");

  // ③ 桌面接线：engine 函数 + IPC 通道 + preload 暴露
  const engSrc = stripComments(readSrc("src", "desktop", "engine.mjs"));
  ok(engSrc.includes("export function usagePolicyGet") && engSrc.includes("export function usagePolicySet"),
    "静态: engine 暴露 usagePolicyGet/Set（桌面与 MCP 共享同一份配置）");
  const ipcSrc = stripComments(readSrc("src", "desktop", "ipc.mjs"));
  ok(ipcSrc.includes('"usage:get"') && ipcSrc.includes('"usage:set"'),
    "静态: ipc.mjs 注册 usage:get/usage:set 通道");
  const preSrc = stripComments(readSrc("src", "preload.js"));
  ok(preSrc.includes("usageGet:") && preSrc.includes("usageSet:"),
    "静态: preload 暴露 usageGet/usageSet 给渲染层");

  // ④ 渲染层：书架页面板 + 开关动作
  const vSrc = stripComments(readSrc("src", "renderer", "views.js"));
  ok(vSrc.includes("usagePanelHTML()") && vSrc.includes('data-action="usagetoggle"'),
    "静态: 书架页渲染用量面板 + usagetoggle 开关动作");
  const aSrc = stripComments(readSrc("src", "renderer", "app.js"));
  ok(aSrc.includes("usage: null") && aSrc.includes("window.study.usageGet()"),
    "静态: 渲染态持 usage + boot 加载");
  const cssSrc = readSrc("src", "renderer", "app.css");
  ok(cssSrc.includes(".usagebox") && cssSrc.includes(".usagemeta"),
    "静态: app.css 含用量面板样式");

  // ⑤ 挂载对账：test:fast 含 usage-gate-test
  const pkgSrc4 = JSON.parse(readSrc("package.json"));
  ok((pkgSrc4.scripts["test:fast"] || "").includes("usage-gate-test"),
    "静态: package.json test:fast 含 usage-gate-test（挂载对账）");

  // ⑥ 接入文档同步：外部智能体要知道开关语义（拒收时收到 hint）
  const doc = readSrc("docs", "外部智能体接入文档.md");
  ok(doc.includes("usage-policy") && /知识库对外服务/.test(doc),
    "静态: 接入文档说明用量治理（usage-policy/对外服务开关）");
}

// ========== 22.9) W2 skill 结构校验器接线（2026-10-21） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  const svSrc = stripComments(readSrc("src", "lib", "skill-validate.mjs"));
  ok(svSrc.includes("export function validateSkillDir") && svSrc.includes("export function validateSkillsRoot"),
    "静态: skill-validate.mjs 导出 validateSkillDir/validateSkillsRoot（校验器契约）");
  ok(svSrc.includes("NEGATIVE_HINT_RE") && svSrc.includes("BODY_MAX_LINES") && svSrc.includes("broken-link"),
    "静态: 校验覆盖负面触发/正文行数/链接完整性（开放标准硬规则）");
  const cliSrc = stripComments(readSrc("src", "skill-validate.mjs"));
  ok(cliSrc.includes("process.exit(errCount > 0 ? 1 : 0)"), "静态: CLI 有 error 时退出码 1（可进 CI）");

  const pkgSrc5 = JSON.parse(readSrc("package.json"));
  ok((pkgSrc5.scripts["skill:validate"] || "").includes("src/skill-validate.mjs"),
    "静态: package.json 有 skill:validate 脚本（一键校验入口）");
  ok((pkgSrc5.scripts["test:fast"] || "").includes("skill-validate-test"),
    "静态: package.json test:fast 含 skill-validate-test（挂载对账）");

  // 白名单对齐开放标准目录：references/（一层深参考文档）+ scripts/（确定性操作脚本化）
  const storeSrc = stripComments(readSrc("src", "lib", "skill-store.mjs"));
  // 源码里 FILE_RE 的斜杠是转义写法（references\/），断言照源码原样匹配
  ok(storeSrc.includes("references\\/[a-z0-9-]+\\.md") && storeSrc.includes("scripts\\/[a-z0-9-]+\\."),
    "静态: saveSkill 白名单含 references/ 与 scripts/（开放标准目录，W2b 起可用）");

  // 真技能目录过一遍校验器（0 error 才允许接线通过——防止真技能烂掉没人知道）
  const { validateSkillsRoot } = await import("../src/lib/skill-validate.mjs");
  const rootResult = validateSkillsRoot(path.join(projRoot, "skills"));
  ok(rootResult.ok, `静态: skills/ 真目录校验 0 error（${rootResult.skills.map(s => s.slug).join(",")}）`,
    JSON.stringify(rootResult.skills.flatMap(s => s.errors)));
}

// ========== 22.7) UI V4：按钮三级制 + 深蓝灰主题（2026-10-20） ==========
{
  const projRoot = path.join(import.meta.dirname, "..");
  const readSrc = (...p) => fs.readFileSync(path.join(projRoot, ...p), "utf8");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  // ① 书架主操作按状态切换（未加工→process / 未编目→catprompt / 未洗→enrich）——
  //    治「加工/洗数据分不清」：不让人记顺序，卡片自己说下一步做什么
  const vSrc = stripComments(readSrc("src", "renderer", "views.js"));
  const mainBtnAt = vSrc.indexOf("let mainBtn");
  const mainBtnSeg = vSrc.slice(mainBtnAt, mainBtnAt + 700);
  ok(mainBtnAt > 0 && /raw[\s\S]{0,80}data-action="process"/.test(mainBtnSeg)
    && /!cataloged[\s\S]{0,80}data-action="catprompt"/.test(mainBtnSeg)
    && /!enriched[\s\S]{0,80}data-action="enrich"/.test(mainBtnSeg),
    "静态: 书架主操作三态机（未加工 process / 未编目 catprompt / 未洗 enrich）");
  // ② 危险操作收进「⋯」菜单（危险区用 sep 分隔，点两次才删）
  ok(vSrc.includes('class="kebab"') && vSrc.includes('class="menu hidden"') && vSrc.includes('class="sep"'),
    "静态: 卡片操作收进 ⋯ 菜单（普通项/危险项用 sep 分隔）");
  ok(vSrc.includes('act === "menu"') && vSrc.includes("classList.remove(\"hidden\")"),
    "静态: ⋯ 菜单事件在位（点击切换 + 点外收起）");

  // ③ 主题 tokens 与三级按钮样式
  const cssSrc = readSrc("src", "renderer", "app.css");
  ok(cssSrc.includes("--bg:") && cssSrc.includes("--accent:") && cssSrc.includes("--bg-card:"),
    "静态: 深蓝灰主题 tokens 在位（--bg/--bg-card/--accent）");
  ok(cssSrc.includes(".kebab") && cssSrc.includes(".menu {") && cssSrc.includes(".menu .danger"),
    "静态: ⋯ 菜单样式（kebab/menu/danger 三件）在位");
  ok(!/box-shadow/.test(cssSrc),
    "静态: 深色主题零 box-shadow（层次靠 1px 边线与底色差，不靠阴影）");

  // ④ 侧栏图标 + 文字常驻（治「找不到功能」——不折叠成纯图标）
  const htmlSrc = readSrc("src", "index.html");
  const navWithIcon = (htmlSrc.match(/class="navbtn[^"]*"[^>]*>\s*<svg/g) || []).length;
  ok(navWithIcon === 5, `静态: 侧栏 5 项均为图标+文字常驻（实测 ${navWithIcon} 项带图标）`);

  // ⑤ 书名规范（2026-10-20 老板要求）：书架标题必须是「起过的名字」，不得是文件名直译。
  // 判定：title === id（去扩展名）视为没起名；有原文名放括号里（「傲慢与偏见（Pride and Prejudice）」）
  // 靠文档约定，机器只卡「没起名」这条硬线——新书走 build-book 没传 --title 就会撞这里。
  const shelfBad = [];
  for (const f of fs.readdirSync(LIB).filter((x) => x.endsWith(".db"))) {
    const id = f.replace(/\.db$/, "");
    const db = new Database(path.join(LIB, f), { readonly: true });
    try {
      const t = db.prepare("SELECT value FROM meta WHERE key='title'").get()?.value;
      if (!t || t === id) shelfBad.push(id);
    } finally { db.close(); }
  }
  ok(shelfBad.length === 0, `静态: 书名规范——无「未起名」库（title===id：${shelfBad.join(",") || "无"}）`);

  // ⑤ 主题系统（2026-10-20）：五套预设 + 强调色自选 + 存档 + 启动应用 + 面板入口
  const themeSrc = readSrc("src", "renderer", "theme.js");
  const presetCount = (themeSrc.match(/^\s{2}"[a-z-]+": \{$/gm) || []).length;
  ok(presetCount >= 5, `静态: theme.js 预设主题 ${presetCount} 套（≥5）`);
  ok(themeSrc.includes('STORE_KEY = "bsp.theme.v1"') && themeSrc.includes("localStorage"),
    "静态: 主题存档 key 与 localStorage 持久化在位");
  ok(themeSrc.includes("prefers-color-scheme") && themeSrc.includes("addEventListener"),
    "静态: 自动模式跟随系统深浅（matchMedia + 变化监听）");
  ok(themeSrc.includes("accentInk") && themeSrc.includes("lum > 0.55"),
    "静态: 强调色按亮度自适应字色（浅底配深字/深底配白字）");
  const appSrc = stripComments(readSrc("src", "renderer", "app.js"));
  ok(appSrc.includes("initTheme()") && appSrc.includes("bindThemePanel()") && appSrc.includes("registerPanelPainter"),
    "静态: boot 应用主题 + 主题面板接线（initTheme/bindThemePanel/painter）");
  ok(htmlSrc.includes('id="themeBtn"') && htmlSrc.includes('id="themePanel"'),
    "静态: 顶栏调色入口与面板容器在位");
  ok(cssSrc.includes(".themepanel") && cssSrc.includes(".themecard") && cssSrc.includes(".swatch"),
    "静态: 主题面板样式三件套在位");
  ok(cssSrc.includes("--accent-ink") && !cssSrc.includes("#182029"),
    "静态: 强调色字色变量化（主题可换，无残留硬编码）");
}
{
  const handlers = new Map();
  const mockServer = { registerTool: (name, spec, fn) => handlers.set(name, fn) };
  regTools(mockServer);
  const db = new Database(GOOD, { readonly: true });
  const firstText = db.prepare("SELECT text FROM chunks ORDER BY id LIMIT 1").get().text;
  db.close();
  const clause = firstText.split(/[。；！？!?;]/).map(s => s.trim()).find(s => s.replace(/\s/g, "").length >= 6) || firstText.slice(0, 10);
  const good = JSON.parse((await handlers.get("cite_check")({ book: "lunyu", quote: clause })).content[0].text);
  ok(good.hit && good.chunk_id === 1, `cite_check 真库原文照抄命中（chunk#${good.chunk_id} level=${good.level}）`);
  const bad = JSON.parse((await handlers.get("cite_check")({ book: "lunyu", quote: "这本书里绝对没有的捏造句子 xyz" })).content[0].text);
  ok(!bad.hit && /不要采用/.test(bad.hint || ""), "cite_check 捏造引文拒收并指路");
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== 防线包验收结果 =====`);
if (fail) { console.error(`${fail} 项 FAIL`); process.exit(1); }
console.log(`全部 PASS：引擎卫兵/维度兜底/LIKE转义/topN上限/错误路径关库/混引擎路由/真机拖拽导入/云问答/洗数据入口/原书视图/导入两段/两档删除/结构化改造/云端清洗/get_outline数据层/read_full_book全文闸/cite_check回验 ${pass} 项全过`);
