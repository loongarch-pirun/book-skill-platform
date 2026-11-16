// 台账一致性核对（只读）
// 用法: node 核对一致性.cjs <项目根绝对路径>
// 比对「台账文件列覆盖的文件」与「r4 内实际有 11 月改动痕迹的文件」，输出差集。
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.argv[2];
const LEDGER = path.join(__dirname, "改动台账.md");
const OUT = path.join(__dirname, "一致性核对结果.txt");
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error("用法: node 核对一致性.cjs <项目根绝对路径>");
  process.exit(1);
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const BASELINE = new Date("2026-11-13T22:23:59+08:00").getTime();
const NOV_RE = /2026-11-1[0-5]|11-1[0-5]|P0-[0-9]|CP1|前置过滤|全盘替换|质量彻底解决|V07|施工官/;

// ---- 1. 实际有 11 月痕迹的文件集合 U ----
const SKIP_DIR = new Set([
  "node_modules", ".git", "docs", "runtime", "books", "release",
  "catalog-results", "catalog-tasks", "enrich-tasks", "_work", "fixtures",
]);
const SKIP_EXT = new Set([".db", ".db-wal", ".db-shm", ".exe", ".blockmap", ".ico", ".onnx", ".png", ".jpg", ".pdf", ".epub", ".docx"]);
const U = new Map(); // path -> reason
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    const r = rel(p);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) || SKIP_DIR.has(r)) continue;
      walk(p);
    } else if (e.isFile()) {
      if (SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const st = fs.statSync(p);
      const byTime = st.mtimeMs > BASELINE;
      let byNote = false;
      if (!e.name.endsWith(".log")) {
        try { byNote = NOV_RE.test(fs.readFileSync(p, "utf8")); } catch { /* binary */ }
      }
      if (byTime || byNote) U.set(r, [byTime ? "mtime" : "", byNote ? "注释" : ""].filter(Boolean).join("+"));
    }
  }
}
for (const d of ["src", "test"]) {
  const p = path.join(ROOT, d);
  if (fs.existsSync(p)) walk(p);
}
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!e.isFile()) continue;
  const p = path.join(ROOT, e.name);
  const r = e.name;
  if (!(/\.(json|mjs|js|md|log|yml)$/.test(r) || r === ".gitignore")) continue;
  const st = fs.statSync(p);
  const byTime = st.mtimeMs > BASELINE;
  let byNote = false;
  try { byNote = NOV_RE.test(fs.readFileSync(p, "utf8")); } catch { /* ignore */ }
  if (byTime || byNote) U.set(r, [byTime ? "mtime" : "", byNote ? "注释" : ""].filter(Boolean).join("+"));
}
// enrich-tasks 产物单独纳入
const et = path.join(ROOT, "enrich-tasks");
if (fs.existsSync(et)) for (const e of fs.readdirSync(et)) {
  if (fs.statSync(path.join(et, e)).mtimeMs > BASELINE) U.set("enrich-tasks/" + e, "mtime");
}
U.delete("改动台账.md");

// ---- 2. 台账「文件」列覆盖的路径集合 T ----
const ledger = fs.readFileSync(LEDGER, "utf8");
const lines = ledger.split(/\r?\n/);
const inRegister = { on: false };
const T = new Set();
let entries = 0, sections = 0;
for (const line of lines) {
  if (line.startsWith("## 台账 · 11 月")) { inRegister.on = true; continue; }
  if (inRegister.on && line.startsWith("## ")) inRegister.on = false;
  if (!inRegister.on) continue;
  if (/^### /.test(line)) sections++;
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").map((x) => x.trim());
  if (cells.length < 4) continue;
  const dateCol = cells[1] || "";
  if (!/^(11-|2026-11|\*\*11-)/.test(dateCol)) continue;
  if (/^---/.test(dateCol) || dateCol === "日期") continue;
  entries++;
  const fileCol = cells[2] || "";
  for (const m of fileCol.matchAll(/`([^`]+)`/g)) {
    let p = m[1].trim();
    p = p.replace(/:\d+(?:-\d+)?.*$/, "");   // 去行号
    p = p.replace(/\*{1,2}.*$/, "");          // 去通配
    p = p.replace(/（.*$/, "").trim();        // 去括号说明
    p = p.replace(/^\.\//, "");
    if (!p || p === "（无）") continue;
    if (p.endsWith("/")) T.add(p);
    else T.add(p);
  }
}
// 目录型前缀：把以 / 结尾或含 ** 的项转成前缀
const prefixes = [...T].filter((p) => p.endsWith("/")).map((p) => p);
const exact = [...T].filter((p) => !p.endsWith("/"));

// ---- 3. 比对 ----
const covered = [], missing = [];
for (const [u, reason] of [...U.keys()].sort().map((k) => [k, U.get(k)])) {
  const hit = exact.includes(u) || prefixes.some((p) => u.startsWith(p));
  (hit ? covered : missing).push({ path: u, reason });
}

// ---- 4. 台账里写了但 U 里没有的（产物/外部/通配符，属正常）----
const external = exact.filter((p) => !U.has(p) && !prefixes.some((q) => q === p + "/"));

const out = [];
out.push("台账一致性核对 · " + new Date().toISOString());
out.push("项目根: " + ROOT);
out.push("");
out.push("== 台账侧 ==");
out.push("登记条目: " + entries + " 条");
out.push("主题分节: " + sections + " 节");
out.push("文件列路径: " + T.size + " 项（精确 " + exact.length + " / 目录前缀 " + prefixes.length + "）");
out.push("");
out.push("== 实际侧（r4 内 11 月痕迹文件）==");
out.push("集合 U: " + U.size + " 个文件（判据: mtime 晚于 11-13 22:23 基线，或文件内容含 11 月日期/施工代号）");
out.push("已覆盖: " + covered.length);
out.push("漏登记: " + missing.length);
out.push("覆盖率: " + (U.size ? (100 * covered.length / U.size).toFixed(1) : "0") + "%");
out.push("");
if (missing.length) {
  out.push("== 漏登记清单（需补进台账）==");
  for (const m of missing) out.push("  - " + m.path + "  [" + m.reason + "]");
} else {
  out.push("== 漏登记清单 ==");
  out.push("  无。台账文件列已覆盖 r4 内全部 11 月痕迹文件。");
}
out.push("");
out.push("== 台账中有、U 中无的项（产物 / 外部原件 / 通配，属正常）==");
out.push("  共 " + external.length + " 项");
for (const p of external.slice(0, 40)) out.push("  · " + p);
if (external.length > 40) out.push("  ... 其余 " + (external.length - 40) + " 项见台账");
out.push("");
out.push("== 证据边界 ==");
out.push("  本核对只覆盖 r4 文件夹内可见改动。外部 workspace 原件未读取，");
out.push("  因此「与外部施工台账逐条一致」未经校验；本结果保证的是「与 r4 内可见实际改动一致」。");

const text = out.join("\n");
fs.writeFileSync(OUT, text, "utf8");
console.log(text);
