// 技能落盘库：skills/<slug>/ 的结构校验 + 引用回源验证（防幻觉红线）
// 分工铁律：工具层无 LLM——内容由对话智能体蒸馏后调 save_skill 落盘，这里只管校验与读写。
// 检索层零改动：只调用 search.mjs 的 listBooks（只读扫描），不碰任何检索行为。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import { listBooks } from "./search.mjs";

export const DEFAULT_SKILLS_DIR = path.join(import.meta.dirname, "..", "..", "skills");

let _skillsDir = null;
// configure：桌面端数据目录注入（打包态迁 userData）；未调用时逐字节维持旧行为
export function configureSkillStore({ skillsDir } = {}) {
  if (skillsDir) _skillsDir = skillsDir;
}
export function currentSkillsDir() {
  return _skillsDir || DEFAULT_SKILLS_DIR;
}

// slug：纯小写字母/数字/连字符（Agent Skills 开放标准惯例）；中文书名写 frontmatter title
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// 允许写入的文件路径白名单（防任意文件写入）；catalog.json = 技能×编目融合 P-A（机器可读索引）
const FILE_RE = /^(?:SKILL\.md|chapters\/ch\d{2}-[a-z0-9-]+\.md|glossary\.md|patterns\.md|cheatsheet\.md|catalog\.json)$/;
const CHAPTER_FILE_RE = /^ch\d{2}-[a-z0-9-]+\.md$/;
// 引用标记：〔别名·章节〕，只认 blockquote 行
const CITATION_RE = /〔(.+?)·(.+?)〕/;
// 大小上限（防失控智能体写超大文件）：单文件 512KB、整包 1MB（BSP_SKILL_MAX_KB 可调，≥64 才生效）
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = (Number(process.env.BSP_SKILL_MAX_KB) >= 64 ? Number(process.env.BSP_SKILL_MAX_KB) : 1024) * 1024;
const kbStr = (n) => (n / 1024).toFixed(0) + "KB";

// ---------- 中文数字解析（覆盖声称防幻觉的硬缺口） ----------
// 教训：「八十一章原典速查」这类中文数字声称，纯 (\d+) 正则静默放过——
// 声称检查漏一类就等于没查。最小实现：一~亿、段式（二千五百一十一），
// 兼容全角阿拉伯数字；解析不出（NaN）时调用方按"无法核验"从严处理。
const CN_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0, 〇: 0, 两: 2 };
const CN_NUM_RE = /^[0-9０-９一二三四五六七八九十百千两零〇]+$/;
function cnSeg(s) {
  if (/^[0-9０-９]+$/.test(s)) return Number(s.replace(/[０-９]/g, d => "０１２３４５６７８９".indexOf(d)));
  let total = 0, section = 0;
  for (const ch of s) {
    if (ch in CN_DIGIT) section = CN_DIGIT[ch];
    else if (ch === "十") { total += (section || 1) * 10; section = 0; }
    else if (ch === "百") { total += (section || 1) * 100; section = 0; }
    else if (ch === "千") { total += (section || 1) * 1000; section = 0; }
    else return NaN; // 段内出现非数字字（如"余"）→ 放弃解析
  }
  return total + section;
}
export function claimNum(s) {
  const t = String(s || "").trim();
  if (!CN_NUM_RE.test(t)) return NaN;
  let total = 0;
  for (const seg of t.split(/[億亿]/)) {
    let v = 0;
    for (const w of seg.split(/[萬万]/)) v = v * 10000 + cnSeg(w);
    total = total * 100000000 + v;
  }
  return total;
}

// ---------- frontmatter（最小手写 YAML，不引依赖） ----------
export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(md || ""));
  if (!m) return null;
  const data = {};
  let sources = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s+\S/.test(line) && sources) {
      const kv = line.trim().split(":");
      if (kv.length >= 2) sources[kv[0].trim()] = kv.slice(1).join(":").trim();
    } else {
      const km = line.match(/^([A-Za-z_]\w*)\s*:\s*(.*)$/);
      if (!km) continue;
      if (km[1] === "sources") {
        sources = {};
        data.sources = sources;
        // flow map（sources: { a: b }）与单值（sources: book）形式：原实现只认块式缩进，
        // flow map 的值被静默丢掉 → 全部引用报 unknown-source（P0 逮到的静默丢值）
        const flow = /^\{([\s\S]*)\}$/.exec(km[2].trim());
        if (flow) {
          for (const part of flow[1].split(",")) {
            const kv = part.split(":");
            if (kv.length >= 2) sources[kv[0].trim().replace(/^["']|["']$/g, "")] = kv.slice(1).join(":").trim().replace(/^["']|["']$/g, "");
          }
        } else if (km[2].trim()) sources[km[2].trim()] = km[2].trim();
      }
      else data[km[1]] = km[2].trim();
    }
  }
  return { data, body: md.slice(m[0].length) };
}

// ---------- 引文提取：blockquote 行内的 〔别名·章节〕 ----------
export function extractCitations(files) {
  const out = [];
  for (const f of files || []) {
    if (!f || typeof f.content !== "string") continue;
    f.content.split(/\r?\n/).forEach((line, i) => {
      if (!line.startsWith(">")) return;
      const m = CITATION_RE.exec(line);
      if (!m) return;
      const quote = line.replace(/〔.*?〕/g, "").replace(/^>\s*/, "").trim();
      out.push({ file: f.path, line: i + 1, alias: m[1].trim(), chapter: m[2].trim(), quote });
    });
  }
  return out;
}

// ---------- 归一化与校注剥离 ----------
// 《道德经》等书原文内嵌校注（如「芻一作「蒭」狗」「或句读为：…」），不剥离会把真实引用误杀
const stripAnnotations = (s) => String(s || "")
  .replace(/一作「[^」]*」/g, "")
  .replace(/一作『[^』]*』/g, "")
  .replace(/一作（[^）]*）/g, "")
  .replace(/或句读爲?:[^。；!?]*[。；!?]?/g, "")
  .replace(/或句读为：[^。；!?]*[。；!?]?/g, "");

const normalize = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");

// 引文按标点切子句（切分要在去标点之前），丢 <4 字短句，逐子句在源文中找。
// 对称剥离校注：源文侧剥了「一作」校注，引文侧也必须剥——智能体照抄 query_book
// 返回的含校注原文时，不剥引文会把真实引用误判为造假（P0 逮到：道德经包的使用
// 约定要求照抄原文、原文含校注，修前恰好没有引文考验过这条路径）。
function quoteClauses(quote) {
  return String(quote || "").split(/[。；！？!?;.\n]+/).map(s => normalize(stripAnnotations(s))).filter(c => c.length >= 4);
}

function verifyOneText(srcText, quote) {
  const src = normalize(stripAnnotations(srcText));
  const cls = quoteClauses(quote);
  if (!cls.length) return { ok: true, hits: 0, total: 0 };
  const hits = cls.filter(c => src.includes(c)).length;
  return { ok: hits / cls.length >= 0.6, hits, total: cls.length };
}

// sources 别名 → 库定位：精确 title 优先，其次 id，再退 id 前缀（id 含格式后缀如 daodejing-zh.docx）
// includeDisabled:true 豁免（H3）——关掉 skill 的书也要能验证已落盘技能包的引用，
// 否则"关一本书"会把过去落盘的包全部打成 unknown-source
function resolveBookExact(bookId) {
  const books = listBooks(undefined, { includeDisabled: true });
  return books.find(b => b.title === bookId)
    || books.find(b => b.id === bookId)
    || books.find(b => b.id.startsWith(bookId + "."))
    || null;
}

// ---------- 引用回源验证 ----------
// 逐条到 library/*.db 查章节原文比对；任一失败即返回错误清单（save 层整包拒收）
// 同时吐出 stats：每本书 { seen: 引文验真覆盖的去重章节, total: 库里实际章节数 }——供出厂自检对账，零额外查询
export function verifyCitations(citations, sourcesMap) {
  const errors = [];
  const stats = {}; // bookId -> { seen: Set<string>, total: number }
  const cache = new Map(); // bookId -> { byChapter, byPage, chapters } | null
  for (const c of citations) {
    const bookId = sourcesMap ? sourcesMap[c.alias] : undefined;
    if (!bookId) {
      errors.push({ ...c, reason: "unknown-source",
        hint: `sources 里没有别名「${c.alias}」。已声明：${Object.keys(sourcesMap || {}).join("、") || "（无）"}` });
      continue;
    }
    if (!cache.has(bookId)) {
      const book = resolveBookExact(bookId);
      if (!book) { cache.set(bookId, null); }
      else {
        const db = new Database(book.db, { readonly: true });
        try {
          const cols = db.prepare("PRAGMA table_info(chunks)").all().map(x => x.name);
          const byChapter = new Map(), byPage = new Map();
          const hasPage = cols.includes("page");
          for (const r of db.prepare("SELECT chapter, page, text FROM chunks").all()) {
            if (!byChapter.has(r.chapter)) byChapter.set(r.chapter, []);
            byChapter.get(r.chapter).push(r.text);
            if (hasPage && r.page != null) {
              if (!byPage.has(r.page)) byPage.set(r.page, []);
              byPage.get(r.page).push(r.text);
            }
          }
          cache.set(bookId, { byChapter, byPage, chapters: [...byChapter.keys()] });
        } finally { db.close(); }
      }
    }
    const entry = cache.get(bookId);
    if (!entry) {
      errors.push({ ...c, reason: "unknown-source", hint: `sources 映射的书「${bookId}」在 library/ 里找不到` });
      continue;
    }
    let texts = entry.byChapter.get(c.chapter);
    if ((!texts || !texts.length) && /^\d+$/.test(c.chapter)) texts = entry.byPage.get(Number(c.chapter));
    if (!texts || !texts.length) {
      errors.push({ ...c, reason: "chapter-not-found",
        hint: `「${c.alias}」没有章节「${c.chapter}」。实际章节示例：${entry.chapters.slice(0, 8).join("、")}…` });
      continue;
    }
    const v = verifyOneText(texts.join("\n"), c.quote);
    if (!v.ok) {
      const sample = normalize(stripAnnotations(texts.join(""))).slice(0, 60);
      errors.push({ ...c, reason: "quote-not-found",
        hint: `该章实文（前60字）：${sample}…；子句命中 ${v.hits}/${v.total}，请照抄 query_book 返回的原文（繁体照抄，勿自行简转繁）` });
      continue;
    }
    if (!stats[bookId]) stats[bookId] = { seen: new Set(), total: entry.chapters.length };
    stats[bookId].seen.add(String(c.chapter));
  }
  return { errors, stats };
}

// ---------- 出厂自检：声称 vs 实际（第三道质检，防"包装说明与内容对不上"） ----------
// 教训：道德经包 description 写"81章原典速查"，实际引文只覆盖 14 章——生成模式凭印象写声称，不回头核对。
// 原则：凡是智能体会拿来当导航依据的声称（覆盖范围/章节数/索引指向），必须机器可验。
const CLAIM_ABILITY_RE = /([0-9０-９一二三四五六七八九十百千两零〇]+)\s*章(?:原典)?\s*(?:速查|指南|手册|全覆盖)/g; // 能力声称："81章速查"/「八十一章速查」
const CLAIM_BOOK_TOTAL_RE = /全书\s*([0-9０-９一二三四五六七八九十百千两零〇]+)\s*章/g; // 书属性声称："全书81章"/「全书八十一章」
const REF_PATH_RE = /(?:chapters\/)?(?:ch\d{2}-[a-z0-9-]+|glossary|patterns|cheatsheet)\.md/g; // 索引表指向的文件

function coverageCheck(fmData, skillMdContent, files, stats) {
  const errors = [];
  const warnings = [];
  const push = (reason, extra = {}) => errors.push({ reason, ...extra });

  const bookIds = Object.values(fmData.sources || {});
  const single = bookIds.length === 1 && stats[bookIds[0]];
  const seenCount = single ? stats[bookIds[0]].seen.size : null;
  const totalCount = single ? stats[bookIds[0]].total : null;

  // a) 索引表存在性：SKILL.md 里提到的技能文件必须在 files 里真实存在（操作手册导航不能撞墙）
  const available = new Set(files.map((f) => f.path));
  for (const ref of new Set(skillMdContent.match(REF_PATH_RE) || [])) {
    if (!available.has(ref))
      push("broken-reference", { file: ref, hint: `SKILL.md 引用了 ${ref}，但 files 里没有这个文件——智能体按索引导航会撞墙` });
  }

  // b) 能力声称："N章速查/指南/手册/全覆盖"里的 N 必须等于实际覆盖数（N 支持中文数字）
  for (const m of skillMdContent.matchAll(CLAIM_ABILITY_RE)) {
    const n = claimNum(m[1]);
    if (single && n !== seenCount)
      push("claimed-coverage-lie", { claimed: n, claimedText: m[1], actual: seenCount, match: m[0],
        hint: `"${m[0]}" 是能力声称，但引文实际只覆盖 ${seenCount} 章——要么写"覆盖 ${seenCount} 章"，要么写"全书 ${totalCount} 章精选 ${seenCount} 章"` });
  }

  // c) 书属性声称："全书N章"里的 N 必须等于源书实际章节数（N 支持中文数字）
  for (const m of skillMdContent.matchAll(CLAIM_BOOK_TOTAL_RE)) {
    const n = claimNum(m[1]);
    if (single && n !== totalCount)
      push("book-total-lie", { claimed: n, claimedText: m[1], actual: totalCount, match: m[0], hint: `"${m[0]}" 与源书实际 ${totalCount} 章不符——先到 query_book 核实原书章节数` });
    else if (single && !fmData.coverage)
      warnings.push(`"全书 ${n} 章"没问题，但建议在 frontmatter 补 "coverage: ${seenCount}/${totalCount}"，让智能体知道这是精选集`);
  }

  // d) coverage 声明："N" 或 "N/M"（N=引文覆盖章数，M=源书总章数；均支持中文数字）
  const cov = String(fmData.coverage || "").trim();
  if (cov) {
    const cm = /^([0-9０-９一二三四五六七八九十百千两零〇]+)(?:\s*\/\s*([0-9０-９一二三四五六七八九十百千两零〇]+))?$/.exec(cov);
    if (!cm) push("bad-coverage", { hint: "coverage 格式应为 N 或 N/M（如 14/81、八十一）" });
    else if (single) {
      if (claimNum(cm[1]) !== seenCount)
        push("coverage-mismatch", { claimed: claimNum(cm[1]), claimedText: cm[1], actual: seenCount, hint: `coverage 声称覆盖 ${cm[1]} 章，引文实际覆盖 ${seenCount} 章` });
      if (cm[2] && claimNum(cm[2]) !== totalCount)
        push("coverage-total-mismatch", { claimed: claimNum(cm[2]), claimedText: cm[2], actual: totalCount, hint: `coverage 分母 ${cm[2]} 与源书实际 ${totalCount} 章不符` });
    } else if (cm[2]) {
      warnings.push("多书技能暂不校验 coverage 分母，请人工核对");
    }
  }
  return { errors, warnings };
}

// ---------- catalog.json 校验（P-A，先 warning 后收紧） ----------
// catalog.json 是机器可读的导航地图：解析不了/书源对不上，智能体按图索骥会撞墙。
// 首版只 warning 不拒收（观察期后升 error——融合规划第五节风险表约定）。
function catalogCheck(files, fmData) {
  const warnings = [];
  const f = (files || []).find(x => x && x.path === "catalog.json");
  if (!f) return warnings;
  let data; // 不预置 null：解析失败即 return，预置值永远读不到（eslint 也会报警）
  try { data = JSON.parse(f.content); }
  catch (e) {
    warnings.push(`catalog.json 不是合法 JSON（${e.message}）——机器读的地图解析不了等于没有，请重跑 skill-scaffold 生成`);
    return warnings;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    warnings.push("catalog.json 应为 JSON 对象——请重跑 skill-scaffold 生成");
    return warnings;
  }
  const bookIds = new Set(Object.values(fmData.sources || {}));
  if (data.book_id && bookIds.size && !bookIds.has(data.book_id))
    warnings.push(`catalog.json 的 book_id（${data.book_id}）不在 SKILL.md sources 里（${[...bookIds].join("、")}）——包里的地图和封面指向不同的书，请核对`);
  return warnings;
}

// ---------- 落盘 / 读 / 枚举 ----------
export function saveSkill(slug, files, { skillsDir = currentSkillsDir() } = {}) {
  const errors = [];
  const push = (reason, extra = {}) => errors.push({ reason, ...extra });

  if (!SLUG_RE.test(slug))
    push("bad-slug", { hint: "slug 只能是小写字母/数字/连字符（1~64位）；中文请写进 frontmatter title，slug 用拼音" });

  const seen = new Set();
  let totalBytes = 0;
  for (const f of files || []) {
    if (!f || typeof f.path !== "string" || !FILE_RE.test(f.path)) {
      push("bad-path", { file: f && f.path, hint: "允许的路径：SKILL.md、chapters/chNN-小写连字符.md、glossary.md、patterns.md、cheatsheet.md、catalog.json" });
      continue;
    }
    if (seen.has(f.path)) push("bad-path", { file: f.path, hint: "路径重复" });
    seen.add(f.path);
    const bytes = typeof f.content === "string" ? Buffer.byteLength(f.content, "utf8") : 0;
    totalBytes += bytes;
    if (bytes > MAX_FILE_BYTES)
      push("file-too-large", { file: f.path, hint: `单文件 ${kbStr(bytes)} 超上限 ${kbStr(MAX_FILE_BYTES)}——技能应是蒸馏后的精华，不是书的搬运` });
  }
  if (totalBytes > MAX_TOTAL_BYTES)
    push("total-too-large", { hint: `整包 ${kbStr(totalBytes)} 超上限 ${kbStr(MAX_TOTAL_BYTES)}（BSP_SKILL_MAX_KB 可调）——一个技能正常 30~100KB，太大了说明没蒸馏` });
  const skillMd = (files || []).find(f => f && f.path === "SKILL.md");
  if (!skillMd) push("missing-skill-md", { hint: "files 里必须包含 SKILL.md" });
  else {
    const fm = parseFrontmatter(skillMd.content);
    if (!fm || !fm.data.name || !fm.data.description)
      push("bad-frontmatter", { file: "SKILL.md", hint: "frontmatter 需要 name 与 description 两个字段" });
    else if (fm.data.name !== slug)
      push("bad-frontmatter", { file: "SKILL.md", hint: `frontmatter name（${fm.data.name}）必须等于 slug（${slug}）` });
  }
  if (errors.length) return { ok: false, stage: "structure", errors };

  const fmData = parseFrontmatter(skillMd.content).data;
  const citations = extractCitations(files);
  const { errors: citErrors, stats: citStats } = verifyCitations(citations, fmData.sources);
  if (citErrors.length) return { ok: false, stage: "citation-check", errors: citErrors, citations_checked: citations.length };

  // 第三道质检：出厂自检（声称 vs 实际）+ catalog.json 校验（P-A，warning 级）
  const cov = coverageCheck(fmData, skillMd.content, files, citStats);
  if (cov.errors.length) return { ok: false, stage: "coverage-check", errors: cov.errors, warnings: cov.warnings, citations_checked: citations.length };
  const catalogWarnings = catalogCheck(files, fmData);

  // 原子写：临时目录 → 删旧 → rename（Windows 下目录 rename 需先删旧）
  const root = path.resolve(skillsDir);
  const dir = path.resolve(root, slug);
  if (!dir.startsWith(root + path.sep)) return { ok: false, stage: "structure", errors: [{ reason: "bad-slug", hint: "路径越界" }] };
  const tmp = dir + ".tmp-" + Date.now();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const f of files) {
      const p = path.join(tmp, ...f.path.split("/"));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content, "utf8");
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, stage: "write", errors: [{ reason: "write-failed", hint: String(e.message || e) }] };
  }
  const bookIds = Object.values(fmData.sources || {});
  const single = bookIds.length === 1 && citStats[bookIds[0]];
  return {
    ok: true, slug, files: files.length,
    citations_checked: citations.length,
    chars_total: files.reduce((a, f) => a + (f.content || "").length, 0),
    coverage: single
      ? {
          covered: citStats[bookIds[0]].seen.size,
          total: citStats[bookIds[0]].total,
          percent: Math.round((citStats[bookIds[0]].seen.size / citStats[bookIds[0]].total) * 100),
          chapters: [...citStats[bookIds[0]].seen],
        }
      : null,
    warnings: [...cov.warnings, ...catalogWarnings],
    dir: "skills/" + slug,
  };
}

function chapterIndex(dir) {
  const chDir = path.join(dir, "chapters");
  if (!fs.existsSync(chDir)) return [];
  return fs.readdirSync(chDir).filter(f => CHAPTER_FILE_RE.test(f)).sort().map(f => {
    const content = fs.readFileSync(path.join(chDir, f), "utf8");
    const t = (/^#\s+(.+)$/m.exec(content) || [])[1];
    return { file: "chapters/" + f, title: (t || f).trim(), tokens_est: Math.ceil(content.length / 1.6) };
  });
}

export function readSkill(slug, chapter, { skillsDir = currentSkillsDir() } = {}) {
  if (!SLUG_RE.test(slug)) return { error: "bad-slug", hint: "slug 只能是小写字母/数字/连字符" };
  const dir = path.join(skillsDir, slug);
  const skillPath = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    return { error: "skill-not-found", hint: `skills/ 下没有「${slug}」`, available: listSkills({ skillsDir }).map(s => s.slug) };
  }
  if (chapter) {
    if (!CHAPTER_FILE_RE.test(chapter)) return { error: "bad-chapter", hint: "章节文件名形如 ch01-wu-wei" };
    const p = path.join(dir, "chapters", chapter);
    if (!fs.existsSync(p)) return { error: "chapter-not-found", available: chapterIndex(dir).map(x => x.file) };
    return { slug, file: "chapters/" + chapter, content: fs.readFileSync(p, "utf8") };
  }
  const skillMd = fs.readFileSync(skillPath, "utf8");
  // catalog（P-A）：包内带 catalog.json 就解析返回（机器可读索引）；坏 JSON / 没有都返回 null——旧包零影响
  let catalog = null;
  const catPath = path.join(dir, "catalog.json");
  if (fs.existsSync(catPath)) {
    try { catalog = JSON.parse(fs.readFileSync(catPath, "utf8")); } catch { catalog = null; }
  }
  return { slug, skill_md: skillMd, index: chapterIndex(dir), catalog };
}

export function listSkills({ skillsDir = currentSkillsDir() } = {}) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir).filter(f => {
    try {
      return fs.statSync(path.join(skillsDir, f)).isDirectory() && fs.existsSync(path.join(skillsDir, f, "SKILL.md"));
    } catch { return false; }
  }).sort().map(slug => {
    const dir = path.join(skillsDir, slug);
    const fm = parseFrontmatter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
    const st = fs.statSync(path.join(dir, "SKILL.md"));
    return {
      slug,
      title: (fm && fm.data.title) || slug,
      description: (fm && fm.data.description) || "",
      coverage: (fm && fm.data.coverage) || null, // frontmatter 约定 coverage: 覆盖数/总章数（出厂自检背书）
      has_catalog: fs.existsSync(path.join(dir, "catalog.json")), // P-A：包内是否带机器可读索引
      chapters: chapterIndex(dir).length,
      sources: Object.values((fm && fm.data.sources) || {}),
      updated_at: st.mtime.toISOString(),
    };
  });
}
