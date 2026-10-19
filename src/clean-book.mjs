// 云端大模型清洗跑批 CLI（clean-book）：本地规则层之后的语义清洗关。
//   跑批（runClean，只读库）产判定清单 → 默认自动落库（importClean：干净块留主库、垃圾块
//   物理 DELETE + 隔离账 quarantine 落原文与理由）。
// 用法:
//   node src/clean-book.mjs <book.db> [--batch 15] [--dry-run] [--no-import] [--force]
//       [--refresh-profile] [--results-dir DIR] [--user-data DIR]
//       [--base URL --key K --model M] [--force-gate]
// 配置解析（三级，先到先得，与 enrich-book.mjs 同款）：命令行 > 环境变量 BSP_LLM_BASE/BSP_LLM_KEY/BSP_LLM_MODEL
//   > <userData>/llm.json（plain 模式可解；enc 加密模式解不了会提示改走 --key）。
// 断点续跑：中断后重跑同一命令即可——已完成块走 clean-results/<书名>.jsonl 缓存，不重复调云端。
// 退出码：0 成功/跳过；1 配置或库错误；2 GATE 闸门拒收（删除比例异常）。
import fs from "node:fs";
import path from "node:path";
import { runClean, estimateClean, buildCleanTasks } from "./lib/clean.mjs";
import { importClean } from "./lib/clean-import.mjs";
import { resolveDirs } from "./desktop/paths.mjs";

const args = process.argv.slice(2);
// flag() 支持 "--name value" 与 "--name=value" 两种形式（V3R-D01/D24 同款）
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const num = (name, dflt) => { const v = flag(name); return v != null && +v > 0 ? +v : dflt; };
// 带值 flag 的「值」必须连 flag 一起排除（否则 URL/key/数字被当书路径——V3R-D01 教训）
const VALUE_FLAGS = new Set(["--batch", "--results-dir", "--user-data", "--base", "--key", "--model", "--timeout-ms"]);
const positional = (() => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a) && i + 1 < args.length && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
})();

const dryRun = args.includes("--dry-run");
const noImport = args.includes("--no-import");
const forceGate = args.includes("--force-gate");

const projectRoot = resolveDirs({ packaged: false }).projectRoot;
const userData = flag("--user-data") || process.env.BSP_USER_DATA
  || (process.env.APPDATA ? path.join(process.env.APPDATA, "book-skill-platform") : null)
  || projectRoot;

// llm.json plain 模式解码（与 enrich-book.mjs 同款往返校验；enc 模式 CLI 解不了）
function loadCfgFromFile() {
  const p = path.join(userData, "llm.json");
  if (!fs.existsSync(p)) return { note: `没找到 ${p}——用 --base/--key/--model 或先在应用内配好` };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return { note: `${p} 不是合法 JSON——用 --base/--key/--model 传入` }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { note: `${p} 内容损坏——用 --base/--key/--model 传入` };
  const enc = raw.apiKeyEnc;
  if (typeof enc === "string" && enc.startsWith("enc:")) {
    return { note: "llm.json 里的 key 是加密存储（safeStorage），命令行解不了——请用 --key 传明文" };
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

const target = positional[0];
if (!target) {
  console.error("用法: node src/clean-book.mjs <book.db> [--batch N] [--dry-run] [--no-import] [--force] [--force-gate]");
  console.error("      [--results-dir DIR] [--user-data DIR] [--base URL --key K --model M]");
  process.exit(1);
}
if (!fs.existsSync(target)) { console.error(`找不到 ${target}`); process.exit(1); }

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
  batchSize: num("--batch", 15),
  timeoutMs: num("--timeout-ms", 90000),
  resultsDir: flag("--results-dir") || path.join(projectRoot, "clean-results"),
  force: args.includes("--force"),
  refreshProfile: args.includes("--refresh-profile"),
  onProgress: (() => {
    let n = 0;
    return ({ phase, ok, done, total }) => {
      if (phase !== "batch" || !ok) return;
      n++;
      if (n % 10 === 0 || done === total) process.stdout.write(`  进度 ${done}/${total}（第 ${n} 批）\r`);
    };
  })(),
};

// 跑批前成本预估（先读块算批数，不调云端）
try {
  const Database = (await import("node:module")).createRequire(import.meta.url)("better-sqlite3");
  const db = new Database(target, { readonly: true });
  const est = estimateClean(buildCleanTasks(db), opts);
  db.close();
  console.log(`${path.basename(target)}：${est.chunks} 块 | ${est.batchCalls} 批 + 1 画像 ≈ ${est.calls} 次云端调用 | 输入 ≈ ${(est.estInputChars / 10000).toFixed(1)} 万字`);
} catch { /* 坏库由 runClean 报人话 */ }

let r;
try { r = await runClean(target, opts); }
catch (e) {
  if (e?.code === "CANCELLED") { console.log("已取消（已完成的块走缓存，重跑续跑）"); process.exit(0); }
  console.error(`✗ ${path.basename(target)}: 清洗失败（${e.message}）`);
  process.exit(1);
}
if (r.skipped) { console.log(`ⓘ ${path.basename(target)}: ${r.message}`); process.exit(0); }
if (!r.ok && r.code !== "PARTIAL") { console.error(`✗ ${path.basename(target)}: ${r.message}`); process.exit(1); }

const s = r.stats;
console.log(`${r.ok ? "✓" : "△"} ${path.basename(target)}：${s.chunks} 块 | ${s.batches} 批（失败 ${s.batchesFailed}）| 画像模式 ${s.profileMode || "-"}`);
console.log(`  云端调用 ${s.calls} 次 | tokens ≈ ${s.usageIn} in / ${s.usageOut} out | 判删 ${s.dropped} | 护栏拦回 G1:${s.guardedG1} G2:${s.guardedG2} G3:${s.guardedG3}`);
if (!r.ok) console.log(`  ${r.message}`);
console.log(`  判定清单: ${r.artifactPath}`);

if (dryRun || noImport) {
  console.log(dryRun ? "（--dry-run 不落库）" : "（--no-import 跳过落库）");
  console.log("落库: node src/clean-book.mjs <db>（重跑会走缓存秒完，然后自动落库）或手动 node -e 调 importClean");
  process.exit(r.ok ? 0 : 1);
}

// 默认自动落库（同一进程直调 lib，不 spawn 第二次）
const ir = importClean(target, r.artifactPath, { forceGate });
if (!ir.ok) {
  console.error(`✗ 落库被拒: ${ir.message}`);
  process.exit(ir.code === "GATE" ? 2 : 1);
}
console.log(`✓ 落库: ${ir.message}${ir.gate?.verdict === "warn" ? `（⚠ 删除占比 ${((ir.gate.ratio || 0) * 100).toFixed(0)}% 超黄线，已入库并标记）` : ""}`);
process.exit(0);
