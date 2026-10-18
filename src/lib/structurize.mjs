// 结构化改造层（V3 第四波 P2）：解析之后、切片之前的一道清洗体检。
// 老板诉求原话：「结构化改造要清洗坏数据/不全数据/乱码符号」，流程改为
//   结构化改造 → 切片 → 洗数据（原来是切完片直接洗）。
// 接入点：build-book.main() 解析成功之后、语义分块之前（烧算力之前拦坏文件）。
// 铁律：
//   - 干净的书零变化：所有规则只对「有问题」的文本发力——存量四书块数锁定不受影响；
//   - 清洗全部可审计：report 进 meta.struct_report，控制台明示条数；
//   - 硬拦只发生在烧算力之前：0 块/内容太少/乱码超阈值 → 人话失败，不进切片不建库；
//   - 修乱码只认经典双重编码（UTF-8 字节被当 Latin-1 解过）：回读不是合法 UTF-8 就不修，
//     宁可留下不修，不可把好文本修坏（French 书里的 é 就是反例警戒）。
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
// 经典双重编码签名（显式 \u 转义，不靠字面字符——文件编码一动正则就废）：
//   é(C3A9)→é(C3 A9)  â‚¬(E282AC)→â‚¬  ä¸­(E4B8AD)→ä¸­  ä½ (E4B9A6)→ä½
const MOJIBAKE_RE = /(?:\u00c3[\u0080-\u00bf]|\u00c2[\u0080-\u00bf]|\u00e2\u20ac[\u2013\u2014\u201c\u201d\u2022\u2026\u0152\u0153]|\u00e5[\u0080-\u00bf]|\u00e6[\u0080-\u00bf]|\u00e8[\u0080-\u00bf])/g;

// 乱码体检：数出四类乱码符号，返回计数与占比（ratio 按字符数加权由调用方汇总）
export function detectGarbled(text) {
  const s = String(text ?? "");
  // 签名实际占用按匹配长度求和：双重编码签名拖 2~3 个字符，按 2 估会把
  // 「100 字符 15 签名 = 真实乱码率 45%」低估成 30% 从而放过（P2-01，
  // A1/A8/F9 三处坐实：乱码隐形入库 + report 全零 = 审计失效）。
  // 注意：MOJIBAKE_RE 是已知经典签名白名单，类外双重编码（如 â€™
  // 撇号乱码）不在其列——检测集非完备，白名单缺口已登记后续波次工单。
  // 用 match 而非 matchAll：match 前置清零 lastIndex，外部若推进过
  // MOJIBAKE_RE.lastIndex 也不会从污染偏移起匹配而静默漏计前缀。
  let mojibake = 0, mojibakeChars = 0;
  for (const m of s.match(MOJIBAKE_RE) || []) { mojibake++; mojibakeChars += m.length; }
  const controls = (s.match(CONTROL_RE) || []).length;
  const pua = (s.match(PUA_RE) || []).length;
  const fffd = (s.match(FFFD_RE) || []).length;
  const bad = mojibakeChars + controls + pua + fffd;
  return { mojibake, controls, pua, fffd, bad, ratio: s.length ? bad / s.length : 0 };
}

// 反向修复：把「被当 Latin-1 解过的 UTF-8」修回来。
// 只修签名单个字符都落在 Latin-1 范围（<0x100）的文本——CP1252 的特俗字符
// （‚ Œ 等 >0xFF）latin1 Buffer 装不下，保守不修（report 里记账）。
// 回读出现 U+FFFD（说明原字节本就不是合法 UTF-8）→ 不修，原样返回。
export function repairMojibake(text) {
  const s = String(text ?? "");
  const hints = (s.match(MOJIBAKE_RE) || []).length;
  if (hints < MOJIBAKE_MIN_HINTS) return { text: s, repaired: false };
  for (const ch of s) {
    if (ch.codePointAt(0) > 0xff) return { text: s, repaired: false };
  }
  let fixed;
  try { fixed = Buffer.from(s, "latin1").toString("utf8"); } catch { return { text: s, repaired: false }; }
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
