// 原书视图单测（V3 第四波 #166）：readTextBuffer（BOM 三态）/ describeAsset（render 分流）/
// book:// 协议 handler（txt 直读 / docx mammoth 转 HTML / pdf 415 / 不存在 404 / 坏 id 400 /
// 超大 413 / 缓存命中）——纯 fs + tmp 夹具，协议 handler 不依赖 Electron 可直接调。
// libDir 经 configureSearch 注入（handler 内部走 currentLibDir，与生产同一条懒取路径）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureSearch } from "../src/lib/search.mjs";
import { readTextBuffer, describeAsset, createAssetProtocol } from "../src/desktop/book-view.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}${cond || extra === undefined ? "" : ` | ${extra}`}`);
  cond ? pass++ : fail++;
};

// ---------- 夹具 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-bookview-"));
const libDir = path.join(tmp, "library");
const booksDir = path.join(tmp, "books");
fs.mkdirSync(libDir, { recursive: true });
fs.mkdirSync(booksDir, { recursive: true });

const TEXT = "道可道，非常道。名可名，非常名。\n第二行：檢索增強生成讓回答錨定原文。";
fs.writeFileSync(path.join(booksDir, "plain.txt"), TEXT, "utf8");
fs.writeFileSync(path.join(booksDir, "bom.txt"), "\uFEFF" + TEXT, "utf8");
fs.writeFileSync(path.join(booksDir, "u16.txt"), "\uFEFF" + TEXT, "utf16le");
// 真 docx：从项目 books/ 拷贝道德经（mammoth 真转换，不造假）
fs.copyFileSync(path.join(import.meta.dirname, "..", "books", "daodejing-zh.docx"), path.join(booksDir, "daodejing-zh.docx"));
fs.writeFileSync(path.join(booksDir, "paper.pdf"), "%PDF-1.4 fake bytes");
fs.writeFileSync(path.join(booksDir, "huge.docx"), Buffer.alloc(9 * 1024 * 1024, 0x41)); // >8MB：走 413 不转

configureSearch({ libDir });

// ---------- 1) readTextBuffer：BOM 三态（UTF-16 原件直接 toString 会变乱码——本轮要治的） ----------
ok(readTextBuffer(fs.readFileSync(path.join(booksDir, "plain.txt"))) === TEXT, "utf8 无 BOM 原样读出");
ok(readTextBuffer(fs.readFileSync(path.join(booksDir, "bom.txt"))) === TEXT, "utf8 BOM 被剥掉，无乱码前缀");
{
  const t = readTextBuffer(fs.readFileSync(path.join(booksDir, "u16.txt")));
  ok(t === TEXT && !t.startsWith("\uFEFF"), "utf16le BOM 正确解码（不是乱码）");
}
ok(readTextBuffer(Buffer.alloc(0)) === "", "空文件 → 空串不抛");

// ---------- 2) describeAsset：render 分流 ----------
{
  const d = describeAsset(libDir, "daodejing-zh.docx");
  ok(d.ok && d.data.render === "html" && d.data.ext === "docx"
    && d.data.url === "book://asset/daodejing-zh.docx" && d.data.size > 0, "docx（≤8MB）→ render=html + book:// URL");
  ok(!("path" in d.data), "describeAsset 不带绝对路径（路径不外泄渲染层）");
}
ok(describeAsset(libDir, "plain.txt").data.render === "text", "txt → render=text");
ok(describeAsset(libDir, "paper.pdf").data.render === "external", "pdf → render=external（系统打开）");
ok(describeAsset(libDir, "huge.docx").data.render === "external", "超大 docx → render=external（拒转）");
ok(describeAsset(libDir, "不存在的书").ok === false, "无原件 → ok:false（不抛）");
for (const bad of ["", "../x", "a/b"]) ok(describeAsset(libDir, bad).ok === false, `describeAsset 拒非法 id：${JSON.stringify(bad)}`);

// ---------- 3) book:// 协议 handler ----------
const handler = createAssetProtocol();
const req = (url) => handler(new Request(url));

{
  const res = await req("book://asset/plain.txt");
  ok(res.status === 200 && res.headers.get("content-type").includes("text/html"), "txt → 200 text/html（包壳供 iframe）");
  const html = await res.text();
  ok(html.includes("<pre class=\"orig-txt\">") && html.includes("道可道，非常道"), "txt 壳含原文（一字不改）");
  ok(html.includes("檢索增強生成讓回答錨定原文"), "txt 第二行完整进壳");
}
{
  const res = await req("book://asset/bom.txt");
  const html = await res.text();
  ok(html.includes("道可道，非常道") && !html.includes("\uFEFF"), "协议层 BOM 文件同样干净（无乱码前缀）");
}
{
  const res = await req("book://asset/u16.txt");
  const html = await res.text();
  ok(html.includes("道可道，非常道") && !html.includes("\uFEFF") && !/�/.test(html), "协议层 utf16le 解码正确（无替换字符）");
}
{
  const res = await req("book://asset/daodejing-zh.docx");
  ok(res.status === 200 && res.headers.get("content-type").includes("text/html"), "docx → 200 text/html");
  const html = await res.text();
  ok(html.includes("<article class=\"orig-docx\">") && html.includes("<style>"), "docx → mammoth HTML 外壳（样式 + article）");
  ok(/<p>|<h[1-6]>/.test(html), "mammoth 真转换出块级标签");
  ok(!/<script/i.test(html), "输出无 script（mammoth 安全 HTML）");
  // 缓存命中：第二次请求同 key 直接返回（内容一致 + 不重复转换）
  const res2 = await req("book://asset/daodejing-zh.docx");
  ok((await res2.text()) === html, "缓存命中：二次请求内容一致");
}
{
  const res = await req("book://asset/paper.pdf");
  ok(res.status === 415, "pdf → 415（前端 fallback 系统打开）");
}
{
  const res = await req("book://asset/huge.docx");
  ok(res.status === 413, "超大 docx → 413（不转，走系统打开）");
}
{
  const res = await req("book://asset/不存在的书.txt");
  ok(res.status === 404, "不存在 → 404");
}
for (const bad of ["../etc/passwd", "a/b", ""]) {
  const res = await req("book://asset/" + encodeURIComponent(bad));
  ok(res.status === 400, `协议层拒非法 id：${JSON.stringify(bad)}`);
}
{
  const res = await req("book://other/plain.txt");
  ok(res.status === 400, "非 asset 主机名 → 400");
}
{
  const res = await req("book://asset/" + encodeURIComponent("..\\..\\windows"));
  ok(res.status === 400, "反斜杠穿越同样拒（safeBookId 双分隔符）");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`===== book-view-test: ${pass} pass / ${fail} fail =====`);
process.exit(fail ? 1 : 0);
