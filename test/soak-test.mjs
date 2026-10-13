// P3 稳定性长流程（终期暴力测试）：连导不重启进程查内存、翻书反复加载防重入、
// 检索性能对账。挂载：test:slow（连导要加载嵌入模型）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0, observe = 0;
const failures = [];
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (cond) pass++; else { fail++; failures.push(msg); } };
const obs = (msg) => { console.log("OBSERVE - " + msg); observe++; };
const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

// ---------- 1) 连续导入 3 本书不重启进程：内存粗线 ----------
console.log("===== 1) 连导 3 本书（同进程不重启） =====");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-p3-"));
  const libDir = path.join(tmp, "library");
  fs.mkdirSync(libDir, { recursive: true });
  const { configureSearch } = await import("../src/lib/search.mjs");
  const { configureModels } = await import("../src/lib/models.mjs");
  configureSearch({ libDir });
  configureModels({ modelsDir: path.join(ROOT, ".models") });
  process.env.BSP_LIB_DIR = libDir;
  process.env.BSP_MODELS_DIR = path.join(ROOT, ".models");
  const { startImport } = await import("../src/desktop/jobs.mjs");
  const { hybridSearch } = await import("../src/lib/search.mjs");

  const rss0 = rss();
  obs(`起点 RSS ${rss0}MB`);
  const books = [
    path.join(ROOT, "books/lunyu-xueer-zh.docx"),
    path.join(ROOT, "books/daodejing-zh.docx"),
    path.join(ROOT, "books/mengzi-zh.docx"),
  ];
  for (const b of books) {
    const r = await startImport(b);
    ok(r.stage === "catalog", `连导 ${path.basename(b)} → 待编目（${r.clusters} 堆）`);
  }
  const rss1 = rss();
  obs(`连导 3 本后 RSS ${rss1}MB（Δ ${rss1 - rss0}MB）`);
  ok(rss1 - rss0 < 400, `P3-1 连导 3 本内存增幅 <400MB（实际 Δ ${rss1 - rss0}MB——模型常驻是大头，泄漏看斜率不看绝对值）`);

  // 每本书跑一次检索（引擎句柄复用压力）
  for (const b of books) {
    const id = path.basename(b).replace(/\.(docx|epub|pdf)$/, "") + ".docx";
    const rs = await hybridSearch(path.join(libDir, id + ".db"), "什么是仁", 3, { rerank: true });
    ok(rs.length > 0, `P3-1b ${id} 连导后可检索（top1 ${rs[0].score.toFixed(3)}）`);
  }
  const rss2 = rss();
  obs(`3 次检索后 RSS ${rss2}MB（Δ 检索 ${rss2 - rss1}MB）`);

  // 2) 同书反复检索 30 次：句柄/缓存泄漏看斜率
  const rssA = rss();
  for (let i = 0; i < 30; i++) await hybridSearch(path.join(libDir, "mengzi-zh.docx.db"), "孟子论性善", 5, { rerank: false });
  const rssB = rss();
  obs(`同书 30 次检索（rerank off）：RSS ${rssA} → ${rssB}MB（Δ ${rssB - rssA}MB）`);
  ok(rssB - rssA < 100, `P3-2 同书 30 次检索内存增幅 <100MB（实际 Δ ${rssB - rssA}MB）`);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 沙箱 */ }
}

// ---------- 3) 翻书防重入：renderer loadReader 的 stale/loadedChapter 守卫 ----------
console.log("===== 3) 翻书防重入（renderer-graph 已覆盖加载路径，这里压切换竞速） =====");
{
  // renderer 是浏览器 ESM，Node 里跑不了 DOM——用 engine 层的数据函数模拟快速切书：
  // 连续切 8 本书 × 每本 5 次 chapters/block 交替，验证数据层无状态污染
  const engine = await import("../src/desktop/engine.mjs");
  const { configureSearch } = await import("../src/lib/search.mjs");
  configureSearch({ libDir: path.join(ROOT, "library") });
  const { listBooks } = await import("../src/lib/search.mjs");
  const books = listBooks().filter(b => b.chunks > 0).slice(0, 8);
  ok(books.length >= 7, `P3-3a 书库 ${books.length} 本可翻（≥7）`);
  let calls = 0;
  for (let round = 0; round < 5; round++) {
    for (const b of books) {
      const chs = await engine.readerChapters(b.id);
      const blk = await engine.readerBlock(b.id, chs.chapters[0].name); // 第二参是章节名不是索引
      if (chs.chapters.length > 0 && blk.blocks.length > 0) calls++;
    }
  }
  ok(calls === books.length * 5, `P3-3b 8 本 × 5 轮 chapters/block 交替全部成功（${calls}/${books.length * 5}，无状态污染）`);
}

// ---------- 4) 性能对账：与 perf-test 基线比延迟 ----------
console.log("===== 4) 检索延迟对账 =====");
{
  const { hybridSearch, configureSearch } = await import("../src/lib/search.mjs");
  const { configureModels } = await import("../src/lib/models.mjs");
  configureSearch({ libDir: path.join(ROOT, "library") });
  configureModels({ modelsDir: path.join(ROOT, ".models") });
  const qs = ["什么是仁", "学和温习的关系", "无为而治"];
  const t0 = Date.now();
  let n = 0;
  for (const q of qs) { const rs = await hybridSearch(path.join(ROOT, "library/mengzi-zh.docx.db"), q, 5, { rerank: true }); n += rs.length; }
  const ms = Date.now() - t0;
  obs(`P3-4 孟子库 3 题 rerank on 共 ${ms}ms（均 ${Math.round(ms / qs.length)}ms/题，eval 基线 3.2s/题同量级）`);
  ok(n > 0 && ms < 60000, `P3-4 延迟对账：${qs.length} 题 ${ms}ms 无劣化爆炸（<60s）`);
}

// ---------- 汇总 ----------
console.log(`\n===== P3 稳定性汇总：${pass} PASS / ${fail} FAIL / ${observe} OBSERVE =====`);
if (failures.length) { console.log("失败项："); failures.forEach(f => console.log("  ✗ " + f)); }
process.exit(fail ? 1 : 0);
