// 技能骨架生成器（技能×编目融合 P-B）：从编目 JSON + 库实况生成 skill 包"半成品"
// 铁律：骨架里的一切结构声称（章节数/主题数/人物数）都从库里查出来——查出来的是真值，
// 手写的才会吹牛（"81章速查"教训）。智能体只填导读空位，目录不许手改。
// 检索层零改动：只读查询 chunks/nodes/edges，不碰 hybridSearch/loadCatalogSignal。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { listBooks } from "./search.mjs";

// chunk 锚点封顶：catalog.json 是导航地图不是搬运原文，长书的 belongs/mention 边
// 动辄几千条，全列会撑爆 skill 包（整包 1MB 上限）——封顶 50 够按图索骥
export const MAX_CHUNK_IDS = 50;
// 主题章节分布封顶（同 getCatalogSummary 的 chMap 语义：代表性分布，不是全集）
const MAX_CHAPTERS_PER_THEME = 8;

// 按书名片段找书（与 register-tools.matchBook 同语义；独立实现避免循环依赖）
// includeDisabled:true——骨架生成是本地创作工具（人/智能体给自己的书写包），不是问答检索：
// 用户在「技能开关」关掉某本书（H3）不应挡住给它生成骨架，否则开关关一圈连脚手架都出不来
function matchBook(book, libDir) {
  const q = String(book).toLowerCase();
  return listBooks(libDir, { includeDisabled: true }).filter(b => b.id.toLowerCase().includes(q) || b.title.toLowerCase().includes(q));
}

// 英文章题 → 文件名 slug（ch01-intro）；纯中文/空 → ch01-section-01 兜底
// 注意：返回值不带 .md——SKILL.md 里出现 chNN-*.md 字样会撞 coverageCheck 的
// broken-reference 校验（REF_PATH_RE 抓裸文件名，文件不存在就整包拒收）
function chapterSlug(chapter, i) {
  const nn = String(i + 1).padStart(2, "0");
  const slug = String(chapter || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "");
  return `ch${nn}-${slug || "section-" + nn}`;
}

// ---------- 骨架生成：章节表 + 编目索引（catalog.json）+ SKILL.md 半成品 ----------
export function generateSkillScaffold(bookQuery, { libDir } = {}) {
  const matches = matchBook(bookQuery, libDir);
  if (!matches.length)
    return { error: "book-not-found", available: listBooks(libDir).map(b => b.title) };
  const b = matches[0];
  const db = new Database(b.db, { readonly: true });
  try {
    // 章节表：从 chunks 实际值 GROUP BY（真值源头，不是手写）
    const hasPage = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name).includes("page");
    const chapterRows = db.prepare(`SELECT chapter, COUNT(*) n, MIN(id) first_id FROM chunks
      WHERE chapter IS NOT NULL AND chapter != '' GROUP BY chapter ORDER BY MIN(id)`).all();
    const chunksTotal = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;

    // 编目层（llm 层，与 getCatalogSummary 同源 SQL）：未编目也不挡骨架——章节表照样是真值
    let cataloged = false, themes = [], persons = [], relations = [];
    const belongsByTheme = new Map(), mentionsByPerson = new Map(), chaptersByTheme = new Map();
    try {
      const nThemes = db.prepare("SELECT COUNT(*) c FROM nodes WHERE type='theme' AND source='llm'").get().c;
      cataloged = nThemes > 0;
    } catch { /* 旧库无 nodes 表 → 未编目 */ }
    if (cataloged) {
      themes = db.prepare("SELECT name, ref FROM nodes WHERE type='theme' AND source='llm' ORDER BY rowid").all().map(t => {
        let note = ""; try { note = JSON.parse(t.ref || "{}").note || ""; } catch { }
        return { name: t.name, note };
      });
      persons = db.prepare("SELECT name, ref FROM nodes WHERE type='person' AND source='llm' ORDER BY rowid").all().map(p => {
        let info = {}; try { info = JSON.parse(p.ref || "{}"); } catch { }
        return { name: p.name, note: info.note || "", match_names: info.match_names || [], mention_count: info.mention_count || 0 };
      });
      relations = db.prepare("SELECT src, dst, ref FROM edges WHERE kind='relation' AND source='llm' ORDER BY rowid").all()
        .map(e => ({ a: e.src, b: e.dst, note: e.ref || "" }));
      // belongs/mention 边 → 主题/人物的 chunk 锚点（封顶）与主题章节分布
      for (const r of db.prepare("SELECT dst theme, src FROM edges WHERE kind='belongs' AND source='llm'").all()) {
        if (!belongsByTheme.has(r.theme)) belongsByTheme.set(r.theme, []);
        belongsByTheme.get(r.theme).push(+r.src);
      }
      for (const r of db.prepare("SELECT dst person, src FROM edges WHERE kind='mention' AND dst_type='person' AND source='llm'").all()) {
        if (!mentionsByPerson.has(r.person)) mentionsByPerson.set(r.person, []);
        mentionsByPerson.get(r.person).push(+r.src);
      }
      const getChunk = db.prepare("SELECT chapter FROM chunks WHERE id = ?");
      for (const [theme, ids] of belongsByTheme) {
        const seen = new Set();
        for (const id of ids) {
          const ch = getChunk.get(id)?.chapter;
          if (ch && seen.size < MAX_CHAPTERS_PER_THEME) seen.add(ch);
        }
        chaptersByTheme.set(theme, [...seen]);
      }
    }

    // ---------- catalog.json（机器可读的骨：从库查出，天然为真） ----------
    const catalogJson = {
      book: b.title, book_id: b.id, generated_at: new Date().toISOString(),
      cataloged,
      note: "本文件由 skill-scaffold 从编目数据自动生成，供智能体导航使用——不要手改，重跑 skill-scaffold 即刷新",
      chapters_total: chapterRows.length,
      chunks_total: chunksTotal,
      chapters: chapterRows.map((r, i) => ({ chapter: r.chapter, chunks: r.n, suggested_file: chapterSlug(r.chapter, i) + ".md" })),
      themes: themes.map(t => ({
        name: t.name, note: t.note,
        chunks_total: (belongsByTheme.get(t.name) || []).length,
        chunk_ids: (belongsByTheme.get(t.name) || []).slice(0, MAX_CHUNK_IDS),
        chapters: chaptersByTheme.get(t.name) || [],
      })),
      persons: persons.map(p => ({
        name: p.name, note: p.note, match_names: p.match_names, mention_count: p.mention_count,
        chunk_ids: (mentionsByPerson.get(p.name) || []).slice(0, MAX_CHUNK_IDS),
      })),
      relations,
    };

    // ---------- SKILL.md 骨架（人读的皮：真值表 + 待填空位） ----------
    const catalogNote = cataloged
      ? `主题 ${themes.length} 个 · 人物 ${persons.length} 个 · 关系 ${relations.length} 条（完整索引见 catalog.json，机器可读）`
      : `本书尚未编目（无主题/人物索引）——结构只有章节表；编目后重跑 skill-scaffold 可补全`;
    const chapterTable = chapterRows.length
      ? chapterRows.map((r, i) => `| ${i + 1} | ${r.chapter} | ${r.n} | ${chapterSlug(r.chapter, i)} |`).join("\n")
      : "| — | （本书无章节结构，只有连续切块） | — | — |";
    const skillMd = `---
name: ${b.id.replace(/\.[a-z0-9]+$/i, "")}
title: ${b.title}
description: （待填）一句话说明这本手册适合什么问题、怎么用
sources:
  ${b.title}: ${b.id}
---

# ${b.title} · 技能手册（自动骨架）

> 骨架由 skill-scaffold 从书库实况生成：章节表/主题/人物全是查出来的真值，**不要手改**。
> 你要填的只有：上面的 description、下面的使用建议、以及带引文的章节文件。提交前删掉所有（待填）。

## 结构总览（自动生成）
- 全书 ${chapterRows.length} 章 / ${chunksTotal} 块
- ${catalogNote}

## 章节表（勿手改——重跑 skill-scaffold 即刷新；建章节文件时照抄建议文件名并补 .md）
| # | 章节 | 块数 | 建议文件名 |
|---|---|---|---|
${chapterTable}

## 使用建议（待填）
（建议写：什么问题适合查这本书、先看主题还是直接 query_book、哪些章节是重点）

## 引用规则（提醒）
blockquote 引用原文时照抄检索结果（繁体照抄，勿自行简转繁），行尾加〔${b.title}·<章节>〕。
`;

    return {
      slug: b.id.replace(/\.[a-z0-9]+$/i, ""),
      book_id: b.id,
      book_title: b.title,
      cataloged,
      chapters_total: chapterRows.length,
      chunks_total: chunksTotal,
      has_page: hasPage,
      // chapters/ 不生成空文件：骨架是半成品，智能体哪章写了引文才建哪章的文件——
      // 81 个空文件只会撑大体积、稀释蒸馏度（save_skill 的引文质检也只认有引文的文件）
      files: [
        { path: "SKILL.md", content: skillMd },
        { path: "catalog.json", content: JSON.stringify(catalogJson, null, 2) + "\n" },
      ],
      next: "填 description/使用建议 → 按需建 chapters/chNN-*.md（含引文）→ save_skill 提交（三道质检）",
    };
  } finally {
    db.close();
  }
}
