---
name: skill-authoring
title: 技能编写规范
description: 教智能体怎么写技能包：三道质检怎么过（结构白名单/引文回源/覆盖声称机器可验）、引文纪律（逐字照抄+平名章节+〔别名·章节〕完整格式）、六步工作流（探针第一手→蒸馏→起草→save_skill→拒收照 hint 修→版本+1）。写新技能、改旧技能、save_skill 被拒收要修时用。不用于：读书查原文（用 kb-research 或领域技能）、新书入库验收（用 book-intake）、引文核查执行（用 citation-check）、检索调参
metadata:
  version: 1.0.0
  category: ops
  updated: 2026-10-21
allowed-tools: [list_skills, read_skill, save_skill, check_skills, query_book, cite_check, list_books, get_outline, get_chapter, read_range, read_full_book]
sources: {}
---

# 技能编写规范

技能包是这个知识库的**方法论沉淀**——把「怎么用好这个库」蒸馏成智能体可复用的操作规程。本技能教你怎么写：**每一句导航性声称都机器可验，每一条引文都能回源逐字找到。**

## 触发边界（先对表再动手）

**应触发**：
- 「我想写一个新技能包 / 沉淀一套方法」
- 「save_skill 被拒收了，怎么修」
- 「旧技能包过时了/书库变了，怎么更新」
- 「技能包的结构/description/frontmatter 有什么规矩」

**不触发（明说边界）**：
- 读书/查原文——kb-research 及领域技能
- 新书入库验收——book-intake
- 逐条核查引文真伪——citation-check
- 检索算法调参——引擎波次的活

## 三条铁律（先记住再动手）

1. **探针第一手**：技能里的每个案例、每条数据，先用探针脚本现场跑出来（`books/_work/probe-*.mjs`），不许凭记忆写——记忆里的块号/章节名/分数全是上一任书库的。
2. **导航性声称机器可验**：SKILL.md 里写的文件索引、章节数、覆盖范围、工具名，必须是机器能核对的——校验器（skill:validate / saveSkill）会逐条对，写的时候就要想到它怎么查。
3. **引文纪律就是防幻觉纪律**：引文逐字照抄工具返回的原文，省略号拼接、语录化改写、模糊占位章节，三类都会在回源验证时现形（或更糟——静默漏查）。

## 六步工作流（总览，细节在 ch01）

```
① 探针第一手 → ② 蒸馏（方法论+绑书案例）→ ③ 起草（目录形制+frontmatter 契约）
→ ④ save_skill 整包重交 → ⑤ 拒收照 hint 修（reason→病因→修法见表）→ ⑥ 版本+1 + 体检闭环
```

- ④⑤ 可能循环多轮：拒收不是失败，是校验器在教你——每条 error 都带 hint，照着重修
- ⑥ 改已有技能必须 bump `metadata.version`；书库增删后跑 `check_skills`（CLI `node src/check-skills.mjs`）

## 三道质检速览（save_skill 落盘时按序过，细节在 ch02）

| 闸 | 查什么 | 不过的典型原因 |
|---|---|---|
| ① 结构 | slug/路径白名单/大小/frontmatter | 中文 slug、路径带大写、整包超 1MB |
| ② 引文回源 | blockquote 引文逐条回库比对 | 别名没声明、章节名不存在、引文非逐字 |
| ③ 覆盖声称 | 索引断链/能力声称/章节数对账 | 「全书81章」与实际不符、索引指向不存在的文件 |

## 引文纪律速览（细节+反模式在 ch03）

- 格式：引文写在 blockquote 行（`>` 开头），出处标 `〔别名·章节〕`——**别名和章节都不能省**，裸 `〔别名〕` 整个绕过提取器，属于静默漏查
- 章节名用 `get_outline` 返回的 `name` 字段（平名），**不是层级 path**（「A›B」那种库内不存在）
- 原文照抄：繁体照抄、全角标点保留、不加「……」省略号；PDF 无章节的书用 `〔别名·页码〕`

## 参考文件索引

| 文件 | 内容 |
|---|---|
| references/ch01-workflow.md | 六步工作流详解：探针→蒸馏→起草→save→修→版本+1（含 kb-research 修复实录） |
| references/ch02-quality-gates.md | 三道质检逐条拆解：每种拒收 reason 的病因与修法 |
| references/ch03-citation-rules.md | 引文纪律 + 五类反模式（自动重写/语录化/模糊占位/自行简转繁/层级路径） |

## 使用约定

- 本技能是**操作规程**，无书中引文（`sources: {}`）——教方法不代理查证，每次用时现场调工具
- saveSkill（写入时校验）与 skill:validate（标准符合度）分工不同、互不重复：前者拦内容造假，后者拦结构不规范；CI 跑后者
- 写完只是开始：书库增删后旧包会腐烂（引文断/声称过期），`check_skills` 红黄绿体检是收尾必跑（ch01 ⑥）
- 临时探针脚本一律归 `books/_work/`，不入正式目录
