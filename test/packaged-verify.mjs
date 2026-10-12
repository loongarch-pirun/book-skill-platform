// 打包产物验收（4.7）：对 electron-builder --dir 的 win-unpacked 做三层验证——
// ① asar 清单：该在的在（better-sqlite3 win32-x64.node / onnxruntime win32/x64 / src），
//    该走的走（onnxruntime-web / 非 win32 平台二进制——files 过滤的账）；
// ② 解包后在纯 Node 里从「过滤后的树」require transformers 并真跑一次 embedding
//    （证明 files 过滤没砍断 onnxruntime-node 的运行时加载链；napi binding 跨 ABI 稳定）；
// ③ 打包出的 exe 以 STONE3 模式自跑（sqlite+fts5 在 Electron ABI 下从 asar/unpacked 加载）。
// 用法：node test/packaged-verify.mjs（先有 release/win-unpacked/ 再跑）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const UNPACKED = path.join(ROOT, "release", "win-unpacked");
const ASAR = path.join(UNPACKED, "resources", "app.asar");
const MODELS = path.join(ROOT, ".models");

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

if (!fs.existsSync(ASAR)) {
  console.log(`FAIL - 找不到 ${path.relative(ROOT, ASAR)}（先跑 npx electron-builder --dir）`);
  process.exit(1);
}

// ---------- ① asar 清单对账 ----------
// listPackage 返回 Windows 反斜杠路径——先归一化成 / 再比对
const files = asar.listPackage(ASAR).map((f) => f.replace(/\\/g, "/"));
const has = (p) => files.some((f) => f.includes(p));
assert(has("/node_modules/better-sqlite3/prebuilds/win32-x64.node"),
  "asar(unpacked) 里有 better-sqlite3 的 win32-x64 预编译绑定");
assert(has("/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node"),
  "asar(unpacked) 里有 onnxruntime-node win32/x64 binding");
assert(has("/src/main.js") && has("/src/desktop/engine.mjs") && has("/src/renderer/app.js"),
  "asar 里有 src 三件套（main/engine/renderer）");
assert(!has("/node_modules/onnxruntime-web/"), "onnxruntime-web 已剔除（141MB wasm，node 版 transformers 不 require 它）");
assert(!has("/node_modules/onnxruntime-node/bin/napi-v6/darwin/") && !has("/node_modules/onnxruntime-node/bin/napi-v6/linux/"),
  "onnxruntime-node 的 darwin/linux 二进制已剔除");
assert(!has("/node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/"), "onnxruntime-node win32/arm64 已剔除");
assert(!has("/node_modules/better-sqlite3/prebuilds/darwin") && !has("/node_modules/better-sqlite3/prebuilds/linux"),
  "better-sqlite3 非 win32-x64 prebuilds 已剔除");
assert(!has("/node_modules/@napi-rs/"), "@napi-rs/canvas 已剔除（pdfjs 可选依赖，我们只做文本提取不渲染页面——下面有真解 PDF 背书）");

// 体积对账（asar + unpacked 合计）
const dirSizeMB = (d) => +execFileSync("du", ["-sm", d], { encoding: "utf8" }).match(/^(\d+)/)[1];
const asarMB = dirSizeMB(ASAR);
const unpackedDir = path.join(UNPACKED, "resources", "app.asar.unpacked");
const unpackedMB = fs.existsSync(unpackedDir) ? dirSizeMB(unpackedDir) : 0;
console.log(`  体积：app.asar ${asarMB}MB + app.asar.unpacked ${unpackedMB}MB = ${asarMB + unpackedMB}MB（过滤前约 470MB）`);
assert(asarMB + unpackedMB < 190, `瘦身生效：合计 ${asarMB + unpackedMB}MB < 190MB`);

// ---------- ② 解包 → 过滤后的树真跑 embedding + 真解一本书 ----------
const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-packverify-"));
try {
  asar.extractAll(ASAR, extractDir);
  // ②-a 模型链：transformers + onnxruntime 从过滤后的树加载，真 embedding
  const out = execFileSync(process.execPath, ["-e", `
    const tf = require(${JSON.stringify(path.join(extractDir, "node_modules", "@huggingface", "transformers"))});
    (async () => {
      tf.env.cacheDir = ${JSON.stringify(MODELS)};
      tf.env.allowLocalModels = true;
      const pipe = await tf.pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "int8" });
      const r = await pipe("passage: 上善若水", { pooling: "mean", normalize: true });
      console.log("EMBED_OK", r.dims[0], r.dims[1]);
    })().catch(e => { console.error("EMBED_FAIL", e.message); process.exit(1); });
  `], { encoding: "utf8", stdio: "pipe", timeout: 180000 });
  const m = out.match(/EMBED_OK (\d+) (\d+)/);
  assert(m && m[1] === "1" && m[2] === "384",
    `过滤后的树真跑 embedding：输出 ${m ? m[1] + "×" + m[2] : "失败"}（e5 384 维——onnxruntime 加载链没被砍断）`);

  // ②-b 导入链：过滤后的 src/build-book.js 真解一本 PDF + 一本 docx（pdfjs 无 canvas 降级路径验证）
  const parseOut = execFileSync(process.execPath, ["-e", `
    const bb = require(${JSON.stringify(path.join(extractDir, "src", "build-book.js"))});
    (async () => {
      const pdf = await bb.parsePdf(${JSON.stringify(path.join(ROOT, "books", "lunyu-xueer-zh.pdf"))});
      const docx = await bb.parseDocx(${JSON.stringify(path.join(ROOT, "books", "lunyu-xueer-zh.docx"))});
      console.log("PARSE_OK", pdf.numPages, pdf.chunks.length, docx.chapters, docx.chunks.length);
    })().catch(e => { console.error("PARSE_FAIL", e.message); process.exit(1); });
  `], { encoding: "utf8", stdio: "pipe", timeout: 120000 });
  const pm = parseOut.match(/PARSE_OK (\d+) (\d+) (\d+) (\d+)/);
  assert(pm && +pm[1] === 4 && +pm[3] === 16,
    `过滤后的树真解 PDF（${pm?.[1]} 页）+ docx（${pm?.[3]} 章）——pdfjs 无 canvas 降级正常，导入链没断`);
} finally {
  fs.rmSync(extractDir, { recursive: true, force: true });
}

// ---------- ③ 打包 exe 的 STONE3 自检（Electron ABI + asar 加载） ----------
const exe = path.join(UNPACKED, "BookSkillPlatform.exe");
if (fs.existsSync(exe)) {
  const stonePath = path.join(os.tmpdir(), "stone3-result.json");
  fs.rmSync(stonePath, { force: true });
  const env = { ...process.env, STONE3: "1" };
  delete env.ELECTRON_RUN_AS_NODE; // 本沙箱会注入它，会把 exe 劫持成裸 Node（卜宕机的坑）
  try {
    execFileSync(exe, [], { encoding: "utf8", stdio: "pipe", timeout: 60000, env });
  } catch { /* STONE3 模式正常退出码可能是 0；结果以文件为准 */ }
  const r = fs.existsSync(stonePath) ? JSON.parse(fs.readFileSync(stonePath, "utf8")) : null;
  assert(r && r.ok === true, `打包 exe STONE3 自检通过（sqlite ${r?.sqlite || "?"} + fts5 trigram 在 Electron ABI 下 OK）`);
} else {
  console.log("SKIP - 找不到 BookSkillPlatform.exe（STONE3 自检跳过）");
}

console.log("\n========== 打包验收结果 ==========");
if (failed > 0) { console.log(`有 ${failed} 项 FAIL`); process.exit(1); }
console.log("全部 PASS：asar 清单对账 + 过滤后树真跑模型 + 打包 exe 自检");
