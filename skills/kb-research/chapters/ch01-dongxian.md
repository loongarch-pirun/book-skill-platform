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
- 不知道查哪本书 → query_library(question) 自动挑书（默认 3 本，maxBooks 可调）。

## ④ cite_check(book, quote)
把准备引用的句子贴回去：命中给块号/章节/页码；未命中明确说「不要采用」。**写完答案后逐条自检**，别等读者发现。

## ⑤ 无依据明说
库里没有的：直接写「本书库中没有找到依据」，给出去哪儿找的建议。**禁止**用「通常来说」「一般来说」开头编一段貌似合理的话——那是幻觉，不是知识库的价值。