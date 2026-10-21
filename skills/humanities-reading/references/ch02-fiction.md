# 英文小说：英文问 + 人物编目关系网

## 动线

1. **英文问**（四本小说全是英文书，跨语言双杀——中文问拿不到正主）
2. 情节/人物类问题：人物编目先行（list_catalog → get_person → expand 关系网）→ 摸到原文块 → 取上下文
3. 引用英文原文照抄，出处带章题

## 实测案例 1：福尔摩斯演绎法（2026-10-21 探针第一手数据）

**输入**：「Sherlock Holmes how does Holmes deduce from small details」——路由福尔摩斯(0.88) + 三本英文小说候补，块级 0.690 命中演绎法正主（「V. THE FIVE ORANGE PIPS」章）：

> "The ideal reasoner," he remarked, "would, when he had once been shown a single fact in all its bearings, deduce from it not only all the chain of events which led up to it but also all the results which would follow from it.〔福尔摩斯·V. THE FIVE ORANGE PIPS〕

同批带出《波希米亚丑闻》开篇名句（编目核心块）：

> To Sherlock Holmes she is always the woman.〔福尔摩斯·I. A SCANDAL IN BOHEMIA〕

**章题即出处**：福尔摩斯 EPUB 章名是真实章题（「I. A SCANDAL IN BOHEMIA」），引用标章题可回验。

## 实测案例 2：人物编目关系网（stage3 端到端实测数据）

傲慢与偏见有完整人物编目（P-A 机制）：`get_person("Elizabeth Bennet")` 拉到 **8 个关系邻居**——Fitzwilliam Darcy（共现 340 块）、Jane Bennet（274）、Mr. Collins（153）……

**用法**：问「伊丽莎白和达西的关系线」→ get_person 拿两人关系块 → query_book/get_chapter 取关键场景原文 → 按章节序整理关系线，每段引文带章题。

## 诚实性红线

- 情节概括必须标「概括」，与原文引用（逐字）分离呈现
- 人物名英文原形检索（Elizabeth Bennet，不译「伊丽莎白」查库——译名查不到编目）
