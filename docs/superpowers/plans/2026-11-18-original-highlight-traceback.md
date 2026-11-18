# 原文回溯（页/章索引 + 内置轻量转换 + 网页映射 + 智能体触发）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 知识点/引用→翻回原件对应页（PDF/PPT）或章/段（txt/docx/epub）并呈现；客户端自带轻量转换器自开全格式（零第三方 WPS/Office）；智能体经网页映射/深链代为触发翻书。

**Architecture:** 统一锚点契约（bookId+chunkId+page+chapter+quote）；原件→网页统一映射层 orig-web（txt 直显/docx mammoth/epub adm-zip XHTML/pdf pdfjs/pptx adm-zip XML→HTML），全部内置依赖；book:// 与环回 HTTP 双通道暴露同一映射；jumpTo 按 page/chapter 翻页呈现；MCP 回 anchor+webUrl+deepLink；OS bookskill:// 深链自动拉起客户端翻书。高亮=可选增强非需求。

**Tech Stack:** Electron(protocol.handle/IPC/单实例)、mammoth、adm-zip、pdfjs-dist（均已在 dependencies）、node:http(环回)、better-sqlite3、MCP SDK。

**Spec:** 2026-11-18 需求对齐：定位并呈现原件对应内容（有页用页/无页用章段）；客户端自开不靠 WPS；智能体网页映射统一渲染；诚实降级仅原件缺失/损坏；高亮非需求。

## Global Constraints

- 零第三方阅读器依赖：不依赖本机 WPS/Office/LibreOffice；转换全用内置 JS 依赖（mammoth/adm-zip/pdfjs）。
- 原文一字不动：呈现/转换只读原件，不改原件与 chunks.text。
- 不重切块：chunk_fp 只哈希 id+text（src/lib/enrich.mjs:43-51）；pptx 为新增格式不影响旧库指纹。
- 页定义：PDF=物理页、PPT=幻灯片号；txt/docx/epub=章/段逻辑定位（章级达标，段级锦上添花）。
- 降级仅当原件缺失/损坏/转换失败：回块视图+人话；智能体侧再降位置+原文。
- 环回服务仅绑 127.0.0.1 + 一次性 token + 不对外；深链参数过 safeBookId/整数校验。
- 包体 ≤2.0GiB（size-budget.json）；新增仅代码级 KB~MB，不内置原生转换器/模型。
- 检索不出网；云端仅既有同意门（resolveSendSource）。
- TDD 红→绿；批末 test:fast + quality-gate 不退化；发布解冻在本 plan Task 7。
- 高亮（mark/overlay）仅可选增强，不做验收必需。

## File Structure

- Create `src/lib/anchor.mjs`：锚点契约 buildAnchor/formatDeepLink/parseDeepLink（客户端/MCP/main 共用）。
- Create `src/lib/pptx.mjs`：adm-zip 解 pptx→slides[{page,text,images[]}]（ingest 与网页映射共用）。
- Create `src/desktop/orig-web.mjs`：原件→网页统一映射 originalHtml(libDir,bookId,{page})→{type,html|pdfUrl}。
- Create `src/desktop/orig-server.mjs`：环回 HTTP + token，serve orig-web 与 pdfjs vendor。
- Create `src/renderer/orig-view.js`：iframe 加载映射网页 / pdfjs 按页渲染；jumpTo 翻页呈现。
- Create tests：`test/anchor-test.mjs`、`test/pptx-test.mjs`、`test/orig-web-test.mjs`、`test/orig-server-test.mjs`、`test/deeplink-test.mjs`、`test/traceback-jump-test.mjs`。
- Modify：`src/lib/assets.mjs:16`(ASSET_EXTS+pptx)、`src/desktop/jobs.mjs`(EXT_FMT+pptx)、`src/build-book.js`(pptx 解析分支)、`src/desktop/book-view.mjs`(委托 orig-web、pdf/epub/pptx 不再 415)、`src/desktop/engine.mjs:605-613`(locate 扩 page/text)、`src/renderer/views-reader.js`(jumpTo)、`src/lib/register-tools.mjs`(anchor/webUrl/deepLink)、`src/main.js`(深链+单实例+orig-server)、`src/desktop/ipc.mjs`(book:origWeb)。

---

### Task 1: 锚点契约 + locate 扩字段

**Files:** Create `src/lib/anchor.mjs`,`test/anchor-test.mjs`; Modify `src/desktop/engine.mjs:605-613`
**Interfaces:** Produces `buildAnchor({bookId,id,page,chapter,loc,text})→{bookId,chunkId,page,loc,chapter,quote}`、`formatDeepLink(a)→bookskill://open?b&c&p`、`parseDeepLink(url)→a|null`；locateChunk 新回 `{chapter,page,text,loc}`。

- [ ] **Step 1 写失败测试** `test/anchor-test.mjs`

```js
import assert from "node:assert";
import { buildAnchor, formatDeepLink, parseDeepLink } from "../src/lib/anchor.mjs";
const a = buildAnchor({ bookId: "mengzi-zh.docx", id: 12, page: null, chapter: "梁惠王上", loc: "梁惠王上·1", text: "孟子見梁惠王。" });
assert.strictEqual(a.chunkId, 12); assert.strictEqual(a.quote, "孟子見梁惠王。");
const back = parseDeepLink(formatDeepLink(a));
assert.strictEqual(back.bookId, a.bookId); assert.strictEqual(back.chunkId, 12);
assert.strictEqual(parseDeepLink("https://x/y"), null);
assert.strictEqual(parseDeepLink("bookskill://open?b=&c="), null);
console.log("anchor-test: PASS");
```

- [ ] **Step 2 跑红** `node test/anchor-test.mjs` → FAIL（模块不存在）。
- [ ] **Step 3 实现** `src/lib/anchor.mjs`

```js
export function buildAnchor({ bookId, id, page = null, chapter = null, loc = null, text = "" }) {
  return { bookId: String(bookId || ""), chunkId: Number(id), page: page ?? null, loc: loc || null, chapter: chapter || null, quote: String(text || "") };
}
export function formatDeepLink(a) {
  const q = new URLSearchParams({ b: a.bookId, c: String(a.chunkId), p: a.page == null ? "" : String(a.page) });
  return `bookskill://open?${q.toString()}`;
}
export function parseDeepLink(url) {
  let u; try { u = new URL(String(url || "")); } catch { return null; }
  if (u.protocol !== "bookskill:" || u.hostname !== "open") return null;
  const b = u.searchParams.get("b"), c = u.searchParams.get("c");
  if (!b || c == null || c === "" || !Number.isInteger(Number(c))) return null;
  const p = u.searchParams.get("p");
  return { bookId: b, chunkId: Number(c), page: p === "" || p == null ? null : Number(p), loc: null, chapter: null, quote: "" };
}
```

- [ ] **Step 4 locate 扩** engine.mjs:610-611：

```js
    const r = db.prepare("SELECT chapter, page, text FROM chunks WHERE id = ?").get(Number(chunkId));
    return r ? { chapter: r.chapter || "未分章", page: r.page ?? null, text: r.text || "", loc: r.chapter || "未分章" } : { chapter: null, page: null, text: "", loc: null };
```

- [ ] **Step 5 跑绿** anchor-test PASS + renderer-graph 不回归。
- [ ] **Step 6 Commit** `git add src/lib/anchor.mjs test/anchor-test.mjs src/desktop/engine.mjs && git commit -m "feat(traceback): 锚点契约 + locate 回 page/text"`

---

### Task 2: pptx 轻量解析（adm-zip XML→slides，ingest/网页共用）

**Files:** Create `src/lib/pptx.mjs`,`test/pptx-test.mjs`
**Interfaces:** Produces `readPptx(path)→[{page,text,images:[{name,dataUrl}]}]`（page=幻灯片号从1）；供 build-book ingest 与 orig-web 共用。

- [ ] **Step 1 写失败测试**（用 adm-zip 现造一个最小 pptx：[Content_Types].xml + ppt/slides/slide1.xml/slide2.xml 含 `<a:t>` 文本 + _rels 指 media；断言 readPptx 回 2 页、text 含原字、page=1/2）。

```js
import assert from "node:assert"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip"); const { readPptx } = await import("../src/lib/pptx.mjs");
const zip = new AdmZip();
const slide = (t) => `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
zip.addFile("ppt/slides/slide1.xml", Buffer.from(slide("第一张原文")));
zip.addFile("ppt/slides/slide2.xml", Buffer.from(slide("第二张原文")));
const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pptx-")), "t.pptx");
zip.writeZip(p);
const s = readPptx(p);
assert.strictEqual(s.length, 2); assert.strictEqual(s[0].page, 1);
assert.ok(s[0].text.includes("第一张原文")); assert.ok(s[1].text.includes("第二张原文"));
console.log("pptx-test: PASS");
```

- [ ] **Step 2 跑红** → FAIL（模块不存在）。
- [ ] **Step 3 实现** `src/lib/pptx.mjs`

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
// 轻量 pptx 读取：zip+XML，只取内容（文本框文字+图片），不渲染版面（用户：重点是内容）。
export function readPptx(filePath) {
  const zip = new AdmZip(filePath);
  const names = zip.getEntries().map(e => e.entryName)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/slide(\d+)/)[1]) - (+b.match(/slide(\d+)/)[1]));
  return names.map((n, i) => {
    const xml = zip.readAsText(n);
    const paras = xml.split(/<a:p[ >]/).slice(1).map(seg => {
      const ts = [...seg.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => dec(m[1]));
      return ts.join("");
    }).filter(t => t.trim());
    const images = [];
    const relName = n.replace("slides/", "slides/_rels/") + ".rels";
    const rels = zip.getEntry(relName) ? zip.readAsText(relName) : "";
    for (const m of rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)) {
      const e = zip.getEntry("ppt/media/" + m[1]);
      if (e) images.push({ name: m[1], dataUrl: `data:image/${m[1].split(".").pop()};base64,${e.getData().toString("base64")}` });
    }
    return { page: i + 1, text: paras.join("\n"), images };
  });
}
```

- [ ] **Step 4 跑绿** pptx-test PASS。
- [ ] **Step 5 Commit** `git commit -m "feat(traceback): pptx 轻量解析（adm-zip XML，内容真/版面近似）"`

---

### Task 3: pptx 入库（ASSET_EXTS/EXT_FMT/build-book 分支，page=幻灯片号）

**Files:** Modify `src/lib/assets.mjs:16`,`src/desktop/jobs.mjs`(EXT_FMT),`src/build-book.js`(解析分支); Test `test/pptx-test.mjs` 增 ingest 断言
**Interfaces:** Consumes readPptx；Produces pptx 书 chunks{page=slide,chapter="幻灯片N",text}，走既有 embed/FTS 管线（不重切旧库）。

- [ ] **Step 1 写失败测试**（buildBook.main([t.pptx,-o,db]) 后 chunks 行数=2、page=1/2、chapter 含幻灯片；书架 listShelf 认 pptx）。
- [ ] **Step 2 跑红**（不支持的格式 .pptx）。
- [ ] **Step 3 实现** assets ASSET_EXTS 加 ".pptx"；jobs EXT_FMT 加 pptx；build-book 解析分支：`if(ext===".pptx"){ blocks = readPptx(file).map(s=>({ text:s.text, page:s.page, chapter:`幻灯片${s.page}` })); }` 接既有 embed/insert 流程。
- [ ] **Step 4 跑绿** + parser-fuzz/stage0 不回归。
- [ ] **Step 5 Commit** `git commit -m "feat(traceback): pptx 入库，page=幻灯片号"`

---

### Task 4: 原件→网页统一映射 orig-web（消除 415/去 WPS）

**Files:** Create `src/desktop/orig-web.mjs`,`test/orig-web-test.mjs`; Modify `src/desktop/book-view.mjs`(委托+pdf/epub/pptx 不再 415)、`src/desktop/ipc.mjs`(book:origWeb)
**Interfaces:** Produces `originalWeb(libDir,bookId,{page})→{type:"html",html}|{type:"pdf",pdfUrl}|{type:"error",message}`；txt/docx/epub/pptx→html（pdf→pdfUrl 交渲染层 pdfjs）；book:// 与环回共用。

- [ ] **Step 1 写失败测试**（txt→html 含原文；docx→html；pptx→html 含 slide 文本且 ?page=2 只呈现第2张；epub→html；pdf→type pdf；无原件→type error 人话）。
- [ ] **Step 2 跑红**。
- [ ] **Step 3 实现** orig-web.mjs：resolveAsset→按 ext 分派：txt/md=readTextBuffer+TXT 壳；docx=mammoth+DOCX 壳；epub=adm-zip 解 OPF spine→xhtml 拼壳（page→spine 索引）；pptx=readPptx→按 page 选 slide→壳（文本段+images img）；pdf→{type:"pdf",pdfUrl:`book://raw/${id}`}；失败→{type:"error",message 人话}。book-view 协议 handler 委托 originalWeb（pdf 回 raw bytes 供 pdfjs）；describeAsset render 改 html/pdf（external 仅转换失败 fallback）。
- [ ] **Step 4 跑绿** + book-view-test/guard 同步（guard 若钉 415 需改）。
- [ ] **Step 5 Commit** `git commit -m "feat(traceback): 原件→网页统一映射，客户端自开全格式去 WPS"`

---

### Task 5: jumpTo 翻页呈现 + 降级矩阵

**Files:** Create `src/renderer/orig-view.js`,`test/traceback-jump-test.mjs`; Modify `src/renderer/views-reader.js`(jumpTo/renderOriginal)
**Interfaces:** Consumes locate{chapter,page,text}+originalWeb；Produces jumpTo(bookId,chunkId)：有原件→orig-view 按 page（pdf/pptx）或 chapter（流式）呈现；段级滚动匹配=锦上添花失败回章；无原件/转换失败→块视图 hl+人话。

- [ ] **Step 1 写失败测试**（矩阵：pdf 有原件→pdf 页呈现；pptx→slide 呈现；docx→章呈现；无原件→块高亮+提示不报错；转换失败→块高亮+人话）。
- [ ] **Step 2 跑红**。
- [ ] **Step 3 实现** orig-view.js：html→iframe srcdoc/book://?page；pdf→pdfjs getDocument(bytes via IPC book:raw)→getPage(page)→canvas+textLayer（可选 mark）；jumpTo 取 locate→describeAsset/originalWeb→分派；失败回块 highlightId+toast。
- [ ] **Step 4 跑绿** + neighbor/renderer-graph 回归。
- [ ] **Step 5 Commit** `git commit -m "feat(traceback): jumpTo 翻页呈现 + 诚实降级矩阵"`

---

### Task 6: 环回网页映射 + MCP anchor/webUrl/deepLink + OS 深链桥

**Files:** Create `src/desktop/orig-server.mjs`,`test/orig-server-test.mjs`,`test/deeplink-test.mjs`; Modify `src/main.js`,`src/lib/register-tools.mjs`
**Interfaces:** Produces 环回 `startOrigServer()→{port,token}`（仅 127.0.0.1）；`GET /book/<id>?page=&t=<token>`→orig-web html（pdf→含 pdfjs vendor 的 viewer html）；MCP results[i]+`anchor,webUrl,deepLink`；OS bookskill://→单实例转发→jumpTo。

- [ ] **Step 1 写失败测试**（server 仅绑 127.0.0.1；无 token/错 token→403；对 token→200 html 含原文；MCP query_book 结果含 anchor/webUrl/deepLink；parseDeepLink 往返）。
- [ ] **Step 2 跑红**。
- [ ] **Step 3 实现** orig-server.mjs（node:http createServer bind 127.0.0.1 port 0；crypto random token；路由 /book/ 与 /vendor/pdfjs/；校验 token+safeBookId）；main.js whenReady 启动 server+`app.setAsDefaultProtocolClient("bookskill")`+`requestSingleInstanceLock`+open-url/second-instance→parseDeepLink→win focus+send("orig:jump")；register-tools map results 加 anchor/webUrl(`http://127.0.0.1:${port}/book/..?t=`)/deepLink。
- [ ] **Step 4 跑绿** + ipc-test/stage3-mcp 回归。
- [ ] **Step 5 Commit** `git commit -m "feat(traceback): 环回网页映射 + MCP 锚点/webUrl/deepLink + OS 深链桥"`

---

### Task 7: 回归 / gate / 体积 / 文档 / 勾选单 / 真机 / 发布解冻

**Files:** Modify `package.json`(test:fast 挂新测试)、`docs/真机验收勾选单.md`、`size-budget.json`(若增量)、安装器 NSIS 协议注册
- [ ] **Step 1** 挂 anchor/pptx/orig-web/orig-server/deeplink/traceback-jump 进 test:fast。
- [ ] **Step 2** `npm run test:fast` 全绿 + `node test/quality-gate.mjs` 不退化。
- [ ] **Step 3** 体积核对：新增仅 JS 代码级 KB~MB，≤2.0GiB；超则同步 size-budget+基线文档。
- [ ] **Step 4** 勾选单增补：客户端自开 txt/docx/epub/pdf/pptx 翻到页/章；无原件/转换失败降级；智能体 webUrl 网页看原文；deepLink 拉起客户端翻书；不依赖 WPS。
- [ ] **Step 5** 真机/CDP 截图留证（含 pptx 新书入库+翻 slide）。
- [ ] **Step 6** Commit+推送+重打包（工作区外目录绕 Qoder 锁）+release:record 冻结 1.0.0（**发布至此解冻**）。

---

## Self-Review

- 规格覆盖：客户端自开去 WPS→T2/T3/T4；页/章索引→T1/T3/T5；智能体网页映射→T6；深链触发→T6；诚实降级→T5；高亮可选→T5 textLayer 可选 mark；不重切/保指纹→Global+T3 仅新增格式；体积→T7。无遗漏。
- 占位扫描：各 step 含真实代码/命令；T4 epub spine 解析复用 adm-zip 既有模式（orig-web 内实现）。
- 类型一致：anchor 字段全 plan 统一；originalWeb 返回 {type:html|pdf|error} 全 plan 统一；readPptx 返回 [{page,text,images}] 与 T3/T4 一致；locate 返回 {chapter,page,text,loc} 与 T1/T5 一致。