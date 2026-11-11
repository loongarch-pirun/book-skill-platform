// PDF 判定表（R12 → R3 → R4 → 兜底）的唯一实现处。
//
// 设计原则（`01-耦合与改造设计.md:92` 的约束）：
//   ① 每条规则的触发条件都必须能从文件本身算出来（扩展名/魔数/文本层字符数/页图占比/表格数），
//      任何一个 PDF 进来唯一落一条 route，不存在「看情况」「人工判断」。
//   ② 判定的**顺序**是规则的一部分：R12（脏排版）必须排在 R3 之前——kk 版 PDF 有 435 字/页，
//      若先判 R3 就会把脏书当干净书直走结构化抽取，脏行原样进库（实测见 01:90）。
//   ③ 新增一类脏内容＝在 DIRTY_RULES 里加一条配置，不写新函数。
//
// 与设计稿的偏离（都有实测依据，见 00-解析与判定表施工方案.md）：
//   · R3 原来的「页图占比 <5%」**删除**。探针 logs/probe-pageratio.txt 实测：Lamport 每页都有图对象
//     （100%）但每页 4246 字，attention 13.33%、Dynamo 31.25%——该指标量的是「这页有没有图」，
//     与「文本层能不能用」无关，当门槛会把干净书全判成脏。
//   · R12 原来的「位置固定带 + 重复度 ≥0.35 + 跨页同型」**改判据**。实测：页码每页文本不同（"39"/"40"/"41"），
//     文本重复度恒为 0；脏内容藏在正文中间 relY 0.209~0.815，不在边缘带；纯数字行在论文里大量是
//     公式上下标（Attention 1.9%、MapReduce 1.75% 全是假阳性）。有区分力的只有「论坛元数据行」：
//     kk 脏版 20 行 / 1.57% / 17 页命中，kk 净版与 3 本论文全部 0（logs/probe-dirty3.txt）。
//   · 阈值三套（≥100 / <50 / <20）收敛成一套：字符口径一律「非空白字符数/页」，分界 100 与 20 两条。
import fs from "node:fs";

// ---------------------------------------------------------------------------
// 阈值：唯一一份。改这里就是改判定表，代码分支不动。
// ---------------------------------------------------------------------------
export const THRESHOLDS = {
  // R3/R4 的分界线：平均每页非空白字符 ≥100 视为文本层可用（R3 直走结构化抽取）
  charsPerPageOk: 100,
  // 单页「几乎没字」的判据：非空白字符 <20
  lowPageChars: 20,
  // 「几乎没字」的页占比 ≥30% → R4 第一步 OCR 降级（设计稿 01:98 的提示级触发）
  lowPageRatioOcr: 0.3,
  // 5%~30% → 也走 OCR 降级，但不提示用户（01:98 的降级级）
  lowPageRatioPartial: 0.05,
  // R12 脏排版：论坛元数据行「跨页同型」的两条口径，满足其一即判脏（都要求 ≥5 行）：
  //   ① 行占比 ≥1.0%——全量实测 kk 脏 5.85%（983 行）、kk 净 0.34%（38 行），余量 5.9 倍 / 2.9 倍；
  //   ② 命中页占比 ≥20%——kk 脏 73%（586/801 页）、kk 净 6.5%（35/542 页）。
  //   两条 OR 而不是 AND：脏行集中在少数页的书（版面版式导致）也不会漏，而净版两条都远不到线。
  dirtyForumMetaPct: 1.0,
  dirtyPageRatio: 0.2,
  dirtyForumMetaMinLines: 5,
};

// ---------------------------------------------------------------------------
// 脏规则表：新增一类脏内容 → 加一条 {id, re, enabled}。enabled:false 的是
// 实测没有区分力、暂不参与判定的，留着是为了下次有人提「为什么不用目录点线」时能看到原因。
// ---------------------------------------------------------------------------
export const DIRTY_RULES = [
  { id: "forum_author_reply", enabled: true, re: /作者[:：].{0,24}回复日期/,
    note: "论坛楼层签名「作者：xxx 回复日期：...」" },
  { id: "forum_reply_date", enabled: true, re: /回复日期[:：]\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}/,
    note: "拆成两行时的回复日期行" },
  { id: "forum_signature", enabled: true,
    re: /^[•·*]?\s*[\w\u4e00-\u9fff]{2,14}\d{8,}\s*\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}$/,
    note: "「•ty_1299550242018-03-16 21:51」这类抓取签名行" },
  { id: "forum_floor_word", enabled: true, re: /^(楼主|沙发|板凳|地板)$/, note: "楼层口头禅行" },
  { id: "forum_floor_no", enabled: true, re: /^\d{1,4}\s*楼$/, note: "「94楼」「183楼」" },
  // 下面两条实测无区分力，只记账不清洗：
  { id: "toc_dot_leader", enabled: false, re: /[.·…]{4,}\s*\d{1,4}\s*$/,
    note: "目录点线。实测 kk 脏 3.84% vs kk 净 4.31%，净版反而更多 → 不能当脏信号" },
  { id: "page_number_only", enabled: false, re: /^第?\s*\d{1,4}\s*页?$/,
    note: "纯页码行。既有 P3 规则（build-book.js 页眉页脚 >35% 页重复）已在处理；"
        + "且论文里纯数字行大量是公式上下标（Attention 1.9%、MapReduce 1.75% 全假阳性）" },
];

// 真正参与「判脏」的规则（enabled 的那批）
export const ACTIVE_RULES = DIRTY_RULES.filter((r) => r.enabled);
// 参与「清洗」的规则：判脏用哪几条，清洗就用哪几条——判了不清等于没判
export const isDirtyLine = (text) => {
  const t = String(text || "").trim();
  return t.length > 0 && ACTIVE_RULES.some((r) => r.re.test(t));
};

// ---------------------------------------------------------------------------
// 文本层探针：只用 pdfjs（仓库现有依赖）数三件事——每页字符数、几乎没字的页数、
// 论坛元数据行数。不做判定，只出数字；判定在 classifyPdf。
// 传入 delayWarn 时静音 pdfjs 的字体/cmap 警告（探针只读文字，不需要渲染）。
// ---------------------------------------------------------------------------
export async function probeTextLayer(file, pdfjs) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false, useSystemFonts: false, verbosity: 0,
  }).promise;
  const pages = doc.numPages;
  const perPageChars = [];
  let totalLines = 0;
  let dirtyLines = 0;
  let pagesWithDirty = 0;
  const dirtySamples = [];
  try {
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // 按基线坐标聚行：同一 y 的文本项算一行。行是「脏行」判定的最小单位，
      // 字符数是块级的，两者口径不同不要混用。
      const rows = new Map();
      let chars = 0;
      for (const it of tc.items) {
        if (!it.str) continue;
        const n = it.str.replace(/\s/g, "").length;
        chars += n;
        if (!it.str.trim()) continue;
        const y = Math.round(it.transform[5]);
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push(it.str);
      }
      perPageChars.push(chars);
      let pageDirty = false;
      for (const parts of rows.values()) {
        const text = parts.join("").trim();
        if (!text) continue;
        totalLines++;
        if (isDirtyLine(text)) {
          dirtyLines++;
          pageDirty = true;
          if (dirtySamples.length < 5) dirtySamples.push({ page: i, text: text.slice(0, 60) });
        }
      }
      if (pageDirty) pagesWithDirty++;
      page.cleanup?.();
    }
  } finally {
    if (typeof doc.destroy === "function") await doc.destroy();
  }
  const totalChars = perPageChars.reduce((a, b) => a + b, 0);
  return {
    pages,
    totalChars,
    charsPerPage: pages ? totalChars / pages : 0,
    pagesUnderLowChars: perPageChars.filter((c) => c < THRESHOLDS.lowPageChars).length,
    lowPageRatio: pages ? perPageChars.filter((c) => c < THRESHOLDS.lowPageChars).length / pages : 0,
    totalLines,
    dirtyLines,
    dirtyPct: totalLines ? (dirtyLines / totalLines) * 100 : 0,
    pagesWithDirty,
    dirtySamples,
  };
}

// ---------------------------------------------------------------------------
// 判定：输入探针数字，输出唯一一条 route。顺序 = R12 → R3 → R4 → 兜底。
// 返回 { route, reason, annotations:[] }，route 取值只有四个：
//   "r12_dirty"        脏排版：先按规则清洗再结构化抽取
//   "r3_structured"    文本层可用：MinerU basic 结构化抽取直走（不加载 VLM）
//   "r4_ocr"           文本层不足：MinerU basic 内置 OCR（PP-OCRv6）出文字流，标「OCR 降级解析」
//   "needs_calibration" 探针本身算不出可信数字（0 页/读不到文本层）→ quarantine 等人工校准
// ---------------------------------------------------------------------------
export function classifyPdf(probe) {
  if (!probe || !probe.pages) {
    return { route: "needs_calibration", reason: "探针读不到页数（0 页或文件头异常），阈值无法判定", annotations: [] };
  }
  // R12 先判：脏排版即使字够多也要先洗，否则脏行原样进库
  const dirtyPageRatio = probe.pages ? probe.pagesWithDirty / probe.pages : 0;
  if (probe.dirtyLines >= THRESHOLDS.dirtyForumMetaMinLines
      && (probe.dirtyPct >= THRESHOLDS.dirtyForumMetaPct || dirtyPageRatio >= THRESHOLDS.dirtyPageRatio)) {
    return {
      route: "r12_dirty",
      reason: `脏排版：论坛元数据行 ${probe.dirtyLines} 行 / 占 ${probe.dirtyPct.toFixed(2)}%`
        + `（≥${THRESHOLDS.dirtyForumMetaPct}% 或 命中页 ${(dirtyPageRatio * 100).toFixed(1)}%≥${THRESHOLDS.dirtyPageRatio * 100}%）`
        + `· 命中 ${probe.pagesWithDirty}/${probe.pages} 页`,
      annotations: [`R12:脏排版清洗(${probe.dirtyLines}行)`],
    };
  }
  // R3：文本层够用
  if (probe.charsPerPage >= THRESHOLDS.charsPerPageOk
      && probe.lowPageRatio < THRESHOLDS.lowPageRatioPartial) {
    return {
      route: "r3_structured",
      reason: `文本层可用：${probe.charsPerPage.toFixed(1)} 字/页（≥${THRESHOLDS.charsPerPageOk}）`
        + `· 近空白页 ${probe.pagesUnderLowChars}/${probe.pages}`,
      annotations: [],
    };
  }
  // R4：文本层不足 → 第一步 OCR 降级（第二步 VLM 见 attemptVlm 的注释：未装、无实测阈值）
  const why = probe.charsPerPage < THRESHOLDS.charsPerPageOk
    ? `${probe.charsPerPage.toFixed(1)} 字/页 < ${THRESHOLDS.charsPerPageOk}`
    : `近空白页 ${probe.pagesUnderLowChars}/${probe.pages}（${(probe.lowPageRatio * 100).toFixed(1)}%）`;
  // 「几乎没字」的页占比分两档（设计稿 01:98-111）：≥30% 提示级、5%~30% 静默级。
  // 两档走同一条 OCR 路径、都不自动下载 VLM；差别只在要不要向用户提「可以考虑装 VLM」。
  const announceVlm = probe.lowPageRatio >= THRESHOLDS.lowPageRatioOcr;
  const tier = announceVlm
    ? `提示级（低字页 ${(probe.lowPageRatio * 100).toFixed(1)}% ≥${THRESHOLDS.lowPageRatioOcr * 100}%）`
    : `静默级（低字页 ${(probe.lowPageRatio * 100).toFixed(1)}% <${THRESHOLDS.lowPageRatioOcr * 100}%）`;
  return {
    route: "r4_ocr",
    reason: `文本层不足（${why}）→ 第一步 OCR 降级（${tier}）`,
    annotations: announceVlm
      ? [`R4:OCR 降级解析·${tier}`, "R4:OCR 后仍不足可考虑装 VLM（1.18 GB，本轮未装，需用户点头）"]
      : [`R4:OCR 降级解析·${tier}`, "R4:不打扰用户（未达提示线，不弹装 VLM）"],
  };
}

// ---------------------------------------------------------------------------
// R12 清洗：在 MinerU 结构化块上按规则丢脏行（块级，不切字——块要么整条留要么整条丢）。
// 只丢命中规则的块，其余逐字不动。返回丢了什么，供建库日志与人工抽查。
// ---------------------------------------------------------------------------
export function cleanDirtyBlocks(blocks) {
  const kept = [];
  const removed = [];
  for (const b of blocks) {
    // 表格/公式/图块不参与脏行清洗：它们的 text 是 HTML/LaTeX/图注，正则不适用，
    // 误判会把整张表丢掉（比留着脏行更糟）
    const kind = b.kind || "text";
    const cleanable = kind === "text" || kind === "footnote" || kind === "heading" || kind === "ref";
    if (cleanable && isDirtyLine(b.text)) {
      removed.push({ page: b.page, seq: b.seq, text: String(b.text).slice(0, 60) });
      continue;
    }
    kept.push(b);
  }
  return { blocks: kept, removed };
}

// OCR 之后的复测口径（R4 第二步的判据）：结构化块再数一遍字/页。
// 阈值与 R3 对齐用 100 字/页；**这个值没有独立实测**（只有自造单页扫描件跑通过 3253 B），
// 所以不拿它自动拒书，只标 needs_vlm 让上层决定要不要下载 1.18 GB VLM 权重。
export function assessAfterOcr(blocks, numPages) {
  if (!numPages) return { charsPerPage: 0, needsVlm: true };
  const chars = blocks.reduce((a, b) => a + String(b.text || "").replace(/\s/g, "").length, 0);
  const charsPerPage = chars / numPages;
  return { charsPerPage, needsVlm: charsPerPage < THRESHOLDS.charsPerPageOk };
}
