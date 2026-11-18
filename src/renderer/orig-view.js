// T5 原件翻页呈现：决策纯函数 chooseOrigTarget（可单测）+ pdf 按页渲染 renderPdf（pdfjs 懒加载）。
// 降级铁律：无原件/需系统打开 → 退块视图高亮 + 人话理由，不干报错。
// pdfjs 走相对 node_modules 路径（打包态在 app.asar 内同路径可达）；worker 同目录。
export function chooseOrigTarget(meta, loc) {
  if (!meta || !meta.ok) return { mode: "block", reason: "没有原件文件（books/ 里找不到）——看库内原文块" };
  const r = meta.data?.render;
  const quote = loc?.text || "";
  if (r === "pdf") return { mode: "original-pdf", page: loc?.page ?? 1, quote };
  if (r === "html" || r === "text") return { mode: "original-html", page: loc?.page ?? null, quote, url: meta.data.url };
  return { mode: "block", reason: "原件需系统程序打开（超大/不支持应用内）——看库内原文块" };
}

// pdf 按页渲染 + 可选句级 overlay（高亮=可选增强）。bytes 来自主进程 IPC book:rawBytes。
export async function renderPdf(container, bytes, { page = 1, quote = "" } = {}) {
  const pdfjs = await import("../../node_modules/pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../node_modules/pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
  const vp = p.getViewport({ scale: 1.5 });
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative;display:inline-block;";
  const canvas = document.createElement("canvas");
  canvas.width = vp.width; canvas.height = vp.height;
  wrap.appendChild(canvas);
  container.appendChild(wrap);
  await p.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  const norm = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");
  if (quote && norm(quote)) {
    const tc = await p.getTextContent();
    const all = norm(tc.items.map((i) => i.str).join(""));
    if (all.includes(norm(quote))) {
      for (const it of tc.items) {
        if (!norm(it.str)) continue;
        const d = document.createElement("div");
        d.style.cssText = `position:absolute;background:rgba(255,229,138,.5);left:${it.transform[4]}px;top:${vp.height - it.transform[5] - (it.height || 10)}px;width:${it.width || 10}px;height:${it.height || 10}px;pointer-events:none;`;
        wrap.appendChild(d);
      }
    }
  }
  container.scrollIntoView({ block: "center" });
  return { numPages: doc.numPages, page: p.pageNumber };
}