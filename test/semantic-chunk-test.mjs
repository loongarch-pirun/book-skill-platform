// V3 第二波语义分块验收（src/lib/semantic-chunk.mjs）：
// split——相邻句余弦突变处下刀；merge——同章/同页相邻小块并到目标尺寸（本语料主力方向）；
// 两向都只动块边界不动字（拼回逐字保真）；全参数覆盖；假向量注入（不加载模型，test:fast 里 <5s）。
import { semanticSplitChunks, semanticMergeChunks, sentenceSpans, pickCuts, DEFAULTS, MERGE_DEFAULTS } from "../src/lib/semantic-chunk.mjs";

let failed = 0;
const assert = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " - " + msg); if (!cond) failed++; };

// ---------- 假 embedder：主题词命中造 4 维向量（同话题 ≈0.98，跨话题 ≈0.11，确定性） ----------
// 模拟 e5 的真实尺度：相邻句同话题余弦 0.75~0.9、话题切换 0.5~0.7（低于默认阈值 0.72）
const TOPICS = [
  ["苹果", "香蕉", "葡萄", "水果", "果实", "藤蔓", "多汁", "鲜食", "酿酒", "口感", "脆甜", "柔软", "香甜", "维生素", "膳食", "热带", "饱满", "常见", "成熟"],
  ["数据库", "索引", "查询", "树结构", "范围", "扫描", "等值", "查找", "事务", "一致性", "隔离", "级别", "并发", "行为", "强度", "优化器", "估算", "代价", "全表", "执行", "计划", "加速", "数据"],
];
const fakeEmbed = (texts) => Promise.all(texts.map(t => {
  const v = [0, 0, 1, Math.min(t.length, 100) / 100];   // 维度2=共享"中文句子"底分量
  TOPICS.forEach((words, ti) => { for (const w of words) if (t.includes(w)) v[ti] += 1; });
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map(x => x / norm);
}));

const FRUIT = ["苹果是一种常见的水果，含有丰富的维生素和膳食纤维，口感脆甜。",
  "香蕉属于热带水果，成熟后果肉柔软香甜，可直接食用。",
  "葡萄串生于藤蔓之上，果粒饱满多汁，常用于鲜食与酿酒。"];
const DB = ["数据库索引用于加速查询，B 树结构适合范围扫描与等值查找。",
  "事务的 ACID 特性保证数据一致性，隔离级别决定并发行为的强度。",
  "查询优化器会估算代价，选择全表扫描或者走索引执行计划。"];
// 510 字符/18 句/6 个话题边界（超默认 minLen=400）
const MIXED3 = (FRUIT.join("") + DB.join("")).repeat(3);

(async () => {
  // ===== 1) 单句块 / 短块不动（minLen 门） =====
  {
    const chunks = [
      { chapter: "短", page: 1, text: "很短的一块，不够 minLen。" },
      { chapter: "长", page: 2, text: FRUIT[0] },
    ];
    const out = await semanticSplitChunks(chunks, { embed: fakeEmbed });
    assert(out.length === 2 && out[0] === chunks[0] && out[1] === chunks[1], "minLen 门：短块原样透传（同一引用）");
  }

  // ===== 2) 话题突变块被切，且拼回逐字保真 =====
  {
    const chunks = [{ chapter: "混合", page: 7, text: MIXED3 }];
    const out = await semanticSplitChunks(chunks, { embed: fakeEmbed, minPiece: 40 });
    assert(out.length >= 2, `水果→数据库突变处下刀（${out.length} 块）`);
    assert(out.every(c => c.chapter === "混合" && c.page === 7), "章节/页码原样带");
    assert(out.map(c => c.text).join("") === MIXED3, "拼回与原文逐字一致（只切不增删）");
    assert(out.every(c => c.text.length >= 40), "minPiece 生效（无薄片）");
  }

  // ===== 3) 同话题长块不切（阈值内没有突变点） =====
  {
    const homo = FRUIT.join("") + FRUIT[0].slice(0, 10);
    const chunks = [{ chapter: "水果", page: null, text: homo }];
    const out = await semanticSplitChunks(chunks, { embed: fakeEmbed, threshold: 0.5 });
    assert(out.length === 1 && out[0] === chunks[0], "同话题长块：相似度高于阈值 → 不切");
  }

  // ===== 4) 参数边界：maxCuts 封顶 / minPiece 防薄片 / threshold 拉高全切 =====
  {
    const chunks = [{ chapter: "多突变", page: null, text: MIXED3 }];
    const out = await semanticSplitChunks(chunks, { embed: fakeEmbed, minPiece: 30, maxCuts: 2 });
    assert(out.length <= 3, `maxCuts=2 → 最多 3 块（实际 ${out.length}）`);
    assert(out.map(c => c.text).join("") === MIXED3, "多刀之后拼回仍逐字保真");
    const out2 = await semanticSplitChunks(chunks, { embed: fakeEmbed, minPiece: 30, threshold: 0.9999 });
    assert(out2.length > out.length, `threshold 拉到 0.9999 → 切得更碎（${out.length} → ${out2.length}，参数真的在起作用）`);
    const out3 = await semanticSplitChunks(chunks, { embed: fakeEmbed, minPiece: 10 ** 9 });
    assert(out3.length === 1, "minPiece 大于全文 → 一刀都不切（宁可不切不切薄片）");
  }

  // ===== 5) sentenceSpans 单元：含尾随空白的偏移切片 =====
  {
    const t = "第一句。 第二句！\n第三句？尾巴没标点";
    const spans = sentenceSpans(t);
    assert(spans.length === 4, `4 个句子跨度（实际 ${spans.length}）`);
    assert(spans.map(([s, e]) => t.slice(s, e)).join("") === t, "跨度切片拼回 == 原文（空白也保真）");
    assert(t.slice(...spans[0]) === "第一句。 ", "首跨度的尾随空白归前句");
    assert(pickCuts([0.9, 0.1, 0.95], [100, 100, 100, 100], { threshold: 0.72, minPiece: 150, maxCuts: 8 }).length === 0,
      "pickCuts：唯一切点会切出 100 字符薄片（< minPiece）→ 放弃");
    assert(pickCuts([0.9, 0.1, 0.95], [100, 100, 100, 100], { threshold: 0.72, minPiece: 50, maxCuts: 8 }).join() === "1",
      "pickCuts：minPiece=50 时同一点可切");
  }

  // ===== 6) 坏输入人话抛错（不许静默） =====
  {
    let msg = "";
    try { await semanticSplitChunks([{ text: "x".repeat(500) }], {}); } catch (e) { msg = e.message; }
    assert(/embed/.test(msg), `缺 embed 函数 → 人话抛错（${msg.slice(0, 40)}…）`);
    const out = await semanticSplitChunks([], { embed: fakeEmbed });
    assert(out.length === 0, "空 chunks → 空结果（不炸）");
  }

  // ===== 8) merge：同话题小块链并成目标尺寸块，拼回保真 =====
  {
    const chain = [...FRUIT, ...FRUIT, ...FRUIT, ...FRUIT, ...FRUIT];   // 15 句同话题 ≈449 字符
    const chunks = chain.map((t, i) => ({ chapter: "水果", page: 7, text: t }));
    const out = await semanticMergeChunks(chunks, { embed: fakeEmbed });
    assert(out.length === 1, `同话题 15 块并成 1 块（实际 ${out.length}）`);
    assert(out[0].text === chain.join("\n"), "并块文本 == 原序列以 \\n 相接（逐字保真）");
    assert(out[0].chapter === "水果" && out[0].page === 7, "合并块带首块的章节/页码");
    assert(chunks.length === 15 && chunks[0].text === chain[0], "入参不被改动");
  }

  // ===== 9) merge：target 即收 / maxLen 封顶 / 跨话题不并 =====
  {
    const chain = [...FRUIT, ...FRUIT, ...FRUIT, ...FRUIT, ...FRUIT];
    const chunks = chain.map(t => ({ chapter: "水果", page: null, text: t }));
    const out = await semanticMergeChunks(chunks, { embed: fakeEmbed, target: 100 });
    assert(out.length >= 3 && out.every(c => c.text.length < 200), `target=100 → 每块一到目标即收（${out.length} 块，最大 ${Math.max(...out.map(c => c.text.length))} 字符）`);
    assert(out.map(c => c.text).join("\n") === chain.join("\n"), "目标尺寸分块后拼回仍保真");
    const out2 = await semanticMergeChunks(chunks, { embed: fakeEmbed, target: 100, maxLen: 120 });
    assert(out2.every(c => c.text.length <= 120), `maxLen=120 封顶（最大 ${Math.max(...out2.map(c => c.text.length))}）`);
    const mixed = [...FRUIT, DB[0]].map(t => ({ chapter: "混合", page: null, text: t }));
    const out3 = await semanticMergeChunks(mixed, { embed: fakeEmbed });
    assert(out3.length === 2 && !out3[0].text.includes("数据库"), "跨话题边界（余弦≈0.06 < 0.72）不并");
  }

  // ===== 10) merge：跨章/跨页不并；空块自成一块；无相邻对不调 embed =====
  {
    const crossChapter = [{ chapter: "A", page: null, text: FRUIT[0] }, { chapter: "B", page: null, text: FRUIT[1] }];
    const out = await semanticMergeChunks(crossChapter, { embed: fakeEmbed });
    assert(out.length === 2, "跨章不并（章节是更强的语义边界）");
    const crossPage = [{ chapter: "c", page: 1, text: FRUIT[0] }, { chapter: "c", page: 2, text: FRUIT[1] }];
    const out2 = await semanticMergeChunks(crossPage, { embed: fakeEmbed });
    assert(out2.length === 2, "跨页不并（PDF 页码归属不能糊）");
    const withEmpty = [
      { chapter: "c", page: null, text: FRUIT[0] },
      { chapter: "c", page: null, text: "" },
      { chapter: "c", page: null, text: FRUIT[1] },
      { chapter: "c", page: null, text: FRUIT[2] },
    ];
    const out3 = await semanticMergeChunks(withEmpty, { embed: fakeEmbed });
    assert(out3.length === 3 && out3[1].text === "", "空块自成一块（不产出前导 \\n）");
    assert(out3.map(c => c.text).join("\n") === withEmpty.map(c => c.text).join("\n"), "有空块时拼回仍保真");
    let calls = 0;
    const counting = (t) => { calls++; return fakeEmbed(t); };
    const solo = await semanticMergeChunks([{ chapter: "c", page: null, text: FRUIT[0] }], { embed: counting });
    assert(calls === 0 && solo.length === 1 && solo[0].text === FRUIT[0], "无相邻对 → 不调 embed、原样返回");
  }

  // ===== 11) merge 坏输入人话抛错（不许静默） =====
  {
    let msg = "";
    try { await semanticMergeChunks([{ text: "x" }], {}); } catch (e) { msg = e.message; }
    assert(/embed/.test(msg), `缺 embed 函数 → 人话抛错（${msg.slice(0, 40)}…）`);
    msg = "";
    try { await semanticMergeChunks([{ text: "x" }], { embed: fakeEmbed, target: 400, maxLen: 200 }); } catch (e) { msg = e.message; }
    assert(/参数不合法/.test(msg), `maxLen < target → 人话抛错（${msg.slice(0, 40)}…）`);
  }

  // ===== 12) 默认参数快照（防误改） =====
  assert(DEFAULTS.minLen === 400 && DEFAULTS.minPiece === 150 && DEFAULTS.threshold === 0.72 && DEFAULTS.maxCuts === 8,
    `split 默认参数锁定（${JSON.stringify(DEFAULTS)}）`);
  assert(MERGE_DEFAULTS.target === 400 && MERGE_DEFAULTS.maxLen === 800 && MERGE_DEFAULTS.threshold === 0.72,
    `merge 默认参数锁定（${JSON.stringify(MERGE_DEFAULTS)}）`);

  console.log(`\n===== 语义切分验收：${failed === 0 ? "全部 PASS" : failed + " 项 FAIL"} =====`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("崩溃:", e); process.exit(1); });
