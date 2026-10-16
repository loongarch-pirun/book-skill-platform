// 洗数据跑批 CLI（V3 第二波 L3）：给每块产 前置/标签/假设问题/块摘要，再汇总章摘要/书摘要。
//
// 用法:
//   node src/enrich-book.js <book.db> [--batch 5] [--min-chars 40] [--no-summary]
//       [--results-dir DIR] [--user-data DIR] [--base URL --key K --model M]
//   node src/enrich-book.js --all [同上选项]      # library/ 下全部书库
//   node src/enrich-book.js <book.db> --export    # 只导任务书给外部智能体（不需要 key）
//
// 配置解析（三级，先到先得）：命令行 --base/--key/--model > 环境变量 BSP_LLM_BASE/BSP_LLM_KEY/BSP_LLM_MODEL
//   > <userData>/llm.json（应用内保存的那份；plain 模式可解，enc 加密模式解不了会提示改走应用内或 --key）
// 断点续跑：中断后重跑同一命令即可——已完成的块走 enrich-results/<书名>.jsonl 缓存，不重复调云端。
// 产物：enrich-results/<书名>.json（#137 存储层入库的输入；外部智能体通道也产这个）。
import fs from "node:fs";
import path from "node:path";
import { runEnrich, buildEnrichTaskFile } from "./lib/enrich.mjs";
import { resolveDirs } from "./desktop/paths.mjs";

const args = process.argv.slice(2);
// flag() 支持 "--name value" 与 "--name=value" 两种形式（V3R-D01/D24：等号形式曾静默回落默认）
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const num = (name, dflt) => { const v = flag(name); return v != null && +v > 0 ? +v : dflt; };
const all = args.includes("--all");
const exportOnly = args.includes("--export");
// V3R-D01（致命）：带值 flag 的「值」必须连 flag 一起排除，否则 URL/key/数字全被当书路径
// （实测旧代码 `node enrich-book.js x.db --batch 5` → 「找不到 5」，文档里每种带值用法必炸）
const VALUE_FLAGS = new Set(["--batch", "--min-chars", "--results-dir", "--user-data", "--base", "--key", "--model"]);
const positional = (() => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a) && i + 1 < args.length && !args[i + 1].startsWith("--")) i++; // 连值一起吃
      continue;
    }
    out.push(a);
  }
  return out;
})();

// userData 候选：--user-data > BSP_USER_DATA > %APPDATA%/book-skill-platform（打包态默认）> 项目根（dev）
const projectRoot = resolveDirs({ packaged: false }).projectRoot;
const userData = flag("--user-data") || process.env.BSP_USER_DATA
  || (process.env.APPDATA ? path.join(process.env.APPDATA, "book-skill-platform") : null)
  || projectRoot;

// llm.json 的 plain 模式解码（与 desktop/llm-config.mjs 的 decodeKey 同款往返校验；enc 模式本 CLI 解不了）
function loadCfgFromFile() {
  const p = path.join(userData, "llm.json");
  if (!fs.existsSync(p)) return { note: `没找到 ${p}——用 --base/--key/--model 或先在应用内配好` };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return { note: `${p} 不是合法 JSON——用 --base/--key/--model 传入` }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { note: `${p} 内容损坏——用 --base/--key/--model 传入` };
  const enc = raw.apiKeyEnc;
  if (typeof enc === "string" && enc.startsWith("enc:")) {
    return { note: "llm.json 里的 key 是加密存储（safeStorage），命令行解不了——请用 --key 传明文，或改用应用内「问一问」页的洗数据入口" };
  }
  let key = null;
  if (typeof enc === "string" && enc.startsWith("plain:")) {
    const s = Buffer.from(enc.slice(6), "base64").toString("utf8");
    if (Buffer.from(s, "utf8").toString("base64") === enc.slice(6)) key = s;
  }
  return { baseUrl: raw.baseUrl || "", model: raw.model || "", apiKey: key };
}

const fileCfg = loadCfgFromFile();
const config = {
  baseUrl: flag("--base") || process.env.BSP_LLM_BASE || fileCfg.baseUrl || "",
  apiKey: flag("--key") || process.env.BSP_LLM_KEY || fileCfg.apiKey || "",
  model: flag("--model") || process.env.BSP_LLM_MODEL || fileCfg.model || "",
};

const libDir = resolveDirs({ packaged: false }).libDir;
const targets = all
  ? fs.readdirSync(libDir).filter(f => f.endsWith(".db")).map(f => path.join(libDir, f))
  : positional;
if (!targets.length) {
  console.error("用法: node src/enrich-book.js <book.db|--all> [--batch N] [--min-chars N] [--no-summary] [--export] [--results-dir DIR]");
  console.error("      [--user-data DIR] [--base URL --key K --model M]");
  process.exit(1);
}
for (const t of targets) if (!fs.existsSync(t)) { console.error(`找不到 ${t}`); process.exit(1); }

if (exportOnly) {
  const outDir = path.join(projectRoot, "enrich-tasks");
  let failed = 0;
  for (const t of targets) {
    // V3R-D03/D06/D07：坏库（无 chunks 表/垃圾文件）→ 人话拒绝，不裸 SqliteError 堆栈。
    // lib 层 buildEnrichTaskFile 契约上不抛；此处双保险（抛异常/返回 {error} 两条都收）。
    let built;
    try { built = buildEnrichTaskFile(t, outDir); }
    catch (e) { console.error(`✗ ${path.basename(t)}: 书库读不了（${e.message}）——不是有效的书库文件？`); failed++; continue; }
    if (built.error) { console.error(`✗ ${path.basename(t)}: ${built.message}`); failed++; continue; }
    const { outPath, chunks, skipped, batches } = built;
    console.log(`✓ ${path.basename(outPath)}：${chunks} 块待洗（跳过短块 ${skipped}）| ${batches} 批`);
  }
  if (failed) process.exit(1);
  console.log(`\n下一步（外部智能体通道）: 按任务书 instructions 产出结果 JSON，存到 enrich-results/<同名>.json，等存储层入库（#137）。`);
  process.exit(0);
}

if (!config.apiKey) {
  console.error("✗ 没有可用的 API key。三条路：");
  console.error("  1. --base https://api.deepseek.com/v1 --key sk-xxx --model deepseek-chat");
  console.error("  2. 环境变量 BSP_LLM_BASE / BSP_LLM_KEY / BSP_LLM_MODEL");
  console.error("  3. 在桌面应用「问一问」页配好 key（存进 llm.json），本命令自动读取");
  if (fileCfg.note) console.error(`  （当前 userData: ${userData}——${fileCfg.note}）`);
  process.exit(1);
}

const opts = {
  config,
  batchSize: num("--batch", 5),
  minChars: num("--min-chars", 40),
  summaries: !args.includes("--no-summary"),
  resultsDir: flag("--results-dir") || path.join(projectRoot, "enrich-results"),
  onProgress: (() => {
    let n = 0;
    return ({ phase, ok, done, total }) => {
      if (phase !== "batch" || !ok) return;
      n++;
      if (n % 20 === 0 || done === total) process.stdout.write(`  进度 ${done}/${total}（第 ${n} 批）\r`);
    };
  })(),
};

let failed = 0;
for (const t of targets) {
  // V3R-D07：runEnrich 契约上不抛（lib 层失败一律 return {error}），但坏库/环境边缘仍兜一道——人话拒绝不裸堆栈
  let r;
  try { r = await runEnrich(t, opts); }
  catch (e) { failed++; console.error(`✗ ${path.basename(t)}: 洗数据失败（${e.message}）`); continue; }
  // V3R-D24：错误码从白名单逐个列举改为通用判断——PARTIAL 有 stats 走 △ 续跑路径，
  // 其余 !ok 一律按失败处理（旧代码漏列新错误码会踩 r.stats 崩出英文栈）
  if (!r.ok && r.code !== "PARTIAL") {
    failed++;
    console.error(`✗ ${path.basename(t)}: ${r.message}`);
    continue;
  }
  const s = r.stats;
  console.log(`${r.ok ? "✓" : "△"} ${path.basename(t)}：${s.chunks} 块待洗（跳过短块 ${s.skipped}）| ${s.chapters} 章 | ${s.batches} 批（失败 ${s.batchesFailed}）`);
  console.log(`  云端调用 ${s.calls} 次 | tokens ≈ ${s.usageIn} in / ${s.usageOut} out | 标签丢弃 ${s.tagsDropped} 个（回源不命中）| 超量截掉 ${s.tagsCapped} 个`);
  if (r.ok) console.log(`  产物: ${r.artifactPath}`);
  else console.log(`  ${r.message}`);
  if (!r.ok) failed++;
}
console.log(failed ? `\n${failed} 个库有失败批——重跑同一命令续跑（已完成的块走缓存不重复调）。` : "\n全部完成。下一步：存储层入库（chunks ctx/tags/questions 列 + summaries 表 + chunk_tags 倒排）。");
process.exit(failed ? 1 : 0);
