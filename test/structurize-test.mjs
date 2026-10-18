// V3 第四波 P2 结构化改造验收：清洗坏数据/不全数据/乱码符号（解析后、切片前）。
// 两层：① lib/structurize.mjs 单元层（纯函数，零依赖）；② build-book.main 集成层
//   （运行时生成 md 夹具真跑建库，验 meta.struct_report 账、库内文本、开关与硬拦）。
// 铁律验证重点：干净的书零变化（BSP_STRUCT=1 与 =0 两次建库逐字节一致）。
// 挂载：test:fast（纯文本无模型；实测 <10s）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { TextDecoder } from "node:util";

const require = createRequire(import.meta.url);
const buildBook = require("../src/build-book.js");
const Database = require("better-sqlite3");
const { detectGarbled, repairMojibake, structurizeChunks, assessCleaned, structChanged } =
  await import("../src/lib/structurize.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-struct-"));
let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

// 经典双重编码样本：中文+拉丁的 UTF-8 被当 Latin-1 解出来的人身
const PROPER = "子曰学而时习之不亦说乎有朋自远方来不亦乐乎 café naïve résumé";
const MOJI = Buffer.from(PROPER, "utf8").toString("latin1");
// 集成层专用样本，讲究「字节安全」：parseMd 的 collapse 会把 \u00a0 规范化成
// 空格（检索质量设计——NBSP 不该进索引），而双重编码文本里的 \u00a0 是数据
// 字节（「习」=E4B9A0），被规范化后字节序列损坏，repairMojibake 按设计保守
// 拒绝（回读含 U+FFFD）。故集成夹具挑 UTF-8 字节不含 A0/85 的句子，让「能修
// 的修好」真跑通；「字节被篡改所以不修」的对抗场景在同节末尾单验。
// 单元层（①~④）不经过解析器，用原版 PROPER/MOJI。
const I_PROPER = "有朋自远方来不亦乐乎千里之行始于足下 café naïve résumé";
const I_MOJI = Buffer.from(I_PROPER, "utf8").toString("latin1");
// cp1252 人身（G-05）：UTF-8 的 E2 80 99（U+2019 撇号）被当 cp1252 解成 â€™——
// 英文书里 it's/don't 全变它，是现实最高发的 mojibake 之一，旧签名表 100% 漏检
const AP = "\u00e2\u20ac\u2122";
const EN_MOJI = `It${AP}s a bright cold day in April, and don${AP}t forget the clocks.`;

// ================== ① 单元层 ==================
console.log("===== 1) detectGarbled 四类乱码体检 =====");
{
  const clean = detectGarbled("學而時習之不亦說乎");
  assert(clean.bad === 0 && clean.ratio === 0, `干净中文零乱码（bad=${clean.bad}）`);
  const c = detectGarbled("正常\u0000文本\u007f结束");
  assert(c.controls === 2, `控制符计数（NUL+DEL，实测 ${c.controls}）`);
  const p = detectGarbled("图标\ue000字体\uf8ff残留");
  assert(p.pua === 2, `私用区计数（实测 ${p.pua}）`);
  const f = detectGarbled("缺字节\ufffd占位\ufffd符");
  assert(f.fffd === 2, `替换符计数（实测 ${f.fffd}）`);
  const m = detectGarbled(MOJI);
  assert(m.mojibake >= 2, `双重编码签名计数（实测 ${m.mojibake}）`);
  assert(detectGarbled("Voilà le café déjà vu").bad === 0, "正常法文重音字符不是乱码（Ã 签名不误伤）");
  // 钉子：签名按实测字符数计费——五个 2 字符分支（Ã©/Â/å/æ/è）与
  // â‚¬ 三重分支各行其道，防未来改动把 2 字符分支误按 3 字符估（误伤干净书）
  const two = "\u00c3\u00a9".repeat(10);
  assert(detectGarbled(two).bad === 20, `2 字符签名 bad=2N=20（实测 ${detectGarbled(two).bad}）`);
  const three = "\u00e2\u20ac\u201c".repeat(10);
  assert(detectGarbled(three).bad === 30, `3 字符签名 bad=3N=30（实测 ${detectGarbled(three).bad}）`);
  // G-05：cp1252 特俗字符域补齐——â€™（撇号）、E2 84/E2 98/E2 9C 打头的整族
  // （™ ✓ ★）与 E4 打头的中文序列都必须检出。这里用 TextDecoder 造**真人身**：
  // Buffer.toString("latin1") 只做码位直通，产不出 € „ œ，验不到 cp1252 那条路。
  const cp1252 = (t) => new TextDecoder("windows-1252").decode(Buffer.from(t, "utf8"));
  const ap = detectGarbled(AP.repeat(10));
  assert(ap.mojibake === 10 && ap.bad === 30, `cp1252 撇号乱码 â€™ 检出（签名 ${ap.mojibake}，bad ${ap.bad}）`);
  const fam = [["™", cp1252("™™")], ["✓", cp1252("✓✓")], ["★", cp1252("★★")], ["€", cp1252("€€")]];
  const miss = fam.filter(([, s]) => detectGarbled(s).mojibake < 2).map(([n]) => n);
  assert(miss.length === 0, `E2 84/98/9C 打头的 cp1252 人身整族检出（漏：${miss.join("") || "无"}）`);
  // E4 分支的夹具必须是「只有 E4 打头」的字（中= E4B8AD）：拿「中国人民」会混进
  // E5(国)/E6(民)，旧代码本来就命中 ≥2，断言等于没锁（陆 F1 实测坐实）
  const e4 = Buffer.from("中中中中", "utf8").toString("latin1");
  assert(detectGarbled(e4).mojibake === 4, `E4 打头的中文双重编码检出（签名 ${detectGarbled(e4).mojibake}，旧代码 0）`);
  // G-06：bad 按并集算——`Ã` + U+009F（C1 控制符，latin1 路的第二字节）同时落在
  // mojibake 域与 CONTROL_RE 域，分类求和会得 3N/2N = ratio 1.5（不可审计）；
  // 并集恒等于文本长度。注：真 Ÿ(U+0178) 不落 C1，各行其道（毛 O7）
  const dup = "\u00c3\u009f".repeat(50);
  const g = detectGarbled(dup);
  assert(g.mojibake === 50 && g.controls === 50, `交叠字符两分类都计（${g.mojibake}/${g.controls}）`);
  assert(g.bad === dup.length && g.ratio === 1, `bad 并集去重 = 文本长度 ${dup.length}、ratio 封顶 1（实测 bad=${g.bad} ratio=${g.ratio}）`);
}

console.log("===== 2) repairMojibake 保守修复 =====");
{
  const fix = repairMojibake(MOJI);
  assert(fix.repaired && fix.text === PROPER, "经典双重编码整块修回原文");
  const mixed = "正常中文混在里面" + MOJI;
  assert(repairMojibake(mixed).repaired === false, "混正常中文的块不修（>0xff 字符保守闸门）");
  const bad = "â€œâ€ Quote broken \ud800";
  assert(repairMojibake(bad).repaired === false, "回读不是合法 UTF-8 的不修（孤立代理对）");
  assert(repairMojibake("只有一处 é 签名").repaired === false, "签名数 <2 不修（防误伤）");
  // G-05：cp1252 人身要真修得回来（不是「见乱码就拦」）——查表还原原字节再解码
  const en = repairMojibake(EN_MOJI);
  assert(en.repaired && en.text.includes("It\u2019s") && !en.text.includes(AP),
    "cp1252 撇号修回真撇号 U+2019（查表还原字节，不用 latin1 硬转）");
  // 混了「真正的弯引号」（>0xFF 且不在 cp1252 表）→ 保守拒修，绝不猜
  assert(repairMojibake(EN_MOJI + " \u201cquote\u201d").repaired === false,
    "混真弯引号拒修（宁可留下不修，不可把好文本修坏）");
  // 毛 F2 回归锁：句子**别处**的 cp1252 特俗字符不许查表——它们对应的字节全在
  // 0x80~0x9F（续字节区），放行就会和前面的前导字符合成「合法但错误」的 UTF-8。
  // 实测旧写法把这段干净意大利文修成含生僻字「蠅」的垃圾，report 还记成清洗成果。
  const it = "Non \u00e8\u00a0\u2026 ma non \u00e8\u00a0\u2026 possibile capire il testo.";
  const itFix = repairMojibake(it);
  assert(itFix.repaired === false && itFix.text === it,
    "跨度外的特俗字符（… ）拒修（F2：不把好文本修成合法垃圾）");
  // 毛 F3 规模锁：跨度查找必须是游标（摊还 O(n)）。退回 spans.some() 会变 O(n·k)：
  // 10 万字符整本人身实测 3 秒+，而 txt2docx「一行一段」正好会把无换行的整本书
  // 变成 1 块送进来——加工横幅会卡在「结构化改造中」且取消拦不住。
  // 夹具必须**稠密**（陆 F1'）：some() 的代价是 O(k²)，k 是签名个数不是字符数。
  // 英文散文只坏撇号（密度 3%）时 k 太小，退回 some() 也只要 37ms——锁形同虚设。
  // 这里每 6 字符 2 个签名（33% 密度）：游标 ≈20ms，some() 实测 2.9s，阈值才有区分力
  const LD = "\u00e2\u20ac\u0153"; // “ 的 cp1252 人身（E2 80 9C → â€œ）
  const RD = "\u00e2\u20ac\u009d"; // ” 的 cp1252 人身（0x9D 在 cp1252 无定义，留 C1）
  const big = `a${LD}b${RD}`.repeat(32000); // ≈ 25.6 万字符（some() 实测 4.7s，游标 26ms）
  const t0 = Date.now();
  const bigFix = repairMojibake(big);
  const dt = Date.now() - t0;
  assert(bigFix.repaired && dt < 500,
    `25 万字符人身修复不退化（${dt}ms < 500ms，游标摊还 O(n)；二次实现实测 5s+）`);
  // 纯撇号串没有文字证据 → 「回读含文字」闸门拒（与 French é 警戒同款）
  assert(repairMojibake(AP.repeat(3)).repaired === false, "纯符号人身拒修（回读无字母/汉字证据）");
}

console.log("===== 3) structurizeChunks 清洗通道 =====");
{
  const clean = structurizeChunks([
    { id: 1, chapter: "一", page: 1, text: "學而時習之不亦說乎" },
    { id: 2, chapter: "一", page: 1, text: "有朋自遠方來不亦樂乎" },
  ]);
  assert(clean.chunks.length === 2 && !structChanged(clean.report), "干净块零变化（存量铁律：report 全零）");
  assert(clean.chunks[0].text === "學而時習之不亦說乎", "干净块逐字节原样");

  const dirty = structurizeChunks([
    { id: 1, text: MOJI },
    { id: 2, text: "   " },
    { id: 3, text: "123 | 456 | 789" },
    { id: 4, text: "控制\u0000符\u007f私用\ue000替换\ufffd混合文本" },
    { id: 5, text: "\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd" },
  ]);
  assert(dirty.report.repairedMojibake === 1 && dirty.chunks[0].text === PROPER, "乱码块修回原文");
  assert(dirty.report.droppedEmpty === 1, "空块丢（实测 " + dirty.report.droppedEmpty + "）");
  assert(dirty.report.droppedGarbage === 2, "纯数字符号块 + 乱码过半块丢（实测 " + dirty.report.droppedGarbage + "）");
  assert(dirty.report.strippedControls === 2 && dirty.report.strippedPua === 1 && dirty.report.strippedFffd === 1,
    `控制符/私用区/替换符分别清（${dirty.report.strippedControls}/${dirty.report.strippedPua}/${dirty.report.strippedFffd}）`);
  assert(dirty.chunks[1].text === "控制符私用替换混合文本", "清完符号文字完好");
  assert(dirty.report.kept === 2, `活下来的块数对（${dirty.report.kept}：修好的+清完符号的）`);
}

console.log("===== 4) assessCleaned 硬闸门（修不动的才拦） =====");
{
  const g0 = assessCleaned([], { droppedGarbage: 5 });
  assert(!g0.ok && /结构化改造后 0 块/.test(g0.reason), "洗完全丢 → 拦（扫描图/加密文档）");
  const g1 = assessCleaned([{ text: "太短" }]);
  assert(!g1.ok && /内容太少/.test(g1.reason), "内容太少 → 拦");
  const junkText = "\ufffd".repeat(30) + "a";
  const junk = structurizeChunks([{ text: junkText }]);
  const g2 = assessCleaned(junk.chunks, junk.report);
  assert(!g2.ok, "修不动的纯乱码 → 拦（不进切片）");
  const rep = structurizeChunks([{ text: MOJI }, { text: MOJI }]);
  const g3 = assessCleaned(rep.chunks, rep.report);
  assert(g3.ok === false && /内容太少/.test(g3.reason), "整份双重编码修得动——本例只是样本太短，非乱码拦（说清楚是内容少）");
  const big = structurizeChunks([{ text: MOJI + MOJI + MOJI + MOJI }]);
  assert(assessCleaned(big.chunks, big.report).ok, "够长的双重编码文件修完放过（不清洗完还拦）");
}

// ================== ② 集成层（build-book.main 真跑） ==================
console.log("===== 5) md 夹具真跑：乱码行被修、账进 meta =====");
{
  const body = [
    "# 检测总则",
    "",
    "本章说明结构化改造的清洗范围与判定标准，供验收对照。",
    "",
    I_MOJI,
    "",
    "控制\u0000符与私用\ue000区字符混在正文里，应当被清掉但不伤文字。",
    "",
    "## 附则",
    "",
    "验收通过的标准是账实相符：报告里的每一项都能在库内文本里对上。",
  ].join("\n");
  const f = path.join(TMP, "struct-dirty.md");
  fs.writeFileSync(f, body, "utf8");
  const out = path.join(TMP, "struct-dirty.db");
  const cap = [];
  const keepExit = process.exitCode;
  const oe = console.error, ol = console.log;
  console.error = (...a) => cap.push(a.map(String).join(" "));
  console.log = (...a) => cap.push(a.map(String).join(" "));
  let r;
  try { r = await buildBook.main([f, "-o", out]); }
  finally { console.error = oe; console.log = ol; process.exitCode = keepExit; }
  assert(!!r, "脏 md 建库成功（清洗是内部通道，不是失败）");
  const db = new Database(out, { readonly: true });
  const rows = db.prepare("SELECT text FROM chunks ORDER BY id").all().map(x => x.text);
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(x => [x.key, x.value]));
  db.close();
  const rep = JSON.parse(meta.struct_report || "{}");
  assert(rep.repairedMojibake >= 1, `meta.struct_report 记了修乱码（${rep.repairedMojibake} 块）`);
  assert(rows.some(t => t.includes("有朋自远方来")), "库内文本是修好的中文（不是乱码字节）");
  // eslint-disable-next-line no-control-regex -- 断言「库内无残留」必须显式匹配控制符
  assert(rows.every(t => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ue000-\uf8ff\ufffd]/.test(t)),
    "库内无控制符/私用区/替换符残留");
  assert(/结构化改造: 去空块/.test(cap.join(" / ")), "控制台明示清洗账（不静默）");

  // 对抗子案：字节被 collapse 篡改过的双重编码（原版 MOJI 含 A0 数据字节）。
  // 修不动 → 不乱码 majority 按垃圾整块丢——绝不把损坏字节「修」成另一堆乱码进库。
  const filler = "对抗样本的陪衬段落，唯一任务是让全文越过内容下限，好单独考察上面那一坨乱码的去向：它应当被整体丢弃，而不是被修成另一堆乱码混进库。再补几句凑长度，确保硬闸门不会因为陪衬太少而误拦——这段话与结构化改造的判定无关，只是为了在数值上满足全文下限，让测试聚焦在乱码块的去向上，而不是被内容太少的拦闸抢走主题。";
  const body2 = ["# 篡改样本", "", MOJI, "", filler].join("\n");
  const f2 = path.join(TMP, "struct-tampered.md");
  fs.writeFileSync(f2, body2, "utf8");
  const out2 = path.join(TMP, "struct-tampered.db");
  const cap2 = [];
  const keepExit2 = process.exitCode;
  const oe2 = console.error, ol2 = console.log;
  console.error = (...a) => cap2.push(a.map(String).join(" "));
  console.log = (...a) => cap2.push(a.map(String).join(" "));
  let r2;
  try { r2 = await buildBook.main([f2, "-o", out2]); }
  finally { console.error = oe2; console.log = ol2; process.exitCode = keepExit2; }
  assert(!!r2, "含篡改乱码块的文件仍建库成功（坏块丢，不是整文件拦）");
  const db2 = new Database(out2, { readonly: true });
  const rows2 = db2.prepare("SELECT text FROM chunks ORDER BY id").all().map(x => x.text);
  const meta2 = Object.fromEntries(db2.prepare("SELECT key,value FROM meta").all().map(x => [x.key, x.value]));
  db2.close();
  const rep2 = JSON.parse(meta2.struct_report || "{}");
  assert(rep2.repairedMojibake === 0, `字节被篡改的双重编码修不动（实测修了 ${rep2.repairedMojibake} 块）`);
  assert(rep2.droppedGarbage >= 1, `篡改乱码块按垃圾丢（${rep2.droppedGarbage} 块）`);
  assert(rows2.some(t => t.includes("陪衬")), "陪衬正文健在（丢的是乱码块，不是全文）");
}

// 5b) G-05 集成层：cp1252 人身（â€™）的英文书真跑——修得回来才叫清洗，
// 只检出不放行等于「见乱码就拦」。夹具纯英文：混进汉字会让整块撞「表外字符」
// 保守闸门（那是设计如此，见第 2 节混排拒修用例）。
console.log("===== 5b) cp1252 撇号英文书真跑：修好入库 =====");
{
  const body = ["# Chapter One", "", EN_MOJI, "", EN_MOJI, "", EN_MOJI].join("\n");
  const f = path.join(TMP, "struct-cp1252.md");
  fs.writeFileSync(f, body, "utf8");
  const out = path.join(TMP, "struct-cp1252.db");
  const cap = [];
  const keepExit = process.exitCode;
  const oe = console.error, ol = console.log;
  console.error = (...a) => cap.push(a.map(String).join(" "));
  console.log = (...a) => cap.push(a.map(String).join(" "));
  let r;
  try { r = await buildBook.main([f, "-o", out]); }
  finally { console.error = oe; console.log = ol; process.exitCode = keepExit; }
  assert(!!r && fs.existsSync(out), "cp1252 乱码英文书建库成功（不是硬拦）");
  const db = new Database(out, { readonly: true });
  const rows = db.prepare("SELECT text FROM chunks ORDER BY id").all().map(x => x.text);
  db.close();
  assert(rows.some(t => t.includes("It\u2019s a bright")), "库内文本是修好的英文（真撇号 U+2019）");
  assert(rows.every(t => !t.includes(AP)), "库内无 â€™ 人身残留");
}

console.log("===== 6) BSP_STRUCT=0 开关：整段跳过，文本原样 =====");
{
  const body = ["# 开关测试", "", I_MOJI, "", "附则内容凑长度，验证开关关掉时不清洗也不拦。"].join("\n");
  const f = path.join(TMP, "struct-off.md");
  fs.writeFileSync(f, body, "utf8");
  const out = path.join(TMP, "struct-off.db");
  const cap = [];
  const keepExit = process.exitCode;
  const oe = console.error, ol = console.log;
  console.error = (...a) => cap.push(a.map(String).join(" "));
  console.log = (...a) => cap.push(a.map(String).join(" "));
  const prev = process.env.BSP_STRUCT;
  process.env.BSP_STRUCT = "0";
  let r;
  try { r = await buildBook.main([f, "-o", out]); }
  finally { console.error = oe; console.log = ol; if (prev === undefined) delete process.env.BSP_STRUCT; else process.env.BSP_STRUCT = prev; process.exitCode = keepExit; }
  assert(!!r, "关开关也建库成功（排障通道）");
  const db = new Database(out, { readonly: true });
  const rows = db.prepare("SELECT text FROM chunks ORDER BY id").all().map(x => x.text);
  const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(x => [x.key, x.value]));
  db.close();
  assert(!meta.struct_report, "关开关不写 struct_report（meta 干净）");
  assert(rows.some(t => t.includes(I_MOJI)), "关开关文本原样（双重编码字节整串穿透，不清洗）");
}

console.log("===== 7) 干净语料零变化：STRUCT=1 与 =0 两次建库逐字节一致 =====");
{
  const body = ["# 学而第一", "", "子曰：学而时习之，不亦说乎？有朋自远方来，不亦乐乎？", "", "## 释义", "", "本章讲治学与交友之乐，是全书首章。先贤以为，读书贵在时时温习，温故而知新，每读一遍皆有一遍之得；交友贵在切磋砥砺，远方朋友来访，正可以道义相磨，故曰不亦乐乎。此章为开宗明义第一篇，定下全书基调：内以治身，外以交友，终归于心悦。"].join("\n");
  const f = path.join(TMP, "struct-clean.md");
  fs.writeFileSync(f, body, "utf8");
  const buildWith = async (flag) => {
    const out = path.join(TMP, `struct-clean-${flag}.db`);
    const keepExit = process.exitCode;
    const prev = process.env.BSP_STRUCT;
    if (flag) process.env.BSP_STRUCT = flag;
    const oe = console.error, ol = console.log;
    console.error = () => {}; console.log = () => {};
    try { return await buildBook.main([f, "-o", out]); }
    finally {
      console.error = oe; console.log = ol;
      if (prev === undefined) delete process.env.BSP_STRUCT; else process.env.BSP_STRUCT = prev;
      process.exitCode = keepExit;
    }
  };
  const rOn = await buildWith("1");
  const rOff = await buildWith("0");
  assert(!!rOn && !!rOff, "两种开关都建库成功");
  const read = (p) => {
    const db = new Database(p, { readonly: true });
    const rows = db.prepare("SELECT text FROM chunks ORDER BY id").all().map(x => x.text);
    const meta = Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(x => [x.key, x.value]));
    db.close();
    return { rows, meta };
  };
  const on = read(path.join(TMP, "struct-clean-1.db"));
  const off = read(path.join(TMP, "struct-clean-0.db"));
  assert(JSON.stringify(on.rows) === JSON.stringify(off.rows),
    `干净语料块文本逐字节一致（开 ${on.rows.length} 块 / 关 ${off.rows.length} 块）`);
  assert(JSON.stringify(JSON.parse(on.meta.struct_report || "{}")) === JSON.stringify({ total: off.rows.length, droppedEmpty: 0, droppedGarbage: 0, repairedMojibake: 0, strippedControls: 0, strippedPua: 0, strippedFffd: 0, strippedSurrogates: 0, kept: off.rows.length }),
    "干净语料 struct_report 全零（铁律：零变化可审计）");

  // 毛 O6：恒等对拍必须覆盖本轮新增的字符域。上面那本书是纯中文，一个字节都碰不到
  // ä/å/æ/è 与 cp1252 特俗字符（€ „ œ ’ ™ …）——等于没验新的误伤面。
  // 这本拉丁混排书专攻它：德语变音、法语 « » 与 SHY 断字（co­opération）、° © ™、ç é。
  // 注意：report 全零 + 逐字节一致看不见「只抬 bad」的误伤（G-12 的 ä+SHY 就是这种），
  // 故下面另加一条 detectGarbled 零签名的直接判据（毛 O-1 实测坐实）
  const latinBody = [
    "# Reinheit der Sprache",
    "",
    "Die Aufgabe erklären zu können ist wichtig, und die Prüfung bleibt verständlich.",
    "",
    "Français : « déjà vu », naïve, résumé, 35 °C, © 2026, marque ™, co\u00adopération, garçon.",
    "",
    "Svenska: ångström, smörgås; Dansk: blåbær, æble; Deutsch: Straße, Öl, über.",
  ].join("\n");
  const fL = path.join(TMP, "struct-clean-latin.md");
  fs.writeFileSync(fL, latinBody, "utf8");
  const buildLatin = async (flag) => {
    const out = path.join(TMP, `struct-clean-latin-${flag}.db`);
    const keepExit = process.exitCode;
    const prev = process.env.BSP_STRUCT;
    if (flag) process.env.BSP_STRUCT = flag;
    const oe = console.error, ol = console.log;
    console.error = () => {}; console.log = () => {};
    try { return await buildBook.main([fL, "-o", out]); }
    finally {
      console.error = oe; console.log = ol;
      if (prev === undefined) delete process.env.BSP_STRUCT; else process.env.BSP_STRUCT = prev;
      process.exitCode = keepExit;
    }
  };
  const lOn = await buildLatin("1");
  const lOff = await buildLatin("0");
  const lonR = read(path.join(TMP, "struct-clean-latin-1.db"));
  const loffR = read(path.join(TMP, "struct-clean-latin-0.db"));
  assert(!!lOn && !!lOff && JSON.stringify(lonR.rows) === JSON.stringify(loffR.rows),
    `拉丁混排干净书零变化（开 ${lonR.rows.length} 块 / 关 ${loffR.rows.length} 块，含 SHY 断字与特俗字符）`);
  assert(JSON.stringify(JSON.parse(lonR.meta.struct_report || "{}")) === JSON.stringify({ total: loffR.rows.length, droppedEmpty: 0, droppedGarbage: 0, repairedMojibake: 0, strippedControls: 0, strippedPua: 0, strippedFffd: 0, strippedSurrogates: 0, kept: loffR.rows.length }),
    "拉丁混排书 struct_report 全零（新字符域不吃干净语料）");
  // 零签名才是「字符域不误伤」的直接判据：report 与文本都不反映只抬 bad 的误伤
  assert(detectGarbled(latinBody).mojibake === 0,
    `拉丁混排书 detectGarbled 零签名（实测 ${detectGarbled(latinBody).mojibake}——G-12 的 ä+SHY 不进这本语料）`);
}

console.log("===== 8) 硬拦：修不动的纯乱码文件进不了切片 =====");
{
  const f = path.join(TMP, "struct-junk.md");
  fs.writeFileSync(f, "# 坏文件\n\n" + "\ufffd".repeat(120), "utf8");
  const out = path.join(TMP, "struct-junk.db");
  const cap = [];
  const keepExit = process.exitCode;
  const oe = console.error;
  console.error = (...a) => cap.push(a.map(String).join(" "));
  let r;
  try { r = await buildBook.main([f, "-o", out]); }
  finally { console.error = oe; process.exitCode = keepExit; }
  assert(!r && !fs.existsSync(out), "硬拦：不建库（修不动的不烧后续算力）");
  assert(/结构化改造后 0 块/.test(cap.join(" / ")), "硬拦说人话（实测：" + cap.join(" ").slice(0, 40) + "）");
}

console.log("===== 9) onStage 回调顺序：结构化改造在切片前 =====");
{
  const f = path.join(TMP, "struct-clean.md");
  const stages = [];
  const out = path.join(TMP, "struct-stage.db");
  const keepExit = process.exitCode;
  const ol = console.log;
  console.log = () => {};
  try {
    await buildBook.main([f, "-o", out], { onStage: (s) => stages.push(s) });
  } finally { console.log = ol; process.exitCode = keepExit; }
  assert(stages.length === 2 && stages[0] === "structurize" && stages[1] === "slice",
    `阶段顺序 structurize → slice（实测 ${stages.join(" → ")}——桌面横幅据此分格）`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n===== structurize-test: ${failed === 0 ? "全部 PASS" : failed + " 项 FAIL"} =====`);
process.exit(failed ? 1 : 0);
