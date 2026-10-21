# 分流体例：体量账与章节质量

## 实测体量（2026-10-19，8 本）

| 书 | 块数 | ≈token | 读法 |
|---|---|---|---|
| 论语·学而 docx | 16 | 0.5K | read_full_book |
| 论语·学而 pdf | 4 | 0.6K | read_full_book（无章节） |
| 道德经 | 81 | 5.6K | read_full_book |
| attention 论文 | 51 | 9.6K | read_full_book |
| 孟子 | 743 | 33.7K | get_outline → read_range（261 个叶子章） |
| Frankenstein | 711 | 104.7K | get_outline → get_chapter |
| 凤凰架构 | 3737 | 383K | get_outline → get_chapter/read_range |
| P&P | 1250 | 177.7K | get_outline（章名 messy）→ read_range |

新书入库自动带这本账（build-book 写 meta）——**不需要人工维护分流表**。

## 章节质量三态怎么应对

- **reliable**（md/docx 正常标题）：放心按章名 get_chapter；get_outline 的章名就是可翻键。
- **messy**（EPUB 通病：章名是正文片段）：get_outline 会警告；按名翻章可能落空——用 get_outline 拿每章起始块号，改走 read_range 按块号读。
- **none**（PDF 无章节）：没有地图可看——read_range 按块号区间读，或 query_book 检索定位。

## token 闸行为
- get_chapter / read_range 截断按 8K token 算（块数上限 60/80 是硬顶）；返回体带 tokens 字段和续读游标——**模型要会自己算账**，一次别索要超过上下文的量。
- 章粒度在不同书之间差 20 倍（孟子 3 块/章 vs P&P 78 块/章）：别用块数估代价，看 token 字段。

## 实测案例（2026-10-21 探针第一手数据）

**路由窗口效应**：问「高可用短链服务」，query_library 给出 4 本——系统设计入门(0.908)、凤凰架构(0.907)、动手学深度学习(0.895)、Hello 算法(0.889)。第 3、4 名与第 1 名只差 0.02：**书架涨书后 maxBooks 窗口要是还停留在 2-3，正主会被挤出窗口**（历史上问「交友信用」曾错配到凤凰架构）。动线第 ① 步 list_books 先看书架规模，就是在防这个。

**体量账实例**：attention 论文 51 块 ≈9.6K token——贴着 10K 线，走 read_full_book 全文直读（9.6K < 10K）；孟子 743 块 ≈33.7K 走 get_outline 拿 261 个叶子章的地图再翻。同一动线里两条分流路都出现过，判据只有 token 一个数字。