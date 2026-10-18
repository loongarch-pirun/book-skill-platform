// 资产层定位与书架合并（V3 第四波 #165，资产/派生分层改造 Step 1）：
//   资产层 = <书库上级>/books/ 里的原件（导入即复制、不可变真身，jobs.mjs jobDirs 同一约定）；
//   派生层 = library/*.db 等加工产物。
//   resolveAsset：bookId → 原件路径（txt 书 bookId 是 <base>.docx 但原件是 <base>.txt——
//     导入时转 docx 建库、原件留 .txt；jobs.mjs:21 EXT_FMT）；
//   listShelf：books/ 资产 ∪ library/*.db 合并出书架清单，支持「仅入库未加工」(raw) 态。
// 铁律：
//   - bookId 防穿越：拒绝路径分隔符与 ..（渲染层只传 bookId，主进程侧唯一放行口在这里）；
//   - 不读 meta.source_file 定位原件（迁库即失效 + txt 书指向临时目录，jobs.mjs:250-262）；
//   - db 侧复用 search.listBooks（含其清单缓存）；本模块只做合并，不动检索内部。
import fs from "node:fs";
import path from "node:path";
import { listBooks } from "./search.mjs";

// 支持的原件扩展（md 仅 CLI 建库场景的容错查找，应用导入不含 md）
const ASSET_EXTS = [".pdf", ".epub", ".docx", ".txt", ".md"];

// bookId 合法性：非空、不含路径分隔符/../控制字符——防目录穿越的唯一闸门
export function safeBookId(bookId) {
  const id = String(bookId ?? "").trim();
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  // 控制字符（含 NUL）文件名里不允许——NUL 是实测放行过的那一个（C1/C8）：
  // 下游 path.join 容错 + existsSync 吞 ERR_INVALID_ARG_VALUE，链路靠吞错降级
  // 兜底，闸门名不副实。此处拒 C0 + DEL（C1 区 0x80-0x9F 在 Win 文件名中合法）。
  // eslint-disable-next-line no-control-regex -- 文件名闸门必须显式匹配控制符
  if (/[\u0000-\u001f\u007f]/.test(id)) return null;
  // win32 特有面：冒号是 ADS 别名（"a:b.json" 是 base "a" 的隐藏流，静默产
  // 怪文件却不报错——与 NUL 同型的「靠下游兜底」）；尾点会被系统剥除撞名
  // （"a." 与 "a" 落同一文件）。只在 win32 拒——macOS/Linux 上冒号/尾点是
  // 合法文件名字符（如书名「第1章:开始」），不许误伤。
  if (process.platform === "win32") {
    if (id.includes(":")) return null;
    if (id.endsWith(".")) return null;
  }
  return id;
}

export function booksDirOf(libDir) {
  return path.join(libDir, "..", "books");
}

// 原件解析：候选顺序 = 与 id 同后缀优先，再按支持格式兜（txt 转 docx 建库的场景）。
// 返回 { bookId, path, ext, exists }；不存在/非法 → path:null, exists:false（不抛错）。
export function resolveAsset(libDir, bookId) {
  const id = safeBookId(bookId);
  const bad = { bookId: String(bookId ?? ""), path: null, ext: null, exists: false };
  if (!id) return bad;
  const booksDir = booksDirOf(libDir);
  const idExt = path.extname(id).toLowerCase();
  const base = idExt ? id.slice(0, -idExt.length) : id;
  const ordered = idExt && ASSET_EXTS.includes(idExt)
    ? [idExt, ...ASSET_EXTS.filter((e) => e !== idExt)]
    : ASSET_EXTS;
  for (const ext of ordered) {
    const p = path.join(booksDir, base + ext);
    if (fs.existsSync(p)) {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return { bookId: id, path: p, ext: ext.slice(1).toLowerCase(), exists: true };
      } catch { /* stat 失败按不存在处理，继续找下一个候选 */ }
    }
  }
  return { bookId: id, path: null, ext: idExt ? idExt.slice(1).toLowerCase() : null, exists: false };
}

// 书架合并：library/*.db（已加工，复用 listBooks 含缓存）∪ books/ 原件（可能仅入库未加工）。
// 每条在 listBooks 字段之上加：
//   status: "processed"（有库）| "raw"（只有原件，等「开始加工」）
//   asset:  resolveAsset 结果（processed 且 asset.exists=false = CLI/旧管线建库无原件）
// raw 条目的 db:null / chunks:0——渲染层据此显示「未加工」，engine 层跳过编目/洗数据摘要。
// 合并判据（不重）：
//   - 正规配对：资产 id（txt→docx 映射后）与库 id 全等（jobs.mjs 命名约定）；
//   - base 兜底：库 id 无扩展/异扩展（CLI/历史命名）时，库的 base 唯一也吞掉该资产——
//     它已由该库条目的 resolveAsset 按扩展兜底顺序挂载，再单列 raw 条目就是同一本书两行。
//     base 对应多个库时保守不吞（宁重复不少）。
export function listShelf(libDir) {
  if (!libDir || !fs.existsSync(libDir)) return [];
  const byId = new Map(listBooks(libDir, { includeDisabled: true }).map((b) => [b.id, { ...b }]));
  const dbBases = new Map();
  for (const id of byId.keys()) {
    const base = path.basename(id, path.extname(id));
    if (!dbBases.has(base)) dbBases.set(base, []);
    dbBases.get(base).push(id);
  }

  const booksDir = booksDirOf(libDir);
  if (fs.existsSync(booksDir)) {
    for (const f of fs.readdirSync(booksDir)) {
      const ext = path.extname(f).toLowerCase();
      if (!ext || !ASSET_EXTS.includes(ext)) continue;
      let st;
      try { st = fs.statSync(path.join(booksDir, f)); } catch { continue; }
      if (!st.isFile()) continue; // 目录（哪怕叫 x.pdf）不是资产
      const base = f.slice(0, -ext.length);
      // 上游中间产物不是书：fetch-wikisource 下载的 <书名>-raw.txt（docs/新书接入验收流程.md），
      // 经 txt2docx 转 <书名>.docx 后才建库——书架显示它会一本变两行
      if (base.endsWith("-raw")) continue;
      // 该原件对应的库 id：txt 建库时转 docx（jobs.mjs EXT_FMT），其余同后缀
      const id = base + (ext === ".txt" ? ".docx" : ext);
      if (byId.has(id)) continue; // 正规配对，合并进它（asset 由统一 resolveAsset 补）
      const sameBase = dbBases.get(base);
      if (sameBase && sameBase.length === 1) continue; // 唯一库同 base：已由 resolveAsset 兜底挂载
      byId.set(id, {
        id, db: null, title: base,
        format: ext === ".txt" ? "txt" : ext.slice(1),
        model: null, chunks: 0, chars: 0, pages: null, chapters: null,
        status: "raw",
      });
    }
  }

  const out = [];
  for (const b of byId.values()) {
    if (b.status !== "raw") b.status = "processed";
    b.asset = resolveAsset(libDir, b.id);
    out.push(b);
  }
  return out;
}
