---
name: humanities-reading
title: 人文阅读
description: 人文经典阅读技能：中国经典（论语/孟子/道德经）小书全文直读与繁体原文引用、大部头经典按章翻读、英文小说（福尔摩斯/简爱/傲慢与偏见/弗兰肯斯坦）英文问原文、小说人物编目关系网查询。不用于：工程书检索（用 engineering-research）、kk 观点考据（用 opinion-archaeology）、把经典当语录生成器（引用必须逐字回验）
metadata:
  version: 1.0.0
  category: humanities
  updated: 2026-10-21
allowed-tools: [list_books, list_catalog, list_skills, read_skill, get_person, get_theme, expand, read_full_book, get_outline, get_chapter, read_range, query_book, query_library, similar_chunks, cite_check]
sources:
  孟子: mengzi-zh
  论语: lunyu-xueer-zh
  福尔摩斯: sherlock-holmes-adventures-en.epub
  傲慢与偏见: pride-and-prejudice-en.epub
---

# 人文阅读

人文文本的价值在**原文本身**——引文不逐字，人文阅读就失去全部意义。本技能管两类资产：中国经典（繁体原典）与英文小说（原版文本），核心纪律是「小书直读、大部头翻章、人物走编目、引用繁体照抄」。

## 触发边界（先对表再动手）

**应触发**：
- 「《论语》/《孟子》/《道德经》里关于 X 怎么说」
- 「帮我读一下某一章原文 / 通读某本经典」
- 「简爱/福尔摩斯/伊丽莎白这个人物/情节原文怎么写的」
- 「伊丽莎白和达西的关系线」（人物编目查询）
- 「这段古文/英文原文帮我从书里找出来」

**不触发（明说边界）**：
- 工程书/论文/云选型—— engineering-research 的地盘
- kk 帖观点考古—— opinion-archaeology 的地盘
- 「帮我写一首论语风格的诗」——生成创作不是阅读检索
- 今译今解替代原文——本技能给原文，解读可给但必须与原文分离标注

## 参考文件索引

| 文件 | 内容 |
|---|---|
| references/ch01-classics.md | 中国经典：直读动线、双版本现象、繁体引用纪律（实测） |
| references/ch02-fiction.md | 英文小说：英文问 + 人物编目关系网（实测） |
| references/ch03-annotation.md | 引用规范：出处格式、今译边界、防「语录化」误用 |
| cheatsheet.md | 场景 → 动线速查 |

## 原文锚点（引用必带出处，可回源验证；繁体照抄）

> 孟子對曰：「王！何必曰利？亦有仁義而已矣。王曰：『何以利吾國？』大夫曰：『何以利吾家？』士庶人曰：『何以利吾身？』上下交征利而國危矣。〔孟子·梁惠王上·1〕
> 學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？人不知而不慍，不亦君子乎？〔论语·第1章〕
> To Sherlock Holmes she is always the woman.〔福尔摩斯·I. A SCANDAL IN BOHEMIA〕

**使用约定**：经典引文繁体照抄（勿自行简转繁，勿改异体字）；英文小说英文引用；出处带章名（经典）或章题（小说）。
