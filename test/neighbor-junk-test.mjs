// 问题5 守卫（gate7 脏块红修）：邻块默认开曾把形态脏块/非 text 邻块扩进答案上下文
// （脏块率 0.0031→0.0059）。本测试钉：① 形态 JUNK 邻块不扩；② kind!=text 邻块不扩；
// ③ formDirtyOf 与 quality-gate 同一把尺子（JUNK 7 条+长度门槛）。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { formDirtyOf } = await import("../src/lib/junk.mjs");
const { hybridSearch } = await import("../src/lib/search.mjs");
const buildBook = await import("../src/build-book.js");

// 单元：JUNK 判据
assert.strictEqual(formDirtyOf("12"), "page_number");
assert.strictEqual(formDirtyOf("Page 3 of 10"), "page_number");
assert.strictEqual(formDirtyOf("© 2020 ACM"), "copyright_line");
assert.strictEqual(formDirtyOf("------"), "separator");
assert.strictEqual(formDirtyOf("这里补足正文长度以免被切片器合并，讲的是数组的连续内存布局与索引寻址方式。"), null);
assert.strictEqual(formDirtyOf(""), null);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nbrjunk-"));
const FILLER = "这里补足正文长度以免被切片器合并，讲的是数组的连续内存布局与索引寻址方式，数组下标从零开始，越界访问属于未定义行为。";
const para = (kw) => `${kw}段落独特词在这里。${FILLER.repeat(4)}`;
const md = `# 数组\n\n${para("苹果")}\n\n${para("香蕉")}\n\n${para("樱桃")}\n\n${para("蜜桃")}\n\n${para("柠檬")}\n\n${para("西瓜")}\n`;
const mdPath = path.join(TMP, "j.md");
fs.writeFileSync(mdPath, md, "utf8");
const dbPath = path.join(TMP, "j.md.db");
{
  const keep = process.exitCode; const oe = console.error, ol = console.log;
  console.error = () => {}; console.log = () => {};
  try { await buildBook.main([mdPath, "-o", dbPath, "--force", "--title", "j"]); } finally { console.error = oe; console.log = ol; process.exitCode = keep; }
}
{
  const w = new Database(dbPath);
  w.prepare("UPDATE chunks SET chapter='数组', chapter_path='数组'").run();
  w.close();
}
const ro = new Database(dbPath, { readonly: true });
const seed = ro.prepare("SELECT id FROM chunks WHERE text LIKE '%樱桃%'").get().id;
ro.close();

// case1: 同章邻块文本改成形态 JUNK（kind 仍 text）→ 不得扩入
{
  const w = new Database(dbPath);
  w.prepare("UPDATE chunks SET text='12', kind='text' WHERE id=?").run(seed + 1);
  w.close();
  const rs = await hybridSearch(dbPath, "樱桃独特词", 3);
  assert.ok(!rs.some(r => r.nbr !== undefined && r.text.trim() === "12"), "形态 JUNK 邻块不得扩入答案上下文");
}
// case2: 同章邻块 kind=ref → 不得扩入
{
  const w = new Database(dbPath);
  w.prepare("UPDATE chunks SET text=?, kind='ref' WHERE id=?").run(para("蜜桃"), seed + 1);
  w.close();
  const rs = await hybridSearch(dbPath, "樱桃独特词", 3);
  assert.ok(!rs.some(r => r.nbr !== undefined && r.id === seed + 1), "kind!=text 邻块不得扩入");
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log("neighbor-junk-test: PASS");