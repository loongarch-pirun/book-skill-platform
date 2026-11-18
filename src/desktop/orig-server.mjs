// T6 环回网页映射：把 orig-web 的原件网页暴露给第三方智能体的 webview（统一渲染，不依赖各智能体原生 UI）。
// 安全：仅绑 127.0.0.1 + 一次性 token（每进程随机）+ safeBookId；不对外网开放。纯 node（无 electron），
// 故 MCP stdio 进程与桌面主进程都可各自起一个。pdf 回一个自包含 viewer html（pdfjs 走 /vendor/pdfjs/）。
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { originalWeb } from "./orig-web.mjs";
import { resolveAsset, safeBookId } from "../lib/assets.mjs";

const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/pdfjs-dist/build");
const pdfViewer = (id, page, token) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#f7f7f5}#c{display:block;margin:0 auto}</style></head><body><canvas id="c"></canvas>
<script type="module">
import * as pdfjs from "/vendor/pdfjs/pdf.mjs?t=${token}";
pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs?t=${token}";
const buf = await (await fetch("/raw/${encodeURIComponent(id)}?t=${token}")).arrayBuffer();
const doc = await pdfjs.getDocument({ data: buf }).promise;
const p = await doc.getPage(Math.min(Math.max(1, ${Number(page) || 1}), doc.numPages));
const vp = p.getViewport({ scale: 1.5 });
const c = document.getElementById("c"); c.width = vp.width; c.height = vp.height;
await p.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
</script></body></html>`;

export async function startOrigServer({ libDir }) {
  const token = crypto.randomBytes(16).toString("hex");
  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, "http://127.0.0.1"); } catch { res.writeHead(400); res.end("bad url"); return; }
    if (u.searchParams.get("t") !== token) { res.writeHead(403); res.end("forbidden"); return; }
    try {
      if (u.pathname.startsWith("/vendor/pdfjs/")) {
        const f = path.basename(u.pathname);
        if (f !== "pdf.mjs" && f !== "pdf.worker.mjs") { res.writeHead(404); res.end("no"); return; }
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(fs.readFileSync(path.join(VENDOR, f)));
        return;
      }
      if (u.pathname.startsWith("/raw/")) {
        const id = safeBookId(decodeURIComponent(u.pathname.slice("/raw/".length)));
        const a = id && resolveAsset(libDir, id);
        if (!a || !a.exists) { res.writeHead(404); res.end("no asset"); return; }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(fs.readFileSync(a.path));
        return;
      }
      if (u.pathname.startsWith("/book/")) {
        const id = safeBookId(decodeURIComponent(u.pathname.slice("/book/".length)));
        const pg = u.searchParams.get("page");
        const r = await originalWeb(libDir, id, { page: pg == null || pg === "" ? null : Number(pg) });
        if (r.type === "html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(r.html); return; }
        if (r.type === "pdf") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(pdfViewer(id, pg, token)); return; }
        res.writeHead(404); res.end(r.message); return;
      }
      res.writeHead(404); res.end("not found");
    } catch (e) { res.writeHead(500); res.end(String(e.message || e)); }
  });
  // 监听失败（沙箱禁绑环回等）不吊死调用方：降级为无服务，webUrl 置 null，锚点/深链仍给。
  const listenOk = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => resolve(true));
  });
  if (!listenOk) return { server: null, token, port: null, bookUrl: () => null };
  server.unref(); // 不保持事件循环：CLI/测试进程用完即退，不被环回服务吊住
  return {
    server, token,
    get port() { return server.address().port; },
    bookUrl: (id, page) => `http://127.0.0.1:${server.address().port}/book/${encodeURIComponent(id)}?t=${token}${page != null ? `&page=${page}` : ""}`,
  };
}