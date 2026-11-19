// T4 原件→网页统一映射：客户端自开全格式（零第三方 WPS/Office）。
// txt/md 直显、docx mammoth、epub adm-zip spine XHTML、pptx readPptx（内容真/版面近似）、
// pdf 交 pdfjs（回 pdfUrl）。book:// 协议与环回 HTTP(orig-server) 共用本映射。
// 壳与 readTextBuffer 与 book-view 同款（纸色阅读样式）；后续可抽公共壳去重。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveAsset, safeBookId } from "../lib/assets.mjs";
import { readPptx } from "../lib/pptx.mjs";
const require = createRequire(import.meta.url);
const mammoth = require("mammoth");
const AdmZip = require("adm-zip");

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const readTextBuffer = (buf) => {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le").replace(/^\uFEFF/, "");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString("utf8").replace(/^\uFEFF/, "");
  return buf.toString("utf8").replace(/^\uFEFF/, "");
};
const SHELL = (cls, body) => `<style>
.orig-${cls}{font-family:Georgia,"Songti SC","SimSun",serif;font-size:15px;line-height:1.9;color:#3a2f23}
.orig-${cls} p{margin:8px 0} .orig-${cls} img{max-width:100%}
.orig-${cls} pre{white-space:pre-wrap;word-break:break-word;margin:0}
.orig-${cls} .slide{border-bottom:1px dashed #d8cdb8;padding:10px 0}
</style><article class="orig-${cls}">${body}</article>`;

function epubHtml(filePath) {
  const zip = new AdmZip(filePath);
  const container = zip.readAsText("META-INF/container.xml");
  const opfPath = (container.match(/full-path="([^"]+)"/) || [])[1];
  if (!opfPath) throw new Error("epub 缺 container/rootfile");
  const opf = zip.readAsText(opfPath);
  const manifest = new Map();
  for (const m of opf.matchAll(/<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)) manifest.set(m[1], m[2]);
  const spine = [...opf.matchAll(/<itemref[^>]*idref="([^"]+)"/g)].map((m) => manifest.get(m[1])).filter(Boolean);
  const dir = path.dirname(opfPath).replaceAll("\\", "/");
  const bodies = spine.map((href) => {
    const e = zip.getEntry(path.posix.join(dir, href));
    if (!e) return "";
    const x = zip.readAsText(e);
    const b = (x.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || x;
    return b.replace(/<script[\s\S]*?<\/script>/gi, "");
  }).filter(Boolean);
  return SHELL("epub", bodies.join("\n"));
}
function pptxHtml(filePath, page) {
  const slides = readPptx(filePath);
  const pick = page == null ? slides : slides.filter((s) => s.page === Number(page));
  const body = pick.map((s) => `<section class="slide" data-page="${s.page}"><h3>幻灯片 ${s.page}</h3>`
    + s.text.split("\n").map((t) => `<p>${escHtml(t)}</p>`).join("")
    + s.images.map((im) => `<img src="${im.dataUrl}" alt="${escHtml(im.name)}">`).join("")
    + `</section>`).join("\n");
  return SHELL("pptx", body || "<p>（该页无可检文字）</p>");
}

// 返回 {type:"html",html} | {type:"pdf",pdfUrl} | {type:"error",message}。只读原件，不改原件。
export async function originalWeb(libDir, bookId, { page = null } = {}) {
  const id = safeBookId(bookId);
  if (!id) return { type: "error", message: "书名不合法" };
  const asset = resolveAsset(libDir, id);
  if (!asset.exists) return { type: "error", message: `《${id}》没有原件文件（books/ 里找不到）——翻书视图看的是库里的原文块` };
  let size;
  try { size = fs.statSync(asset.path).size; } catch { return { type: "error", message: "原件读不出来（可能正在被占用）" }; }
  if (size > 50 * 1024 * 1024) return { type: "error", message: "文件太大（>50MB），请用系统程序打开" };
  try {
    if (asset.ext === "txt" || asset.ext === "md") return { type: "html", html: SHELL("txt", `<pre>${escHtml(readTextBuffer(fs.readFileSync(asset.path)))}</pre>`) };
    if (asset.ext === "docx") {
      if (size > 8 * 1024 * 1024) return { type: "error", message: "docx 太大（>8MB），请用系统程序打开" };
      const { value } = await mammoth.convertToHtml({ path: asset.path });
      return { type: "html", html: SHELL("docx", value) };
    }
    if (asset.ext === "epub") return { type: "html", html: epubHtml(asset.path) };
    if (asset.ext === "pptx") return { type: "html", html: pptxHtml(asset.path, page) };
    if (asset.ext === "pdf") return { type: "pdf", pdfUrl: `book://raw/${encodeURIComponent(id)}` };
    return { type: "error", message: `${asset.ext} 格式请用系统程序打开` };
  } catch (e) {
    return { type: "error", message: `这个 ${asset.ext} 打不开（${e.message || e}）——请用系统程序打开` };
  }
}
