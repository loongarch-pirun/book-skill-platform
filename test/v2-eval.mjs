// v2 金标准评测（考卷）：跨语言问答题 × 自动判分
// 用法: node test/v2-eval.mjs [--rerank off|on|both]
// 判分规则：top4 结果里出现金标准关键词（任一）算命中
// 引擎一致性：库内 meta.model 必须和当前 BSP_EMBED_MODEL 一致，否则拒绝跑
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { hybridSearch } from "../src/lib/search.mjs";
import { getEmbedder, DEFAULT_EMBED } from "../src/lib/models.mjs";

// BSP_EVAL_LIB：影子库评测覆盖（P3-⑤ 渐进重建对照用——新切片影子库先跑考卷，
// 与基线对账后才替换正式库；不设=正式库，门语义不变）
const LIB = process.env.BSP_EVAL_LIB || path.join(import.meta.dirname, "..", "library");

const GOLDEN = [
  // 名册说明（2026-10-19 考卷重建时盘点）：
  //   · 在架书（library/ 有库）正常计分：论语×2 版/孟子/道德经/P&P/Frankenstein/attention/凤凰/kkndme；
  //   · 【佚书】标记的条目（d2l/og-aws/SDP/hello-algo/简爱/福尔摩斯/三篇论文）——书曾建库编目，
  //     但库不在本机（V3 第二波~第三波-3 的历史资产，catalog JSON 仍在 git），跑时自动丢弃不计分；
  //     原料多在本机 books/_work/，哪天真重入库（第二波重入库波次），这些题自动复活。
  // ===== 论语·学（繁体版原文，金标准用书中原字） =====
  { book: "lunyu-xueer-zh.docx", q: "学了之后经常温习会怎么样", g: ["不亦說乎"] },
  { book: "lunyu-xueer-zh.docx", q: "别人不了解我我也不生气，算怎样的人", g: ["不亦君子乎"] },
  { book: "lunyu-xueer-zh.docx", q: "君子专心做人的根本，根本立住了会怎样", g: ["本立而道生"] },
  { book: "lunyu-xueer-zh.docx", q: "曾子每天反省自己的哪几件事", g: ["吾日三省", "三省"] },
  { book: "lunyu-xueer-zh.docx", q: "治理一个大国要怎么做", g: ["使民以時"] },
  { book: "lunyu-xueer-zh.docx", q: "年轻人怎么对待父母兄长和朋友", g: ["汎愛眾", "愛眾", "弟子入則孝"] },
  { book: "lunyu-xueer-zh.docx", q: "礼的运用以什么为贵", g: ["禮之用"] },
  { book: "lunyu-xueer-zh.docx", q: "不担心别人不了解自己，该担心什么", g: ["患不知人"] },
  { book: "lunyu-xueer-zh.docx", q: "贫穷不谄媚富贵不骄傲，更好的境界是什么", g: ["貧而樂", "貧而無諂"] },
  // ===== 孟子（维基文库繁体原文，2026-10-13 新书冷接入；金标准逐一回原文验真） =====
  // 编目注：本版作「天將降大任於是人也」（是人非斯人，校勘差异已核）
  { book: "mengzi-zh.docx", q: "上天要降大任给一个人之前会怎么考验他", g: ["苦其心志"] },
  { book: "mengzi-zh.docx", q: "鱼和熊掌不能同时得到该怎么选", g: ["舍魚而取熊掌"] },
  { book: "mengzi-zh.docx", q: "打仗的时候天时和地利哪个更重要", g: ["天時不如地利"] },
  { book: "mengzi-zh.docx", q: "国家当中什么最贵重，江山和君主哪个轻", g: ["民為貴", "君為輕"] },
  { book: "mengzi-zh.docx", q: "不得志的时候修养自身，得志的时候要怎么样", g: ["兼善天下"] },
  { book: "mengzi-zh.docx", q: "富贵贫穷威武什么样的考验都不能动摇一个人", g: ["富貴不能淫"] },
  { book: "mengzi-zh.docx", q: "不用学就会的能力不用想就懂的见识叫什么", g: ["良知", "良能"] },
  { book: "mengzi-zh.docx", q: "看见小孩子快要掉进井里为什么会心跳", g: ["惻隱之心"] },
  { book: "mengzi-zh.docx", q: "有人嫌禾苗不长就往高里拔，苗最后怎样了", g: ["苗則槁矣", "槁矣"] },
  // ===== 道德经（繁体校勘版原文，金标准用书中原字） =====
  { book: "daodejing-zh.docx", q: "可以说出来的道就不是永恒的道吗", g: ["非常道", "非恆道"] },
  { book: "daodejing-zh.docx", q: "最高的善像什么", g: ["水善利萬", "上善若水"] },
  { book: "daodejing-zh.docx", q: "了解别人叫聪明，了解自己叫什么", g: ["自知者明"] },
  { book: "daodejing-zh.docx", q: "再远的路从哪里开始", g: ["始於足下"] },
  { book: "daodejing-zh.docx", q: "天下最柔弱的东西是什么", g: ["莫柔弱於水"] },
  { book: "daodejing-zh.docx", q: "治理大国像做什么菜", g: ["烹小鮮"] },
  { book: "daodejing-zh.docx", q: "功业成就之后怎么办才符合天道", g: ["功遂身退"] },
  { book: "daodejing-zh.docx", q: "杯子装满了不如怎样", g: ["不如其已"] },
  { book: "daodejing-zh.docx", q: "缤纷的颜色动听的音乐厚味让人怎样", g: ["目盲", "耳聾", "口爽"] },
  // ===== Attention 论文 =====
  { book: "attention-is-all-you-need-en.pdf", q: "what kind of model does the paper propose that uses only attention", g: ["transformer"] },
  { book: "attention-is-all-you-need-en.pdf", q: "how many GPUs were used for training the big model", g: ["p100"] },
  { book: "attention-is-all-you-need-en.pdf", q: "which translation benchmark is used for english to german", g: ["wmt 2014", "wmt"] },
  { book: "attention-is-all-you-need-en.pdf", q: "what BLEU score did the big model get on english to german", g: ["28.4"] },
  { book: "attention-is-all-you-need-en.pdf", q: "what functions encode token positions", g: ["sine", "cosine"] },
  { book: "attention-is-all-you-need-en.pdf", q: "how long does one training step take on the big model", g: ["0.4"] },
  { book: "attention-is-all-you-need-en.pdf", q: "which convolutional sequence models are cited as prior work", g: ["convs2s", "bytenet"] },
  { book: "attention-is-all-you-need-en.pdf", q: "论文里的缩放点积注意力是什么", g: ["dot-product", "scaled"] },
  { book: "attention-is-all-you-need-en.pdf", q: "这篇论文用了几张显卡训练", g: ["p100"] },
  // ===== Frankenstein =====
  { book: "frankenstein-en.epub", q: "who writes the letters that open the novel", g: ["walton"] },
  { book: "frankenstein-en.epub", q: "who is falsely accused of william's murder", g: ["justine"] },
  { book: "frankenstein-en.epub", q: "who teaches the creature language in the cottage", g: ["felix"] },
  { book: "frankenstein-en.epub", q: "what does the creature ask victor to create for him", g: ["companion", "female"] },
  { book: "frankenstein-en.epub", q: "which university does victor attend", g: ["ingolstadt"] },
  { book: "frankenstein-en.epub", q: "which outdated philosopher's work first inspires victor", g: ["agrippa"] },
  { book: "frankenstein-en.epub", q: "怪物最后说要把自己怎么样", g: ["flames", "pyre"] },
  { book: "frankenstein-en.epub", q: "弗兰肯斯坦在哪个城市读大学", g: ["ingolstadt"] },
  // ===== 傲慢与偏见 =====
  { book: "pride-and-prejudice-en.epub", q: "what is the famous opening sentence about", g: ["truth universally acknowledged"] },
  { book: "pride-and-prejudice-en.epub", q: "how many daughters does the bennet family have", g: ["five"] },
  { book: "pride-and-prejudice-en.epub", q: "whom does mr collins marry after being rejected", g: ["charlotte"] },
  { book: "pride-and-prejudice-en.epub", q: "who finds lydia and wickham in london", g: ["gardiner"] },
  { book: "pride-and-prejudice-en.epub", q: "what is mr darcy's estate called", g: ["pemberley"] },
  // 判分注：Caroline Bingley 在书中多以 "Miss Bingley" 出现（同一人两种原文写法），
  // 最佳答案块（如第11章"Miss Bingley's civility"）不含字面 caroline → 判卷接受两种表面形式
  { book: "pride-and-prejudice-en.epub", q: "who tries to separate jane and bingley", g: ["caroline", "miss bingley"] },
  { book: "pride-and-prejudice-en.epub", q: "达西先生的庄园叫什么名字", g: ["pemberley"] },
  { book: "pride-and-prejudice-en.epub", q: "what legal arrangement means the estate passes to collins", g: ["entail"] },
  // ===== V3 第二波新语料（2026-10-16，md 书 5 本冷接入；每题金词逐一回原文验真后进卷）=====
  // 【佚书】og-aws/SDP/hello-algo/d2l 四本库不在本机（凤凰已回架，见下）；条目保留，重入库自动复活
  // og-aws（英文工程手册；中英混问测跨语言——AZ 题实测中文问句跨不过去，与既有「文言边界」同理登记）
  { book: "og-aws-en.md", q: "S3 的数据持久性官方数字是多少", g: ["99.999999999"] },
  { book: "og-aws-en.md", q: "在 S3 里刚创建的对象做列表操作能保证马上出现吗", g: ["eventual consistency"] },
  { book: "og-aws-en.md", q: "what do AWS regions contain", g: ["availability zones"] },
  { book: "og-aws-en.md", q: "IAM 角色最好按什么维度来分配", g: ["realm"] },
  // 金卷扩容（2026-10-20；按编目主题补盲区 t2 网络/t4 Lambda/t6 Aurora/t9 CloudWatch。og-aws 必须英文问——AZ 题教训）
  { book: "og-aws-en.md", q: "what is AWS' serverless compute offering for defining functions invoked via triggers", g: ["Lambda"] },
  { book: "og-aws-en.md", q: "which AWS service monitors resources and applications, captures logs, and sends events", g: ["CloudWatch"] },
  { book: "og-aws-en.md", q: "how large can aurora storage auto-scale per instance", g: ["64TB"] },
  { book: "og-aws-en.md", q: "which load balancer supports tcp layer 4 load balancing", g: ["NLB"] },
  // System Design Primer（英文；库里混排 ja/zh 翻译篇——跨语噪声也是真实分布）
  { book: "system-design-primer-en.md", q: "what does the CAP theorem say you can only support in a distributed system", g: ["two of the following"] },
  { book: "system-design-primer-en.md", q: "what is another name for the cache-aside strategy", g: ["lazy loading"] },
  { book: "system-design-primer-en.md", q: "which caches are mentioned for storing user sessions", g: ["redis", "memcached"] },
  { book: "system-design-primer-en.md", q: "what does horizontal scaling require of servers", g: ["stateless"] },
  // 金卷扩容（2026-10-20；补盲区 t5 负载均衡/t8 MySQL 伸缩/t6 CDN。t5/t8 目标块是中文翻译篇，中文问同语近邻）
  { book: "system-design-primer-en.md", q: "引入负载均衡器消除单点故障的代价是什么", g: ["额外的复杂性"] },
  { book: "system-design-primer-en.md", q: "在把频繁访问的内容放进内存缓存之前，先尝试配置什么来缓解 MySQL 瓶颈", g: ["MySQL 数据库"] },
  { book: "system-design-primer-en.md", q: "what is a content delivery network composed of, serving content from locations closer to the user", g: ["proxy servers"] },
  // Hello 算法（中文；图表+代码混排，代码围栏已去，正文是算法讲解）
  { book: "hello-algo-zh.md", q: "栈是一种遵循什么原则的数据结构", g: ["先入后出"] },
  { book: "hello-algo-zh.md", q: "队列遵循什么原则", g: ["先入先出"] },
  { book: "hello-algo-zh.md", q: "解决哈希冲突的链式方案叫什么名字", g: ["链式地址"] },
  { book: "hello-algo-zh.md", q: "栈的数组实现扩容时单次入栈的时间复杂度会劣化到多少", g: ["O(n)", "劣化至"] },
  // 金卷扩容（2026-10-20；补盲区 t4 二叉树/t8 堆/t9 AVL/t7 分治/t11 DP×贪心对比）
  { book: "hello-algo-zh.md", q: "堆是一棵什么树，按成立条件分为大顶堆和小顶堆", g: ["完全二叉树"] },
  { book: "hello-algo-zh.md", q: "AVL 树靠什么操作在插入删除节点后保持平衡", g: ["旋转"] },
  { book: "hello-algo-zh.md", q: "零钱兑换用贪心找不到最优解时，更适合用什么算法", g: ["动态规划"] },
  { book: "hello-algo-zh.md", q: "归并排序是哪种算法策略的典型应用", g: ["分治"] },
  // 凤凰架构（中文；分布式架构教材。2026-10-19 订正：库名 awesome-fenix-zh.md → fenix-architecture.md，
  //  改名后这 4 题曾被静默丢弃——金词已在新库复核仍在（x21/x9/x2/x4））
  { book: "fenix-architecture.md", q: "微服务中的服务降级熔断异常注入等链路治理需要在几层负载均衡里做", g: ["七层"] },
  { book: "fenix-architecture.md", q: "Paxos Raft ZAB 这类分布式共识协议被称为什么协议", g: ["强一致性"] },
  { book: "fenix-architecture.md", q: "Redis 集群从数据一致性角度属于哪种类型", g: ["AP 式"] },
  { book: "fenix-architecture.md", q: "狭义的刚性 ACID 事务在分布式系统中为什么会矛盾", g: ["CAP 不可兼得"] },
  // 动手学深度学习（中英混排；d2l-zh 中英双语篇交替）
  { book: "d2l-zh.md", q: "Fashion-MNIST 的训练集有多少张图像", g: ["60000"] },
  { book: "d2l-zh.md", q: "Fashion-MNIST 每张图像的高度和宽度是多少", g: ["28像素"] },
  { book: "d2l-zh.md", q: "用什么方法可以减轻过拟合，比如随机水平翻转图像", g: ["图像增广"] },
  { book: "d2l-zh.md", q: "在注意力机制中，自主性提示被称为什么", g: ["（query）", "被称为*查询*"] },
  // 金卷扩容（2026-10-20；补盲区 t17 Kaggle/t15 优化/t11 RNN/t5 softmax。英文篇用英文问——英文书教训同理）
  { book: "d2l-zh.md", q: "训练数据太少凑不齐验证集时，用什么交叉验证方法", g: ["折交叉验证"] },
  { book: "d2l-zh.md", q: "why does minimizing training error not guarantee the best parameters", g: ["generalization error"] },
  { book: "d2l-zh.md", q: "what does the rnn encoder transform a variable-length sequence into", g: ["fixed-shape hidden state"] },
  { book: "d2l-zh.md", q: "after training softmax regression, which class is used as the output prediction", g: ["highest predicted probability"] },
  // ===== V3 第三波-3 epub 两本（2026-10-16 冷接入；每题金词回原文验真+候选题探针实跑才入卷）=====
  // 【佚书】两本库不在本机（原料在 books/_work/epub/）；条目保留，重入库自动复活
  // 简·爱（Gutenberg pg1260；判分注：金词 "no possibility of taking a walk" 全书仅 1 处=开篇名句，
  //   top4 命中依赖复试官——与既有 og-aws AZ 题同理登记「英文文学细节题需复试官价值区」）
  { book: "jane-eyre-en.epub", q: "what was impossible to do on the day the novel opens", g: ["no possibility of taking a walk"] },
  { book: "jane-eyre-en.epub", q: "what is the name of mr rochester's country estate", g: ["Thornfield"] },
  { book: "jane-eyre-en.epub", q: "who is rochester's first wife hidden in the attic at thornfield", g: ["Bertha"] },
  { book: "jane-eyre-en.epub", q: "简爱离开盖茨黑德之后就读的学校叫什么", g: ["Lowood"] },
  // 金卷扩容（2026-10-20；补盲区 t3 Lowood 人物/t4 Thornfield 人物/t7 Grace Poole/t10 Rivers 家线。
  //  实测修订：管家题（「housekeeper」问法）答案块 #410 在 top4 拉不动——Fairfax 块噪声 125 处；
  //  换 Adèle（t4 的另一位人物，探针 rank1 过），Grace Poole 题（t7）探针 rank1 过
  { book: "jane-eyre-en.epub", q: "who is the clergyman who runs lowood school and humiliates jane in public", g: ["Brocklehurst"] },
  { book: "jane-eyre-en.epub", q: "who is the little french girl that jane works for as governess at thornfield", g: ["Adèle"] },
  { book: "jane-eyre-en.epub", q: "whose laugh does jane keep hearing from the third storey of thornfield", g: ["Grace Poole"] },
  { book: "jane-eyre-en.epub", q: "who proposes marriage to jane while she is living with the rivers family", g: ["St. John", "St.John"] },
  // 福尔摩斯冒险史（Gutenberg pg1661；12 短篇集）
  { book: "sherlock-holmes-adventures-en.epub", q: "who is the woman who outwits sherlock holmes in a scandal in bohemia", g: ["Irene Adler"] },
  { book: "sherlock-holmes-adventures-en.epub", q: "what is the address of sherlock holmes's london lodgings", g: ["Baker Street", "221B"] },
  { book: "sherlock-holmes-adventures-en.epub", q: "what kind of snake is the deadly serpent in the speckled band", g: ["swamp adder"] },
  { book: "sherlock-holmes-adventures-en.epub", q: "who is the friend and colleague who helps sherlock holmes and narrates the cases", g: ["Watson"] },
  // 金卷扩容（2026-10-20；补盲区 t4 红发会/t7 五橘核/t9 蓝宝石——短篇集人名线）
  { book: "sherlock-holmes-adventures-en.epub", q: "who brought jabez wilson the newspaper advertisement about the red-headed league", g: ["Spaulding"] },
  { book: "sherlock-holmes-adventures-en.epub", q: "what did john openshaw's relatives receive from london before dying, marked with K.K.K.", g: ["orange pips"] },
  { book: "sherlock-holmes-adventures-en.epub", q: "who did holmes confront and release for the theft of the blue carbuncle", g: ["Ryder"] },
  // ===== V3 第三波-3 论文三篇（2026-10-16 PDF 冷接入；双栏列感知解析后，金词回原文验真+探针实跑才入卷）=====
  // 【佚书】三本库不在本机（原料在 books/_work/论文/）；条目保留，重入库自动复活
  // Dynamo（SOSP 2007；Amazon 高可用键值存储）
  { book: "dynamo-2007-en.pdf", q: "what partitioning technique does dynamo use to spread its keys across nodes", g: ["consistent hashing"] },
  { book: "dynamo-2007-en.pdf", q: "what mechanism does dynamo use to capture causality between different versions of the same object", g: ["vector clock"] },
  { book: "dynamo-2007-en.pdf", q: "what quorum-like technique keeps writes available when some replicas are temporarily down", g: ["sloppy quorum", "hinted handoff"] },
  { book: "dynamo-2007-en.pdf", q: "what structure is used in anti-entropy to synchronize divergent replicas", g: ["merkle"] },
  // 金卷扩容（2026-10-20；补盲区 t4 性能评估——负载均匀分配的选型）
  { book: "dynamo-2007-en.pdf", q: "what load distribution did dynamo choose for uniform performance across nodes", g: ["uniform load", "uniform"] },
  // Lamport（1978；时间、时钟与事件排序，老式排版零星空格丢失属原料特征）
  { book: "lamport-1978-en.pdf", q: "what relation does lamport define to order events in a distributed system", g: ["happened before"] },
  { book: "lamport-1978-en.pdf", q: "what does lamport introduce into the system to assign numbers to events", g: ["logical clock"] },
  { book: "lamport-1978-en.pdf", q: "what must the system of clocks satisfy so events can be ordered by their timestamps", g: ["clock condition"] },
  { book: "lamport-1978-en.pdf", q: "how are ties broken when two events happen to get the same clock value", g: ["total ordering", "break ties"] },
  // MapReduce（OSDI 2004；Google 大规模分布式处理）
  { book: "mapreduce-2004-en.pdf", q: "which functional language inspired the map and reduce primitives", g: ["lisp"] },
  { book: "mapreduce-2004-en.pdf", q: "what is the primary mechanism mapreduce uses for fault tolerance", g: ["re-execut"] },
  { book: "mapreduce-2004-en.pdf", q: "what does the master launch to handle straggler machines that slow down completion", g: ["backup task"] },
  { book: "mapreduce-2004-en.pdf", q: "why does mapreduce schedule map tasks close to the data they process", g: ["locality", "network bandwidth"] },
  // ===== V3R7 考卷重建（2026-10-19；kkndme 正式收录。每题金词已回库 instr 验真）=====
  // 房地产主线（白话问、原文答；论坛体「作者：xxx的回复」噪声是检索难点，故 6 题里 4 题走主线）
  { book: "kkndme-zh.pdf", q: "2010 年房地产调控真正为的是什么，不是降房价吗", g: ["维稳"] },
  { book: "kkndme-zh.pdf", q: "楼主说通货膨胀对延缓灭亡来说是什么药", g: ["良药"] },
  { book: "kkndme-zh.pdf", q: "公租房推出来之后市场上的房租会整体怎么走", g: ["房租整体上涨"] },
  { book: "kkndme-zh.pdf", q: "人民币外升内贬的现象是怎么造成的", g: ["外升内贬"] },
  { book: "kkndme-zh.pdf", q: "想了解一个片区房价，楼主说要聊几家中介公司", g: ["3个中介"] },
  { book: "kkndme-zh.pdf", q: "读者问全款买房还是贷款买房更划算，楼主给了什么思路", g: ["贷款划算", "毋庸置疑"] },
  // 以史喻今副线（同一本书的历史段落——考跨主题检索：房产书里问历史）
  { book: "kkndme-zh.pdf", q: "楼主形容朱元璋发家前是个什么样的人", g: ["要饭吃的和尚"] },
  { book: "kkndme-zh.pdf", q: "崇祯皇帝最后会上吊，楼主认为根子在哪", g: ["性格缺陷"] },
  { book: "kkndme-zh.pdf", q: "宋史把贾似道写进了哪一部传", g: ["奸臣传"] },
  { book: "kkndme-zh.pdf", q: "楼主说读史读的不是故事，那读的是什么", g: ["历史规律"] },
];

const args = process.argv.slice(2);
const ri = args.indexOf("--rerank");
const mode = ri >= 0 ? args[ri + 1] : "both";
const TOPN = 4;

// 1) 校验金标准真的在书里（防止我记错原文导致误判）
const valid = [];
for (const e of GOLDEN) {
  const f = fs.readdirSync(LIB).find(x => x.startsWith(e.book) && x.endsWith(".db"));
  if (!f) { console.log(`[丢弃] ${e.book}: 找不到库文件`); continue; }
  const db = new Database(path.join(LIB, f), { readonly: true });
  const ok = e.g.some(g => db.prepare("SELECT COUNT(*) n FROM chunks WHERE instr(lower(text), lower(?)) > 0").get(g).n > 0);
  db.close();
  if (ok) valid.push({ ...e, file: f });
  else console.log(`[丢弃] 「${e.q}」金标准 ${e.g.join("/")} 不在书里（我记错原文了）`);
}
console.log(`有效题数: ${valid.length}/${GOLDEN.length}（引擎: ${DEFAULT_EMBED}）\n`);

// 2) 引擎一致性检查
const activeKey = (await getEmbedder()).key;
const dbModels = [...new Set(valid.map(e => {
  const db = new Database(path.join(LIB, e.file), { readonly: true });
  const m = db.prepare("SELECT value FROM meta WHERE key='model'").get()?.value || "(无)";
  db.close();
  return m;
}))];
// 旧库（v1 时代）没写模型名，历史事实是全部用 zh-small 灌的
const legacyOk = dbModels.every(m => m === activeKey || (m === "(无)" && activeKey === "zh-small"));
if (!legacyOk) {
  console.error(`引擎不一致！库里是 [${dbModels.join(",")}]，当前查询用 ${activeKey}。先用 embed-book.js 把库灌成 ${activeKey} 再跑评测。`);
  process.exit(1);
}

// 3) 跑卷子
const judge = (results, goldens) => {
  const low = results.map(r => r.text.toLowerCase());
  for (let i = 0; i < low.length; i++) {
    const g = goldens.find(x => low[i].includes(x.toLowerCase()));
    if (g) return { hit: true, rank: i + 1, golden: g };
  }
  return { hit: false };
};

for (const rr of mode === "both" ? [false, true] : [mode === "on"]) {
  let hits = 0, latSum = 0, rankSum = 0, latMax = 0;
  const perBook = new Map();
  const misses = [];
  for (const e of valid) {
    const t0 = Date.now();
    const rs = await hybridSearch(path.join(LIB, e.file), e.q, TOPN, { rerank: rr });
    const lat = Date.now() - t0;
    latSum += lat; latMax = Math.max(latMax, lat);
    const { hit, rank } = judge(rs, e.g);
    if (hit) { hits++; rankSum += rank; } else misses.push(e.q);
    const b = perBook.get(e.book) || { n: 0, hit: 0 };
    b.n++; if (hit) b.hit++;
    perBook.set(e.book, b);
  }
  const rate = (100 * hits / valid.length).toFixed(0);
  console.log(`===== 复试官${rr ? "开" : "关"} =====`);
  for (const [b, s] of perBook) console.log(`  ${b.padEnd(34)} ${s.hit}/${s.n}`);
  console.log(`  总分: ${hits}/${valid.length} = ${rate} 分 | 首次命中平均第 ${(rankSum / Math.max(hits, 1)).toFixed(1)} 名 | 平均延迟 ${(latSum / valid.length).toFixed(0)}ms (最慢 ${latMax}ms)`);
  if (misses.length) console.log(`  漏题: ${misses.join(" | ")}`);
  console.log(`EVAL_RESULT ${JSON.stringify({ model: activeKey, rerank: rr, total: valid.length, hits, rate: +rate, avgLatencyMs: Math.round(latSum / valid.length) })}`);
  console.log("");
}
