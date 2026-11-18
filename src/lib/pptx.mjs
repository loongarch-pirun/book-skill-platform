// T2 pptx 轻量读取：pptx 本质 zip+XML，用已有 adm-zip 解，只取内容（文本框文字+图片），
// 不渲染版面/动画（用户拍板：重点是内容，当图片/网页呈现即可）。零原生转换器依赖。
// page=幻灯片号（从1，按 slideN 数值排序）。ingest(T3) 与网页映射(T4) 共用。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
export function readPptx(filePath) {
  const zip = new AdmZip(filePath);
  const names = zip.getEntries().map((e) => e.entryName)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/slide(\d+)/)[1]) - (+b.match(/slide(\d+)/)[1]));
  return names.map((n) => {
    const xml = zip.readAsText(n);
    const paras = xml.split(/<a:p[ >]/).slice(1).map((seg) => {
      const ts = [...seg.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => dec(m[1]));
      return ts.join("");
    }).filter((t) => t.trim());
    const images = [];
    const relName = n.replace("slides/", "slides/_rels/") + ".rels";
    const rels = zip.getEntry(relName) ? zip.readAsText(relName) : "";
    for (const m of rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)) {
      const e = zip.getEntry("ppt/media/" + m[1]);
      if (e) images.push({ name: m[1], dataUrl: `data:image/${m[1].split(".").pop()};base64,${e.getData().toString("base64")}` });
    }
    return { page: +n.match(/slide(\d+)/)[1], text: paras.join("\n"), images };
  });
}