// 原书视图（V3 第四波 #166，资产/派生分层 Step 2）：
//   book:// 协议给渲染进程读 books/ 原件——「丢入即可看原文」在结构化改造之前就能看；
//   book:openExternal 走系统程序（WPS/Word/pdf 阅读器）打开——桌面可打开。
// URL：book://asset/<bookId>（encodeURIComponent；安全闸门 safeBookId + resolveAsset，与 assets.mjs 同一把）
// 格式路由：
//   txt/md：读文件包 HTML 壳返回（BOM 感知：utf8 / utf16le——txt2docx 见过 UTF-16 原件）
//   docx ：mammoth 转 HTML（复用 build-book 同依赖，渲染层零新包；缓存 key=id+mtime+size，LRU 8）
//   pdf/epub：415——前端 fallback 元信息卡 + 「用系统程序打开」
// 渲染层经 <iframe src="book://..."> 加载（不走 fetch——guard-test「渲染层无直连 fetch」
// 红线防的是绕开 IPC 调外部 API；book:// 是 app 内只读协议，iframe 导航不碰网络）
// 体积闸门：>50MB 不读（413）；docx >8MB 不转 HTML（413，走系统打开）——防扫描件巨书拖垮渲染进程
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveAsset, safeBookId } from "../lib/assets.mjs";
import { currentLibDir } from "../lib/search.mjs";

const require = createRequire(import.meta.url);
const mammoth = require("mammoth");

const ASSET_READ_MAX = 50 * 1024 * 1024;   // 协议读取总闸门
const DOCX_HTML_MAX = 8 * 1024 * 1024;     // mammoth 转换闸门
const DOCX_CACHE_MAX = 8;                  // HTML 缓存条数（LRU）

// docx → HTML 的外壳：自包含样式（渲染层 <iframe> 加载，样式随片段一起进 iframe 文档）。
// 类名统一 .orig- 前缀，不污染 app.css 命名空间
const DOCX_SHELL = (body) => `<style>
.orig-docx{font-family:Georgia,"Songti SC","SimSun",serif;font-size:15px;line-height:1.9;color:#3a2f23}
.orig-docx h1{font-size:22px;margin:18px 0 10px}
.orig-docx h2{font-size:19px;margin:16px 0 8px}
.orig-docx h3{font-size:16px;margin:14px 0 6px}
.orig-docx p{margin:8px 0}
.orig-docx table{border-collapse:collapse;margin:10px 0}
.orig-docx td,.orig-docx th{border:1px solid #d8cdb8;padding:5px 9px;font-size:13px}
.orig-docx img{max-width:100%}
</style><article class="orig-docx">${body}</article>`;

// txt 同款包壳（iframe 里统一纸色阅读样式；文本必须 HTML 转义后进 <pre>）
const TXT_SHELL = (text) => `<style>
.orig-txt{font-family:Georgia,"Songti SC","SimSun",serif;font-size:14px;line-height:1.9;white-space:pre-wrap;word-break:break-word;margin:0;color:#3a2f23}
</style><pre class="orig-txt">${escHtml(text)}</pre>`;

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// txt 读取：BOM 感知。项目 txt 均 utf8，但 txt2docx 的人话提示见过 UTF-16 原件——
// 直接 toString("utf8") 会把 UTF-16 读成乱码，用户看到的就是「乱码符号」（本轮要治的）
export function readTextBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le").replace(/^\uFEFF/, "");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString("utf8").replace(/^\uFEFF/, "");
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

// 原件描述（IPC book:original 用）：存在性/格式/大小/展示方式。不带绝对路径——渲染层不需要
export function describeAsset(libDir, bookId) {
  const id = safeBookId(bookId);
  if (!id) return { ok: false, error: "书名不合法" };
  const asset = resolveAsset(libDir, id);
  if (!asset.exists) {
    return { ok: false, error: `《${id}》没有原件文件（books/ 里找不到）——这本书可能是早期命令行建库的，翻书视图看的是库里的原文块` };
  }
  let size;
  try { size = fs.statSync(asset.path).size; } catch { return { ok: false, error: "原件读不出来（可能正在被占用）" }; }
  const render = asset.ext === "txt" || asset.ext === "md" ? "text"
    : asset.ext === "docx" && size <= DOCX_HTML_MAX ? "html"
      : "external";
  return {
    ok: true,
    data: {
      bookId: id, ext: asset.ext, name: path.basename(asset.path), size,
      url: `book://asset/${encodeURIComponent(id)}`,
      render, // text=直接读 / html=mammoth 片段 / external=系统打开
    },
  };
}

// book:// 协议 handler（main.js whenReady 注册）。libDir 懒取——handler 只在用户点击时触发，
// 彼时 engine.init 已完成目录解析（启动时序无 G-04 式坑）
export function createAssetProtocol() {
  const cache = new Map(); // key -> html（Map 保序即 LRU：命中 delete+set 挪尾，超限砍头）
  const cacheSet = (key, html) => {
    cache.set(key, html);
    while (cache.size > DOCX_CACHE_MAX) cache.delete(cache.keys().next().value);
  };

  return async (request) => {
    let bookId;
    try {
      const u = new URL(request.url);
      if (u.hostname !== "asset") return new Response("book:// 只认 asset 主机名", { status: 400 });
      bookId = decodeURIComponent(u.pathname.replace(/^\//, ""));
    } catch { return new Response("book:// 地址不对", { status: 400 }); }

    const id = safeBookId(bookId);
    if (!id) return new Response("书名不合法", { status: 400 });
    const asset = resolveAsset(currentLibDir(), id);
    if (!asset.exists) return new Response("原件不在 books/ 目录", { status: 404 });

    let size = 0;
    try { size = fs.statSync(asset.path).size; } catch { /* stat 失败落下面读取的错误分支 */ }
    if (size > ASSET_READ_MAX) return new Response("文件太大（>50MB），请用系统程序打开", { status: 413 });

    if (asset.ext === "txt" || asset.ext === "md") {
      const text = readTextBuffer(fs.readFileSync(asset.path));
      return new Response(TXT_SHELL(text), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (asset.ext === "docx") {
      if (size > DOCX_HTML_MAX) return new Response("文件太大，请用系统程序打开", { status: 413 });
      const st = fs.statSync(asset.path);
      const key = `${id}:${st.mtimeMs}:${st.size}`;
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); return new Response(hit, { headers: { "content-type": "text/html; charset=utf-8" } }); }
      try {
        const { value } = await mammoth.convertToHtml({ path: asset.path });
        const html = DOCX_SHELL(value);
        cacheSet(key, html);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      } catch (e) {
        return new Response(`这个 docx 打不开（${e.message || e}）——请用系统程序打开`, { status: 500 });
      }
    }
    // pdf / epub：应用内不渲染，前端拿 415 后走「系统打开」卡片
    return new Response(`${asset.ext} 格式请用系统程序打开`, { status: 415 });
  };
}
