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

// slug：纯小写字母/数字/连字符（Agent Skills 开放标准惯例）；中文书名写 frontmatter title
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// 允许写入的文件路径白名单（防任意文件写入）
const FILE_RE = /^(?:SKILL\.md|chapters\/ch\d{2}-[a-z0-9-]+\.md|glossary\.md|patterns\.md|cheatsheet\.md)$/;
const CHAPTER_FILE_RE = /^ch\d{2}-[a-z0-9-]+\.md$/;
// 引用标记：〔别名·章节〕，只认 blockquote 行
const CITATION_RE = /〔(.+?)·(.+?)〕/;

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
      if (km[1] === "sources") { sources = {}; data.sources = sources; }
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

// 引文按标点切子句（切分要在去标点之前），丢 <4 字短句，逐子句在源文中找
function quoteClauses(quote) {
  return String(quote || "").split(/[。；！？!?;.\n]+/).map(normalize).filter(c => c.length >= 4);
}

function verifyOneText(srcText, quote) {
  const src = normalize(stripAnnotations(srcText));
  const cls = quoteClauses(quote);
  if (!cls.length) return { ok: true, hits: 0, total: 0 };
  const hits = cls.filter(c => src.includes(c)).length;
  return { ok: hits / cls.length >= 0.6, hits, total: cls.length };
}

// sources 别名 → 库定位：精确 title 优先，其次 id，再退 id 前缀（id 含格式后缀如 daodejing-zh.docx）
function resolveBookExact(bookId) {
  const books = listBooks();
  return books.find(b => b.title === bookId)
    || books.find(b => b.id === bookId)
    || books.find(b => b.id.startsWith(bookId + "."))
    || null;
}

// ---------- 引用回源验证 ----------
// 逐条到 library/*.db 查章节原文比对；任一失败即返回错误清单（save 层整包拒收）
export function verifyCitations(citations, sourcesMap) {
  const errors = [];
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
    }
  }
  return errors;
}

// ---------- 落盘 / 读 / 枚举 ----------
export function saveSkill(slug, files, { skillsDir = DEFAULT_SKILLS_DIR } = {}) {
  const errors = [];
  const push = (reason, extra = {}) => errors.push({ reason, ...extra });

  if (!SLUG_RE.test(slug))
    push("bad-slug", { hint: "slug 只能是小写字母/数字/连字符（1~64位）；中文请写进 frontmatter title，slug 用拼音" });

  const seen = new Set();
  for (const f of files || []) {
    if (!f || typeof f.path !== "string" || !FILE_RE.test(f.path)) {
      push("bad-path", { file: f && f.path, hint: "允许的路径：SKILL.md、chapters/chNN-小写连字符.md、glossary.md、patterns.md、cheatsheet.md" });
      continue;
    }
    if (seen.has(f.path)) push("bad-path", { file: f.path, hint: "路径重复" });
    seen.add(f.path);
  }
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
  const citErrors = verifyCitations(citations, fmData.sources);
  if (citErrors.length) return { ok: false, stage: "citation-check", errors: citErrors, citations_checked: citations.length };

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
  return {
    ok: true, slug, files: files.length,
    citations_checked: citations.length,
    chars_total: files.reduce((a, f) => a + (f.content || "").length, 0),
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

export function readSkill(slug, chapter, { skillsDir = DEFAULT_SKILLS_DIR } = {}) {
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
  return { slug, skill_md: skillMd, index: chapterIndex(dir) };
}

export function listSkills({ skillsDir = DEFAULT_SKILLS_DIR } = {}) {
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
      chapters: chapterIndex(dir).length,
      sources: Object.values((fm && fm.data.sources) || {}),
      updated_at: st.mtime.toISOString(),
    };
  });
}
