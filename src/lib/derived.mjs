// 派生文件定位与清除（V3 第四波 P5「一体删除」收尾）：
//   一本「书」散落在六处：library/<id>.db（本体）+ 四个派生目录里的六个文件。
//   彻底删除对用户的承诺是「这本书的一切」，但历史实现只清库 + books/ 原件 +
//   开关记录，编目任务书/结果、洗数据任务书/产物全留盘（实测真库四个目录共
//   45 项）——承诺名不副实。本模块是该承诺的**唯一定位与删除出口**。
// 铁律：
//   - bookId 先过 safeBookId（assets.mjs 单一真源）：不合法直接返回空结果，
//     一个文件都不碰——不在这里另写一套闸门（两套闸门必然漂移）。
//   - 文件名只按候选表**精确拼接**，绝不 glob、绝不前缀匹配：enrich-tasks/ 里
//     躺着 cli1.json / cli2.json 这类测试残留，若按 bookId 前缀匹配（id="cli"）
//     会连别人的文件一起删。
//   - 只删**单个普通文件**：禁止 recursive、禁止删目录；目录与符号链接一律
//     跳过并留痕（目录名可能被用户手工改成 x.json，删它等于删用户数据）。
//   - 不 throw：单个失败进 failed，继续删其余。与 skill 开关清理同款理由——
//     删书主体已是既成事实，派生残留最多是尾巴，不该把成功变成报错。
// 「移出书架」（engine.deleteBook）**明确不调本模块**：原件还在、重建后块号
// 可复用，派生留着能省一次云端洗数据的钱（老板 2026-10-18 拍板）。
import fs from "node:fs";
import path from "node:path";
import { safeBookId } from "./assets.mjs";

// 六个落点。kind 是回执/日志里给人看的标签；dir + bookId + suffix 即磁盘路径。
// 与生产写入方逐一对齐（guard-test 第 15 节锁这些字面量，改一处必须同步两处）：
//   catalog-tasks/<id>.json        jobs.mjs「编目任务书」
//   catalog-tasks/<id>.prompt.md   jobs.mjs「导出提示词」
//   catalog-results/<id>.json      jobs.mjs「智能体产出的编目结果」
//   enrich-tasks/<id>.json         enrich-book.mjs --export「洗数据任务书」
//   enrich-results/<id>.json       enrich.mjs enrichArtifactPath「洗数据产物」
//   enrich-results/<id>.jsonl      enrich.mjs enrichResultPath「洗数据缓存（断点续跑）」
const DERIVED = [
  { kind: "编目任务书", dir: "catalog-tasks", suffix: ".json" },
  { kind: "编目提示词", dir: "catalog-tasks", suffix: ".prompt.md" },
  { kind: "编目结果", dir: "catalog-results", suffix: ".json" },
  { kind: "洗数据任务书", dir: "enrich-tasks", suffix: ".json" },
  { kind: "洗数据产物", dir: "enrich-results", suffix: ".json" },
  { kind: "洗数据缓存", dir: "enrich-results", suffix: ".jsonl" },
];

// 派生目录根 = 书库目录的上级（jobs.mjs jobDirs / enrich-job.mjs resultsDirOf 同款约定：
// 任务书与产物紧挨书库放，迁库一起走）。
export function derivedRoot(libDir) {
  return path.join(String(libDir || ""), "..");
}

// 纯定位，不碰文件系统：返回六项候选路径 + 是否被闸门放行。
// id 或 libDir 不合法 → ok:false / items:[]（调用方据此一个文件都不删）。
// libDir 必须显式给：空串会让 derivedRoot 退化成 ".."，指向进程 cwd 的上级——
// 那是 fail-open（删到项目外面去），必须在这里拦死，不能指望上游 currentLibDir 永远有值。
// 注意 bookId 是**库文件名去掉 .db**（"d2l-zh.md"），不是原件名也不是书名。
export function derivedCandidates(libDir, bookId) {
  const raw = typeof libDir === "string" ? libDir : "";
  const root = raw ? derivedRoot(raw) : "";
  const id = safeBookId(bookId);
  const asked = String(bookId ?? "");
  // 拒绝「需要静默归一的输入」：safeBookId 会 trim，若结果与输入不同（" foo.docx"
  // → "foo.docx"），说明这个名字带首尾空白——按归一结果去拼路径就会删到另一本书的
  // 派生文件（评审对抗官 FAIL-1 的数据丢失路径）。宁可 rejected，不猜。
  if (!raw || !id || id !== asked) {
    return { ok: false, bookId: null, input: asked, root, items: [] };
  }
  return {
    ok: true,
    bookId: id,
    root,
    items: DERIVED.map((d) => ({
      kind: d.kind,
      path: path.join(root, d.dir, id + d.suffix),
    })),
  };
}

// 定位 + 清除。返回结构恒定（调用方不用判空）：
//   removed      已删除的项（kind/path）
//   skipped      存在但不是普通文件（目录/符号链接），保守不动
//   failed       删不掉的项（code=errno）
//   wouldRemove  dryRun 模式下「本会删掉」的项
//   removedCount  removed.length
// dryRun:true 只列不删（真库只读验收用）。
export function purgeDerived(libDir, bookId, opts) {
  const o = opts || {};
  const dryRun = o.dryRun === true;
  const cand = derivedCandidates(libDir, bookId);
  const out = {
    bookId: cand.bookId,
    input: cand.input ?? String(bookId ?? ""),
    root: cand.root,
    rejected: !cand.ok,
    dryRun,
    removed: [],
    skipped: [],
    failed: [],
    wouldRemove: [],
    removedCount: 0,
  };
  if (!cand.ok) return out;
  for (const it of cand.items) {
    let st;
    try {
      // lstat 不跟随符号链接：链接本身不是「我们的文件」，跟随只会误伤目标
      st = fs.lstatSync(it.path);
    } catch (e) {
      if (e.code === "ENOENT") continue; // 没有这项=这本没跑过该阶段，正常
      out.failed.push({ ...it, code: e.code || "?" });
      continue;
    }
    if (!st.isFile()) {
      out.skipped.push({ ...it, reason: st.isDirectory() ? "dir" : "not-file" });
      continue;
    }
    if (dryRun) {
      out.wouldRemove.push({ ...it });
      continue;
    }
    try {
      // force:true 让「检查后被别人删掉」的竞态不抛；不带 recursive——
      // 即使上面 lstat 判断被绕过，删目录也会因缺 recursive 而失败，不会递归清空
      fs.rmSync(it.path, { force: true });
      out.removed.push({ ...it });
    } catch (e) {
      out.failed.push({ ...it, code: e.code || "?" });
    }
  }
  out.removedCount = out.removed.length;
  return out;
}
