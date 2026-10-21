# ch01 · 六步工作流详解

从「想写个技能」到「包落盘、体检绿」的完整动线。核心顺序：**先探针、再蒸馏、后落盘**——反过来（先写后验）必返工。

## ① 探针第一手：一切从现场数据出发

写技能前先跑探针，把要写进包里的每个数字坐实：

- 探针脚本放 `books/_work/probe-<主题>.mjs`，直接查 library/*.db 或调检索层，把 chunk 号/章节名/原文片段/检索分数打出来
- **要写进包的案例，必须是探针输出的第一手记录**：块号、章节名、引文原文，全部照抄探针结果，不是照抄记忆
- 原因：书库会重建（章节数变、块号变、编目变），凭记忆写的包落盘即腐烂——kb-research 首案三条断引文全是「抄了过时的 outline 层级名」

## ② 蒸馏：方法论 + 绑书案例，不是书的搬运

技能包是**怎么用这个库的方法**，不是书摘：

- 提炼「什么场景走什么动线、踩过什么坑、铁律是什么」——判断标准：删掉具体书名后还剩多少通用方法
- 绑定具体书的案例做证据（「快排 0.959 vs 裸问漂移 0.657」），但一节技能通常绑一个主场景
- 体积纪律：单文件 ≤512KB、整包 ≤1MB（`BSP_SKILL_MAX_KB` 可调）——超了说明在搬书没在蒸馏

## ③ 起草：目录形制 + frontmatter 契约

- 目录：`SKILL.md`（主索引，常驻约 1.5K token）+ `references/chNN-*.md`（按需加载，一层深）+ 可选 `glossary.md`/`cheatsheet.md`/`catalog.json`
- frontmatter 契约：`name`=目录名 slug（kebab-case，中文进 `title`）；`description` **单行**、≤1024 字符、带负面触发（「不用于 X——用 Y」）——它是唯一的 L1 触发线索，写歪了智能体永远找不到这个包
- SKILL.md 正文 <500 行；参考文件 >100 行顶部加目录；索引表提到的文件必须真实存在（broken-reference 会拒收）

## ④ save_skill：整包重交，不是打补丁

- MCP 工具 `save_skill`（slug + files 全量文件列表）——整包原子重写，改一个字符也要整包重交
- 落盘前内部按序过三道质检（结构→引文回源→覆盖声称），任一不过整包拒收，返回 `{ok:false, stage, errors:[{reason, hint}]}`
- 桌面端没有 save 入口——写技能是智能体在对话里干的活（工具层无 LLM，内容靠对话蒸馏）

## ⑤ 拒收照 hint 修：reason → 病因 → 修法

拒收是校验器在教学，常见 reason 速查（全量见 ch02）：

| reason | 病因 | 修法 |
|---|---|---|
| bad-slug | slug 非 kebab-case | 中文书名写 title，slug 用拼音/英文 |
| bad-path | 路径不在白名单 | 只允许 SKILL.md、references/*.md、glossary/patterns/cheatsheet.md、catalog.json、scripts/* |
| file-too-large / total-too-large | 在搬书没蒸馏 | 砍到精华；引文只留够用的条数 |
| unknown-source | 引文别名没在 sources 声明 | SKILL.md frontmatter 补 `别名: bookId` |
| chapter-not-found | 章节名不存在（多是抄了层级 path） | 用 get_outline 的 `name` 字段重查 |
| quote-not-found | 引文非逐字（省略号拼接/转述） | 照抄 query_book 返回的原文重贴 |
| broken-reference | 索引指向包里不存在的文件 | 补齐文件或改索引 |
| claimed-coverage-lie / book-total-lie | 章节数声称与实际不符 | 按实际数改，或加 coverage 精选声明 |

原则：**每条 hint 都指向具体文件与改法，不许猜着改**；同一 reason 反复出现，回到①重新探针。

## ⑥ 版本+1 + 体检闭环

- 改已有技能：`metadata.version` +1（无版本号的包无法判断新旧，review 时对不上账）
- 收尾必跑体检：CLI `node src/check-skills.mjs` 或 MCP `check_skills`——红=源书删/引文断/索引断链/声称对不上（不可信不可用）；黄=源书关/无章节/catalog 异常（能用但提醒）
- **书库增删后必须重跑**：旧包的引文和声称会随书库变动悄悄失效（W5 首跑逮到 kb-research 三断引文就是实例）

## 实录：kb-research 修复首案（正规通道样板）

1. `check_skills` 报红：3 条引文断 + 1 条绕过提取器的裸别名引文
2. `read_skill` 取全文 → 探针坐实每个断点的真实块号/章节名/原文（#1698/#635/#1636/#40）
3. 逐字修复 + 平名章节 + sources 补声明 → `save_skill` 整包重交，8/8 引文全过、0 warning
4. 修后 `check_skills` 复跑：6 包全绿——**发现 → 坐实 → 正规通道修 → 复验**，这就是技能维护的标准闭环
