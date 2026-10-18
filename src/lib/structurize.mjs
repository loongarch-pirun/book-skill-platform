// 结构化改造层（V3 第四波 P2）：解析之后、切片之前的一道清洗体检。
// 老板诉求原话：「结构化改造要清洗坏数据/不全数据/乱码符号」，流程改为
//   结构化改造 → 切片 → 洗数据（原来是切完片直接洗）。
// 接入点：build-book.main() 解析成功之后、语义分块之前（烧算力之前拦坏文件）。
// 铁律：
//   - 干净的书零变化：所有规则只对「有问题」的文本发力——存量四书块数锁定不受影响；
//   - 清洗全部可审计：report 进 meta.struct_report，控制台明示条数；
//   - 硬拦只发生在烧算力之前：0 块/内容太少/乱码超阈值 → 人话失败，不进切片不建库；
//   - 修乱码只认经典双重编码（UTF-8 字节被当 Latin-1 或 cp1252 解过）：回读不是
//     合法 UTF-8 就不修，宁可留下不修，不可把好文本修坏（French 书里的 é 就是反例警戒）。
// 纯文本层：零依赖、零 IO、零模型——可在 node 下单测。

// 内容下限：全文少于此字数视为「不全数据」（空文件/加密文档/扫描图片的典型身形）
export const STRUCT_MIN_CHARS = 100;
// 乱码上限：按字符数加权的乱码符号占比超过此值 → 硬拦（文件编码不对或已损坏）
export const STRUCT_GARBLED_MAX = 0.3;
// 单块乱码占比上限：超过即整块按垃圾丢（此块已无检索价值）
const CHUNK_GARBLED_MAX = 0.5;
// 修乱码的最小线索数：块内经典双重编码签名少于此数不修（防误伤含特殊字符的正常文本）
const MOJIBAKE_MIN_HINTS = 2;

// 控制符（保留 \t \n \r 与正常空白）：C0 除 09/0A/0D、DEL、C1 区
// eslint-disable-next-line no-control-regex -- 清洗控制符是本职，正则必须显式匹配它们
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// 私用区字符（PDF 图标字体/坏提取的典型产物，不承载文字信息）
const PUA_RE = /[\ue000-\uf8ff]/g;
// 替换符 U+FFFD：解不出来的字节的占位——就是「乱码符号」本人
const FFFD_RE = /\ufffd/g;
// 孤立代理对（lone surrogate）：字符串层面就损坏的半个 UTF-16 代理对。
// 成对的天文字符（代理对）不动，只剥孤立的——高代理后不跟低代理、
// 低代理前不接高代理（lookaround 两侧查岗，成对的一个不误伤）。
// 必须在 sqlite 绑定前剥掉：绑定会把 lone surrogate 静默变成 U+FFFD
// 入库——等于绕过上面的 FFFD 清洗让它换件马甲再进（P2-02，A3/F2a
// 坐实「库内 FFFD 残留」）。剥了多少记入 report.strippedSurrogates。
// 注意：/g 正则的 lastIndex 是模块级共享可变状态——只走 match/replace
// 入口（两者均前置清零），勿用于 .test() 循环或跨异步边界复用。
const LONE_SURROGATE_RE = /(?:[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff])/g;

// lone surrogate 剥离：单遍 replace 回调计数（不 match+replace 双扫），
// 返回 [剥后文本, 剥掉几个]。成对的天文字符一个不误伤
function stripLoneSurrogates(text) {
  let n = 0;
  const out = text.replace(LONE_SURROGATE_RE, () => { n++; return ""; });
  return [out, n];
}
// 双重编码续字节的字符域（cp1252 版）。UTF-8 的续字节只可能是 0x80~0xBF，但
// 「被当什么编码解」决定它落在哪个字符上：
//   - latin1 解码：0x80~0xBF 原样 = U+0080~U+00BF（C1 控制符 + Latin-1 符号）
//   - cp1252 解码：0x80~0x9F 那 27 个字节变成「特俗字符」（€ ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ
//     Ž ‘ ’ “ ” • – — ˜ ™ š › œ ž Ÿ），0xA0~0xBF 仍是原样
// 两套都要算进字符域。漏掉 cp1252 那一半 = â€™（U+2019 撇号，现实书里最高发的
// mojibake 之一，英文书的 don't/it's 全变它）整类 100% 逃逸（G-05：与 P2-01
// 同一审计失效模式——把签名表当白名单用，白名单外就漏检）。
// 逐段枚举而非 \u2013-\u2022 图省事：那一段里含 2015/2016/2017/201B/201F 五个
// 码位，它们**永远不可能**由 cp1252 单字节产生（毛 O2）——放进来只会给
// 「检得出、修不动」添乱（CP1252_REV 没有它们的映射）。
const CP1252_HI = "\\u0080-\\u00bf\\u0152\\u0153\\u0160\\u0161\\u0178\\u017d\\u017e\\u0192"
  + "\\u02c6\\u02dc\\u2013\\u2014\\u2018-\\u201a\\u201c-\\u201e\\u2020-\\u2022\\u2026\\u2030\\u2039\\u203a\\u20ac\\u2122";
// 经典双重编码签名（显式 \u 转义，不靠字面字符——文件编码一动正则就废）：
//   2 字符：Ã©(C3A9) / Âx(C2xx) / ä(E4) / å(E5) / æ(E6) / è(E8) 打头
//   3 字符：â + 两个续字节（E2 80/84/8B… xx，标点族）。第三字节必是续字节
//     （0x80~0xBF），两段都落在 CP1252_HI 内，故一支 {2} 同时覆盖两条解码路径：
//     cp1252 路 â€™/â€œ/â€”/â„¢(™)、latin1 路 â + C1 + C1（毛 F1：先前只写死第二字符
//     为 €，等于只补了 â€™ 一个案例，â„¢/âœ“/â˜… 等 E2 84/E2 98/E2 9C 打头的
//     整类仍 0 命中——工单点名的正是这一族）
const MOJIBAKE_RE = new RegExp(
  `(?:\\u00e2[${CP1252_HI}]{2}|\\u00c3[${CP1252_HI}]|\\u00c2[${CP1252_HI}]`
  + `|\\u00e4[${CP1252_HI}]|\\u00e5[${CP1252_HI}]|\\u00e6[${CP1252_HI}]|\\u00e8[${CP1252_HI}])`, "g");

// 乱码字符并集（G-06）：MOJIBAKE 的第二字符域与 CONTROL_RE 在 C1 区
// （\u0080~\u009f）交叠——按分类求和会把同一个字符数两遍（「ÃŸ」×50 得
// bad=150/100，ratio 1.5，报告出现不可审计的数字）。bad 改按并集长度算：
// alternation 左优先且不重叠，天然去重，保证 bad ≤ 文本长度、ratio ≤ 1。
// （正则用字符串构造：字符域里含 C1 控制符，字面量写法过不了 no-control-regex）
const BAD_RE = new RegExp(
  `(?:${MOJIBAKE_RE.source})|(?:${CONTROL_RE.source})|(?:${PUA_RE.source})|(?:${FFFD_RE.source})`, "g");

// 乱码体检：数出四类乱码符号，返回计数与占比（ratio 按字符数加权由调用方汇总）
export function detectGarbled(text) {
  const s = String(text ?? "");
  // bad 按「匹配到的字符长度」求和而非按签名个数×2 估：双重编码签名拖 2~3 个
  // 字符，按 2 估会把「100 字符 15 签名 = 真实乱码率 45%」低估成 30% 从而放过
  // （P2-01，A1/A8/F9 三处坐实：乱码隐形入库 + report 全零 = 审计失效）。
  // 注意：MOJIBAKE_RE 是已知经典签名表，不是完备检测器；G-05 已把 cp1252
  // 特俗字符域（â€™ 一族）与 E4 打头的中文序列补进字符域，仍属白名单式扩展。
  // 用 match 而非 matchAll：match 前置清零 lastIndex，外部若推进过
  // MOJIBAKE_RE.lastIndex 也不会从污染偏移起匹配而静默漏计前缀。
  const mojibake = (s.match(MOJIBAKE_RE) || []).length;
  const controls = (s.match(CONTROL_RE) || []).length;
  const pua = (s.match(PUA_RE) || []).length;
  const fffd = (s.match(FFFD_RE) || []).length;
  // bad = 并集字符数（G-06）。分支各自计数只用于 report 展示，不进 bad——
  // 分类之间在 C1 区有交叠，求和会重复计数（ratio 能到 1.5）
  let bad = 0;
  for (const m of s.match(BAD_RE) || []) bad += m.length;
  return { mojibake, controls, pua, fffd, bad, ratio: s.length ? bad / s.length : 0 };
}

// cp1252 高位区反查表：把「特俗字符」还原成原字节（0x80~0x9F 那 27 个有定义的）。
// 0x81/0x8D/0x8F/0x90/0x9D 在 cp1252 无定义——解码器按 C1 控制符原样留下，
// 码位本身 ≤0xFF，走 Latin-1 直通，不需查表。
const CP1252_REV = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

// 反向修复：把「被当 Latin-1 / cp1252 解过的 UTF-8」修回来。
// 逆向编码两条路：Latin-1 字符（<0x100）直通取码位；cp1252 的 27 个特俗字符
// （€ ‚ Œ ‘ ’ “ ” • – — ™ …）查表还原原字节——不这么做，â€™ 这类英文书里
// 最高发的撇号乱码只能检出不能修，等于「见乱码就拦」，违背清洗诉求（G-05）。
// 表外字符（中文/日文/真正的弯引号）一律拒绝——宁可留下不修，不可把好文本修坏
// （French é 就是反例警戒：单码位 é 回读不是合法 UTF-8，照样被下面的回读闸门拦）。
// 查表只在**签名跨度内**放行（毛 F2）：cp1252 特俗字符对应的字节全在 0x80~0x9F
// （UTF-8 的续字节区），若允许句子别处的 …/™/œ 也查表，它们会和前面的前导字节
// 拼成**合法但错误**的 UTF-8——实测干净意大利文「è\u00a0… ma non è\u00a0…」会被
// 「修」成含生僻汉字「蠅」的垃圾，report 还记成清洗成果。跨度外的 >0xFF 字符
// 一律触发保守拒修，与「宁可留下不修」对齐。
// 回读出现 U+FFFD（说明原字节本就不是合法 UTF-8）→ 不修，原样返回。
export function repairMojibake(text) {
  const s = String(text ?? "");
  const spans = [];
  for (const m of s.matchAll(MOJIBAKE_RE)) spans.push([m.index, m.index + m[0].length]);
  if (spans.length < MOJIBAKE_MIN_HINTS) return { text: s, repaired: false };
  // 跨度游标而非 spans.some()（毛 F3）：matchAll 产出的跨度天然升序、互不重叠，
  // 而 i 在下面的循环里单调递增——游标只前进不后退，摊还 O(n)。
  // 用 some() 是 O(n·k) 二次：10 万字符的整本人身要 3 秒+（实测 210k=3.8s），
  // 而 txt2docx「一行一段」会把无换行的整本书变成 1 块送进来，正好是最坏输入。
  let si = 0;
  const inSpan = (i) => {
    while (si < spans.length && spans[si][1] <= i) si++;
    return si < spans.length && i >= spans[si][0];
  };
  const bytes = [];
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i);
    const w = cp > 0xffff ? 2 : 1;
    if (cp <= 0xff) { bytes.push(cp); i += w; continue; }
    const b = inSpan(i) ? CP1252_REV.get(cp) : undefined;
    if (b === undefined) return { text: s, repaired: false }; // 混了表外/跨度外字符：保守不修
    bytes.push(b);
    i += w;
  }
  let fixed;
  try { fixed = Buffer.from(bytes).toString("utf8"); } catch { return { text: s, repaired: false }; }
  if (fixed.includes("\ufffd") || fixed === s) return { text: s, repaired: false };
  if (!/[\u4e00-\u9fffA-Za-z]/.test(fixed)) return { text: s, repaired: false };
  return { text: fixed, repaired: true };
}

// 硬闸门（清洗之后、烧算力之前评）：修不动的才拦。
// 顺序很关键——先让 structurizeChunks 把能修的双重编码修掉，再拿残局评：
// 可修的文件被放过（修完比拦下更符合「清洗乱码符号」的诉求），
// 修不动的（真二进制垃圾/编码错乱）才因人话失败进不了切片。
export function assessCleaned(chunks, report = null) {
  if (!chunks.length) {
    return { ok: false, reason: "结构化改造后 0 块：全文都是空块/乱码块——文件可能是扫描图片、加密文档或已损坏。" };
  }
  let totalChars = 0, bad = 0;
  for (const c of chunks) {
    const g = detectGarbled(String(c?.text ?? ""));
    totalChars += String(c?.text ?? "").length;
    bad += g.bad;
  }
  if (totalChars < STRUCT_MIN_CHARS) {
    return { ok: false, reason: `内容太少（全文 ${totalChars} 字符）：文件可能是空的、加密文档或扫描图片型 PDF。` };
  }
  const garbled = totalChars ? bad / totalChars : 0;
  if (garbled > STRUCT_GARBLED_MAX) {
    return { ok: false, reason: `乱码严重（约 ${(garbled * 100).toFixed(0)}% 的字符是乱码符号）：文件可能编码不对或已损坏，换个来源再试。` };
  }
  return { ok: true, report: { totalChars, garbledRatio: Number(garbled.toFixed(4)), dropped: report?.droppedGarbage || 0 } };
}

// 清洗通道：坏数据（空块/纯符号块/乱码 majority 块）丢、乱码符号（控制符/PUA/替换符/
// 孤立代理对）清、经典双重编码修。干净文本逐字节原样返回——report 全零即零变化。
export function structurizeChunks(chunks) {
  const report = {
    total: chunks.length,
    droppedEmpty: 0,   // 空块/纯空白块
    droppedGarbage: 0, // 纯符号数字块 / 乱码过半的块
    repairedMojibake: 0,
    strippedControls: 0,
    strippedPua: 0,
    strippedFffd: 0,
    strippedSurrogates: 0, // 孤立代理对（剥晚了会被 sqlite 绑定变 FFFD 入库）
    kept: 0,
  };
  const out = [];
  for (const c of chunks) {
    const raw = String(c?.text ?? "");
    if (!raw.trim()) { report.droppedEmpty++; continue; }
    let text = raw;
    // lone surrogate 前置剥离：赶在修乱码/清符号之前——绑定前剥掉才轮不到
    // sqlite 把它静默变成 U+FFFD（P2-02）。剥完只剩空白的按空块丢
    const [cleanText, surN] = stripLoneSurrogates(text);
    text = cleanText;
    if (surN) {
      report.strippedSurrogates += surN;
      if (!text.trim()) { report.droppedEmpty++; continue; }
    }
    let g = detectGarbled(text);
    // 先修乱码再评垃圾：双重编码的字节里含 C1 控制符（\u0080-\u009f），
    // 先评会把「可修」误判成「垃圾」；修完重算体检，修不动的才按垃圾丢
    if (g.mojibake >= MOJIBAKE_MIN_HINTS) {
      const fix = repairMojibake(text);
      if (fix.repaired) {
        text = fix.text; g = detectGarbled(text); report.repairedMojibake++;
        // 出口复检（纵深防御）：修复产物按说不该再产 lone surrogate——
        // 严格 UTF-8 解码产的是 U+FFFD，会被回读闸门拦下；但「绑定前无
        // 孤立代理对」这条不变量不赌解码器实现，谁产的在这里统一剥掉
        const [fixedText, surFix] = stripLoneSurrogates(text);
        text = fixedText;
        if (surFix) report.strippedSurrogates += surFix;
      }
    }
    if (g.ratio > CHUNK_GARBLED_MAX) { report.droppedGarbage++; continue; }
    text = text.replace(CONTROL_RE, "");
    report.strippedControls += g.controls;
    text = text.replace(PUA_RE, "");
    report.strippedPua += g.pua;
    text = text.replace(FFFD_RE, "");
    report.strippedFffd += g.fffd;
    if (!text.trim()) { report.droppedEmpty++; continue; }
    // 纯标点/数字块：没有任何文字——检索零价值，属坏数据
    if (!/[\u4e00-\u9fffA-Za-z]/.test(text)) { report.droppedGarbage++; continue; }
    out.push({ ...c, text });
    report.kept++;
  }
  return { chunks: out, report };
}

// 清洗有没有动手脚（供 jobs 横幅与测试判零变化）
export function structChanged(report) {
  if (!report) return false;
  return report.droppedEmpty + report.droppedGarbage + report.repairedMojibake
    + report.strippedControls + report.strippedPua + report.strippedFffd + report.strippedSurrogates > 0;
}
