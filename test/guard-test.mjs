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
  const viewsSrc = readSrc("src", "renderer", "views.js");
  const cardAt = viewsSrc.indexOf("function bookCard(");
  const cardBody = viewsSrc.slice(cardAt, viewsSrc.indexOf("\nfunction ", cardAt + 10));
  ok(/const delBtns = raw\s*\n\s*\?\s*`[^`]*data-action="purge"[^`]*`\s*\n\s*:\s*`[^`]*data-action="del"[^`]*data-action="purge"/.test(cardBody),
    "静态: raw 卡仅彻底删除 / processed 卡移出+彻底两档（#168 按钮分流）");
  // ④ 两个动作都拨通 IPC + 彻底删除带确认清单（asset/chunks 数从书架数据来）
  ok(/act === "purge"[\s\S]{0,600}window\.study\.purgeBook/.test(viewsSrc),
    "静态: 彻底删除动作拨通 purgeBook（#168）");
  ok(/act === "purge"[\s\S]{0,900}不可恢复/.test(viewsSrc) && /asset\?\.exists/.test(viewsSrc),
    "静态: 彻底删除确认清单先行（books/ 原件在不在按 asset.exists 说实情）");
  // ⑤ 通道契约同步：ipc-test EXPECTED 含 books:purge
  const ipcTestSrc = readSrc("test", "ipc-test.mjs");
  ok(ipcTestSrc.includes('"books:purge"'), "静态: ipc-test EXPECTED 含 books:purge（#168 通道对账）");
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
  ok(/onStage: \(s\) => \{[\s\S]{0,200}?if \(s === "slice"\) emit\(id, \{ stage: "slice", label: "切片中"/.test(jobsSrc),
    "静态: onStage slice → 横幅转「切片中」（结构化改造/切片两格分明）");
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

  // ① 套件本体落盘在 test/ 根（51 发：A12/B6/C14/D4/E5/F10），自包含对抗套件（头部声明即身份）
  const fuzzSrc = readSrc("test", "entry-adversarial-fuzz.mjs");
  ok(fuzzSrc.includes("入口链路 + 结构化改造对抗 fuzz") && fuzzSrc.includes("51 发索引与 ledger 缺陷对照"),
    "静态: entry-adversarial-fuzz.mjs 落盘（51 发对抗套件，V3 第四波标准轮 S2）");
  // ②③ 挂载对账：fast 与 ci 都含新套件（防「写了套件没挂」——S2 步骤 4 挂载的静态锁）
  const pkgSrc = JSON.parse(readSrc("package.json"));
  ok((pkgSrc.scripts["test:fast"] || "").includes("entry-adversarial-fuzz"),
    "静态: package.json test:fast 含 entry-adversarial-fuzz（对抗套件挂 fast）");
  ok((pkgSrc.scripts["test:ci"] || "").includes("entry-adversarial-fuzz"),
    "静态: package.json test:ci 含 entry-adversarial-fuzz（对抗套件挂 ci）");
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== 防线包验收结果 =====`);
if (fail) { console.error(`${fail} 项 FAIL`); process.exit(1); }
console.log(`全部 PASS：引擎卫兵/维度兜底/LIKE转义/topN上限/错误路径关库/混引擎路由/真机拖拽导入/云问答/洗数据入口/原书视图/导入两段/两档删除/结构化改造 ${pass} 项全过`);
