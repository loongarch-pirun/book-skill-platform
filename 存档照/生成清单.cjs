// 存档照生成器（只读，不改动项目任何文件）
// 用法：
//   node 生成清单.cjs <项目根绝对路径>           生成/更新 version-manifest.json
//   node 生成清单.cjs <项目根绝对路径> --check   只比对，不写文件；有差异 exit 1
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = process.argv[2];
const CHECK = process.argv.includes("--check");
const SNAP_ID = (process.argv.find((a) => a.startsWith("--id=")) || "").slice(5) || "r4-snapshot-20261115";
const OUT = path.join(__dirname, "version-manifest.json");
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error("用法: node 生成清单.cjs <项目根绝对路径> [--check]");
  process.exit(1);
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const iso = (p) => fs.statSync(p).mtime.toISOString();

const SKIP_DIR = new Set([
  "node_modules", ".git", "library", "runtime", "books", "release",
  "catalog-results", "catalog-tasks", "enrich-tasks", "backup", "_work",
  // 存档照自己：清单文件 version-manifest.json 就住在这里。不排除会自激——
  // 每次重拍都改清单 → 指纹跟着变 → 永远对不上。2026-11-16 纳入版本管理时加的。
  "存档照",
]);
const SKIP_EXT = new Set([
  ".db", ".db-wal", ".db-shm", ".exe", ".blockmap", ".ico", ".onnx",
  ".pdf", ".epub", ".docx", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".mp4",
]);
const TOP_DIRS = ["src", "test", "docs", ".github", "build", "skills"];
const TOP_FILES = [
  "package.json", "package-lock.json", "README.md", ".gitignore",
  "quality-baseline.json", "eslint.config.mjs", "LICENSE",
];

function collect() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      const r = rel(p);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || SKIP_DIR.has(r)) continue;
        walk(p);
      } else if (!SKIP_EXT.has(path.extname(e.name).toLowerCase())) {
        const buf = fs.readFileSync(p);
        out.push({ path: r, bytes: buf.length, mtime: iso(p), sha256: sha(buf) });
      }
    }
  };
  for (const d of TOP_DIRS) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) walk(p);
  }
  for (const f of TOP_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      out.push({ path: f, bytes: buf.length, mtime: iso(p), sha256: sha(buf) });
    }
  }
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".log")) {
      const p = path.join(ROOT, e.name);
      const buf = fs.readFileSync(p);
      out.push({ path: e.name, bytes: buf.length, mtime: iso(p), sha256: sha(buf) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const files = collect();
const treeSha = sha(Buffer.from(files.map((f) => f.path + "\0" + f.sha256 + "\0").join(""))).slice(0, 16);

// 旁挂清单：只记名字与大小，不读二进制内容
const sideList = (dir, filter) => {
  const p = path.join(ROOT, dir);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isFile() && filter(e.name))
    .map((e) => ({ name: e.name, bytes: fs.statSync(path.join(p, e.name)).size, mtime: iso(path.join(p, e.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

// 考卷指纹，口径照抄 test/quality-gate.mjs:156-167
let golden = null;
try {
  const gd = path.join(ROOT, "test", "golden");
  const names = fs.readdirSync(gd).filter((x) => x.endsWith(".json")).sort();
  const h = crypto.createHash("sha256");
  let questions = 0;
  for (const n of names) {
    h.update(n); h.update("\0");
    const buf = fs.readFileSync(path.join(gd, n));
    h.update(buf); h.update("\0");
    questions += JSON.parse(buf.toString("utf8")).length;
  }
  golden = { files: names.length, questions, sha: h.digest("hex").slice(0, 16) };
} catch { /* 考卷缺失时留空 */ }

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch { return null; } };
const qb = readJson("quality-baseline.json");
const eb = readJson("test/eval-baseline.json");
let defaultEmbed = null;
try {
  const m = fs.readFileSync(path.join(ROOT, "src", "lib", "models.mjs"), "utf8")
    .match(/DEFAULT_EMBED\s*=\s*process\.env\.BSP_EMBED_MODEL\s*\|\|\s*"([^"]+)"/);
  defaultEmbed = m ? m[1] : null;
} catch { /* ignore */ }

let lastCodeChange = null;
for (const f of files.filter((x) => /^(src|test)\//.test(x.path))) {
  if (!lastCodeChange || f.mtime > lastCodeChange.mtime) lastCodeChange = { path: f.path, mtime: f.mtime };
}

const libs = sideList("library", (n) => n.endsWith(".db"));
const rels = sideList("release", () => true);
const logs = files.filter((f) => f.path.endsWith(".log"))
  .map((f) => ({ name: f.path, bytes: f.bytes, mtime: f.mtime, sha16: f.sha256.slice(0, 16) }));

const manifest = {
  snapshotId: SNAP_ID,
  capturedAt: new Date().toISOString(),
  scope: "只读快照；不含 node_modules / library 二进制 / runtime / books / release / 中间任务目录 / .models 软链接",
  treeSha16: treeSha,
  fileCount: files.length,
  facts: {
    golden,
    defaultEmbed,
    libraryDbCount: libs.length,
    libraryDbs: libs.map((x) => x.name),
    qualityBaseline: qb ? { generatedAt: qb.generatedAt, topN: qb.topN, total: qb.total, metrics: qb.metrics } : null,
    evalBaseline: eb ? { date: eb.date, model: eb.model, rate: eb.rate, hits: eb.hits, total: eb.total, rerankOffRate: eb.rerankOffRate } : null,
    lastCodeChange,
    release: rels,
    logs,
  },
  files,
};

if (CHECK) {
  if (!fs.existsSync(OUT)) { console.error("找不到基线清单：" + OUT); process.exit(2); }
  const old = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const om = new Map(old.files.map((f) => [f.path, f.sha256]));
  const nm = new Map(files.map((f) => [f.path, f.sha256]));
  const added = files.filter((f) => !om.has(f.path)).map((f) => f.path);
  const removed = [...om.keys()].filter((p) => !nm.has(p));
  const changed = files.filter((f) => om.has(f.path) && om.get(f.path) !== f.sha256).map((f) => f.path);
  console.log("存档照树指纹：" + old.treeSha16);
  console.log("当前树指纹：  " + treeSha);
  console.log(`新增 ${added.length} / 删除 ${removed.length} / 改动 ${changed.length}`);
  for (const p of added) console.log("  + " + p);
  for (const p of removed) console.log("  - " + p);
  for (const p of changed) console.log("  ~ " + p);
  if (treeSha === old.treeSha16) console.log("✓ 与存档照一致，一个字节都没变");
  else { console.log("✗ 与存档照不一致"); process.exit(1); }
} else {
  if (fs.existsSync(OUT)) {
    try { manifest.previousTreeSha16 = JSON.parse(fs.readFileSync(OUT, "utf8")).treeSha16 || null; } catch { /* 旧清单坏了就留空 */ }
  }
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1), "utf8");
  console.log("已生成：" + OUT);
  console.log("文件数：" + files.length);
  console.log("树指纹：" + treeSha);
  console.log("考卷：" + JSON.stringify(golden));
  console.log("默认引擎：" + defaultEmbed);
  console.log("书库 .db：" + libs.length);
  console.log("基线：" + JSON.stringify(qb && qb.metrics));
  console.log("最后代码改动：" + JSON.stringify(lastCodeChange));
  console.log("日志数：" + logs.length);
  console.log("release：" + JSON.stringify(rels.map((x) => x.name + " " + x.bytes)));
}
