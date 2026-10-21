# 五步动线详解

## ① list_books（不带参数）
返回每本书：id / title / format / chunks / total_tokens / chapter_quality。
- total_tokens：全书 ≈token（中文 ×0.75、英文 ×0.25 实测系数）。
- chapter_quality.verdict：reliable（章名可信）/ messy（章名可能是正文片段）/ none（没有章节）。
- 回应「有哪些书可查」类问题前必须先调它。

## ② 分流（唯一判据：token）
- total_tokens ≤ 10000 → read_full_book(book)：全书一口气返回，**跳过检索**。小书走检索是纯损耗（排序误差 + 可能漏），全文进上下文零检索误差。
- total_tokens > 10000 → get_outline(book)：返回章名 + 每章块数 + ≈token + 起始块号。**这是翻书的第一跳**——没有地图，大书只能瞎翻。
- get_outline 报 no-chapters（PDF 无章节）→ 直接走第 ③ 步的 read_range。

## ③ 读原文（三条路按质量选）
- get_chapter(book, chapter)：reliable 的书按章名整章通读（三级匹配 精确→前缀→包含）。截断按 token 闸 8K 算，note 里带真实 token 账和续读块号。
- read_range(book, from, to)：按块号区间连续读。messy/none 的书（EPUB 脏章名、PDF 无章）**优先用它**；也是 get_chapter 截断后的续读通道。
- query_book(book, question)：查「哪一段讲了 X」用检索；结果带定位，可再 get_chapter/read_range 取完整上下文。
- 不知道查哪本书 → query_library(question) 自动挑书（默认 4 本，maxBooks 可调）。

## ④ cite_check(book, quote)
把准备引用的句子贴回去：命中给块号/章节/页码；未命中明确说「不要采用」。**写完答案后逐条自检**，别等读者发现。

## ⑤ 无依据明说
库里没有的：直接写「本书库中没有找到依据」，给出去哪儿找的建议。**禁止**用「通常来说」「一般来说」开头编一段貌似合理的话——那是幻觉，不是知识库的价值。

## 完整动线实测案例（2026-10-21 探针第一手数据，非编造）

### 案例一：架构方案题（query_library 路线）

**输入**：「设计一个高可用的短链服务，架构上要考虑哪些要点？」

**动线**：query_library 自动挑书 → 路由给 4 本：系统设计入门(0.908)、凤凰架构(0.907)、动手学深度学习(0.895)、Hello 算法(0.889)——前两名紧贴，路由没跑偏 → 逐块取原文，凤凰架构给出三段真原文：

> 在需要高可用的生产环境中，应当考虑在网关之前部署负载均衡器或者等价路由器（ECMP）……〔凤凰架构·网关路由›网络 I/O 模型〕
> 另一条更关键的原则是奥卡姆剃刀原则……多级分流的手段……并不是越多越好。〔凤凰架构·透明多级分流系统〕
> 注意异地容灾和异地双活的差别……一般只能跨区域做双活，当然也可以将它们结合起来同时使用，即"两地三中心"模式。〔凤凰架构·客户端负载均衡›地域与区域〕

**产出**：方案里「入口扩展」「分流克制」「多区域部署」三点全部原文可回验；短链算法本身（哈希/发号器）书里没有——第 ⑤ 步明说，指向 Hello 算法的哈希表章节做参考。

### 案例二：跨语言检索（英文书必须英文问）

**输入**：「how does consistent hashing and replication work in Dynamo」

**动线**：英文书英文问 → 路由 Dynamo(0.906) + OG-AWS(0.859)，块级命中 0.946/0.938/0.933 三连高分：

> Thus, each node becomes responsible for the region in the ring between it and its predecessor node on the ring. The principle advantage of consistent hashing is ...〔Dynamo〕

**反面教训**：同一本书若用中文问故事/细节（「Dynamo 里一致性哈希怎么工作」），跨语言 embedding 双杀——路由分和块分都掉。**英文书检索题用英文问**是铁律，不是偏好。