// 派生文件定位与清除单测（V3 第四波 P5「一体删除」收尾）：
//   覆盖 derivedCandidates（纯定位/闸门）与 purgeDerived（精确删/跳过/容错/dryRun）。
// 攻击面（对应规划 §2.3 S1 七项 + 两项加固）：
//   ① 六项全删  ② 同目录别的 id 与 cli1.json 诱饵零误伤  ③ 非法 id 全拒且零变化
//   ④ 目录/符号链接不删（进 skipped）  ⑤ 缺文件静默跳过  ⑥ dryRun 只列不删
//   ⑦ rmSync 抛错进 failed 且继续删其余  ⑧ 传 ".db" 全名不会误删同名书的派生
// 原则同 shelf-assets-test：纯 fs + tmp，不碰真书库；import assets.mjs 连带 search.mjs，
// 模型懒加载不会真下。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { derivedCandidates, derivedRoot, purgeDerived } = await import("../src/lib/derived.mjs");

let pass = 0, fail = 0, skipped = 0;
const ok = (cond, msg, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} - ${msg}${cond || extra === undefined ? "" : ` | ${extra}`}`);
  cond ? pass++ : fail++;
};
const mkTmp = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-derived-"));
  const lib = path.join(tmp, "library");
  fs.mkdirSync(lib, { recursive: true });
  return { tmp, lib };
};
// 按生产约定在四个派生目录各放一份（six 项全有）
const seedAll = (lib, id) => {
  const root = path.join(lib, "..");
  const dirs = ["catalog-tasks", "catalog-results", "enrich-tasks", "enrich-results"];
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  const files = [
    `catalog-tasks/${id}.json`,
    `catalog-tasks/${id}.prompt.md`,
    `catalog-results/${id}.json`,
    `enrich-tasks/${id}.json`,
    `enrich-results/${id}.json`,
    `enrich-results/${id}.jsonl`,
  ];
  for (const f of files) fs.writeFileSync(path.join(root, f), `内容:${f}`, "utf8");
  return files.map((f) => path.join(root, f));
};

// ---------- §1 纯定位 + 六个落点 ----------
console.log("\n--- §1 定位（不碰文件系统） ---");
{
  const { tmp, lib } = mkTmp();
  const c = derivedCandidates(lib, "d2l-zh.md");
  ok(c.ok === true && c.bookId === "d2l-zh.md", "§1 合法 id → ok:true，bookId 原样");
  ok(c.items.length === 6, `§1 六项候选（实测 ${c.items.length}）`);
  const rel = c.items.map((x) => path.relative(c.root, x.path).replace(/\\/g, "/"));
  const want = [
    "catalog-tasks/d2l-zh.md.json",
    "catalog-tasks/d2l-zh.md.prompt.md",
    "catalog-results/d2l-zh.md.json",
    "enrich-tasks/d2l-zh.md.json",
    "enrich-results/d2l-zh.md.json",
    "enrich-results/d2l-zh.md.jsonl",
  ];
  ok(want.every((w) => rel.includes(w)) && rel.length === 6,
    `§1 六个落点与生产写入方逐字对齐（实测 ${JSON.stringify(rel)}）`);
  // 纯定位：目录都不存在也不报错、不创建
  ok(!fs.existsSync(path.join(c.root, "catalog-tasks")), "§1 纯定位不创建目录（零副作用）");
  ok(derivedRoot(lib) === path.join(lib, ".."), "§1 root = 书库上级（jobs.mjs 同款约定）");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- §2 六项全删 ----------
console.log("\n--- §2 六项全删 ---");
{
  const { tmp, lib } = mkTmp();
  const files = seedAll(lib, "量子力学.md");
  const r = purgeDerived(lib, "量子力学.md");
  ok(r.removedCount === 6 && r.removed.length === 6, `§2 six 项全删（removedCount=${r.removedCount}）`);
  ok(files.every((f) => !fs.existsSync(f)), "§2 磁盘上六项均不存在");
  ok(r.failed.length === 0 && r.skipped.length === 0, "§2 干净路径无 failed / 无 skipped");
  ok(r.rejected === false && r.dryRun === false, "§2 回执结构：rejected/dryRun 明确为 false");
  const again = purgeDerived(lib, "量子力学.md");
  ok(again.removedCount === 0 && again.failed.length === 0, "§2 重复清除幂等（全缺=静默跳过，不算失败）");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- §3 诱饵零误伤 ----------
console.log("\n--- §3 同目录诱饵零误伤 ---");
{
  const { tmp, lib } = mkTmp();
  const root = path.join(lib, "..");
  const mine = seedAll(lib, "book-a.md");
  const others = seedAll(lib, "book-ab.md"); // 前缀相同的另一本书
  fs.writeFileSync(path.join(root, "enrich-tasks", "cli1.json"), "测试残留", "utf8");
  fs.writeFileSync(path.join(root, "enrich-tasks", "cli2.json"), "测试残留", "utf8");
  fs.writeFileSync(path.join(root, "catalog-tasks", "book-a.md.notes.txt"), "私有笔记", "utf8");
  const r = purgeDerived(lib, "book-a.md");
  ok(r.removedCount === 6, `§3 只删自己六项（removedCount=${r.removedCount}）`);
  ok(others.every((f) => fs.existsSync(f)), "§3 前缀同名的另一本书（book-ab.md）一格不动");
  ok(fs.existsSync(path.join(root, "enrich-tasks", "cli1.json"))
    && fs.existsSync(path.join(root, "enrich-tasks", "cli2.json")), "§3 cli1/cli2 测试残留不被前缀匹配误伤");
  ok(fs.existsSync(path.join(root, "catalog-tasks", "book-a.md.notes.txt")), "§3 非候选后缀（notes.txt）不删");
  ok(mine.every((f) => !fs.existsSync(f)), "§3 自己的六项确实清干净");

  // 真·前缀诱饵分支：bookId 就叫 "cli"，而 enrich-tasks/ 里躺着 cli1.json / cli2.json。
  // 前缀匹配实现会把这两个当自己的文件删掉（陆回测 M1 变异实测：
  // removed=['cli.json','cli1.json','cli2.json']，把别人的残留吃了）。
  // 上面 book-a.md vs book-ab.md 其实匹不上（"book-ab.md" 不以 "book-a.md" 开头），
  // 这一组才真正锁得住前缀匹配。
  seedAll(lib, "cli");
  fs.writeFileSync(path.join(root, "enrich-tasks", "cli1.json"), "测试残留", "utf8");
  fs.writeFileSync(path.join(root, "enrich-tasks", "cli2.json"), "测试残留", "utf8");
  const rCli = purgeDerived(lib, "cli");
  ok(rCli.removedCount === 6
    && fs.existsSync(path.join(root, "enrich-tasks", "cli1.json"))
    && fs.existsSync(path.join(root, "enrich-tasks", "cli2.json")),
    `§3 bookId="cli" 时 cli1/cli2 仍不被前缀匹配误伤（真·诱饵分支，removedCount=${rCli.removedCount}）`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- §4 非法 id 全拒、零变化 ----------
console.log("\n--- §4 非法 bookId 闸门 ---");
{
  const { tmp, lib } = mkTmp();
  const keep = seedAll(lib, "victim.md");
  // 首尾空白必须在拒绝名单里：safeBookId 会 trim，归一后拼出的路径属于另一本书
  // （" foo.md" → "foo.md"）。评审对抗官 FAIL-1 的数据丢失路径，这里锁死。
  const badIds = ["", "   ", "..", "../evil", "a/b", "a\\b", "a\u0000b", "x\u001fy",
    " foo.md", "foo.md ", "\tfoo.md", "foo.md\n"];
  // "." 在 POSIX 上是合法文件名（拼出 "..json" 不穿越），只在 win32 被尾点规则拒；
  // 放通用列表会让跨平台 CI 假红（陆回测 OBSERVE-5）
  if (process.platform === "win32") badIds.push("a:b", "a.", "CON", "com1.json", "nul", ".");
  let allRejected = true, noChange = true, allEmpty = true;
  for (const bad of badIds) {
    const c = derivedCandidates(lib, bad);
    if (c.ok !== false) { allRejected = false; console.log(`   ↳ 未拒绝: ${JSON.stringify(bad)}`); }
    if (c.items.length !== 0) allEmpty = false;
    const r = purgeDerived(lib, bad);
    if (r.rejected !== true || r.removedCount !== 0) noChange = false;
  }
  ok(allRejected, `§4 非法 id 全部拒绝（${badIds.length} 种，含 .. / 分隔符 / NUL / 控制符${process.platform === "win32" ? " / 冒号 / 尾点 / 设备名" : ""}）`);
  ok(allEmpty, "§4 非法 id 候选项为空（调用方无从删起）");
  ok(noChange && keep.every((f) => fs.existsSync(f)), "§4 非法 id 调用 purgeDerived 后文件零变化");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- §5 目录与符号链接不删 ----------
console.log("\n--- §5 非普通文件保守跳过 ---");
{
  const { tmp, lib } = mkTmp();
  const root = path.join(lib, "..");
  const files = seedAll(lib, "dir-book.md");
  // 有人手工把 x.json 建成目录
  const dirAsJson = path.join(root, "catalog-results", "dir-book.md.json");
  fs.rmSync(dirAsJson, { force: true });
  fs.mkdirSync(dirAsJson, { recursive: true });
  fs.writeFileSync(path.join(dirAsJson, "inner.txt"), "用户数据，不许递归清空", "utf8");
  const r = purgeDerived(lib, "dir-book.md");
  ok(r.removedCount === 5 && r.skipped.length === 1, `§5 目录不算候选文件（删 5 / 跳过 1，实测 ${r.removedCount}/${r.skipped.length}）`);
  ok(r.skipped[0]?.reason === "dir", `§5 跳过原因标注 dir（实测 ${r.skipped[0]?.reason}）`);
  ok(fs.existsSync(path.join(dirAsJson, "inner.txt")), "§5 目录内容原封不动（未递归删除）");
  ok(r.failed.length === 0, "§5 目录不是失败（是保守跳过）");
  ok(files.filter((f) => f !== dirAsJson).every((f) => !fs.existsSync(f)), "§5 除目录外的五项确实删了");

  // 链接（Windows 用 junction：不需要管理员权限，本机实测 lstat isSymbolicLink=true、
  // isDirectory=false；POSIX 用普通符号链接）。目的：证明 purgeDerived 不跟随链接。
  const linkPath = path.join(root, "enrich-results", "dir-book.md.jsonl");
  let linked = false;
  try {
    if (process.platform === "win32") fs.symlinkSync(dirAsJson, linkPath, "junction");
    else fs.symlinkSync(path.join(dirAsJson, "inner.txt"), linkPath, "file");
    // 能力探测：部分文件系统上 symlinkSync 会静默退化成普通文件（lstat 能识破）
    linked = fs.lstatSync(linkPath).isSymbolicLink();
  } catch { /* 权限不足：跳过 */ }
  if (linked) {
    const r2 = purgeDerived(lib, "dir-book.md");
    ok(r2.skipped.some((s) => s.path === linkPath && s.reason === "not-file"), "§5 符号链接不跟随、不删除（进 skipped）");
    ok(fs.existsSync(linkPath) && fs.existsSync(path.join(dirAsJson, "inner.txt")), "§5 链接与其目标都还在");
  } else {
    skipped++;
    console.log("SKIP - §5 符号链接断言（当前平台无建链权限）");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- §6 缺文件静默跳过 ----------
console.log("\n--- §6 缺文件不报错 ---");
{
  const { tmp, lib } = mkTmp();
  const root = path.join(lib, "..");
  fs.mkdirSync(path.join(root, "catalog-tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "catalog-tasks", "partial.md.json"), "{}", "utf8");
  const r = purgeDerived(lib, "partial.md");
  ok(r.removedCount === 1 && r.failed.length === 0 && r.skipped.length === 0,
    "§6 只有一项时只删一项，其余五项缺失静默跳过（不记 failed）");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- §7 dryRun ----------
console.log("\n--- §7 dryRun 只列不删 ---");
{
  const { tmp, lib } = mkTmp();
  const files = seedAll(lib, "dry.md");
  const r = purgeDerived(lib, "dry.md", { dryRun: true });
  ok(r.dryRun === true && r.wouldRemove.length === 6 && r.removedCount === 0,
    `§7 dryRun 列出 6 项、removedCount=0（实测 ${r.wouldRemove.length}/${r.removedCount}）`);
  ok(files.every((f) => fs.existsSync(f)), "§7 dryRun 后六项全部还在");
  const real = purgeDerived(lib, "dry.md");
  ok(real.removedCount === 6, "§7 随后真删仍然六项（dryRun 无副作用）");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- §8 rmSync 抛错 → failed 且继续删其余 ----------
console.log("\n--- §8 单个失败不中断 ---");
{
  const { tmp, lib } = mkTmp();
  seedAll(lib, "busy.md");
  const realRm = fs.rmSync;
  let hit = 0;
  // derived.mjs 与测试共用同一个 node:fs 默认导出对象，patch 属性对两边同时生效
  fs.rmSync = (p, o) => {
    if (String(p).endsWith("busy.md.prompt.md")) { hit++; throw Object.assign(new Error("被占用"), { code: "EBUSY" }); }
    return realRm(p, o);
  };
  let r;
  try { r = purgeDerived(lib, "busy.md"); }
  finally { fs.rmSync = realRm; }
  ok(hit === 1, "§8 注入点确实被命中一次");
  ok(r.failed.length === 1 && r.failed[0].code === "EBUSY", `§8 EBUSY 进 failed 并带 errno 码（实测 ${r.failed[0]?.code}）`);
  ok(r.removedCount === 5, `§8 其余五项照常删除（不因一项失败中断，removedCount=${r.removedCount}）`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- §9 传 .db 全名不误删 ----------
console.log("\n--- §9 bookId 契约（去 .db） ---");
{
  const { tmp, lib } = mkTmp();
  const files = seedAll(lib, "x.md");
  const r = purgeDerived(lib, "x.md.db"); // 误传了库文件名全名
  ok(r.removedCount === 0, '§9 传 ".db" 全名不匹配任何派生文件（精确拼接，不做模糊匹配）');
  ok(files.every((f) => fs.existsSync(f)), "§9 真书的六项未被误删（契约写进注释与回执 bookId）");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- §10 libDir 护栏（fail-open 防御） ----------
console.log("\n--- §10 空 libDir 不许 fail-open ---");
{
  // 空串会让 root 退化成 ".."（进程 cwd 的上级）——那是删到项目外面去。
  // 这里断言「宁可什么都不做，也不许猜一个目录」。
  const emptyC = derivedCandidates("", "x.md");
  ok(emptyC.ok === false && emptyC.items.length === 0, "§10 空 libDir → 拒绝定位（不退化成 cwd 上级）");
  const emptyP = purgeDerived("", "x.md");
  ok(emptyP.rejected === true && emptyP.removedCount === 0, "§10 空 libDir 调 purge → rejected，零删除");
  const nullP = purgeDerived(null, "x.md", null);
  ok(nullP.rejected === true && nullP.removedCount === 0, "§10 null libDir + null opts → 不抛错、零删除");
  const numP = purgeDerived(12345, "x.md");
  ok(numP.rejected === true && numP.removedCount === 0, "§10 非字符串 libDir → rejected（不做隐式转字符串）");
}

// ---------- §11 兄弟书保护（前导空白绝不归一） ----------
console.log("\n--- §11 近似书名不许点到兄弟书 ---");
{
  const { tmp, lib } = mkTmp();
  const sibling = seedAll(lib, "foo.md");       // 正常那本
  const spaced = seedAll(lib, " foo.md");       // 前导空格的另一本（raw 卡的 id 形状）
  const a = purgeDerived(lib, " foo.md");
  ok(a.rejected === true && a.removedCount === 0, "§11 前导空白 id → rejected（safeBookId 归一会拼到 foo.md）");
  ok(sibling.every((f) => fs.existsSync(f)), "§11 隔壁 foo.md 的六项一格不动（数据丢失路径堵死）");
  ok(spaced.every((f) => fs.existsSync(f)), "§11 被拒的请求零副作用（自己那六项也没删）");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log();
console.log(`===== derived-test: ${pass} pass / ${fail} fail${skipped ? ` / ${skipped} skip` : ""} =====`);process.exit(fail ? 1 : 0);
