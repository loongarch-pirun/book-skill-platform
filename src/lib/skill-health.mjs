// 技能体检：红黄绿报告（工具层无 LLM，只读——修技能是智能体的事，见 skill-authoring 元技能）
// 背景：书库会长胖/删书/关书，已落盘的技能包会悄悄失效——save_skill 只保"落盘那一刻"
// 干净，保不了以后。本模块补定期体检：逐包重跑引用回源 + 覆盖声称核对 + 索引存在性 +
// 源书在否/开关态，输出红（不可信不可用）/黄（能用但提醒）/绿（全过）。
// 判定语义（与桌面技能开关页、MCP check_skills 工具三方同一份）：
//   红 = source-missing（源书删了）/ 引文回源失败 / broken-reference（索引断链）/ 声称对不上
//   黄 = source-disabled（源书被关）/ no-chapters（无章节文件）/ catalog.json 异常 / 覆盖声称存疑告警
//   绿 = 全部通过
// 复用铁律：引文回源、声称核对、catalog 校验全部调 skill-store 的同名函数（导出即复用）——
// 体检与落盘不许有两份判定实现，否则"落盘时过关、体检时放水"。
import fs from "node:fs";
import path from "node:path";
import { currentLibDir } from "./search.mjs";
import { loadSkillState } from "./skill-state.mjs";
import {
  SLUG_RE, currentSkillsDir, parseFrontmatter, extractCitations,
  verifyCitations, resolveBookExact, coverageCheck, catalogCheck,
} from "./skill-store.mjs";

// 整包读取（与 save_skill 的 files 形态对齐：{path, content}，path 用 / 分隔）。
// 512KB/文件上限与 save 时同款：防异常大文件把体检本身拖垮；读不动的（二进制）跳过——
// 技能包白名单里本就不该有二进制。
function readPackageFiles(dir) {
  const out = [];
  const walk = (rel) => {
    let names;
    try { names = fs.readdirSync(path.join(dir, rel)); } catch { return; }
    for (const name of names.sort()) {
      const childRel = rel ? rel + "/" + name : name;
      const abs = path.join(dir, childRel);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(childRel); continue; }
      if (st.size > 512 * 1024) continue;
      try { out.push({ path: childRel, content: fs.readFileSync(abs, "utf8") }); } catch { /* 读不动即跳过 */ }
    }
  };
  walk("");
  return out;
}

// 单包体检。libDir 只用于 listBooks/loadSkillState；引文回源走 search 层的 currentLibDir()
// （verifyCitations 内部解析）——桌面/MCP 启动时已 configure，两者同目录。
function checkOne(slug, dir, libDir) {
  const findings = [];
  const add = (level, reason, hint, extra = {}) => findings.push({ level, reason, hint, ...extra });

  const files = readPackageFiles(dir);
  const skillMd = files.find(f => f.path === "SKILL.md");
  const fm = skillMd ? parseFrontmatter(skillMd.content) : null;
  const fmData = (fm && fm.data) || {};
  if (!fm || !fmData.name || !fmData.description)
    add("red", "bad-frontmatter", "SKILL.md 缺 frontmatter（name/description）——智能体无法判断该不该用它，先 read_skill 看全文再 save_skill 重修");

  // ① 源书在否 + 开关态（关书≠坏书：书还在，引文仍可回源，只是对外检索不到）
  const state = loadSkillState(libDir);
  const sourceRows = [];
  for (const [alias, bookId] of Object.entries(fmData.sources || {})) {
    const book = resolveBookExact(bookId);
    if (!book) {
      add("red", "source-missing", `来源书「${bookId}」（别名「${alias}」）不在书库里——书被删了？引文全部无法回源，此包不可信不可用`, { alias, book: bookId });
      sourceRows.push({ alias, book: bookId, state: "missing" });
    } else if (state[book.id] === false) {
      add("yellow", "source-disabled", `来源书「${book.title}」（别名「${alias}」）在桌面端被关掉——书还在、引文仍可回源，但对外检索不到它`, { alias, book: book.id });
      sourceRows.push({ alias, book: book.id, state: "disabled" });
    } else {
      sourceRows.push({ alias, book: book.id, state: "ok" });
    }
  }

  // ② 引文回源重验（save 时同一函数；任一失败即红——防幻觉红线不因时间褪色）
  const citations = extractCitations(files);
  const { errors: citErrors, stats } = verifyCitations(citations, fmData.sources);
  for (const e of citErrors)
    add("red", e.reason, e.hint, { file: e.file, line: e.line, alias: e.alias, chapter: e.chapter });

  // ③ 覆盖声称 + 索引断链（复用 save 时的 coverageCheck：声称过期/断链都是红）
  // 注意：extra 展开在 {level, reason, hint} 之后，cov.errors 的条目不带 level 键才不会覆盖它
  const cov = coverageCheck(fmData, skillMd ? skillMd.content : "", files, stats);
  for (const e of cov.errors) add("red", e.reason, e.hint, e);
  for (const w of cov.warnings) add("yellow", "coverage-warning", w);

  // ④ catalog.json 机器可读地图（坏地图 = 智能体按图索骥撞墙，黄——能用但提醒）
  for (const w of catalogCheck(files, fmData)) add("yellow", "catalog-warning", w);

  // ⑤ 无章节文件：只有 SKILL.md 一层，智能体想深读时无处可去（纯流程型技能可忽略）
  const chapterFiles = files.filter(f => /^(?:chapters|references)\//.test(f.path) && f.path.endsWith(".md"));
  if (!chapterFiles.length)
    add("yellow", "no-chapters", "没有 chapters/ 或 references/ 章节文件——只有 SKILL.md 一层，智能体想深读时无处可去（纯流程型技能可忽略此条）");

  const status = findings.some(f => f.level === "red") ? "red"
    : findings.some(f => f.level === "yellow") ? "yellow" : "green";
  const bookIds = Object.values(fmData.sources || {});
  const single = bookIds.length === 1 && stats[bookIds[0]];
  // 覆盖百分比只在「按章引文」语境下有意义：PDF 书的引文走页码通道（数字章节），
  // stats.total 数的是章节键（含无章节块）——covered 3 / total 1 这种 300% 是尺子错了，
  // 不是书错了。不可比就干脆不给百分比，别报个看着像 bug 的数。
  const st0 = single ? stats[bookIds[0]] : null;
  const pctOk = !!st0 && st0.total > 0 && st0.seen.size <= st0.total;
  let st = null;
  try { st = fs.statSync(path.join(dir, "SKILL.md")); } catch { /* 读不到 mtime 就留 null */ }
  return {
    slug,
    title: (fm && fmData.title) || slug,
    status,
    findings,
    citations: { checked: citations.length, failed: citErrors.length },
    sources: sourceRows,
    coverage: st0
      ? {
          covered: st0.seen.size,
          total: st0.total,
          percent: pctOk ? Math.round((st0.seen.size / st0.total) * 100) : null,
          ...(pctOk ? {} : { note: "引文按页码定位（PDF 常见）或源书章节键异常——covered/total 不具可比性，看 citations 通过率即可" }),
        }
      : null,
    chapters: chapterFiles.length,
    updated_at: st ? st.mtime.toISOString() : null,
  };
}

// 全量体检：skillsDir 下每个合法包（SLUG_RE 过滤——顺手把 slug.tmp-* 僵尸挡在报告外，
// 另在 warnings 里点名，那些是 save_skill 原子写进程被砍留下的半成品）。
export function checkSkills({ skillsDir = currentSkillsDir() } = {}) {
  const libDir = currentLibDir();
  if (!fs.existsSync(skillsDir))
    return { total: 0, green: 0, yellow: 0, red: 0, packages: [], warnings: [`skills/ 目录不存在（${skillsDir}）——没有技能包可体检`] };

  let entries = [];
  try { entries = fs.readdirSync(skillsDir); } catch { /* 读取失败按空处理 */ }
  const slugs = entries.filter(f => {
    try {
      return SLUG_RE.test(f) && fs.statSync(path.join(skillsDir, f)).isDirectory()
        && fs.existsSync(path.join(skillsDir, f, "SKILL.md"));
    } catch { return false; }
  }).sort();
  // 僵尸临时目录：合法 slug 不含点，名字里出现 .tmp- 的必是原子写残留（deleteSkill 同款识别）
  const zombies = entries.filter(f => f.includes(".tmp-"));

  const packages = slugs.map(slug => {
    try { return checkOne(slug, path.join(skillsDir, slug), libDir); }
    catch (e) {
      // 单包坏掉不许掀翻整场体检（铁律：失败降级为一条红发现，不 throw 穿层）
      return {
        slug, title: slug, status: "red",
        findings: [{ level: "red", reason: "check-failed", hint: `体检自身出错：${e.message || e}——包可能已损坏，read_skill 看全文后 save_skill 重修或删除` }],
        citations: { checked: 0, failed: 0 }, sources: [], coverage: null, chapters: 0, updated_at: null,
      };
    }
  });

  return {
    total: packages.length,
    green: packages.filter(p => p.status === "green").length,
    yellow: packages.filter(p => p.status === "yellow").length,
    red: packages.filter(p => p.status === "red").length,
    packages,
    warnings: zombies.length
      ? [`发现 ${zombies.length} 个原子写残留目录（${zombies.slice(0, 3).join("、")}${zombies.length > 3 ? "…" : ""}）——save_skill 进程被砍会留这种半成品，删掉即可（不影响体检计数）`]
      : [],
  };
}
