# ch02 · 三道质检逐条拆解

save_skill 落盘时按序过三道闸，任一不过整包拒收。理解每道闸**怎么查**，写的时候才能提前规避。

## 闸① 结构（stage: structure）

| 检查项 | 规则 |
|---|---|
| slug | kebab-case：小写字母/数字/连字符，1~64 位；中文写 frontmatter title |
| 路径白名单 | SKILL.md、chapters/chNN-*.md、references/*.md、scripts/*.(mjs|js|py|sh)、glossary.md、patterns.md、cheatsheet.md、catalog.json——**路径不带大写、不带二级目录** |
| 大小 | 单文件 ≤512KB、整包 ≤1MB（BSP_SKILL_MAX_KB ≥64 时可调） |
| frontmatter | name=slug、name+description 必填；description 单行 ≤1024 字符 |

## 闸② 引文回源（stage: citation-check）

机制：只提取 **blockquote 行**（以 `>` 开头）里的 `〔别名·章节〕`，逐条回库比对：

1. **别名解析**：`别名` 必须在 SKILL.md frontmatter `sources` 里声明（`别名: bookId`）——没声明报 unknown-source
2. **书定位**：bookId 按「精确 title → id → id 前缀」匹配 library 里的书；书不存在报 unknown-source
3. **章节定位**：章节名精确匹配 chunks 表 chapter 列；章节名是纯数字时按 PDF 页码匹配
4. **原文比对**：引文按标点切子句（≥4 字），在章节原文里找——**命中率 ≥60% 才过**；不过报 quote-not-found 并附该章前 60 字实文

配套纪律（详见 ch03）：繁体照抄（验证器对称剥离校注，但**不帮你简转繁**）；原文含「一作」校注时两侧都会剥，照抄即可。

## 闸③ 覆盖声称（stage: coverage-check）

防「包装说明与内容对不上」——智能体会拿 SKILL.md 的声称当导航依据，声称必须机器可验：

| 检查 | 规则 |
|---|---|
| broken-reference | SKILL.md 索引表提到的技能文件（chNN-*.md/glossary/patterns/cheatsheet）必须在 files 里真实存在 |
| claimed-coverage-lie | 「N章速查/指南/手册/全覆盖」的 N 必须等于引文实际覆盖章数（单书技能；N 支持中文数字） |
| book-total-lie | 「全书N章」的 N 必须等于源书实际章节数 |
| coverage 字段 | frontmatter `coverage: N` 或 `N/M`——N=引文覆盖章数、M=源书总章数，对不上拒收；写了「全书N章」建议补 coverage 让智能体知道是精选集 |
| catalog.json（warning） | 不是合法 JSON / book_id 与 sources 对不上 → 黄牌提醒，暂不拒收 |

## 与 skill:validate 的分工（别搞混）

| | save_skill（三道质检） | skill:validate（W2 标准符合度） |
|---|---|---|
| 时机 | 写入时（对话智能体调 save_skill） | CI + 本地 `npm run skill:validate` |
| 管什么 | 内容造假：引文假、声称谎、索引断 | 结构规范：slug/README 混入/嵌套深度/description 单行/正文行数/链接完整 |
| 不过的后果 | 整包拒收（落不了盘） | CI 红（落盘了但不合标准） |

两边互不重复：saveSkill 放过的不代表 validate 放过（例：description 多行、references 两层深，saveSkill 不查，validate 报 error）。

## 黄牌与体检的分层

- saveSkill 的 catalog.json 问题是 warning（不拦落盘）；check_skills 体检把它们升级成黄灯可见
- 体检还管 saveSkill 够不着的事：源书被删（红）、源书被关（黄，书还在引文仍可回源）、无章节文件（黄）
- **落盘过关 ≠ 永远过关**：书库重建后「全书81章」可能变「全书79章」——save 时是真的，体检时是假的。这就是书库增删必跑体检的原因
