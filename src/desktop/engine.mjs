// 桌面端引擎桥接层：主进程（CJS）→ 引擎库（ESM）的唯一通道
// 所有 IPC 处理器只跟本模块说话；检索算法一行不碰——全部转调 lib。
// 职责（按对账审计）：configure 注入（paths.mjs 三层解析）+ getBookChunks（M1）+
// 错误人话化（M3）+ 模型进度钩子转事件（M4）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveDirs, writeConfig, hasConfig } from "./paths.mjs";
import { listBooks, findBook, hybridSearch, routeAndSearch, configureSearch, currentLibDir } from "../lib/search.mjs";
import { getOutline } from "../lib/outline.mjs";
import { listShelf, resolveAsset, safeBookId } from "../lib/assets.mjs";
import { purgeDerived } from "../lib/derived.mjs";
import { describeAsset } from "./book-view.mjs";
import { getCatalogSummary } from "../lib/catalog.mjs";
import { questionKeywords } from "../lib/keywords.mjs";
import { listSkills, readSkill, configureSkillStore, deleteSkill } from "../lib/skill-store.mjs";
import { loadSkillState, setSkillEnabled } from "../lib/skill-state.mjs";
import { loadUsagePolicy, saveUsagePolicy, serviceStatus, sessionUsage, todayUsage } from "../lib/usage-policy.mjs";
import { configureModels, setModelProgress, getEmbedder } from "../lib/models.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

let _dirs = null, _userData = null, _packaged = false;

// ---------- 初始化：三层解析 → 注入三个 lib + 回写环境变量（M2：spawn 的 CLI 子进程继承） ----------
export function init({ packaged = false, userData = null } = {}) {
  _packaged = packaged;
  _userData = userData;
  _dirs = resolveDirs({ packaged, userData });
  configureSearch({ libDir: _dirs.libDir });
  configureSkillStore({ skillsDir: _dirs.skillsDir });
  configureModels({ modelsDir: _dirs.modelsDir });
  process.env.BSP_LIB_DIR = _dirs.libDir;
  process.env.BSP_SKILLS_DIR = _dirs.skillsDir;
  process.env.BSP_MODELS_DIR = _dirs.modelsDir;
  return _dirs;
}

export function dirs() { return _dirs; }
export function isFirstRun() { return _packaged && !hasConfig(_userData); }

// 改目录（首启向导/设置）：写 config.json 后按新解析重新注入
export function applyConfig(patch) {
  if (!_userData) throw new Error("未打包态没有配置层，用环境变量 BSP_LIB_DIR 改目录");
  writeConfig(_userData, patch);
  return init({ packaged: _packaged, userData: _userData });
}

// ---------- 书架：全量书（含关掉的）+ 编目摘要 + 开关态 ----------
// 洗数据摘要（#140 书架徽标）：轻量只读——ctx 列在不在、覆盖率、标签数、三级摘要数。
// 与 enrich-job 的 auditEnrich 的区别：**不做全库指纹**（书架每次刷新都跑，指纹太贵），
// 只取徽标要显示的数字；回源率等重活走 enrich:audit 通道按需查。
function enrichSummary(dbPath) {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const cols = db.prepare("PRAGMA table_info(chunks)").all().map((c) => c.name);
      if (!cols.includes("ctx")) return { ready: false }; // 没洗过（ensureEnrichSchema 未跑）
      const covered = db.prepare("SELECT COUNT(*) c FROM chunks WHERE ctx IS NOT NULL AND ctx != ''").get().c;
      const eligible = db.prepare("SELECT COUNT(*) c FROM chunks WHERE length(text) >= 40").get().c;
      const has = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      const tags = has("chunk_tags") ? db.prepare("SELECT COUNT(*) c FROM chunk_tags").get().c : 0;
      const byScope = has("summaries")
        ? Object.fromEntries(db.prepare("SELECT scope, COUNT(*) c FROM summaries GROUP BY scope").all().map((r) => [r.scope, r.c]))
        : {};
      // P4 闸门印记：入库时写的 verdict（pass/warn；block 到不了库里）。老库无此键 → null。
      // 内层兜底：meta 表缺失/值坏都不该把整份摘要打成 ready:false（徽标数字比闸门印记重要）
      let enrichGate = null;
      try {
        const gateRaw = db.prepare("SELECT value FROM meta WHERE key='enrich_gate'").get()?.value;
        if (gateRaw) { try { enrichGate = JSON.parse(gateRaw).verdict || null; } catch { enrichGate = null; } }
      } catch { enrichGate = null; }
      return {
        ready: true, covered, eligible,
        pct: eligible ? Math.round((covered / eligible) * 100) : 0,
        tags,
        summaries: { chunk: byScope.chunk || 0, chapter: byScope.chapter || 0, book: byScope.book || 0 },
        enrichGate,
      };
    } finally { db.close(); }
  } catch { return { ready: false }; } // 单本读失败不拖垮整个书架
}

export function booksList() {
  const libDir = currentLibDir();
  const state = loadSkillState(libDir);
  // V3 第四波 #165：listShelf 合并 books/ 原件与 library/*.db（raw=仅入库未加工）。
  // raw 书没有库：跳过编目/洗数据摘要（无表可查），skill 恒开（无技能开关可言）。
  return listShelf(libDir).map(b => {
    if (b.status === "raw") {
      return { ...b, skillEnabled: true, catalog: { cataloged: false, themes: [], persons: 0 }, enrich: { ready: false } };
    }
    let catalog = { cataloged: false, themes: [], persons: 0 };
    try {
      const s = getCatalogSummary(b.db);
      if (s.cataloged) catalog = { cataloged: true, themes: s.themes.map(t => t.name), persons: s.persons.length };
    } catch { /* 单本编目读失败不拖垮整个书架 */ }
    return { ...b, skillEnabled: state[b.id] !== false, catalog, enrich: enrichSummary(b.db) };
  });
}

export function bookCatalog(bookId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const out = getCatalogSummary(b.db);
  return { book: b.title, bookId: b.id, ...out };
}

// 删书第一档「移出书架」（M6 + V3 第四波 #168 两档删除）：只删库文件（含 wal/shm），
// books/ 原件保留——书架回到 raw 态，点「开始加工」即可重建，不用重新拖文件。
// 明确**不调 purgeDerived**（P5 拍板 2026-10-18）：原件还在、重建后块号可复用，
// 编目/洗数据派生留着能省一次云端洗数据的钱；只有「彻底删除」承诺清全部六落点。
export function deleteBook(bookId) {
  const libDir = currentLibDir();
  const shelf = listBooks(libDir, { includeDisabled: true });
  const b = shelf.find(x => x.id === bookId);
  if (!b) {
    // 大小写/空白变体（C20）：Windows 文件系统大小写不敏感，"D1.docx" 与
    // "d1.docx" 是同一本——直接说「找不到」会让用户以为书没了，给正确书名
    const want = String(bookId ?? "").trim().toLowerCase();
    const near = shelf.find(x => x.id.toLowerCase() === want);
    throw new UserError(near
      ? `书库里没有「${bookId}」，但有《${near.id}》——请按书架上的书名操作`
      : `书库里找不到「${bookId}」——移出书架只删书库；只有原件的书请用「彻底删除」`);
  }
  // 删除顺序：先 wal/shm 后主库——主库是「书还在不在」的判定依据，主库删不掉
  // 时书还在、状态一致；反序会让主库没了 wal/shm 残留成僵尸。EBUSY（另一进程
  // 开着库/杀软扫描）时 rmSync 会抛——裸抛到 IPC 是一屏英文堆栈，包成人话
  for (const suffix of ["-wal", "-shm", ""]) {
    const p = b.db + suffix;
    if (!fs.existsSync(p)) continue;
    try { fs.rmSync(p, { force: true }); }
    catch (e) {
      // 只带 errno 码不带 e.message：后者含绝对路径+英文串（书名为用户可控，
      // 渲染层转义面未覆盖前不拼进响应——毛求疵 F5 O3）
      throw new UserError(`书库文件删除失败（${e.code || "未知错误"}）——文件可能正被占用，请关掉占用程序后重试；若持续失败可重启应用再试`);
    }
  }
  // 开关记录清理是副作用：写失败（状态文件被占用/磁盘满）不该把「删书已成功」
  // 变成用户看到报错——书库已删是既成事实，残留记录最多多一条无效键
  // （loadSkillState 各消费点按 bookId 查，未知键无害），留一行痕迹供排障（C18/D3）
  try { setSkillEnabled(libDir, bookId, true); }
  catch (e) { console.warn(`  开关记录清理失败（${e?.code || e?.message}）——书库已删，残留记录无害`); }
  const hasAsset = resolveAsset(libDir, bookId).exists;
  return { deleted: bookId, removedAsset: false, note: hasAsset
    ? "已移出书架——书库文件已删，books/ 原件还在；点「开始加工」可重建"
    : "已移出书架——书库文件已删（这本没有 books/ 原件，重建要重新导入文件）" };
}

// 删书第二档「彻底删除」（V3 第四波 #168；P5 补齐派生六落点）：书库文件 + books/ 原件 +
// 开关记录 + 编目/洗数据派生文件一体删，不可恢复。
// 顺序：先删原件再删库——原件删除失败（占用/权限）时书库还完好，用户可重试；
// 派生清理放最后（前面失败就整块不动，见下方注释）。
// 存档/反馈样本联动在 ipc 层（purgeArchives 双清，与第一档同一条链路）。
export function purgeBook(bookId) {
  const libDir = currentLibDir();
  const raw = String(bookId ?? "");
  const shelf = listBooks(libDir, { includeDisabled: true });

  // 第一段：精确匹配，**不做任何归一**。
  let b = shelf.find(x => x.id === raw) || null;
  let id = b ? b.id : raw;
  let asset = resolveAsset(libDir, id);
  // resolveAsset 内部过 safeBookId（它会 trim）：返回的 bookId 与请求不一致，说明这次
  // 「找到」的是另一本书（" foo.docx" → "foo.docx"）。数据丢失级，一律不认账
  // （评审对抗官 FAIL-1 实测复现：前导空格的 raw 卡会把隔壁正常书的原件删掉）。
  if (asset.exists && asset.bookId !== id) {
    asset = { bookId: id, path: null, ext: null, exists: false };
  }

  // 原件归属校验（评审 FAIL-4）：resolveAsset 有**跨扩展兜底**（"foo.pdf" 的库会被
  // 判成 books/foo.docx）——阅读场景那是容错，删除场景就是删掉隔壁那本的原件。
  // 删除路径只认两种归属：与 id 同扩展，或 jobs.mjs EXT_FMT 的 txt→docx 映射；
  // 无扩展的旧库 id 才允许任意扩展（历史命名约定）。
  const assetBelongs = (aid, apath) => {
    if (!apath) return false;
    const idExt = path.extname(aid).toLowerCase();
    if (!idExt) return true;
    const gotExt = path.extname(apath).toLowerCase();
    if (gotExt === idExt) return true;
    return idExt === ".docx" && gotExt === ".txt";
  };

  // 第二段：精确没命中库时做大小写归一（C20）。Windows/macOS 默认文件系统大小写
  // 不敏感，T3.docx 与 t3.docx 是同一本。**不能看 asset.exists 再决定**：Windows 上
  // resolveAsset 本身大小写不敏感，会先一步「找到」原件，导致这段被跳过 → 库不删、
  // 原件却删了（评审 FAIL-2 实测：比不修更糟的半截态）。
  // 判「同一本」用**文件系统身份**，不用字符串小写：JS 的 toLowerCase 会把 U+212A
  // KELVIN SIGN 折叠成 ASCII "k"，而 NTFS 视其为两个不同文件名——用字符串证明身份
  // 会删错书（评审 FAIL-3 实测：purge("k.docx") 删掉了 K.docx 那本）。
  // 坏库（在盘上但 scanBooks 读不了）不会进 shelf → 探不到 → 不猜，宁可拒绝。
  // 也不 trim：首尾空白可能是文件名的一部分。
  if (!b && raw && raw === raw.trim()) {
    let probeReal = null;
    try { probeReal = fs.realpathSync.native(path.join(libDir, raw + ".db")); } catch { /* 盘上没有这个名 */ }
    if (probeReal) {
      const hit = shelf.find((x) => {
        try { return fs.realpathSync.native(x.db) === probeReal; } catch { return false; }
      });
      if (hit) {
        b = hit;
        id = b.id;
        asset = resolveAsset(libDir, id);
      }
    }
  }

  // 归属统一收口：不管走哪条路，最终 asset 必须真属于这本书——bookId 回验挡住
  // safeBookId 的 trim，扩展校验挡住 resolveAsset 的跨扩展兜底。
  if (asset.exists && (asset.bookId !== id || !assetBelongs(id, asset.path))) {
    asset = { bookId: id, path: null, ext: null, exists: false };
  }

  if (!b && !asset.exists) {
    // 带首尾空白的书名单独给话术：含糊说「找不到」会让用户反复试
    if (raw !== raw.trim()) {
      throw new UserError(`「${raw}」书名前后带空白——系统无法确认是哪一本，请先把文件改成不含首尾空格的名字再删`);
    }
    // 补刀路（评审 OBSERVE-1）：库和原件都没了，但上次可能因占用留下派生——
    // 没有这条，用户永远清不掉残留（再点一次只会得到「找不到」）。只清派生，
    // 删不掉就如实说。派生文件名严格等于 bookId，不存在「猜」的成分。
    const leftover = purgeDerived(libDir, id);
    if (leftover.removedCount > 0 || leftover.failed.length > 0) {
      const bits = [];
      if (leftover.removedCount > 0) bits.push(`清掉残留派生 ${leftover.removedCount} 项`);
      if (leftover.failed.length > 0) bits.push(`还有 ${leftover.failed.length} 项没删掉（可能被占用）`);
      return {
        purged: id, title: id.replace(/\.[^.]+$/, ""), removedAsset: false,
        removedDerived: leftover.removedCount, derivedFailed: leftover.failed.length,
        note: `《${id}》的书库和 books/ 原件都不在了；${bits.join("，")}`,
      };
    }
    throw new UserError(`书库里找不到「${bookId}」`);
  }
  const title = b?.title || id.replace(/\.[^.]+$/, "");
  if (asset.exists && asset.path) {
    try { fs.rmSync(asset.path, { force: true }); }
    catch (e) { throw new UserError(`books/ 原件删除失败（${e.message}）——书库未动，请关掉占用该文件的程序后重试`); }
  }
  if (b) {
    // 同 deleteBook：先 wal/shm 后主库；任何一步失败都要人话——注意原件已删
    // 不可逆，必须告诉用户「再点一次彻底删除」就能清掉剩余书库（C17/D2）
    for (const suffix of ["-wal", "-shm", ""]) {
      const p = b.db + suffix;
      if (!fs.existsSync(p)) continue;
      try { fs.rmSync(p, { force: true }); }
      catch (e) {
        // 同 deleteBook：只带 errno 码；原件已删不可逆，话术必须给出「再点一次」路径
        throw new UserError(`书库文件删除失败（${e.code || "未知错误"}）——books/ 原件已删，请关掉占用程序后再点一次「彻底删除」清掉剩余书库`);
      }
    }
  }
  try { setSkillEnabled(libDir, id, true); }
  catch (e) { console.warn(`  开关记录清理失败（${e?.code || e?.message}）——书库已删，残留记录无害`); }
  // 派生文件六落点（P5 一体删除收尾）：编目任务书/提示词/结果 + 洗数据任务书/产物/缓存。
  // 放在最后：上面任何一步抛错（原件或库删不掉）都会直接穿层，派生保持原样——
  // 用户重试还能原路清，不会出现「书库还在、任务书先没了」的半截态。
  // 失败不改成功语义（与开关清理同款）：删书主体已成既成事实，残留尾巴进 note 告知。
  const dv = purgeDerived(libDir, id);
  const parts = [];
  if (b) parts.push("书库文件");
  if (asset.exists) parts.push("books/ 原件");
  let note = `《${title}》已彻底删除（${parts.join(" + ")}）`;
  if (dv.removedCount > 0) note += `；编目/洗数据派生文件已清 ${dv.removedCount} 项`;
  if (dv.failed.length > 0) note += `；有 ${dv.failed.length} 项派生文件没删掉（可能被占用）`;
  // skipped 必须说出来：候选位置是目录/符号链接时我们保守不动，但用户看到的
  // 「彻底删除」承诺不能含糊——否则那项会静默留下，且没有补刀入口（陆回测 OBSERVE-1）
  if (dv.skipped.length > 0) note += `；有 ${dv.skipped.length} 项不是普通文件（目录或链接），已保留`;
  // rejected = 派生层闸门没过（书名含系统不允许的字符）。必须说出来：
  // 否则用户以为「彻彻底底删干净了」，实际上六项可能一项没动（评审 OBSERVE-1）
  if (dv.rejected) note += "；派生文件未清理（书名含系统不允许的字符），请手动检查四个派生目录";
  return {
    purged: id, title, removedAsset: asset.exists,
    removedDerived: dv.removedCount,
    derivedFailed: dv.failed.length,
    note,
  };
}

// ---------- 问一问：单书 / 全库（跨书检索入口） ----------
export async function ask({ bookId, question, topN = 4, skillSlug = null }) {
  const q = String(question || "");
  const n = Math.min(Math.max(1, Math.floor(Number(topN) || 4)), 20);
  let base;
  if (!bookId) {
    base = { mode: "library", ...(await routeAndSearch(q, { topN: n })) };
  } else {
    const b = findBook(bookId) || exactBook(bookId);
    if (!b) throw new UserError(`书库里找不到「${bookId}」`);
    // H3 桌面路径：关掉 skill 的书，桌面也问不到（翻书仍可看——读书是本地的，问 AI 是开关管的事）
    const st = loadSkillState(currentLibDir());
    if (st[b.id] === false) throw new UserError(`《${b.title}》的 skill 已关——去「技能开关」面板打开才能问`);
    base = { mode: "book", book: b.title, bookId: b.id, results: await hybridSearch(b.db, q, n) };
  }
  // 「用技能包回答」：技能章节作为附加参考随结果返回（见 attachSkill）
  return skillSlug ? attachSkill(base, String(skillSlug), q) : base;
}

// 技能包参考：读技能索引 → 用问题词给章节打分（与字面腿同一套抽词，不另起炉灶）→ 取 top2。
// 注意边界：这是"附加参考区"，不是新的检索腿——检索算法一行不碰，skill 匹配不上时
// 普通检索结果原样返回（matched 为空数组），UI 明示"技能包无匹配章节"。
// V3 导出：chat.mjs 的改写多路路径绕过 ask()，技能参考由编排层显式补挂。
export async function attachSkill(base, slug, question) {
  const skill = readSkill(slug);
  if (skill.error) throw new UserError(`技能包「${slug}」不存在（可去技能开关面板看有哪些）`);
  const { en, cjk } = questionKeywords(question);
  const hay = (s) => String(s || "").toLowerCase();
  const scored = [];
  for (const ch of skill.index || []) {
    const full = readSkill(slug, ch.file.split("/").pop()); // "chapters/ch01-x.md" → "ch01-x.md"
    if (full.error) continue;
    const text = hay(full.content);
    const title = hay(ch.title);
    let score = 0;
    for (const w of en) if (text.includes(w)) score += 2;   // 英文整词命中权重高
    for (const g of cjk) score += (title.includes(g) ? 2 : 0) + (text.includes(g) ? 1 : 0);
    scored.push({ file: ch.file, title: ch.title, score, tokens_est: ch.tokens_est, content: full.content });
  }
  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter(s => s.score > 0).slice(0, 2);
  return { ...base, skill: { slug, chapters_total: (skill.index || []).length, matched } };
}

// ---------- 翻书：目录 + 原文块（M1：lib 无此 API，这里自建，不污染 lib） ----------
// ---------- 原书视图（V3 #166）：book:// 协议 + 系统打开 ----------
// bookOriginal：原件元信息（存在性/格式/大小/展示方式）——渲染层按 render 分流
// bookAssetPath：原件绝对路径——只给 book:openExternal 用（shell.openPath 要真路径），
//   不走 IPC 回渲染层（路径不外泄）；不存在/不合法抛 UserError 走统一错误包装
export function bookOriginal(bookId) {
  const d = describeAsset(currentLibDir(), bookId);
  if (!d.ok) throw new UserError(d.error);
  return d.data;
}

export function bookAssetPath(bookId) {
  const id = safeBookId(bookId);
  if (!id) throw new UserError("书名不合法");
  const asset = resolveAsset(currentLibDir(), id);
  if (!asset.exists) throw new UserError(`《${id}》没有原件文件（books/ 里找不到）`);
  return asset.path;
}

// 章节目录（V3R7 对称：吃 lib getOutline 同一数据源——token 账 + 质量三态 + no-chapters 指路，
// 不再自建聚合。无章节书（PDF）保底一桶「未分章」保住「能翻」的能力，hint 引导去检索。
// 兼容面：chapters[i] 至少有 {name, blocks, firstId}（views-reader 与 ipc-test/soak-test 依赖）
export function readerChapters(bookId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const o = getOutline(b.db);
  if (o.error === "db-broken") throw new UserError(o.hint || "书库打不开");
  const base = {
    book: b.title,
    bookId: b.id,
    totalTokens: o.total_tokens ?? null,
    quality: o.chapter_quality || null, // {verdict: none|messy|reliable, coverage}
  };
  if (o.error === "no-chapters") {
    const db = new Database(b.db, { readonly: true });
    try {
      const agg = db.prepare("SELECT COUNT(*) n, MIN(id) m FROM chunks").get();
      return {
        ...base,
        chapters: agg.n ? [{ name: "未分章", blocks: agg.n, firstId: agg.m, tokens: o.total_tokens }] : [],
        hint: "本书没有章节标题（PDF 类）——目录只有整本一桶；找具体内容建议用「问一问」检索",
      };
    } finally { db.close(); }
  }
  return {
    ...base,
    chapters: (o.chapters || []).map((c) => ({ name: c.name, blocks: c.blocks, firstId: c.first_id, tokens: c.tokens })),
    chaptersTotal: o.chapters_total ?? null,
    shown: o.shown ?? null,
    notes: o.notes || [],
  };
}

export function readerBlock(bookId, chapter) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const sql = chapter === "未分章"
      ? "SELECT id, page, text FROM chunks WHERE chapter IS NULL OR chapter='' ORDER BY id"
      : "SELECT id, page, text FROM chunks WHERE chapter = ? ORDER BY id";
    const rows = chapter === "未分章" ? db.prepare(sql).all() : db.prepare(sql).all(chapter);
    return { book: b.title, bookId: b.id, chapter, blocks: rows.map((r, i) => ({ n: i + 1, id: r.id, page: r.page, text: r.text })) };
  } finally { db.close(); }
}

// 按 chunk id 反查所在章节（问一问的引用徽标点击 → 跳翻书对应块用）
export function locateChunk(bookId, chunkId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const r = db.prepare("SELECT chapter FROM chunks WHERE id = ?").get(Number(chunkId));
    return { chapter: r ? (r.chapter || "未分章") : null };
  } finally { db.close(); }
}

// ---------- 翻书·编目资产（M1 同款：lib 没有"按主题/人物取块"的浏览 API，这里自建） ----------
// 主题分区：llm 编目层 themes + 每个主题的代表块预览（点主题 → readerThemeBlocks 看全文）
export function readerThemes(bookId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const themes = db.prepare("SELECT name, ref FROM nodes WHERE type='theme' AND source='llm' ORDER BY rowid").all();
    if (!themes.length) return { book: b.title, bookId: b.id, themes: [] };
    const belongs = db.prepare("SELECT src FROM edges WHERE kind='belongs' AND dst=? ORDER BY rowid LIMIT 5");
    const get = db.prepare("SELECT id, chapter, text FROM chunks WHERE id = ?");
    return {
      book: b.title, bookId: b.id,
      themes: themes.map(t => {
        let note = "";
        try { note = JSON.parse(t.ref || "{}").note || ""; } catch { /* ref 损坏不当成主题坏 */ }
        const representatives = belongs.all(t.name).map(r => {
          const c = get.get(+r.src);
          return c ? { chunk: c.id, chapter: c.chapter || "", preview: (c.text || "").slice(0, 60) } : null;
        }).filter(Boolean);
        return { name: t.name, note, representatives };
      }),
    };
  } finally { db.close(); }
}

// 主题代表块全文（翻书区"按主题逛"的落点）
export function readerThemeBlocks(bookId, theme) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const ids = db.prepare("SELECT src FROM edges WHERE kind='belongs' AND dst=? ORDER BY rowid LIMIT 5").all(String(theme)).map(r => +r.src);
    if (!ids.length) return { book: b.title, bookId: b.id, theme, blocks: [] };
    const get = db.prepare("SELECT id, page, chapter, text FROM chunks WHERE id = ?");
    const blocks = ids.map(id => get.get(id)).filter(Boolean)
      .map((r, i) => ({ n: i + 1, id: r.id, page: r.page, chapter: r.chapter || "", text: r.text }));
    return { book: b.title, bookId: b.id, theme, blocks };
  } finally { db.close(); }
}

// 人物表：身份注记 / 书中写法 / 出场块数（吃 importCatalog 写进 nodes.ref 的编目数据）
export function readerPersons(bookId) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const rows = db.prepare("SELECT name, ref FROM nodes WHERE type='person' AND source='llm' ORDER BY rowid").all();
    return {
      book: b.title, bookId: b.id,
      persons: rows.map(p => {
        let info = {};
        try { info = JSON.parse(p.ref || "{}"); } catch { /* 同上 */ }
        return { name: p.name, note: info.note || "", match_names: info.match_names || [], mention_count: info.mention_count || 0 };
      }),
    };
  } finally { db.close(); }
}

// 人物出场块：name + match_names 全文 instr 扫描（与 validateResult 防幻觉校验同一招式），封顶 50 块
export function readerPersonBlocks(bookId, person) {
  const b = exactBook(bookId);
  if (!b) throw new UserError(`书库里找不到「${bookId}」`);
  const db = new Database(b.db, { readonly: true });
  try {
    const row = db.prepare("SELECT ref FROM nodes WHERE type='person' AND source='llm' AND name=?").get(String(person));
    if (!row) throw new UserError(`编目里没有人物「${person}」`);
    let info = {};
    try { info = JSON.parse(row.ref || "{}"); } catch { /* ref 坏 → 只按名字查 */ }
    const names = [String(person), ...(info.match_names || [])].filter(Boolean);
    const hit = new Map();
    for (const n of names) {
      for (const r of db.prepare("SELECT id, page, chapter, text FROM chunks WHERE instr(lower(text), lower(?)) > 0 ORDER BY id LIMIT 50").all(n)) {
        if (!hit.has(r.id)) hit.set(r.id, r);
      }
    }
    const blocks = [...hit.values()].sort((a, b2) => a.id - b2.id).slice(0, 50)
      .map((r, i) => ({ n: i + 1, id: r.id, page: r.page, chapter: r.chapter || "", text: r.text }));
    return { book: b.title, bookId: b.id, person, blocks };
  } finally { db.close(); }
}

// ---------- 技能：list/read/toggle ----------
export function skillsList() {
  const st = loadSkillState(currentLibDir());
  // W3.5：蒸馏技能包带 enabled（与书级开关同吃 skill-state.json，slug 键）——技能开关页的开关要显示状态
  return listSkills().map(p => ({ ...p, enabled: st[p.slug] !== false }));
}
export function skillRead(slug, chapter) { return readSkill(slug, chapter); }
export function skillToggle(bookId, enabled) {
  return setSkillEnabled(currentLibDir(), bookId, !!enabled);
}
// 删除技能包（桌面「技能开关」页删除按钮；老板拍板确认框直接删、不做回收站——
// git 历史是唯一后悔药）。开关记录清理是副作用：写失败（状态文件被占用/磁盘满）
// 不该把「删除已成功」变成用户看到报错——技能目录已删是既成事实，残留键最多让
// 一个不存在的 slug 停在"关"态，无害（同 deleteBook 143 行的处理）。
export function skillDelete(slug) {
  const r = deleteSkill(slug);
  if (!r.ok) throw new UserError(r.hint || `删除技能包失败：${r.error}`);
  try { setSkillEnabled(currentLibDir(), slug, true); }
  catch (e) { console.warn(`  开关记录清理失败（${e?.code || e?.message}）——技能已删，残留记录无害`); }
  return { deleted: slug, note: `技能「${slug}」已删除——不进回收站；git 历史里还有，要找回得从版本库 checkout` };
}

// ---------- 对外服务用量治理（W1，2026-10-21） ----------
// 与 skill-state 同款：桌面写 usage-policy.json，MCP 闸机读同一份
export function usagePolicyGet() {
  const libDir = currentLibDir();
  const policy = loadUsagePolicy(libDir);
  const usage = todayUsage(libDir);
  return { policy, usage, session: sessionUsage(), open: serviceStatus(policy).open };
}
export function usagePolicySet(patch) {
  return saveUsagePolicy(currentLibDir(), patch || {});
}

// ---------- 引擎状态 + 模型进度（M4） ----------
export function engineStatus() {
  return {
    dirs: _dirs,
    rerank: process.env.BSP_RERANK !== "0",
    catalog: process.env.BSP_CATALOG !== "0",
    ftsKw: process.env.BSP_FTS_KW !== "0",
  };
}

// 订阅模型下载进度（首启向导用）；返回退订函数
export function onModelProgress(fn) {
  setModelProgress(fn);
  return () => setModelProgress(null);
}

// 预热：触发嵌入模型下载/加载（reranker 首次提问时才下，574MB——向导要提示）
export async function warmup() {
  const embed = await getEmbedder();
  return { model: embed.id, dim: embed.dim };
}

// ---------- 内部工具 ----------
function exactBook(bookId) {
  const q = String(bookId || "").toLowerCase();
  return listBooks(undefined, { includeDisabled: true })
    .find(b => b.id === bookId || b.id.toLowerCase() === q || b.title === bookId) || null;
}

// M3：错误人话化——UI 不崩，且告诉用户怎么修
export class UserError extends Error {
  constructor(msg, code = "user") { super(msg); this.code = code; }
}

export function humanizeError(e) {
  const m = String((e && e.message) || e);
  if (/引擎不一致|维度不一致/.test(m)) return { code: "engine-mismatch", message: m }; // 原文已带修复指引
  // ENOENT 保真（C25）：只有「书库文件（.db）」缺失才说「书库文件不见了」——
  // 原件（books/）、任务书、prompt 等别的 ENOENT 一律保真原文，别用同一句话误导
  if (/ENOENT|no such file/i.test(m)) {
    if (/\.db\b/i.test(m)) return { code: "db-missing", message: "书库文件不见了（可能被移走或删除）" };
    return { code: e instanceof UserError ? e.code : "missing", message: m };
  }
  if (e instanceof UserError) return { code: e.code, message: m };
  return { code: "unknown", message: m };
}
