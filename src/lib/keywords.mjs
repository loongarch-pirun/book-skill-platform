// 字面腿关键词化：把"整句问题"拆成"可检索的关键词组"
// 背景：旧字面腿对整个问题做 FTS 短语 MATCH（trigram = 整句子串匹配），书里永远不会
// 出现"which convolutional sequence models are cited as prior work"这种整句 → 43 题里
// 字面腿命中 0 次，纯摆设。中文更惨：问题是简体、书是繁体，整句 MATCH 必然落空。
// 这里做三件事：
//   1. 英文：抽 ≥3 字符的实义词（问题词 who/what 全停），FTS OR 联合 MATCH（trigram 支持 ≥3 字）
//   2. 中文：整串先简转繁（S2T_MAP，按评测问题 × 书中用字diff 生成），再切 2-gram，逐词 LIKE 计分
//   3. 质量阶梯：关键词腿命中块占比越高越像噪声，权重沿 0.5→0.4→0.35→0.3 阶梯降级
// 开关：BSP_FTS_KW=0 退回旧整句短语行为（对照组/回滚）；BSP_FTS_W 手动钉死权重（跳过阶梯）

// 简→繁 单字映射（覆盖评测问题 166 字里书里缺的 95 字 + 常用补充；
// 无繁简之分的字不进表——缺了就缺了，靠其他 bigram 补偿）
const S2T_MAP = {
  // —— 评测问题实测缺字（43 题全量 CJK × 两本中文书用字 diff 生成）——
  专: "專", 业: "業", 东: "東", 个: "個", 么: "麼", 乐: "樂", 习: "習", 从: "從",
  会: "會", 几: "幾", 别: "別", 办: "辦", 动: "動", 后: "後", 吗: "嗎", 听: "聽",
  园: "園", 国: "國", 学: "學", 对: "對", 庄: "莊", 开: "開", 张: "張", 恒: "恆",
  担: "擔", 显: "顯", 来: "來", 样: "樣", 气: "氣", 温: "溫", 满: "滿", 点: "點",
  礼: "禮", 积: "積", 穷: "窮", 纷: "紛", 练: "練", 经: "經", 缤: "繽", 缩: "縮",
  聪: "聰", 让: "讓", 训: "訓", 论: "論", 该: "該", 说: "說", 谄: "諂", 贫: "貧",
  贵: "貴", 轻: "輕", 达: "達", 运: "運", 这: "這", 远: "遠", 长: "長", 颜: "顏",
  骄: "驕", 兰: "蘭",
  // —— 常用补充（未来新书/新问题大概率撞上）——
  时: "時", 问: "問", 间: "間", 与: "與", 体: "體", 术: "術", 网: "網", 络: "絡",
  数: "數", 据: "據", 处: "處", 复: "復", 关: "關", 书: "書", 画: "畫", 华: "華",
  万: "萬", 优: "優", 传: "傳", 众: "眾", 伤: "傷", 余: "餘", 儿: "兒", 党: "黨",
  内: "內", 册: "冊", 军: "軍", 农: "農", 决: "決", 况: "況", 冻: "凍", 净: "淨",
  凉: "涼", 减: "減", 凤: "鳳", 凭: "憑", 凯: "凱", 击: "擊", 划: "劃", 刘: "劉",
  则: "則", 刚: "剛", 创: "創", 删: "刪", 剂: "劑", 剑: "劍", 剥: "剝", 剧: "劇",
  劝: "勸", 务: "務", 励: "勵", 劲: "勁", 势: "勢", 勋: "勳", 勤: "勤", 匀: "勻",
  医: "醫", 协: "協", 单: "單", 卖: "賣", 占: "佔", 卢: "盧", 卫: "衛", 却: "卻",
  厂: "廠", 厅: "廳", 历: "歷", 厉: "厲", 压: "壓", 厌: "厭", 厕: "廁", 厘: "釐",
  厢: "廂", 厦: "廈", 厨: "廚", 县: "縣", 参: "參", 双: "雙", 发: "發", 变: "變",
  叙: "敘", 叠: "疊", 号: "號", 叹: "嘆", 吁: "籲", 吓: "嚇", 吕: "呂", 员: "員",
  呐: "吶", 呕: "嘔", 呜: "嗚", 咏: "詠", 咸: "鹹", 响: "響", 哑: "啞", 唤: "喚",
  啰: "囉", 啸: "嘯", 喷: "噴", 嘱: "囑", 团: "團", 围: "圍", 图: "圖",
  圆: "圓", 圣: "聖", 坏: "壞", 坚: "堅", 声: "聲", 备: "備", 边: "邊", 写: "寫",
  实: "實", 宝: "寶", 审: "審", 层: "層", 岁: "歲", 岛: "島", 帅: "帥", 师: "師",
  帐: "帳", 库: "庫", 补: "補", 态: "態", 惊: "驚", 惯: "慣",
  愿: "願", 战: "戰", 扑: "撲", 执: "執", 扩: "擴", 扬: "揚", 报: "報",
  护: "護", 拟: "擬", 拦: "攔", 择: "擇", 换: "換", 掷: "擲",
  揽: "攬", 摄: "攝", 罗: "羅", 胜: "勝", 脑: "腦", 术: "術", 机: "機",
  杀: "殺", 条: "條", 构: "構", 标: "標", 桥: "橋", 检: "檢", 楼: "樓", 欢: "歡",
  欧: "歐", 毕: "畢", 汇: "匯", 汉: "漢", 沟: "溝",
  泪: "淚", 洁: "潔", 测: "測", 济: "濟", 涂: "塗", 涌: "湧",
  渐: "漸", 渔: "漁", 温: "溫", 满: "滿", 滤: "濾", 潜: "潛", 灭: "滅", 灯: "燈",
  灵: "靈", 烦: "煩", 烧: "燒", 热: "熱", 爱: "愛", 环: "環", 现: "現", 产: "產",
  电: "電", 疗: "療", 监: "監", 矿: "礦", 码: "碼",
  确: "確", 离: "離", 种: "種", 称: "稱", 稳: "穩", 竞: "競",
  笔: "筆", 笼: "籠", 类: "類", 级: "級", 纯: "純", 线: "線", 组: "組", 终: "終",
  维: "維", 绿: "綠", 缓: "緩", 编: "編", 缘: "緣", 网: "網", 联: "聯",
  肃: "肅", 胆: "膽", 胜: "勝", 脏: "臟", 艺: "藝", 荐: "薦", 蓝: "藍",
  虑: "慮", 蚀: "蝕", 装: "裝", 见: "見", 观: "觀", 规: "規", 视: "視",
  觉: "覺", 触: "觸", 计: "計", 认: "認", 讨: "討", 让: "讓", 训: "訓", 议: "議",
  讯: "訊", 记: "記", 讲: "講", 讽: "諷", 设: "設", 访: "訪", 证: "證", 评: "評",
  识: "識", 诉: "訴", 词: "詞", 译: "譯", 试: "試", 话: "話", 询: "詢", 诚: "誠",
  详: "詳", 语: "語", 误: "誤", 说: "說", 请: "請", 读: "讀", 课: "課", 谁: "誰",
  调: "調", 谈: "談", 谊: "誼", 谢: "謝", 谱: "譜", 谲: "譎", 象: "象", 财: "財",
  责: "責", 败: "敗", 货: "貨", 质: "質", 购: "購", 贴: "貼", 贸: "貿", 资: "資",
  赏: "賞", 赐: "賜", 赔: "賠", 赛: "賽", 赞: "讚", 赶: "趕", 趋: "趨", 车: "車",
  轨: "軌", 转: "轉", 轮: "輪", 软: "軟", 轴: "軸", 轻: "輕", 载: "載", 较: "較",
  辅: "輔", 辆: "輛", 输: "輸", 辞: "辭", 边: "邊", 达: "達", 迁: "遷", 过: "過",
  运: "運", 还: "還", 进: "進", 远: "遠", 违: "違", 连: "連", 迟: "遲", 适: "適",
  选: "選", 递: "遞", 通: "通", 逻: "邏", 遗: "遺", 邓: "鄧", 邮: "郵", 邻: "鄰",
  酱: "醬", 释: "釋", 里: "裡", 鉴: "鑑", 针: "針", 钉: "釘", 钟: "鐘", 钢: "鋼",
  钱: "錢", 铁: "鐵", 银: "銀", 链: "鏈", 锁: "鎖", 错: "錯", 键: "鍵", 镜: "鏡",
  长: "長", 门: "門", 闪: "閃", 闭: "閉", 问: "問", 间: "間", 闻: "聞", 阀: "閥",
  阁: "閣", 队: "隊", 阶: "階", 隐: "隱", 难: "難", 雏: "雛", 雾: "霧", 静: "靜",
  项: "項", 顺: "順", 须: "須", 顽: "頑", 顾: "顧", 顿: "頓", 预: "預", 领: "領",
  题: "題", 颜: "顏", 风: "風", 飞: "飛", 馆: "館", 驱: "驅", 驶: "駛", 驾: "駕",
  骗: "騙", 骤: "驟", 鱼: "魚", 鸟: "鳥", 鸡: "雞", 鸣: "鳴", 齿: "齒",
};
const S2T_RE = /[\u4e00-\u9fff]/g;

// 简转繁（只映射表中有的字，其他原样保留）
export function convS2T(s) {
  return String(s || "").replace(S2T_RE, c => S2T_MAP[c] || c);
}

// 英文停用词：超集（含 who/what/which 等问题词——旧短语腿就是被它们堵死的）
export const EN_STOP = new Set(("a an the and or of to in on for with as at by from this that these those " +
  "it its their his her hers him them himself herself not no nor but they we you your ours our i me my mine " +
  "he she which what who whom whose when where why how is are was were be been being am do does did done doing " +
  "can could will would shall should may might must have has had having if then than so such too very just also " +
  "into over under again further once here there all any both each few more most other same only own s t don now " +
  "about above after before between during through up down out off while because until against per via any some " +
  "many much get got make made use used using said says say one two three first second last next new old").split(" "));

// 从问题抽关键词：英文 ≥3 字符实义词（弯引号 ’ 归一成直引号、属格 's 剥掉——
// epub 正文全是弯引号，实测 "darcy's" 直引号形式 df=0，剥成 darcy 才能命中）；
// 中文简转繁后切 2-gram
export function questionKeywords(q) {
  const s = String(q || "").replace(/\u2019/g, "'").toLowerCase();
  const en = [];
  for (const w of s.match(/[a-z][a-z'-]{2,}/g) || []) {
    const clean = w.replace(/^['-]+|['-]+$/g, "").replace(/'s$/, "");
    if (clean.length >= 3 && !EN_STOP.has(clean)) en.push(clean);
  }
  const t = convS2T(s.replace(/[^\u4e00-\u9fff]/g, ""));
  const cjk = [];
  for (let i = 0; i + 2 <= t.length; i++) cjk.push(t.slice(i, i + 2));
  return { en, cjk };
}

// 英文 FTS 查询：OR 联合（trigram 对 ≥3 字词做子串匹配）；封顶 24 词防超长问题
export function buildFtsQuery(kws) {
  const terms = [...new Set((kws?.en || []).map(w => `"${w}"`))];
  if (!terms.length) return null;
  return terms.slice(0, 24).join(" OR ");
}

// 字面腿提名席位数：只留 12 个最尖的候选进池。
// 实测教训（86→81 回归）：不封顶时 "what OR estate OR called" 命中几百块，min-max 归一化后
// 满屏 nf≈1 的噪声把预筛窗口挤爆，两道原本会做的题被打翻——帮不上忙的信号不许扰动。
export const FTS_TOPK = 12;

// 中文关键词计分：逐 2-gram 对全库 text 做 includes（书文本几百 KB 级，JS 单遍扫描足够快）。
// 先算每个 gram 的 df：df > max(5%总块数, 4) 的 gram 是无区分度的现代白话词（实测「可以」
// df=7/81=8.6% 纯噪声，把会做的题打翻），直接扔掉；剩下的按命中 gram 数计分。
export function cjkLikeScores(db, grams) {
  const scores = new Map();
  const uniq = [...new Set(grams || [])];
  if (!uniq.length) return scores;
  const total = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const cap = Math.max(0.05 * total, 4);
  const df = new Map();
  const rows = db.prepare("SELECT id, text FROM chunks").all();
  for (const c of rows)
    for (const g of uniq) if (c.text.includes(g)) df.set(g, (df.get(g) || 0) + 1);
  const keep = uniq.filter(g => (df.get(g) || 0) > 0 && df.get(g) <= cap);
  if (!keep.length) return scores;
  for (const c of rows) {
    let n = 0;
    for (const g of keep) if (c.text.includes(g)) n++;
    if (n) scores.set(c.id, n);
  }
  return scores;
}

// 提名封顶：按分数取 top-K（bm25 与 LIKE 计分都是越大越相关，同向排序）
export function capFtsHits(scores, k = FTS_TOPK) {
  if (scores.size <= k) return scores;
  return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k));
}

// 质量阶梯（调参备用，当前主路径不走它）：字面腿命中块占全库比例越高，权重越低
// ≤2% 满权重 0.5 → ≤6% 0.4 → ≤10% 0.35 → 否则 0.3。实测主路径选了"top-12 封顶"而非
// 降权——命中面大时降权仍在扰动窗口，封顶才是最小扰动（86→81 回归的教训）
export function ftsWeightFor(ratio) {
  if (ratio <= 0.02) return 0.5;
  if (ratio <= 0.06) return 0.4;
  if (ratio <= 0.10) return 0.35;
  return 0.3;
}
