# Scale 缺陷台账 · book-skill-platform · V3 第四波 P1+P2 标准轮 · 档位：标准

- **范围**：P1 入口四件 #165~#168（assets/book-view/两段导入/两档删除）+ P2 结构化改造 #169（structurize）
- **方法论**：`AI编码工作流资产\通用代码质量验证方法论-skill.md`（五步流水线 / 判级表 / 硬证据 6.1 / 五会话拆分 6.2）
- **规划文件**：`.workbuddy\plans\electric-pulse-babbage-GAOHrqlD.md`（已获批）
- **代码基线**：HEAD=8296a3d（P2 收官 4 commit 975a176/43b34bd/27b2a8b/8296a3d 已于本轮补推 origin/main，前置阻塞解除）；不变性对拍父提交 d18a447
- **双轨说明**：P2 轨（#169）优先修；P1 轨源 C1~C41（Review Surface Map 附录 A）随行

## 状态：步骤 3（S3 分组修复）上段完成 —— F1/F2a/F2b/F3/F4 全修，下段 F5~F8 待启动

S1 完成判据：全量入账 + 疑点逐条核验归级（本文档）。S2 起每会话开头只喂「方法论 + 本 ledger」。
S2 完成判据：51 发探针实跑、红绿预判全坐实（下文硬证据节）；套件挂载 test:fast/test:ci + guard §17 对账（同 commit）。
S3 完成判据（上段 F1~F4 + 检查点）：P2 轨四组缺陷全清、每组专家团审验 PASS 后一组一 commit；fuzz FAIL 25→上段归零部分（余下段组）、无新红。

## S2 对抗实测（硬证据 · 方法论 6.1）

- **命令**：`node test/entry-adversarial-fuzz.mjs`（自包含：tmp 目录+合成夹具+猴子补丁，不碰 library/ 真库、不连网、不加载模型）
- **环境**：Node v22.22.2 ｜ win32 x64 ｜ 2026-10-18 00:54 +0800 ｜ HEAD=8296a3d（产品码零改动，仅测试侧）
- **退出码**：1（fail>0 即 1，符合对抗套件预期）
- **汇总行原文**：`===== entry-adversarial-fuzz: 46 PASS / 25 FAIL / 2 OBSERVE / 1 SKIP =====`
- **分段计数**（断言结果）：A 段 12 发 = 24 PASS / 4 FAIL｜B 段 6 发 = 5 PASS / 2 FAIL / 1 OBSERVE｜C 段 14 发 = 5 PASS / 10 FAIL / 1 OBSERVE｜D 段 4 发 = 1 PASS / 3 FAIL（+1 NOTE）｜E 段 5 发 = 4 PASS / 1 FAIL｜F 段 10 发 = 7 PASS / 5 FAIL / 1 SKIP —— 合计 51 发探针 / 74 条断言结果
- **与预判核对**：计划预判 FAIL ≈ 25~31（19 旧红 + 6 新红探针失败断言）、PASS ≈ 40+、OBSERVE 2、SKIP 1、exit 1 —— **实跑 25/46/2/1 全部落入预判，无非预期**（红探针全红、绿锁全绿）

### FAIL 行逐条原文（禁转述）与缺陷对照

| 探针 | FAIL 输出原文 | → 缺陷 |
| --- | --- | --- |
| A1 | `FAIL - A1 权重精确：15 个 3 字符签名的 100 字符块真实乱码率 45%（修复前算成 30% 放过） \| ratio=0.300 bad=30（真实坏字符 45）` | P2-01 |
| A3 | `FAIL - A3 lone surrogate 前置剥离 + 入账（不到 sqlite 绑定） \| strippedSurrogates=undefined 残留=true` | P2-02 |
| A4 | `FAIL - A4 assessCleaned 对 null 元素不抛（lib 层契约与 structurizeChunks 对称） \| 抛 TypeError: Cannot read properties of null (reading 'text')` | P2-03 |
| A8 | `FAIL - A8 块级 0.5 边界：20 签名块（真实乱码率 60%）整块丢垃圾 \| kept=1 droppedGarbage=0` | P2-01 |
| B1 | `FAIL - B1 TOCTOU：读取失败给人话状态码（不裸抛穿层） \| 裸抛 ENOENT` | C11 |
| B2 | `FAIL - B2 换库后缓存不串味（key 含 libDir） \| 命中旧库缓存返回甲的 HTML` | C12 |
| C1 | `FAIL - C1 取消后无复活事件（墓碑挡住 struct emit 幽灵横幅） \| 复活 1 条：slice/undefined` | C21 |
| C2 | `FAIL - C2 取消后无复活事件（墓碑挡住 failed emit 持久幽灵） \| 复活 1 条：failed/加工失败` | C21 |
| C3 | `FAIL - C3 tmp 转换文件按内容区分（换源不碰撞：甲/乙两份都在） \| swap 文件 1 个（swap.docx）；甲=false 乙=true` | C33 |
| C6 | `FAIL - C6 取消杀掉 txt2docx 子进程（转换不落地） \| 取消后转换仍跑完并落盘（子进程没挂上取消闸门）` | C22 |
| **C8（新）** | `FAIL - C8 safeBookId 拒 NUL（修复前放行带 NUL 的 id） \| 返回="a\u0000b"` | **C1** |
| **C10（新）** | `FAIL - C10 resumeCatalog 逃逸 id → UserError「书名不合法」（修复前：读库外任务书，人话不含书名） \| UserError: 书库文件不见了：C:\Users\JIANGX~1\AppData\Local\Temp\bsp-entry-adv-HTzedX\evil.db` | **C2** |
| **C11（新）** | `FAIL - C11 catalogPrompt 逃逸 id → UserError「书名不合法」且 prompt.md 不落上级目录 \| 竟返回 path=C:\Users\JIANGX~1\AppData\Local\Temp\bsp-entry-adv-HTzedX\evil.prompt.md` | **C2** |
| **C12（新）** | `FAIL - C12 导入 x..pdf → 人话拒（派生 id 含 ..；修复前放行出永卡条目 + 幽灵文件） \| 竟导入 bookId=x..pdf` | **C3** |
| **C13（新）** | `FAIL - C13 导入 ..txt → 人话拒（修复前放行 title="." 怪行 + 幽灵文件） \| 竟导入 bookId=..docx` | **C3** |
| **C14（新）** | `FAIL - C14 dest 大小写碰撞 → 人话拒且原书内容不动（win32 折叠语义：修复前静默覆盖） \| 竟导入 bookId=Book.docx` | **C6** |
| D1 | `FAIL - D1 rmSync EBUSY → UserError 人话（不半删不裸抛） \| Error: EBUSY: resource busy or locked, open 'C:\Users\JIANGX~1\AppD`（探针 extra 截断至 60 字符） | C16/C35 |
| D2 | `FAIL - D2 db rmSync EBUSY → UserError 人话且库文件不动（半途失败可描述） \| Error: EBUSY: resource busy or locked, open 'C:\Users\JIANGX~1\AppD`（截断同上） | C17 |
| D3 | `FAIL - D3 开关状态写失败不拖垮删除（书库照删，用户不看到假失败） \| 装抛 EBUSY: resource busy or locked, open 'C:\Users\JIANGX~1\AppD`（截断同上） | C18 |
| E3 | `FAIL - E3 data-cid 转义（引用徽标属性注入面，results+cloud 两处） \| data-cid 2 处，含裸 onmouseover 注入` | C30 |
| F2a | `FAIL - F2a lone surrogate 前置清洗 + 入账（不到 sqlite 绑定变 FFFD） \| strippedSurrogates=undefined 库内FFFD=true` | P2-02 |
| F4 | `FAIL - F4 BSP_STRUCT 六值矩阵（只有 "0 " 分支修复前为红） \| "0 " 尾空格视同关（修复前失灵=开）：期望关实际开` | P2-04 |
| F5 | `FAIL - F5 onStage(structurize) 抛错不穿出 main（包底，继续建库） \| 穿出：boom-onstage-1` | P2-05 |
| F6 | `FAIL - F6 onStage(slice) 抛错不穿出 main（包底，继续建库） \| 穿出：boom-onstage-2` | P2-05 |
| F9 | `FAIL - F9 main 全链 0.3 边界拦（P2-01 全链版：修复前隐形入库） \| r=true 库存在=true captured=建库完成: f9.db`（captured 多行截断） | P2-01 |

### OBSERVE 与 SKIP 原文

- `OBSERVE - B6 并发同 docx 转换次数登记（1=已有 in-flight 去重 / 2=无去重双转） | convert 调用 2 次`（C15 现状：无 in-flight 去重，F4 修后翻转登记为 1）
- `OBSERVE - C4 Windows 保留设备名/尾空格文件名创建行为登记（libuv \?\ 前缀实证） | aux.txt 创建=true；「尾空格 .txt」创建=true`（C4/C37 现状登记）
- `SKIP - F10 BSP_SEMANTIC=1 与结构化同开（需加载嵌入模型，排 slow 套件，本轮登记不跑）`（P2-06，slow 套件执行期定）

### 新补绿锁（本轮 4 组 12 断言全绿）

- A10（M-01 立红依据）：`PASS - A10 单签名不修（hints≥2 闸门锁定；M-01 hints<1 变异立红依据）` —— 单签名「éa」搭 ASCII 证据，绕过 hints 闸门即可被修，锁住 M-01（A5b 纯 é 恒等 roundtrip 拦得住，锁不住该变异）
- A11（M-07 立红依据）：8 断言全绿（null→false、全零→false、6 计数器各 +1→true）；F2a 同 commit 扩 7 字段
- A12（M-04 立红依据）：`PASS - A12a 99 干净字符 → 拦「内容太少」（100 字硬闸门下界）` + `PASS - A12b 100/101 干净字符 → 过闸（边界值恰放行）`
- C9（C1 行为锁）：`PASS - C9 startProcessing NUL id 不崩（UserError + jobs 无残留条目）`

### 测试侧稳定性记录（产品码零改）

- C11 首跑崩：catalogPrompt 是同步函数不返 Promise，settle 直接吃 `p.then is not a function` → 照 D4 先例包 async IIFE（二跑全量通过）
- 写入前用一次性预检脚本（books/_work/，跑完即删）核验 9 项前置行为：NUL 路径 existsSync 吞错、x..pdf/..txt 派生 id、逃逸读取/落盘、win32 折叠覆盖——与预判全吻合后才落探针

### 结论

- 25 条 FAIL 与台账缺陷 1:1 坐实（含 6 发新红探针补齐的 C1/C2×2/C3×2/C6——原「严重级无红证」缺口闭合）；绿锁 12 断言锁定不误伤边界
- **挂载后 S3 期间 test:fast 预期为红（缺陷坐证），F1~F8 修完回绿**；不得为求绿弱化探针
- 下一轮 S3 八组修复（F1→F8）→ S4 五门 → S5 归档

## 缺陷清单

### P2 轨（结构化改造 #169，优先修）

| ID | 文件:行号 | 描述 | 级别 | 状态 | 修复commit |
| --- | --- | --- | --- | --- | --- |
| P2-01 | src/lib/structurize.mjs:41（权重×2）、:14/:16/:81（阈值）、:112（块级） | 拒修乱码块按 0.3 边界隐形入库、report 全零——违反「库内无乱码残留」不变量；根因=权重×2 低估 3 字符双重编码签名实际占用（100 字符块 15 签名实测真实乱码率 45% 被算成 30%）；repairMojibake 又被 >0xff 闸门拒修 | 致命（静默篡改持久化状态+审计失效，实测复现） | **已修 3b81aa9（F1）**｜坐实 A1/A8/F9｜专家团毛求疵/陆回测双 PASS | |
| P2-02 | src/lib/structurize.mjs:89-126（无 surrogate 处理）；build-book.js 入库点 | lone surrogate 经 sqlite 绑定静默转 U+FFFD 穿库，无夹具；structurize 跑在绑定之前原样穿层 | 致命（静默数据损坏，实测坐实） | **已修 802a9d2（F2a）**｜坐实 A3/F2a（A9 机理）｜毛求疵/陆回测双 PASS |
| P2-03 | src/lib/structurize.mjs:73/:74 | assessCleaned 直取 `c.text`（[null] 抛 TypeError），structurizeChunks 却 `c?.text ?? ""`——契约不对称，违 lib 层不 throw 铁律 | 严重 | **已修 802a9d2（F2a）**｜坐实 A4｜毛求疵/陆回测双 PASS |
| P2-04 | src/lib/structurize.mjs:14/:16/:18/:81/:112；src/build-book.js:490 | 100 字符/0.3 ratio/块级 0.5 三档边界无夹具；BSP_STRUCT `"0 "` 尾空格陷阱（`"0 " !== "0"` 开关失灵，实测） | 一般 | **已修 bbc9c80（F2b）**｜坐实 F4（尾空格+零宽+全角变体）/A12（字数档）｜双 PASS |
| P2-05 | src/build-book.js:489/:506 | onStage 抛错无 try → 穿出 main → jobs 横幅卡「结构化改造中」，重导入被拒 | 一般 | **已修 bbc9c80（F2b）**｜坐实 F5/F6｜双 PASS |
| P2-06 | src/build-book.js:490-505 × src/desktop/jobs.mjs 管线 | BSP_SEMANTIC 同开无测；结构化闸门经 jobs 全链无行为测 | 一般（测试缺口） | 探针（F 段） | |
| P2-07 | src/lib/structurize.mjs 全件 | G1~G9 变异候选现套件仍绿，缺探针 | 一般（测试缺口） | 探针+变异（M-01~08） | |
| P2-08 | — | 5 本真书全链路 sha256 不变性对拍 + 干净书 report 全零断言缺位 | 一般（测试缺口） | 门禁③ | |

### P1 轨（入口四件 #165~#168，源 C1~C41）

| ID | 文件:行号 | 描述 | 级别 | 状态 | 修复commit |
| --- | --- | --- | --- | --- | --- |
| C1 | src/lib/assets.mjs:21 | safeBookId 放行 NUL（实测 Node 22 path.join 容错+existsSync 吞 ERR_INVALID_ARG_VALUE，链路降级 404/UserError 无崩溃无穿越——闸门名不副实，靠下游吞错兜底） | 一般 | **已修 1365b91（F3）**｜坐实 C8（C9 行为锁）｜双 PASS |
| C2 | src/desktop/jobs.mjs:197/199-202/248/260-262 | resumeCatalog/catalogPrompt/scanPending 无 safeBookId：taskPath 可 `../` 逃逸、resultPath 任意文件读 | 严重 | **已修 1365b91（F3）**｜坐实 C10/C11｜双 PASS |
| C3 | src/desktop/jobs.mjs:73-74 | 文件名派生 bookId 未经 safeBookId：「x..pdf」幽灵条目永卡书架、「..txt」出 title="." 怪行 | 严重 | **已修 14a86c3（F8）**｜坐实 C12/C13（C13b 隐藏文件同族）｜双 PASS |
| C4/C37 | src/desktop/jobs.mjs:85-86 | Windows 设备名/尾空格文件名：覆盖或 id 与磁盘名不一致 | 一般 | 探针锁定+人话文案 | |
| C5 | — | ADS 冒号/超长 id >255/MAX_PATH | 疑点→挂起 | 真机轮 | |
| C6 | src/desktop/jobs.mjs:85-86 | 大小写折叠碰撞：双导入 dest 同名覆盖，两条书架条目指向同一文件 | 严重 | **已修 14a86c3（F8）**｜坐实 C14（+C14b id 级折叠）；运行时 FS 探测覆盖 win32/macOS｜双 PASS |
| C7 | src/desktop/book-view.mjs:117-119 | 损坏 docx → 500 人话路径无测试 | 一般 | **已锁（C7a/C7b 探针，F4 随异常路径落地时转绿）**——行文过期修正（陆 F8-FAIL-2） | |
| C8 | src/desktop/book-view.mjs:100/107 | docx zip 炸弹：只挡文件体积，无解压尺寸/超时闸门 | 严重 | 挂起→候选解压尺寸闸门 | |
| C9 | src/desktop/book-view.mjs:47-51 | UTF-16BE/无 BOM UTF-16 静默乱码（P2 后部分缓解） | 一般 | 登记+探针 | |
| C10 | src/desktop/book-view.mjs:100-104 | 49MB 临界 txt 双倍内存 + 渲染进程 ~100MB HTML | 严重 | 挂起→候选流式/早闸门 | |
| C11 | src/desktop/book-view.mjs:103/108 | TOCTOU：exists 后文件被删 → readFileSync/statSync 未捕获 → 协议请求无状态码失败 | 严重 | **已修 b3810f7（F4）**｜坐实 B1/B1b｜双 PASS |
| C12 | src/desktop/book-view.mjs:109 | 缓存 key 无 libDir → applyConfig 换库后同名同尺寸同 mtime 串味 | 严重 | **已修 b3810f7（F4）**｜坐实 B2｜双 PASS |
| C13 | src/desktop/book-view.mjs:80-83 | LRU 淘汰序未测（只测命中内容一致） | 一般 | 待修（F4/F8 补探针） | |
| C14 | src/desktop/book-view.mjs:89-91 | "%zz"/主机名变体靠 catch 无显式测试 | 一般 | 待修（F8 补断言） | |
| C15 | src/desktop/book-view.mjs:112-116 | 并发同 docx 双 mammoth 转换（无 in-flight 去重） | 一般 | **已修 b3810f7（F4）**｜B6 OBSERVE 2→1 翻转登记｜双 PASS |
| C16/C35 | src/desktop/engine.mjs:104-107 | deleteBook rmSync 无 try：Windows EBUSY → 半删（db 没 -wal 在）+ 裸抛 | 严重 | 待修（F5）｜坐实 D1 | |
| C17 | src/desktop/engine.mjs:124-133 | purgeBook 第二步 db rmSync 无 try：原件已删库删失败 → 书架 processed 但 asset 消失；purgeArchives 在 engine 返回后才跑 → 存档未清 | 严重 | 待修（F5）｜坐实 D2 | |
| C18 | src/desktop/engine.mjs:108/134；src/lib/skill-state.mjs:29 | setSkillEnabled writeFileSync 无兜底：文件已删但整调用报错（用户见失败实则成功） | 一般 | 待修（F5）｜坐实 D3 | |
| C19 | src/desktop/engine.mjs:118-139 | 并发双 purge 竞态（二次见空 UserError，行为尚可无测试） | 一般 | 探针锁定 | |
| C20 | src/desktop/engine.mjs:103 | deleteBook 精确匹配：大小写/空白变体得误导文案 | 一般 | 待修（F5 文案） | |
| C21 | src/desktop/jobs.mjs:47-52、151-156、158-162 | 取消后 emit 复活：buildBook 失败路径 emit failed 重建条目（持久幽灵横幅）；脏书 struct emit 瞬建瞬删（幽灵闪烁） | 严重 | 待修（F6 墓碑）｜坐实 C1/C2 | |
| C22 | src/desktop/jobs.mjs:300 vs :279 | txt2docx 子进程未挂 j.child → 取消杀不到，reject 落 failed emit 叠加幽灵 | 一般 | 待修（F6）｜坐实 C6 | |
| C23 | src/desktop/jobs.mjs:234-239 | 终态后取消：cancelled 残留（下次导入自愈） | 轻微 | 登记 | |
| C25 | src/desktop/engine.mjs:370 | humanizeError ENOENT 正则把非书库操作误报「书库文件不见了」，code 统一 db-missing | 一般 | **已修 14a86c3（F8）**｜D5 直证（.db→书库文件；books/→保真原文）｜双 PASS |
| C26 | src/desktop/ipc.mjs:95-100 | openExternal 错误文案回传绝对路径 | 疑点→轻微·可接受 | 登记 | |
| C27 | src/desktop/ipc.mjs/preload.js | 通道无参数形状校验 | 一般 | 随 C2 修（F3） | |
| C29 | src/renderer/views.js/views-ask.js | 全库零 XSS/转义断言（书名可合法含 `<`、`>`、引号） | 严重（测试面） | **已修 325d52b（F7）**｜E1/E2/E3/E3b/E6 五发常驻 + guard 四条绳索｜双 PASS |
| C30 | src/renderer/views-ask.js:54/123 | data-cid 未 esc（当前为 sqlite 整数，低危但不一致） | 轻微 | **已修 325d52b（F7）**｜坐实 E3；九处实际未转义面全清（含 chat×3/reader×3/views.js×2 自查扩面）｜双 PASS |
| C31 | src/renderer/views-reader.js:50 | iframe 无 sandbox：mammoth HTML 原样入，docx 内 http(s) 图片发起网络请求 | 疑点→一般 | 登记→后续评估 | |
| C32 | src/renderer/app.js:136 | state.jobs 以 bookId 为键 spread，"__proto__" 键无断言 | 轻微 | **已锁 325d52b（F7）**｜E4 常驻（自有属性 + 原型不污染）｜双 PASS |
| C33 | src/desktop/jobs.mjs:297-309 | tmp 稳定路径保幂等但永不清理 + 同名 base 碰撞覆盖（第二个换源，重灌保护误判「另一本书」） | 一般 | 待修（F6 hash 命名）｜坐实 C3 | |
| C34 | src/desktop/jobs.mjs:268 | catalog prompt.md 累积（与任务书同命运、幂等覆盖） | 疑点→轻微 | 登记（设计行为） | |
| C38 | src/desktop/jobs.mjs:85-86 | WPS 打开中导入共享违规分支无测 | 疑点→一般 | 登记 | |
| C39 | src/lib/search.mjs:46-51 | 指纹缓存同 size+mtime 内容替换不刷新 | 轻微 | 登记 | |
| C40 | src/desktop/engine.mjs:50-71 | enrichSummary 每书一只读句柄（有 finally close 无泄漏，仅并发压力） | 一般 | 登记 | |
| C41 | test/ipc-test.mjs:46/137 | 「十七本」硬编码——真库漂移即红（非产品缺陷） | 轻微 | 登记 |

## 疑点清单

| ID | 描述 | 核验结论 | 去向 |
| --- | --- | --- | --- |
| C26 | openExternal 错误文案回传绝对路径 | 单用户本地应用、路径帮定位；两路只回路径本身 | 轻微·可接受，登记 |
| C34 | catalog prompt.md 累积 | 设计意图（与任务书同命运、幂等覆盖） | 登记 |
| C5/C36/C38 | Windows 特有（ADS/8.3 短路径/保留名+尾空格/共享违规） | 难沙箱复现 | 挂起→真机验收轮 |
| C31 | iframe 无 sandbox | 受信转换器（mammoth 无 script）+ 图片加载是产品功能 | 登记→后续评估 sandbox |
| P2-G2 | 西里尔 mojibake 不检出 | 已知限制（MOJIBAKE_RE 签名表覆盖拉丁系） | 探针锁定不误伤+登记已知限制 |
| P2-G7 | 补充平面 PUA 不检出 | 已知限制 | 探针锁定不误伤+登记已知限制 |

## 门禁记录

| 门禁 | 结果 | 证据(命令/输出/文件) |
| --- | --- | --- |
| ① 回归 fast 30 套 | 待 S4 | |
| ① 回归 slow 10 套 | 待 S4 | |
| ② 基线 eval-gate 93 | 待 S4 | |
| ③ 不变性 5 书 sha256 对拍+report 全零 | 待 S4 | |
| ④ 变异 M-01~M-18 全立红 | 待 S4 | |
| ⑤ Lint 0 | 待 S4 | |

## 遗留事项（排入下一轮）

- C5/C36/C38 → 真机验收轮（Windows 特有）
- C31 → 后续评估 iframe sandbox
- C8/C10 → 候选方案排期（解压尺寸闸门 / 流式）
- C26/C34/C39/C40/C41 → 登记不修
- P2 G2/G7 → 已知限制登记

## 修复分组索引（S3 执行顺序：致命→严重→一般，P2 优先）

| 组 | 契约域 | 缺陷 |
| --- | --- | --- |
| F1 | 乱码权重精确化 | P2-01（致命） |
| F2a | 符号族+null 对称 | P2-02（致命）、P2-03（严重） |
| F2b | 开关+回调 | P2-04、P2-05 |
| F3 | bookId 闸门统一 | C1、C2、C27 |
| F4 | 协议 handler | C11、C12、C15 |
| F5 | 删除半途失败 | C16/C35、C17、C18、C20 |
| F6 | jobs 竞态/tmp/幽灵条目 | C21、C22、C33、C3、C6 |
| F7 | 渲染转义+挂载+guard §17 | C29、C30、C32 |
| F8 | 一般项收尾 | C7、C13、C14、C25 |

## S3 执行记录（一组一 commit，专家团审验 PASS 后落）

| 组 | 状态 | commit | 验证硬证据 | 成员结论 |
| --- | --- | --- | --- | --- |
| F1 乱码权重精确化 | **已修** | 3b81aa9 | structurize-test 九节全绿（含新钉子 bad=20/30）；fuzz 49 PASS/22 FAIL/2 OBSERVE/1 SKIP，转绿恰 {A1,A8,F9}，集合级 diff 新红=空（22⊆25）；guard 91 绿；eslint 0 | 毛求疵 PASS（7 OBSERVE：3 条采纳同 commit=lastIndex 硬化/白名单注释/钉子测试；2 条登记工单见下）；陆回测 PASS（FAIL 无） |
| F2a surrogate 剥离 + null 对称 | **已修** | 802a9d2 | structurize-test 43 PASS（第 7 节 9 字段全零精确相等）；fuzz 53 PASS/19 FAIL/2 OBSERVE/1 SKIP，转绿恰 {A3,A4,F2a}，集合差新红空（19⊆22），A11c strippedSurrogates=1→true；guard 91 绿；jobs-test 全 PASS；ipc-test 29 PASS；eslint 0 | 毛求疵 PASS（高 0/中 3/低 5/观察 2：M1/M2/L1/L2 同 commit 采纳；M3 grep 坐实构造点唯一=关闭；余登记）；陆回测 PASS（FAIL 无） |
| F2b 开关 + 回调 | **已修** | bbc9c80 | fuzz 56 PASS/16 FAIL/2 OBSERVE/1 SKIP，转绿恰 {F4,F5,F6}（19→16），F4 十值矩阵全绿（含零宽/全角/前导空/制表换行）；F5/F6 加调用序列断言；guard 91 绿（③ 放宽为语义存在性）；structurize/jobs/ipc（29 PASS）全绿；eslint 0 | 毛求疵 PASS（无 FAIL，5 OBSERVE 全部同 commit 处置：零宽换脸复现→归一化、async 契约注释、catch 留日志、guard 放宽、onStage 两处 grep 坐实）；陆回测 PASS（FAIL 0，O1 补跑 ipc、O5 加序列断言、余登记） |
| F3 bookId 闸门统一 | **已修** | 1365b91 | fuzz 61 PASS/13 FAIL/2 OBSERVE/1 SKIP，转绿恰 {C8,C10,C11}（16→13），C8b/C8c win32 冒号/尾点双平台语义锁；jobs/ipc（29）/guard（91）/enrich-job（30）/book-view（31）全绿；eslint 0 | 毛求疵 PASS（无 FAIL；OBSERVE-2 ADS 冒号/OBSERVE-3 尾点/OBSERVE-4 留痕/OBSERVE-5b resultPath 澄清同 commit 处置；C1 区间/误伤面/includes 过宽/scanPending 直证登记）；陆回测 PASS（FAIL 0；OBSERVE-4 → G-08；OBSERVE-5 enrich 补跑闭环） |
| F4 协议 handler | **已修** | b3810f7 | fuzz 65 PASS/11 FAIL/2 OBSERVE/1 SKIP，转绿恰 {B1,B2}（13→11），B1b docx statSync TOCTOU/B6b 不同书并发不折叠 新断言全绿；B3 LRU calls=10 绿锁未破；B6 OBSERVE calls 2→1 翻转；book-view 31 pass；ipc 29 PASS；guard 91；eslint 0 | 毛求疵 PASS（无硬阻断；O1 currentLibDir 契约核实恒返字符串→条件阻断关闭；O2 ctimeMs/O3 状态码/O4 单次 stat/O6 归一化 同 commit；O5 超时/O8 纯函数 登记）；陆回测 PASS（FAIL 0，第 11 条红经核为 C6 无缺项） |
| F5 删除半途失败 | **已修** | b8b71d4 | fuzz 69 PASS/8 FAIL/2 OBSERVE/1 SKIP（纯净 F5 态，F6 改动 stash），转绿恰 {D1,D2,D3}（11→8）；D1b wal 顺序直证/D2 文案「再点一次」/D3 patch 命中计数 新断言全绿；guard 92 绿（+删除顺序契约）；ipc 29/enrich 30 全绿；eslint 真退出码 0 | 评审对抗官条件性 PASS（F-A deleteBook 空守卫/F-B purge 原件吞错 核实均不成立=关闭；O1 顺序前提核实 makeBookDb 只建主库=关闭；O2/O3/O5 同 commit；O4 幂等/O6 僵尸登记）；测试验证师有条件过关（D1 零删除/D3 patch 直证 两条 FAIL 已同 commit 补齐） |
| F6 jobs 竞态/幽灵 | **已修** | da907c6 | fuzz 75 PASS/4 FAIL/2 OBSERVE/1 SKIP，转绿恰 {C1,C2,C3,C6}（8→4）；C1b jobsStatus 无残留/C1c 代际防线/C3b 同内容幂等/C6 幽灵事件 新断言全绿；jobs/ipc(29)/guard(92)/enrich(30)/book-view(31) 全绿；eslint 真退出码 0 | 评审对抗官 PASS（F1 代际竞态阻断→epoch 方案落地；F2 墓碑只入口清/F3 orphan 短路/O1 16hex/O2 流式/O3 取消不抛 同 commit；O4/O5/O6 核实覆盖）；测试验证师 PASS（实跑差分 69/8→75/4、C6 假绿手工对照排除）+ FAIL F2 代际零覆盖/F3 C6 单断言 已同 commit 补齐；F1 eslint 红归属 F2a 遗留另 commit 647e3e8 |
| F7 渲染转义 | **已修** | 325d52b | fuzz 78 PASS/3 FAIL/2 OBSERVE/1 SKIP，转绿 {E3}（4→3）；E3 三载荷精确断言（data-cid 值逐字=esc(id)）/E3b 集成计数恰 2/E6 chat 常驻 全绿；guard 96 绿（+4 转义绳索）；book-view 31/renderer-graph 全 PASS/ipc 29 全绿；eslint 真退出码 0 | 评审对抗官 PASS（代码侧 0 阻断：esc 对双引号属性完备/单趟不二次扫描/DOM 反查不失配；F1 载荷字面量可绕过→三载荷精确断言、F2 覆盖率 1/9→renderCite 单点+E6 同 commit；O1 全属性扫/O4 消费链/O15/O17 采纳；O3 on*/O7 URL/O14 tagged template 登记）；测试验证师 PASS（实跑 jsdom 四处渲染面全转义；F1 cites 未进断言→===2、F2 文本节点→esc、O1 E6、O2 guard 通用绳索 同 commit） |
| F8 一般项收尾 | **已修** | 14a86c3 | fuzz **85 PASS / 0 FAIL / 2 OBSERVE / 1 SKIP EXIT=0**（25 红全清 25→0）；C8d 保留名/C13b 隐藏文件/C14 补文案+零状态断言+折叠 FS 探测/C14b id 级折叠/D5 ENOENT 保真 新断言全绿；**npm run test:fast EXIT=0**；jobs/ipc(29)/guard(96)/enrich(30)/book-view(31)/renderer-graph/structurize 全绿；eslint 真退出码 0 | 评审对抗官 PASS（F1 macOS 折叠阻断→运行时探测/F2 空 base/F3 保留名/OBSERVE 全部同 commit；F4 核实 mkdir 在 readdir 前=关闭）；测试验证师 PASS（25→0 逐 commit 实跑逐位一致、闭环 3+3+3+3+2+3+4+1+3=25、零回归）+ FAIL-2 C25/FAIL-3 C14 断言/FAIL-4 id 级折叠/O-1 fail-safe/O-3 平台护栏 全部同 commit 补齐 |

## S3 下段检查点 + S4 五门（2026-10-18）

- **F5~F8 全修 + F5b 补漏**：b8b71d4（F5 删除半途失败）→ 8729f86（F5b C20 变体文案）→ da907c6（F6 墓碑+代际/转换命名/child 闸）→ 325d52b（F7 renderCite 单点+九处转义）→ 14a86c3（F8 派生 id 闸+折叠防护+C25 保真）→ 647e3e8（lint 修复，F2a 遗留）
- **fuzz 25→0 全清（EXIT=0）**：红数轨迹 25→22（F1）→19（F2a）→16（F2b）→13（F3）→11（F4）→8（F5）→4（F6）→3（F7）→**0（F8）**；断言总数 74→88（85 PASS + 0 FAIL + 2 OBSERVE + 1 SKIP）
- **25 条红闭环**（测试验证师逐 commit 实跑复现，非引账）：F1{A1,A8,F9} F2a{A3,A4,F2a} F2b{F4,F5,F6} F3{C8,C10,C11} F4{B1,B2} F5{D1,D2,D3} F6{C1,C2,C3,C6} F7{E3} F8{C12,C13,C14} —— 3+3+3+3+2+3+4+1+3=25，零清单外、零新红、正常路径（空格/间隔点/中文名）无被误伤
- **S4 五门全过**：
  - `npm run test:fast` **EXIT=0**（30 套，含 entry-fuzz 85/0）
  - `npm run test:ci` **EXIT=0**（16 套）
  - `npm run test:slow` **EXIT=0**（10 套）；**eval-gate 86/92 = 93 分 ≥ 基线 93，漏题 6 条与基线一致（无新增）**——零回归
  - guard 96 项全过（含 F5 删除顺序 / F7 转义四条绳索）
  - `npx eslint .` **EXIT=0**（真退出码——本轮起弃用管道读退出码）
- **工单**：G-05 签名白名单 / G-06 双计 ratio / G-07 横幅 emit 直证 / G-08 scanPending continue 直证 / **G-09（新）空格与间隔点书名测试锁**（陆 O-5）/ **G-10（新）同名改内容重导入语义锁**（陆 O-6，与 C33 重灌保护分界）
- **教训（重要）**：lint 门从 F2a 起一直读管道退出码（`npm run lint | tail` 的 $? 是 tail 的 0），5 轮「eslint 0」是假绿——由测试验证师 `npx eslint .` 实测揭穿（structurize.mjs 两处 no-useless-assignment）。fuzz 首跑曾踩过同一坑，lint 没汲取。

## S3 上段检查点（2026-10-18）

- **已完成组**：F1 乱码权重 / F2a surrogate+null / F2b 开关+回调（**P2 轨全清**）+ F3 bookId 闸门 / F4 协议 handler（P1 轨 C1/C2/C11/C12/C15/C27 清）
- **commit 序列**（一组一 commit，每组之前有专家团双 PASS）：3b81aa9（F1）→ 71666e2（ledger）→ 802a9d2（F2a）→ 7729b60（ledger）→ bbc9c80（F2b）→ dc5e6de（ledger）→ 1365b91（F3）→ e2d6090（ledger）→ b3810f7（F4）
- **fuzz 红数轨迹**：25（S2 基线）→ 22（F1：A1/A8/F9 转绿）→ 19（F2a：A3/A4/F2a）→ 16（F2b：F4/F5/F6）→ 13（F3：C8/C10/C11）→ **11（F4：B1/B2）**；断言总数 74 → 79（65 PASS + 11 FAIL + 2 OBSERVE + 1 SKIP）
- **剩余 11 条红（全部属下段组，无清单外）**：C1/C2/C3/C6（探针名；缺陷 C21/C22/C33/C3/C6 → F6/F8 组）、C12/C13/C14（缺陷 C3/C7/C13/C14 → F8 组）、D1/D2/D3（缺陷 C16/C35/C17/C18/C20 → F5 组）、E3（缺陷 C30/C29/C32 → F7 组）
- **下段计划**：F5 删除半途失败（D1/D2/D3）→ F6 jobs 竞态/tmp/幽灵条目（C1/C2/C3/C6）→ F7 渲染转义+挂载+guard §17（E3）→ F8 一般项收尾（C12/C13/C14）→ S4 五门复跑 → S5 归档
- **工单登记**：G-05 签名白名单缺口 / G-06 CONTROL∩mojibake 双计 ratio>1 / G-07 jobs 横幅 emit 直证 / G-08 scanPending continue 直证
- **观察备查**：O5 in-flight 无超时（畸形 docx 挂起放大）、O8 txt 的 readTextBuffer/TXT_SHELL 在 try 外（纯函数不抛）、F1 的 L3/L4/L5/O1/O2、F2b 的「onStage 无条件触发」提示

### F1 顺手采纳与工单登记（毛求疵 OBSERVE 处置）

- 已采纳（同 commit 3b81aa9）：OBSERVE-2 match 替代 matchAll 免疫 lastIndex 污染；OBSERVE-1 注释明示签名集白名单非完备；OBSERVE-6 structurize-test 第 1 节 2/3 字符分支钉子。
- **工单 G-05（新登记，后续波次）**：签名白名单覆盖缺口——â€™（U+2019 右单引号撇号乱码，现实书籍最高发 mojibake 之一）等 cp1252 高位字节类外双重编码 100% 逃逸 detectGarbled（â‚¬ 前缀第三字符类不含 2018/2019）。与 P2-01 同一审计失效模式。建议：分支 3 第三字符类扩为 U+2013–U+2026 乃至 U+2018–U+201F 全段，或加「â€」前缀通用计数；扩宽属行为变更，须重跑全量回归+干净书恒等对拍。
- **工单 G-06（新登记，后续波次）**：CONTROL_RE 与 mojibake 第二字符类交叠 [\u0080-\u009f] 双计——输入「\u00c3\u009f」×N 时 ratio 可达 1.5（如 50 对 = 150/100），report 输出不可审计数字。建议计数去重或 ratio 封顶 1.0 并注释。预存、新旧逐位一致。
- OBSERVE-4（bad 语义由估算变实测）：下游 report 消费方改为直读 `bad` 字段——已随 3b81aa9 注释隐覆盖，F2a 起各 report 消费点复核时顺带核对，不另立工单。
- OBSERVE-7（签名跨块边界两侧各算一半）：分块检测固有，全文层 >0.3 阈值构成兜底，登记备查不修。

### F2a 顺手采纳与观察登记（毛求疵/陆回测 OBSERVE 处置）

- 已采纳（同 commit 802a9d2）：M1 assessCleaned 循环 `detectGarbled(String(c?.text ?? ""))` 与主链逐字对称（null 元素/缺 text/数字 text 全形态不抛）；M2 repair 出口复检 lone surrogate（不赌解码器实现，「绑定前无孤立代理对」不变量出口兜底）；L1 stripLoneSurrogates 单遍 replace 回调计数（不双扫）；L2 LONE_SURROGATE_RE 注释警示勿走 .test() 循环。
- M3 已关闭：grep `strippedFffd: 0` 坐实 report 字面量构造点唯一（structurize.mjs:111），无第二处副本。
- O1 已核：struct 账消费点全景 = meta 落账（JSON 整体自动入）+ build-book console + jobs 横幅 + main 返回值透传，无第五处；docs 无 report 字段表需同步。
- **工单 G-07（新登记，后续波次）**：jobs 横幅 emit 直证用例——构造 st.strippedSurrogates>0 的正常加工路径，断言 detail「清符号 N 处」含该计数。C1 墓碑探针时序上注定吃掉 slice emit，不能复用。
- **观察 L3/L4/L5 登记备查**：L3（structurize-test:232 走 JSON 精确相等=键序即契约，保持现状）；L4（ratio 分母从 raw 变剥后 text——单调不减、只多丢不少丢，保守方向已由 A8/F9 边界锁覆盖）；L5（lookbehind 需 Node≥9，测试绿已证语法层无恙，打包链待真机验收顺带确认）。
- O2（mock struct 键集 meta 测试）：本次三处 mock/期望已手工同步，防复发靠 commit 纪律，不另立套件。

### F2b OBSERVE 处置（毛求疵/陆回测）

- 已采纳（同 commit bbc9c80）：毛 OBSERVE-1 零宽空格 `"0\u200B"`（trim 删不掉，P2-04 换脸复现，最硬发现）→ 判定归一化加 `replace(/[\u200b-\u200d]/g,"")` + NFKC（全角"０"）；毛 OBSERVE-2 async 契约 → 注释钉死「onStage 必须同步」；毛 OBSERVE-3 空 catch 静默 → catch 留一行 stderr（全程仅 2 次不刷屏）；毛 OBSERVE-4 guard 正则过紧 → 放宽为语义存在性（不锁 ??/|| 写法）；毛 OBSERVE-5 → grep 坐实 onStage 全仓仅两处调用均包 try；陆 O1 → ipc-test 29 PASS 补跑；陆 O5 → F5/F6 加调用序列断言（slice 仍投递=横幅不永久卡）；陆补充 → F4 六值扩十值（前导空格/制表换行/零宽/全角）。
- 陆 O2/O3/O4 登记备查：O2 两条 OBSERVE 即 S2 硬证据节原有 2 条（前后同源）；O3 单次跑+总量守恒（56+16+2+1=75=53+19+2+1）已闭合，不重复跑；O4 lint 效力限于 no-empty（含注释块不报），行为断言以 fuzz 为准。
- 陆「放行条件」归档：pre-fix 19 条 FAIL 清单见 S2 硬证据节原文表；回滚粒度=4 hunk（build-book 3 + guard 1）整体 revert（不可半回滚，半回滚会留 F4 单独复红的混合态）；fuzz EXIT=1 与 16 条红登记为 known-red，不参与发布门禁。
- 毛「顺带提示」登记：onStage("structurize") 位于 if 之前无条件触发——BSP_STRUCT=0 时仍发「结构化改造」阶段事件（既有行为，本轮不改，横幅语义名不符实属 UI 层待办）。

### F3 OBSERVE 处置（毛求疵/陆回测）

- 已采纳（同 commit 1365b91）：毛 OBSERVE-2 win32 冒号（ADS 别名 `a:b.json`=base a 的隐藏流，静默产怪文件=与 NUL 同型）与尾点（系统剥点撞名）入闸——只在 win32 拒，macOS/Linux 合法名不误伤，C8b/C8c 双平台语义锁；毛 OBSERVE-4 scanPending 跳过留一行 stderr；毛 OBSERVE-5b resumeCatalog 注释澄清 resultPath 为用户「选择文件」直传（非 id 派生，设计如此，非缺陷）；陆 OBSERVE-5 enrich-job-test 补跑 30 PASS 闭环。
- 毛 OBSERVE-1 C1 区间：不扩（C1 区 0x80-0x9F 在 Win 文件名合法，微软命名文档为据），注释已改为「C0 + DEL」口径。
- **工单 G-08（新登记，后续波次）**：scanPending continue 分支直证——真实文件系统造不出含 NUL/`/` 的文件名，须 mock 注入 readdir 返回 `["../evil.json","正常书.json"]` 断言只含正常书（陆 OBSERVE-4 + 毛 OBSERVE-4 后半）。注意加探针会动「51 发索引」计数体系（guard §17），故本轮登记不加。
- **观察 A（含与 C3 修复的耦合）**：`id.includes("..")` 过宽会误拒 "Vol.2..3" 类合法名——但过严是安全侧偏差、误伤极罕见，且 C12/C13（派生 id 含 ..）的修复锚点正在此处：**F6/F8 修 C3 时若要依赖 safeBookId 拒 ..，不得先收紧 includes**；若改收紧为「整段 . / ..」，须同 commit 把 C12/C13 拒点移到 startImport 派生规则。
- 观察 B/C 登记：C10 读侧直证已由「修复前走到『书库文件不见了』=已读库外任务书」隐证（人话文案即读侧证据），不另加 canary；C27（ipc 通道参数形状）随 C2 处置——三入口在 jobs 层过闸 + UserError 经 handle() 统一 {ok:false,error}，ipc 层无需重复校验；缺陷号 C1/C2 与 fuzz 用例号 C1/C2 同号不同义，汇编时以「缺陷 C1/C2」与「探针 C1/C2」区分。

### F4 OBSERVE 处置（毛求疵/陆回测）

- 已采纳（同 commit b3810f7）：毛 O2 ctimeMs 入 key（挡 stat→open 间隙同 size 同整秒替换的缓存中毒）；毛 O3 ENOENT→404 / EBUSY/EPERM/EACCES→500 状态码语义分开；毛 O4 docx 单次 stat 供闸门与 key + txt 读后长度校验；毛 O6 key 的 libDir 归一化（path.resolve + win32 小写，只影响命中率不影响正确性）。
- O1 已核实关闭：currentLibDir 三级兜底 `_libDir || ENV_LIB_DIR || DEFAULT_LIB_DIR`，DEFAULT_LIB_DIR 是 path.join 常量——恒返字符串，resolveAsset 不会因 undefined 裸抛；条件阻断候选不成立。
- 陆 OBSERVE 采纳：B1b 补 docx statSync TOCTOU 直证（patch statSync 按调用序只让第二次抛，锁「读不出来」文案区分 resolveAsset 的「原件不在」404）；B6b 补不同 docx 并发不折叠；ipc-test 29 PASS 补跑。
- 陆「第 11 条红缺字号」经核：11 = C1/C2/C3/C6（4）+ C12/C13/C14（3）+ D1/D2/D3（3）+ E3（1），陆漏算 C6，**无缺项**。
- 观察登记：O5 in-flight 无超时（畸形 docx 挂起会放大为该 key 全部等待者 pending——mammoth 对坏 docx 通常 reject 不挂起，加超时需 AbortSignal 且 mammoth 不支持，登记不修）；O8 txt 的 readTextBuffer/TXT_SHELL 在 try 外（两者均为纯函数，不抛，登记）；陆「fuzz 常红建议 xfail 语义」登记（S4 五门阶段评估，当前以 FAIL 清单人工核对）。

## 工单清零波次（2026-10-18）：G-05~G-10 全清

**背景**：S3 收官时留了六张工单（G-05/G-06 行为缺口、G-07/G-08 直证缺口、G-09/G-10 语义锁缺口）。本波次一组一 commit，专家团双 PASS（含两轮定向回审：毛求疵 F1/F2/F3，陆回测 F1/F4/F5/F1'），顺带登记三张新工单。

**提交**：`254322b` 组 A（生产 + structurize-test）、`a8da899` 组 B（fuzz + guard）、本文档随 docs commit 落地。

### 组 A（G-05+G-06）：乱码检测扩域 + 修复侧反查表 + bad 并集计数

- **G-05 检测**：`MOJIBAKE_RE` 白名单式扩域。第二/第三字符域由 `[\u0080-\u00bf]` 换成 `CP1252_HI` = Latin-1 0x80-0xBF ∪ cp1252 0x80-0x9F 的 27 个特俗字符（逐段枚举，剔除 2015/2016/2017/201B/201F 这 5 个 cp1252 永远产生不出来的码位）。E2 分支合并成 `\u00e2[CP1252_HI]{2}`（按 3 字符计），补 `\u00e4`（E4 打头中文）。
  - 实测：cp1252 人身 `™ ✓ ★ €` 修复前 mojibake=0 → 修复后 2 签名/6 字符；`It’s … don’t` 0 → 2；E4「中中中中」0 → 4（旧表只认 E5/E6/E8）。毛求疵逐码位复验：U+2000–U+2FFF 全 4096 码位 × 两条解码路径，漏检 0。
  - **修复侧**：加 `CP1252_REV` 反查表（27 项，独立脚本逐字节核验零错映射），逆向编码改逐码位查表——否则 â€™ 只能检出不能修，等于「见乱码就拦」，违背清洗诉求。
  - **查表只在签名跨度内放行**（毛 F2）：跨度外的 >0xFF 特俗字符一律拒修。否则句子别处的 …/™ 会和前导字节拼成**合法但错误**的 UTF-8——实测干净意大利文 `Non è\u00a0… ma non è\u00a0…` 会被「修」成含生僻字「蠅」的垃圾，且 report 记成清洗成果。
  - **跨度查找用升序游标**（毛 F3）：`spans.some()` 是 O(n·k)，21 万字符整本人身实测 3.7s；改游标后 25 万字符 17ms。规模锁用**稠密夹具**（33% 签名密度，25 万字符）：`some()` 实测 5s+，阈值 500ms，两边各有 25×/10× 余量（陆 F1'：稀疏的英文散文密度只有 3%，锁不住）。
- **G-06 计数**：`bad` 由分类求和改为 `BAD_RE`（MOJIBAKE|CONTROL|PUA|FFFD 并集交替）长度求和。「ÃŸ」×50 旧 bad=150/ratio 1.5 → 新 bad=100/ratio 1.0；20 万随机串 bad>len 违例 0。
- **行为变更记账**：并集是**修正**不是放水——旧实现恒定高估，故有一批过去被 0.3/0.5 阈值拦下的输入现在放行（例：len=750 旧 bad=300/0.400 拦 → 新 200/0.267 放）。200 才是真值，放行是正确方向。
- **零回归**：干净中文书 + 新增「拉丁混排干净书」（德语变音 / 法语 « » / SHY 断字 / ° © ™ / ç é）两本恒等对拍：STRUCT=1 与 =0 逐块逐字节一致、report 全零、detectGarbled 零签名；存量四本 txt 原件 detectGarbled 全零；parser-v3 块数锁定（51/4/16/2400）不变；eval 93 不变。

### 组 B（G-07~G-10）：直证与语义锁

- **G-07**：C15（stub，锁「清符号 N 处」= controls+pua+fffd+surrogates 之和，逐项拆验 1/2/3/4 与合计 10）＋ **C15b 真路径**（docx 埋 `&#xD800;` 真跑 build-book → 横幅「清符号 1 处」，锁 build-book→jobs 的 struct 键名接缝）。
- **G-08**：C16/C16b——readdir 注入 `["../evil.json","正常书.json"]` → 只出正常书 + 脏名留痕（console.warn）。
- **G-09**：C17×3——`The Great Gatsby` / `论语 · 学而` / `Vol.2 修订版` 可导入（空格/间隔点/卷次点不误伤）。
- **G-10**：C18/a/b/c——同名 docx 换内容 → 拒建（人话含「内容已变」）+ 老库 chunks 与**全字段 meta**（含 content_hash）一格不动 + 书架落 failed。
- **卫兵**：guard §17 改机械对账（头部声明数 == 索引行数 == 57），不再是单向 tripwire；A13 绿锁按 A2（西里尔）先例登记已知限制。

### 新登记工单（本波次不修）

- **G-11 首字节域缺口**：签名 lead 只覆盖 C2/C3/E2/E4/E5/E6/E8。E7/E9/E3 打头的中文日文、C5 打头的 œ/ł/ř、F0 打头的 emoji，其 cp1252 人身仍 0 检出（bad=0，既不计数也不修）。已补 A13a/A13b 绿锁。扩 lead 域会把 Ä/Å/Æ/Ç/È 后接符号的误伤面成倍放大，须单独立项评估。
- **G-12 `ä` 分支的 SHY 误伤**：德语断字 `erklä\u00adren` 会计入 mojibake（旧表无 ä 分支，本轮新增）。ratio 顶不到阈值、不进 report、不改文本（极端句实测 0.113），不阻断；解 = `[\u0080-\u00bf]` 排除 U+00AD，或按「续字节后必须还有续字节」判。
- **G-13 检出但修不动零记账**：`struct_report` 只有「修成功」计数，没有「检出签名数/拒修数」——0<ratio<0.3 的人身残留完全静默，与「清洗全部可审计」有张力。建议加 `mojibakeSeen`/`repairRejected` 两键（不动阈值）。

### 六门（终态）

| 门 | 结果 |
|---|---|
| `npm run test:fast` | 30 套 **EXIT=0**（entry-fuzz 98 PASS / 0 FAIL / 2 OBSERVE / 1 SKIP；structurize-test 59 PASS） |
| `npm run test:ci` | 16 套 **EXIT=0** |
| `npm run test:slow` | 10 套 **EXIT=0**；**eval-gate 86/92 = 93 ≥ 基线 93，漏题 6 条不变** |
| guard | **96 项 EXIT=0** |
| eslint | **EXIT=0**（真退出码，非管道） |
| 索引对账 | **57 发** = A13/B6/C19/D4/E5/F10（guard §17 机械核：声明数 == 索引行数） |

### 教训

- **白名单式扩域只补案例 = 没补类**：G-05 第一版把 E2 分支的第二字符写死成 €，只覆盖 â€™ 一个案例，™/✓/★/€ 整族仍 0 命中（毛 F1 用 `TextDecoder("windows-1252")` 逐码位实测揭穿）。扩域必须按「字节可达集」枚举，不能按「见过的样本」枚举。
- **放宽闸门必须带范围**：cp1252 查表若无跨度约束，等于给「把好文本修成合法垃圾」开了门（毛 F2）。
- **跨度匹配要游标，规模锁要稠密**：`some()` 是二次的，但稀疏夹具（3% 密度）连二次实现都测不出来——锁的力度取决于夹具密度，不取决于断言写法（毛 F3 + 陆 F1'）。
- **「双态绿」也是断言缺陷**：用「中国人民」锁 E4 分支，旧代码本来就命中 ≥2（陆 F1 实测）——夹具混入了别的 lead 字节，等于没锁。
- **差分验证不许动工作树**：回测用 `git checkout` 回退生产文件做差分，与我并行编辑撞车，一度让工作树处于「生产改动消失」的瞬时态（已按 md5 恢复）。以后差分一律 `git show HEAD:<path> > 临时文件` 后直接 import 旧模块，工作树只读。

---

## P5 一体删除收尾（2026-10-18）

**背景**：P1 的两档删除只兑现了「库 + 原件 + 开关记录 + 存档/反馈」。编目与洗数据的四个目录（`catalog-tasks/`、`catalog-results/`、`enrich-tasks/`、`enrich-results/`）从来没人清——真库实测 45 项，其中 42 项属于这 17 本书。**「彻底删除」承诺的「一切」名不副实。**

### 拍板（2026-10-18，老板四项，P4/P3 的两项一并在内）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 「移出书架」是否清派生 | **不清**；只有「彻底删除」清六落点（重建后块号可复用，省一次云端洗数据） |
| 2 | P4 闸门强度 | **双档**：硬线拦 + 黄线标记 |
| 3 | P3 范围 | **全上**：表格整表 + `chapter_path` + 邻块扩展（默认关） |
| 4 | P3 重建节奏 | **直接全量 17 本**（仍先备份、先 `library-new/` 再原子换名） |

### 改动

- 新增 `src/lib/derived.mjs`（唯一定位与删除出口，两个导出）：
  - `derivedCandidates(libDir, bookId)` 纯定位不碰 FS，返回六项候选（`catalog-tasks` ×2、`catalog-results` ×1、`enrich-tasks` ×1、`enrich-results` ×2）；
  - `purgeDerived(libDir, bookId, {dryRun})` 只删单个普通文件：`removed` / `skipped`（目录、符号链接）/ `failed`（带 errno）/ `wouldRemove`，**不 throw**。
- 三条硬约束：`safeBookId` 单一真源放行（不另写一套闸门）；精确拼名不 glob 不前缀匹配（`enrich-tasks/cli1.json` 这类残留守住）；`rmSync` 不带 `recursive`（目录即便骗过 lstat 也删不掉）。
- `engine.purgeBook` 接线（**删库成功之后**才清派生——前面任何一步抛错则派生原样，不留「库还在、任务书没了」的半截态）；回执加 `removedDerived` / `derivedFailed`，note 追加「已清 N 项」。
- `engine.purgeBook` **顺手补 C20 类缺陷（#168 遗留，自审实测坐实）**：只按严格相等 `find` 库，导致 `purgeBook("t3.docx")` 对库 `T3.docx.db` 只删原件、**库还留在架上**，回执却说「已彻底删除」。修法是**两段式**：精确匹配优先 → 精确没命中库时只做**大小写**归一（Windows/macOS 默认大小写不敏感），**首尾空白一律拒绝**（空白可能是另一本书名的一部分）；归一的 id 同时用于删库、清开关、清派生三处（缺一处就是半截态）。
- `derived.mjs` **拒绝静默归一**：`safeBookId` 内部会 trim，若结果与原始输入不等（`" foo.md"` → `"foo.md"`）直接 `rejected`——否则会删到隔壁那本书的派生。
- `engine.purgeBook` **补刀路**：库与原件都不在了但派生还在（上次删到一半/被占用）时，再点一次会清残留并如实说明，不再只回「找不到」。
- `derived.mjs` **libDir 护栏**：空串会让 `derivedRoot` 退化成 `".."`（进程 cwd 的上级）＝ fail-open 删到项目外；现要求 `typeof libDir === "string"` 且非空，否则 `rejected` 零删除。
- **删除目标的身份判据**（评审 FAIL-3/FAIL-4 后加固，两条都实测复现过数据丢失）：
  - 大小写归一不再用 `toLowerCase` 字符串判等，改用 `fs.realpathSync.native` 比对——JS 会把 U+212A KELVIN SIGN 折叠成 ASCII `k`，而 NTFS 视 `K.docx` 与 `k.docx` 为两个文件，字符串判等会把「一命中」的隔壁书删掉；
  - 新增原件归属校验：只认同扩展，或 `jobs.mjs EXT_FMT` 的 txt→docx 映射（无扩展的旧库 id 才允许任意扩展）——`resolveAsset` 的跨扩展兜底在阅读场景是容错，在删除场景就是偷隔壁的原件。
- `engine.deleteBook` 明确不调，注释写死拍板理由；guard 静态锁「不许顺手补全」。
- `views.js` 彻底删除确认清单加一行派生说明（不做逐文件 stat，实数由回执保证）。

### 测试

| 套件 | 结果 |
|---|---|
| `derived-test`（新增，挂 fast+ci） | **42 PASS / 0 FAIL / 0 SKIP** |
| `archive-config-fuzz` P1-E | **78 PASS**（+27：E1 六项全清 + 前缀诱饵零误伤 + note 实数；E2 移出不清派生；E3 raw-only 照清；E5 大小写/空白变体归一后三处全清；E5b 首尾空白 → 人话拒绝；E5c 前导空格兄弟书零触碰；**E6 删库失败时派生原样＝顺序契约的机器断言**；**E7 删到一半后的补刀路**；**E8/E8b Unicode 折叠不许删错书**；**E9 跨扩展兜底不许偷隔壁的原件**） |
| `guard-test` 第 15 节 | **103 项**（+7：purgeBook 真接线 / deleteBook 不调 / 不 glob 不扫目录 / 不递归 / 六落点「目录↔后缀」成对 / jobs.mjs 与 enrich.mjs 落盘命名防漂移 ×2） |
| `ipc-test` | **32 PASS**（+3：17 本各定位六项 / 全落在四个目录内 / 真库 dryRun 零删除零失败） |

### 真库只读验收

`purgeDerived(..., {dryRun:true})` 对全部 17 本 processed 跑一遍：**账上本会删 42 项，零删除零失败**。四个目录实际 45 项，差额 3 项是 `enrich-tasks/cli1.json`、`cli2.json` 这类不属于任何书的测试残留——**精确匹配的必要性由此坐实**（若用前缀匹配，`cli` 这类的书会误伤）。

### 六门

| 门 | 结果 |
|---|---|
| `npm run test:fast` | 31 套 **EXIT=0**（新增 derived-test；entry-fuzz 98 PASS / 0 FAIL 不变） |
| `npm run test:ci` | 17 套 **EXIT=0**（新增 derived-test） |
| `npm run test:slow` | 10 套 **EXIT=0**；eval-gate **86/92 = 93**，漏题 6 条不变（P5 不碰检索） |
| guard | **103 项 EXIT=0** |
| eslint | **EXIT=0**（真退出码） |
| 索引对账 | **57 发**（P5 未加探针） |

### 登记不修（本波次）

- **派生目录的覆盖范围 = 书库上级**：CLI 若在别的 cwd 跑 `catalog-export` / `enrich-book --export`，产物落在那个 cwd，彻底删除找不到。这是 `jobs.mjs` 既有约定（任务书与书库同级、迁库一起走），不扩大扫描范围——扫别的目录等于猜。
- **孤儿派生**：真库四个目录 45 项里有 3 项（`enrich-tasks/cli1.json`、`cli2.json` 等）不属于任何书，永远不会被任何一次 purge 清掉。**不自动清**：「不属于任何书」不等于「可以删」，可能是用户手工放的东西。
- **`purgeBook("x.txt")` / `purgeBook("x")` 的派生缺口**：渲染层传的是 `listShelf` 的 id（txt 书是 `x.docx`），正常路径正确；直接调 IPC 传原件扩展名时会删原件、但派生按 `x.txt.*` 找不到。属于「调用方传错形状」，登记不改语义。
- **派生删除失败后的补刀**已给（E7）：库和原件都没了、只剩派生时，再点一次「彻底删除」会清残留并如实说明；但**没有自动重试**，占用解除前每次点都只会报「还有 N 项没删掉」。

### 教训

- **「距离窗口」型静态断言天生脆**：`act === "purge"[\s\S]{0,600}purgeBook` 被确认清单新增一行推过了 600 字符 → 假红。它锁的语义是「这个分支拨通的是 purgeBook」而非精确距离，窗口放宽到 900 并写明理由；以后新增文案要顺手看这类断言。
- **平台能力缺失 ≠ 代码缺陷，但要先找替代构造**：本机 `symlinkSync` 不抛错却静默退化成硬链接（`lstat.isSymbolicLink()` false、`readlinkSync` EINVAL），第一版据此记 SKIP。评审提示改用 **junction**（Windows 上不需要管理员，`lstat` 同样 `isSymbolicLink=true`）——断言当场从 SKIP 变真跑，`derived-test` 现在 **0 SKIP**。写 SKIP 之前先问一句「有没有另一种造法」。
- **「删得干净」和「删得准」是两件事**：六项全清只是及格线，真正容易出人命的是前缀匹配误伤（`cli` vs `cli1.json`）——诱饵断言比删除断言更重要，而且**诱饵必须真的落在前缀路径上**（见下一条）。
- **顺序即数据安全**：清派生放在删库之后而非之前。反序会让「库删不掉（占用）」变成「派生已清、库还在」的半截态，用户重试时还会以为产物丢了。
- **「删了一半还报成功」是最坏的失败形态**：`purgeBook` 的大写变体缺陷（#168 遗留）让回执说「已彻底删除」而库还在架上——比报错严重得多，因为用户不会再查。凡是「多步删除 + 单一成功回执」的实现，必须逐处核对「每一步用的是不是同一个归一后的 id」。
- **自己写的新模块也要查 fail-open**：`derivedRoot("")` 返回 `".."`，即进程 cwd 的上级。生产上 `currentLibDir()` 不会给空值，但「上游保证有值」不是安全边界——把 `typeof === "string" && 非空` 直接写进模块内。
- **教训写进文档 ≠ 进了测试**：本轮把「顺序即数据安全」写成了教训，但整轮**没有任何断言守顺序**；是测试验证师的变异实验（把 `purgeDerived` 挪到删库前，全套竟全绿）把它揪出来的，随后补了 E6（patch `fs.rmSync` 让库删除抛 EBUSY → 断言派生六项原样）。**变异测试是「断言覆盖率」的唯一实测手段，代码读得再细也代替不了**。
- **诱饵必须真的在前缀路径上**：`bookId="book-a.md"` 时 `book-ab.md` 并不以它开头，这组诱饵等于没测（陆回测 M1 实测：改成前缀匹配后它照样绿）。换成 `bookId="cli"` + `enrich-tasks/cli1.json` 才落到真前缀上。
- **静态断言不许绑变量名**：`purgeDerived(libDir, bookId)` 写死参数名，改成语义等价的 `purgeDerived(libDir, id)`（大小写归一后的 id）就假红。断言要锁「传了 libDir + 一个 id 变量」，不锁名字。
- **改完生产代码必须重跑卫兵**：本次改 `engine.purgeBook` 后先跑了 fast/ci/slow，却漏了 guard——而 guard 恰好是唯一读源码的那个门。六门里「跑哪个」不能凭感觉，凡是动过 `src/**` 就六门全跑。
- **归一化本身就是误删源**：给 `purgeBook` 加「大小写/空白归一」时用了 `trim()`，于是 `" foo.docx"`（另一张 raw 卡，Windows 文件名允许前导空格）被归一成 `"foo.docx"`，会删掉隔壁正常书的库和原件——**评审对抗官 FAIL-1 实测复现**。删除路径上的任何静默归一（trim / toLowerCase / Unicode 折叠 / 路径规范化）都必须先问：归一之后会不会指到另一个真实存在的对象？现在的做法是「精确优先、归一仅限大小写、空白一律拒绝」。
- **修一个缺陷可能引入更糟的**：第一版归一被 `!asset.exists` 挡着，而 Windows 上 `resolveAsset` 本来就大小写不敏感、先一步找到了原件 → 回退整段被跳过 → **库不删、原件却删了**（比原缺陷更糟，FAIL-2）。同一条路径改完必须重跑**既有**行为用例，不能只跑新加的。
- **「同一本」要用文件系统身份证明，不能用字符串小写**：JS 的 `toLowerCase` 会把 **U+212A KELVIN SIGN 折叠成 ASCII "k"**，而 NTFS 把 `K.docx` 与 `k.docx` 当**两个不同文件**（实测可共存）。用字符串判等时 `purge("k.docx")` 命中 `hits.length===1` 的 K 那本 → **把 Kelvin 那本的书库删了**（FAIL-3，实测复现）。改为 `realpathSync.native` 比对：raw 拼出的库文件必须在盘上、且 realpath 与某个 shelf 条目的 db 相同才认。字符串的「看起来一样」不是身份。
- **阅读场景的容错，就是删除场景的误删**：`resolveAsset` 有跨扩展兜底（`foo.pdf` 的库会兜到 `books/foo.docx`）——**打开书时这是好心，删书时这就是偷隔壁的原件**（FAIL-4，实测复现：`purge("foo.pdf")` 把 `foo.docx` 那本的原件删了）。修法是在删除路径上加归属校验：只认同扩展，或 `jobs.mjs EXT_FMT` 的 txt→docx 映射；无扩展的旧库 id 才允许任意扩展。**同一个函数在不同语义下风险等级不同，删除前必须重新问一遍。**
- **「拒绝」也是一条要测的路径**：E5b/E5c 锁的不是「能删掉」，而是「拒绝时零副作用」——带空白的书名要报人话、隔壁书一格不动、自己那本也没动。删除类功能里，「什么都没做」比「做对了」更需要证明。


---

## P4 洗数据闸门（2026-10-18）

**背景**：P3 将改切片规则。源文件不变时 `content_hash` 相同，旧洗数据产物会按 idx 硬套新块、
静默串味（条目对得上号、内容全错位）。P4 在 P3 之前补四道保险，外加两道质量闸门。
顺序：P5 → P4 → P3（P4 是 P3 重建的保险，必须先于 P3）。

### 四项拍板（开工前）

| # | 问题 | 拍板 |
|---|---|---|
| 1 | 指纹覆盖范围 | 对**全部块**算（`[idx, text.length, sha1(text).slice(0,8)]` → sha256 截 16 位）——短块也算，任何结构变动都算「重新加工过」 |
| 2 | 闸门强度 | **双档**：硬线拦（block，拒收）+ 黄线标记（warn，入库+meta 落账） |
| 3 | 老产物兼容 | 无 `chunk_fp` → 退化为 `chunk_count` 比对；都不写 → 放行（外部智能体通道同族纪律，W2-2 先例） |
| 4 | 脏库阈值 | **5%** 合格块带乱码/控制符即拒洗（DIRTY），逃生开关 `BSP_ENRICH_DIRTY=0` |

### 改动清单

- `src/lib/enrich.mjs`：
  - 新增 `chunkFingerprint(chunks)`（纯函数，idx/id 两形状同值，空数组/非数组有确定值不抛）；
  - `buildEnrichTasks` 返回值加 `book.chunk_fp`、`book.eligible`（三处流转：任务书/产物/缓存 meta）；
  - `buildEnrichTaskFile` 的 book 块带 `chunk_fp/eligible`——外部智能体通道也能把指纹带回来（堵「P3 重建后块数巧合不变、chunk_count 兜底漏判」）；
  - `loadEnrichCache(jsonlPath, contentHash, chunkFp)` 第三参——meta 行带 `chunk_fp` 且不符 → `stale:true, staleReason:"STRUCT"`（hash 不符优先报 HASH）；**A7 修复后：调用方传了 chunkFp 而 meta 无 `chunk_fp`（P4 之前格式/meta 行整个缺失）→ 同样 stale STRUCT（「无指纹」不等于「没变过」，旧条目按 idx 硬套新块即静默串味）；两参旧调用不传 chunkFp 故不判结构（compactEnrichArtifact 重读路径，兼容不变）**；STALE 消息按 `cache.fp==null` 分叉（旧格式说人话，不渲染 `null → fp`）；
  - `compactEnrichArtifact` 写 `book.chunk_fp/eligible`（老调用方不传写 null，入库侧按「无指纹」兜底）；
  - `runEnrich` 前门体检：`buildEnrichTasks` 之后、**任何云端调用之前**，合格块逐块 `detectGarbled(text).bad>0`，`dirtyRatio>0.05` → `{ok:false, code:"DIRTY", message}`（连缓存文件都不建）；STALE 消息按 `staleReason` 分叉（HASH=书被重建过 / STRUCT=书被重新加工过）；
  - 新增纯函数 `evaluateEnrichGate({eligible,covered,tagsDropped,tagsKept,chapterCount,chapterTotal})` → `{verdict,coverage,dropRate,summaryGap,reasons}`；阈值 env 可覆盖（`BSP_GATE_COVERAGE_WARN/HARD` 0.95/0.60、`BSP_GATE_DROP_WARN/HARD` 0.10/0.50、`BSP_GATE_SUMMARY_WARN/HARD` 0.20/0.50）；覆盖率按**合格块**算（论语 9/16 按总块数算只有 56% 会被误杀）；章摘要缺口仅 `chapterTotal>0` 时判（未开摘要/全失败不冤枉）；0 合格块不误杀。
- `src/lib/enrich-import.mjs`：判定顺序 content_hash→STALE → `chunk_fp` 不符→STALE_STRUCT（老产物退化为 chunk_count）→ `evaluateEnrichGate`（**在 ensureEnrichSchema 与事务之前**，block 一个字符都不写）→ warn/pass 写 `meta.enrich_gate=JSON.stringify({verdict,coverage,dropRate,at})`；成功返回值带 `gate`。
- `src/desktop/enrich-job.mjs`：`r.code==="DIRTY"` → failed 标签「洗数据被拒（书太脏）」；`imp.code==="GATE"` → failed 标签「入库被拦（质量闸门）」；warn → done detail 追加「闸门标记：覆盖 N%（部分覆盖）」+ gate 随终态出海。
- `src/desktop/engine.mjs`：`enrichSummary` 读 `meta.enrich_gate` → `enrichGate`（内层 try 兜底：meta 表缺失/值坏不打翻整份摘要）。
- `src/renderer/views.js` + `app.css`：warn 徽标文案「洗数据·部分覆盖」（.tag.enr.warn 琥珀色）。

### 测试

| 套件 | 结果 |
|---|---|
| `enrich-fuzz`（+9b 指纹节） | 75→**81 PASS / 0 FAIL**（指纹稳定性/换字即变/顺序敏感/idx 进指纹/idx·id 同值/空值不抛；缓存 STRUCT/HASH/兼容三判；任务书带 chunk_fp/eligible；**A7：r4b 旧格式缓存拒收+零调用+缓存字节不变、§9b c5/c6 无 fp 单测、r4c 孤儿清理路径保留**） |
| `enrich-import-test`（+§10 十条） | 58→**93 PASS / 0 FAIL**（STALE_STRUCT 两路、老产物兼容、GATE block/warn/pass、env 覆盖、纯函数 14 条边界、指纹与 eligible 直判） |
| `enrich-job-test`（+§9 三块） | 30→**47 PASS / 0 FAIL**（warn 进 done detail + 书架 enrichGate=warn、block 落 failed 标签人话 + DB 零印记、DIRTY 标签 + 零请求 + 连 ctx 列都没建） |
| `enrich-adversarial-fuzz`（+W6 五块） | 32→**52 PASS / 0 FAIL / 0 OBSERVE**（DIRTY 零请求连缓存都不建、控制符型脏块、逃生开关、1/20=5% 压线放行 vs 2/20=10% 拦、GATE 拦后缓存保勾+全量再入库零重复调用；**A7：W6-6 旧格式缓存+同 hash 重加工全链路拒收 + meta 缺失同族**） |
| `guard-test` §12 ⑧ | 103→**114 项**（指纹存在+任务书出海/缓存 STRUCT/闸门在 schema 与事务之前的源码顺序/STALE_STRUCT 码+落账点/前门体检三件套+体检在批次组织之前/GATE·DIRTY 分流/engine 读 enrich_gate/warn 徽标样式；**A7：b2 fpStale 含 out.fp==null + b3 旧格式消息分叉**） |

**既有测试契约变化（新设计有意取代，均已改断言锁新语义）**：
- enrich-fuzz「孤儿条目」场景：同 hash 但块数 8→6 → 旧行为「静默清孤儿后继续」，新契约 **STALE_STRUCT 拒续跑**（清掉的条目若其实对应还在的块，就是无声的数据丢失）；另补「旧版缓存（meta 无 chunk_fp）→ 孤儿清理照旧」锁兼容路径。
- enrich-import-test「增量补导入」：2/6=33% 覆盖率 → 旧行为放行，新契约 **GATE 硬线拒收**（拍板口径 30% 都拦）；真实续跑口径改为「重跑跑批走缓存补齐 → 全量产物入库 → pass」，两路都锁。

### 验收

- **脏库阈值实测（17 本真库只读扫）**：16 本零乱码块，最高 `system-design-primer-en.md.db` **0.08%**（1/1188）——5% 阈值离真实分布 60 倍安全边际，不误伤任何真书。成本实测：d2l（5506 块/5333 合格/1.8M 字符）体检 **19ms**（纯正则、e5 不加载），比规划估的 <1s 好两个量级。
- **三份真产物回放（只读）**：awesome-fenix / lunyu-xueer / mapreduce 全部 **verdict=pass**（覆盖率 100%、dropRate 0%、summaryGap ≤14.85% 低于黄线）；结构判据全部 COUNT-MATCH（老产物无 fp 走 chunk_count 兜底）、content_hash 全 MATCH。
- 六门（终态，A7 修复后的最终字节）：`test:fast` 31 套 **EXIT=0**（1m34s，1448+ PASS / 0 FAIL；受影响五套件实数——enrich-fuzz **81 / 0**、enrich-import-test **93 / 0**、enrich-job-test **47 / 0**、enrich-adversarial-fuzz **52 / 0 / 0**、guard **114 项** 含 §17 索引对账 57 发）；`test:ci` 17 套 **EXIT=0**（55s，entry-adversarial 98/0/2/1）；`test:slow` 10 套 **EXIT=0**，eval-gate **86/92 = 93 ≥ 基线 93，漏题 6 条不变**（P4 不碰检索）；eslint **EXIT=0**（真退出码）。
- 变异测试 M1~M12 + 自选追加：见「专家团报告」小节（陆回测，**已收官：16 变异 15 红 1 等价，结论 PASS**）。
- 对抗审查 A1~A10：见「专家团报告」小节（毛求疵，**已收官：PASS 无阻断级，A7 唯一真实缺口已修复闭环**）。

### 专家团报告（P4）

**陆回测·变异测试（16 变异，15 红 / 1 等价，结论 PASS）**。方法：备份→改→跑五套件→守卫式还原（还原前活文件 md5 必须正是变异版，否则 ABORT——16 次全部 RESTORE-OK，零覆盖队友保存）；收尾逐一 diff 四份 src 与金快照字节级一致、git status 与开工相同、五套件复跑全绿。

| # | 变异（文件:行 → 改动） | 结果 | 变红的测试 | 判定 |
|---|---|---|---|---|
| M1 | enrich.mjs:49 指纹序列去掉 `text.length` | **全绿** | 无 | **等价变异**（见缺口①） |
| M2 | enrich.mjs:134 `chunkFingerprint(chunks)`→`chunkFingerprint(eligible)` | 红 | import-test §10-9「短块…改变指纹」 | 符合预期 |
| M3 | enrich-import.mjs:93 fp 比对分支 `if (false && ...)` | 红 | import-test §10-2 指纹拒收 | 符合预期 |
| M4 | enrich-import.mjs:99 chunk_count 兜底分支 `if (false && ...)` | 红 | import-test §10-1 两断言（拒收+schema 未建） | 符合预期 |
| M5 | enrich-import.mjs:121 `eligible: task.chunks.length`→`task.book.chunk_count`（分母） | 红+测试进程崩溃 | import-test §3 学而 9/16=56% 被误杀 | 符合预期，论语误杀场景锁死 |
| M6 | enrich.mjs:70-71 coverageWarn/Hard 默认 0.95/0.60 对调 | 红+崩溃 | import-test §6「缺号 4/6 覆盖」（66.7% 被硬线拦） | 符合预期 |
| M7 | enrich.mjs:392 DIRTY 前门条件 `if (false && ...)` | 红 | job-test 5 条（§9-3 全挂）+ adversarial 6 条 | 符合预期 |
| M8 | enrich-import.mjs:172 meta.enrich_gate 写入整句包进 `if (false)` | 红 | import-test §6 印记断言 + job-test §9-1（含书架 enrichGate=warn） | 符合预期 |
| M9 | enrich-job.mjs:142 GATE 标签恒「入库失败」 | 红 | job-test §9-2 标签断言 + **guard §12-f 静态断言**（额外抓到） | 符合预期 |
| M10 | engine.mjs:69 `gateRaw` 恒 null | 红 | job-test §9-1 书架断言 + guard §12-f 静态断言 | 符合预期 |
| M11 | enrich.mjs:330 `fpStale` 恒 false | 红 | enrich-fuzz §5 r4 + 9b「chunk_fp 不符 → STRUCT」 | 符合预期 |
| M12 | enrich-import.mjs:120-132 闸门整块挪到 `ensureEnrichSchema(db);` 之后 | 红 | **guard §12-c 顺序断言** + import-test §10-4 + job-test §9-2 + adversarial W6-5，四套件全红 | 符合预期，顺序断言有效 |
| X1 | enrich.mjs:396 DIRTY 阈值 `>`→`>=` | 红 | adversarial W6-4「1/20=5% 恰好压线 → 放行」 | 压线边界锁死 |
| X2 | enrich.mjs:62-67 `gateNum` 恒返回默认（env 失效） | 红 | import-test §10-7 + job-test 10 条（§9-1/9-2 全挂） | env 覆盖路径锁死 |
| X3 | enrich.mjs:101 judge 硬线 `>`→`>=` | 红 | import-test §10-8 压线两断言（覆盖率 60%、丢弃率 50%） | 硬线压线锁死 |
| X4 | enrich-import.mjs:100 兜底条件 `!==`→`===`（取反） | 红 | import-test §2 首条（该放的被拒）+ adversarial | 兼容路径双向锁死 |

变异覆盖地图：边界压线（X1/X3）、env 覆盖（X2）、老产物兼容（X4/M4）、DIRTY 前门（M7）、GATE 双档与位置（M12）、桌面可见性（M9/M10）、缓存结构判据（M11）、论语误杀（M5）均有实测佐证。

**陆回测覆盖缺口清单**：
- ①**M1 等价变异（低风险观察项）**：源码注释声称指纹对「编号/长度/内容」三维敏感，测试只独立钉了编号与内容两维；`text.length` 与 `sha1(text)` 信息冗余，任何内容变化必变 sha1，去掉长度语义上不可观测。「同 sha1 不同长度」实际无法构造，等于建议保留现状——登记不改。
- ②**测试健壮性（登记不修）**：import-test §3/§6 与 adversarial W6-5 在 importEnrich 返回非 ok 时直接访问 `r.stats.imported`，M5/M6/M8/X4 实测抛 TypeError 令测试进程崩溃（FAIL 行已打印、结论不丢）。正常流程必 ok 所以不炸；未来若新增合法拒收码，测试会崩而非干净 FAIL。建议后续给这几处加 `r.stats?.` 保护——按铁律只登记不动手。
- ③**guard 静态断言超额命中**（加分项）：M9/M10 除行为测试外还被 guard §12-f 静态断言抓到（源码字符串消失即红），双重覆盖。

**第二轮全量重跑（A7 修复后，团队解散后单独恢复执行，17 变异：16 击杀 / 1 等价存活，PASS）**。变异锚点按新树重新定位（M1-M12 落 enrich.mjs、X1-X4 落 enrich-import.mjs），另按团队指定加 M1-R（A7 判据改回旧判据）与 M11（fpStale 恒 false）。**关键对照**：M11 红集 = {fuzz r4/r4b/§9b c5、guard b2、adv W6-6×3}（连「有指纹但不符」也放过）；M1-R 红集 = {fuzz r4b/§9b c5、guard b2、adv W6-6×3}（只放过「无指纹」盲区）——红集差异精确刻画 A7 判据的语义边界，新契约（r4b 三断言、§9b c5/c6、W6-6、guard b2/b3）全部焊死。唯一存活 M1 为等价变异（指纹删 `\n` 分隔符——逐块 JSON 括号唯一可切分，不改变任何相等/不等关系；与第一轮删 `text.length` 同属 sha1 已覆盖的冗余维）。收尾核验：四生产文件 md5 与开工基线逐字节一致、git status 13 改 + 1 未跟踪、五套件终态复跑全绿、17/17 还原 RESTORED OK 零 ABORT、全程零 git checkout/restore/stash/reset、library/ 与个人文件未碰。

**毛求疵·对抗审查 A1~A10（11 个自写探针，结论 PASS，无阻断级）**。方法：只读代码 + 探针（books/_work/，跑完已删；临时库全在 os.tmpdir()；library/ 17 本真库零写——find 验证 mtime 无变化；三份真产物回放入临时副本）；全部结论已用 20:18 后的当前代码重跑复核。

| # | 对抗面 | 判定 | 严重度 |
|---|--------|------|--------|
| A1 | 结构判据绕过（产物缺三字段） | 可容忍缺口（与 W2-2 同族：三道结构判据全是信任输入，缺任一即跳过；idx 对齐验真仍兜底；**修正：buildEnrichTaskFile 已带 chunk_fp/eligible，实际暴露面比报告初稿更小**） | 中 |
| A2 | fp 伪造（手改产物 fp=库 fp + 旧结构 entries） | 已防住意外/可容忍手改（16hex=64bit，偶然碰撞需 ~2^32；信任输入与 content_hash 同族，防意外不防恶意） | 低 |
| A3 | DIRTY 判据（短脏块/计时/env 七值） | 已防住（假阴为设计内：脏短块不喂云端；d2l 5506 块体检 12~19ms 纯正则；仅精确 "0" 放行，fail-safe） | 低 |
| A4 | 闸门假阳（0 条目/重跑补齐/全短块书） | 已防住（0 条目→block 但缓存不毒化；重跑只补失败批→pass；eligible=0 不误杀） | 无 |
| A5 | 老库兼容（17 本只读 audit + 三产物回放 + MCP 静态） | 已防住（17 本全过；回放 9/9、70/70、1171/1171 全 pass） | 无 |
| A6 | 闸门 env 覆盖（13 种垃圾值） | 已防住（回落默认或可用，无静默错误；"0" 更严但只降黄线不降硬线） | 无 |
| A7 | runEnrich 缓存路径（老缓存+同 hash 重加工） | **漏洞→已修复闭环**（见下） | 中 |
| A8 | 桌面侧（8 种坏 gate 值/徽标 7 值/端到端四场景） | 已防住（+3 项 OBSERVE） | 低 |
| A9 | 事务边界（delete-journal + WAL 双模式快照 + PRAGMA） | 已防住（block 时主库 sha 不变、无新文件残留、ctx 列未加——一个字符都不写坐实） | 无 |
| A10 | 顺序盲区（章摘要 0/3 vs 1/3 vs 未开 vs 孤儿章） | 可容忍缺口（0/3 全失败→pass 而 1/3→block，非单调；未开与全失败不区分——登记） | 低-中 |

**A7 缓存盲区（唯一真实缺口，已修复）**：P4 前格式缓存（meta 无 `chunk_fp`）+ 同 `content_hash` 重加工 → runEnrich 不拒（旧判据要求 `out.fp != null`）→ 旧结构条目按 idx 硬套新块 → 压出的产物带**新鲜** fp → 入库侧结构判据形同虚设 → 旧 prefix/summary 串味入库（实证：库内 ctx="旧结构第 1 块前置"）。**修复**（2026-10-18 20:35-20:38 落地）：`loadEnrichCache` 的 `fpStale` 改 `!!chunkFp && (out.fp == null || out.fp !== chunkFp)`——调用方传了 chunkFp 而 meta 无指纹（含 meta 行整个缺失，此时 hashStale 也短路、fpStale 是唯一结构后门）→ 一律 stale STRUCT；两参旧调用（compactEnrichArtifact 重读）行为不变；STALE 消息按 `cache.fp==null` 分叉说人话。**测试**：enrich-fuzz r4b 改锁新契约（拒收+零调用+缓存字节不变）+ §9b c5/c6 单测 + r4c 保孤儿清理覆盖；adversarial W6-6 端到端（拒收+零请求+缓存产物零改+meta 缺失同族）；guard b2/b3 静态断言。**复测（毛求疵，团队解散后单独恢复执行，对当前字节实跑：62 PASS / 0 FAIL / 2 OBSERVE）**：V1-V4 四场景全绿（V1 旧格式缓存+同 hash 重加工 → STALE+「旧格式」消息分叉+零调用+缓存产物字节不变；V2 meta 行整个缺失 → 同拒，fpStale 是唯一结构后门；V3 两参兼容不变、压缩只做瘦身；V4 fp 相符零误伤、断点续跑照常）；7 探针面全量重跑（A1 判据面 14 个攻击向量含 fp 类型伪装四形态/垃圾行/双 meta/孤儿条目全堵；A2/A3/A4/A6 复核通过；A8-2 桌面侧四场景端到端复现同一契约、DB 零印记）；A5/A9/A10 依据「enrich-import.mjs 本轮未动、字节与金快照一致」且有 A2-4 交叉验过入库侧作补偿观测而略过。**结论：A7 改判「已修复」，许可给出。**

**毛求疵 OBSERVE 清单**（A7 外 6 项全部登记不修，见下「登记不修」）：内部通道丢弃率闸门盲区 / warn 真因不可见 / 桌面 PARTIAL 路由事实 / A1 同族信任输入 / 短脏块假阴 / 「已洗 0%」显示副产物。复测轮新增 2 项（均为本地文件信任模型内的契约边界，非缺陷非回归）：**双 meta 行**（一条有 fp 相符 + 一条无 fp → out.fp 取有指纹者、不拒；多 meta 非正常写入路径，只可能来自手工篡改/历史遗留）；**伪造 fp=当前书 fp**（缓存实为旧结构条目 → 放行零调用出产物，产物带当前 fp 使入库侧 artFp 比对失去意义——与 import 侧同一威胁模型：防无意重加工、不防恶意手改本地文件，与 A2 结论互证）。

### 登记不修（本波次）

- **产物既无 `chunk_fp` 又无 `chunk_count`** → 结构判据整体缺失（外部智能体通道可能产这种形状）。与 W2-2「artifact 缺 content_hash 三条件放行」同族：idx 对齐验真仍兜底，登记不改语义。
- **「章摘要全失败」与「未开摘要」被同等放过**（`chapter_summaries` 为空都不判缺口）：失败数在 `stats.summariesFailed` 机器可验，闸门不重复判——防「失败一次就永远 block」比「惩罚失败」重要。
- **DIRTY 只数合格块**：<40 字符的脏短块不计入——短块无检索价值，进不了提示词。
- **测试健壮性（陆回测缺口②）**：import-test §3/§6 与 adversarial W6-5 在 importEnrich 返回非 ok 时直接访问 `r.stats.imported`，变异实测抛 TypeError 令测试进程崩溃（FAIL 行照打、结论不丢）。未来新增合法拒收码时测试会崩而非干净 FAIL，建议加 `r.stats?.` 保护——本轮不动手（变异窗口内改测试会污染基线）。
- **指纹长度维无独立测试背书（陆回测缺口①）**：`text.length` 与 `sha1(text)` 信息冗余，「同 sha1 不同长度」不可构造——保留现状，只登记。
- **内部通道丢弃率闸门盲区（毛求疵 OBSERVE-2，中）**：enrichBatch 写缓存前已过滤 tags → 入库再验无非丢标签 → 内部通道 dropRate 恒 0（实证：模型标签 100% 不可回源时桌面显示 done「标签 0」、闸门 pass；`stats.tagsDropped` 有记录但闸门不读 artifact.stats）。外部产物通道有效（50%→warn 实证）。数据完整性无亏——存活的标签 100% 回源、用户在 done 统计里看得到「标签 0」；这是监测缺口不是串味缺口。建议后续闸门补读 `artifact.stats.tagsDropped`（取 max）——改闸门语义需配套变异覆盖，留专门轮次。
- **warn 真因不可见（毛求疵 OBSERVE-3，低）**：done detail 与徽标只报覆盖率，`gate.reasons`（丢弃率/章摘要缺口）UI 不展示。
- **桌面路由事实（毛求疵 OBSERVE-4，低，知悉即可）**：runEnrich PARTIAL 即短路「洗数据失败」，导入从不发生 → 覆盖率闸门实际由 CLI/外部产物通道把守；桌面 GATE block 只经章摘要缺口可达。
- **A1 同族信任输入（毛求疵 OBSERVE-5，低）**：三道结构判据（content_hash/chunk_fp/chunk_count）均为信任输入——防意外不防恶意，手改产物=用户自伤；建议在洗数据文档明记。
- **「已洗 0%」显示副产物（毛求疵 OBSERVE-7，低）**：全短块书（eligible=0）入库后徽标显示「已洗 0% · 标签 0」——coverage 定义 1 不误杀是对的，显示层可后续美化。

### 教训

- **「覆盖率」的分母能杀人**：按总块数算，论语 9/16=56% 会被硬线误杀；按合格块算才是 100%。任何比率型闸门，先问「分母是什么、谁会落在分母里」。
- **压线值必须成对测**：60%/50%/95%/10% 每个阈值都测「压线不过」与「越线一分」两侧——本次第一版测试自己就把 50% 丢弃率写成 block（正确是 warn）、章摘要缺口 60% 写成 warn（正确是 block），全是边界想反。
- **env 覆盖不是装饰**：`BSP_GATE_COVERAGE_HARD=1.5` 让全量产物也被拦——回归对比时不想改代码就能调档；但 env 名进入生产后就成了契约，测试必须锁「设了生效、删了复原」。
- **真库实测先于阈值拍板**：5% 不是拍脑袋——17 本扫完最高 0.08% 才敢定。闸门阈值没有真实分布数据就是赌博。
- **fail-open 面要逐个摸**：`evaluateEnrichGate(null)` 会抛（lib 铁律：不许抛）——默认参数只兜 undefined 不兜 null，自写探针才逮到。
- **顺序断言要防「定义误命中」**：`indexOf("ensureEnrichSchema(db)")` 命中的是函数定义（第 20 行）而不是调用点，断言假红；改成带分号的调用点正则才锁住「闸门在 schema 之前」。
- **变异实验照旧是覆盖率唯一实测**：本轮 M1~M12 见专家团报告。
- **「无指纹」不等于「没变过」**：A7 盲区的根源是旧判据把「缓存没有指纹」当作「无需判结构」——兼容思维用错了地方。信任输入缺字段时，安全方向是「不可判即拒收」，不是「不可判即放过」；放过的代价是静默串味，拒收的成本只是重跑一次（缓存是优化，正确性是底线）。
- **多人并发编辑工作树要有窗口纪律**：本轮两次竞态（陆回测变异还原盖编辑、毛求疵探针撞上编辑中间态）都靠「金快照 + 冻结窗口 + 守卫式还原」化解——凡有队友在跑变异/探针，主对话只做只读与 docs；窗口开关必须团队内明示。

### 当前状态与后续窗口（2026-10-18 21:40 更新）

- **代码态**：A7 修复 + 全部测试改动已落盘；主对话的 src/test 保存已全部完成。git status = **14 个已修改 + 1 个未跟踪**（`books/新建 文本文档.txt`，用户个人文件）——3 docs + 6 src + 5 test，即 P4 全集（此前口播的「13」为计数口误，以 14 为准）。
- **字节态注意**：陆回测变异循环的还原工具把 `src/lib/enrich.mjs`、`src/lib/enrich-import.mjs`、`test/enrich-adversarial-fuzz.mjs` 写成了 CRLF（内容经 `git diff` 验证与预期一致）。**终态决定：不做行尾归一化**——本仓库 `core.autocrlf=true`，CRLF 是 checkout 原生态，提交时 git 自动归一化为 LF（`git diff` 实测只有预期内容差异），归一化对仓库是 no-op 却有改写风险与 golden-src 失配成本。毛求疵已把 golden-src/enrich.mjs 刷新为当前字节（md5 3c506c4a，四份快照与磁盘全 MATCH）。
- **窗口执行情况（全部收官）**：① 陆回测 17 变异全量重跑 **PASS**（16 击杀 / 1 等价存活，M11/M1-R 红集精确符合新契约，收尾四文件 md5 与开工基线一致、五套件全绿）→ ② 毛求疵 V1-V4 + 7 探针面复测 **PASS**（62 PASS / 0 FAIL / 2 OBSERVE，A7 改判「已修复」许可给出；金快照已刷新）→ ③ 六门全量 **全绿**（fast 1m34s / ci 55s / slow eval-gate 93≥93 漏题 6 不变 / guard 114 / eslint 0，见「验收」节终态）→ ④ ledger 六门终值已补 → ⑤ 三组 commit + push（见下）。
- **commit 分组预案**：`feat(P4)` 生产六文件（enrich.mjs/enrich-import.mjs/enrich-job.mjs/engine.mjs/views.js/app.css）/ `test(P4)` 测试五文件（enrich-fuzz/enrich-import-test/enrich-job-test/enrich-adversarial-fuzz/guard-test）/ `docs(P4)` 文档三文件（ledger/规划/勾选单）。

---

## P3 切片 v4（2026-10-18 立项，P4 入账后开工）

**背景**：P4 四道保险已就位（块结构指纹/双档闸门/前门体检/桌面可见性），P3 可以安全改切片规则。
顺序仍是 P5 → P4 → P3；P3 是渐进重建前最后一块拼图。

### 三项拍板（开工前）

| # | 问题 | 拍板 |
|---|---|---|
| 1 | 表格整表成块 | 新增 `splitTableRows`：连续 `fromTable` 行合成一个块（表格是结构化单元，逐行进块=行与上下文混溶、表头与数据行分离）；整表超过长度上限时按行组切（表头+数据行一组） |
| 2 | 章节层级 | 新增 `chapter_path` 字段（如「第3章 › 3.2 节」）：DB 加列惰性迁移；编目/检索/展示层渐进采用，存量库 NULL 不报错 |
| 3 | 邻块扩展 | `BSP_NEIGHBOR` 默认关（0）：开（1）后对 topN 结果按同章 id±k 扩展、衰减计分、不重跑复试官（成本可控）；evals 双门验证后才考虑默认开 |

### 执行记录（P3-①②③ 已落地，P4 push 后开工）

- **P3-1 表格整表成块（已落地）**：`packTable`+`mergeTableRows` 进 build-book.js——连续 `fromTable` 行合成一个块（`" | "` 连接单元格、`"\n"` 连接行），整表超 900 字按行组切（表头随组重复，单行超长保持原子永不跨行切）；**合并必须在 promotePlainHeadings 之后**（promote 的「下一段更长才认」不看 fromTable，先合并会让标题提升误触发——干净书零变化红线）；`tid` 表 id 语义（md 空行/任何非表行断表、docx 每个 `<table>` 元素一表、跨文件不相并）；整表块跳过 sentenceSplit（docx 保留首行「第X章」匹配、行内不再误切章=修复）；记账 tableStats（rows→blocks）进 meta.table_stats + CLI 播报；`BSP_TABLE=0` 逃生（零宽剥离+NFKC 归一化同 P2-04）。真书实测：d2l 125 行→18 块、道德经 81 块零变化、33454→33347 块（-107）
- **P3-2 chapter_path（已落地）**：解析器层级栈（md 按 # 层级、docx 按 h1-h6、启发式提升=顶层重置、「第X章」文本匹配=栈重置）→ `chapter_path`（"卷 › 章 › 节"，空洞过滤后空=**null**）；扁平 `chapter` 行为逐字不变（路径是新增字段、叶节点=chapter）；**不做 ALTER 写迁移**——库全 readonly 打开，列随重建出现，消费侧 `pragma_table_info` 探测回退（pdf/epub/无标题书/老库=null）；接线四处：search 行搭载（不动 loc——loc 喂提示词）、llm 引用 additive、renderCite 有路径优先展示、similar.mjs 两路。真书实测：d2l 23521 多级路径块（样例 `Using AWS EC2 Instances › Creating and Running an EC2 Instance`）、道德经 81 章路径全对、叶节点一致性 33323 块全对
- **P3-3 邻块扩展（已落地，默认关）**：`BSP_NEIGHBOR=1` 开——复试官终排后对终排结果按**同章 id±1** 各补一席（衰减 ×0.5 计分、只附加不挤位、不重跑复试官=成本零、总数 ≤4）；变体快路径（rerank:false）不扩；同章判据用扁平 chapter（空章/跨章不扩）。测试 12 断言（默认关/不变式/去重/跨章/上限/透传/老库兼容/多变体）挂 test:fast（31→32 套）；guard §18 十三断言（114→127 项）
- **P3-4 测试与六门（已收官）**：neighbor-test 12 断言新挂 test:fast（31→**32 套**）；guard §18 十三断言（114→**127 项**，含 P3 三件套形状/调用序/挂载对账）；parser-v3 四个旧表格契约断言改锁新语义（整表成块/表头随组/table_stats 记账/逃生还原）+ 补 table_stats 与 BSP_TABLE=0 断言；v2-eval 加 `BSP_EVAL_LIB` 影子覆盖（门语义不变）。六门终态：fast **32 套 EXIT=0**（0 FAIL）/ ci 17 套 **EXIT=0** / guard **127 项 EXIT=0**（含 §17 索引对账）/ eslint **EXIT=0** / slow **EXIT=0**（eval-gate **93 ≥ 93，漏题 6 条不变**——默认旗标下老库检索零扰动，行字段纯加法）
### P3-5 影子重建与换库（已收官）
- **关键发现：现库是混合旗标**——#58/#158 之后的书（P&P/Frank/md 五本/epub 两本/论文三篇）带 `BSP_SEMANTIC=1` 建（凤凰 1227 vs 默认建 3737、d2l 5506 vs 默认建 ~33k 实证），中文经典（孟子/论语/道德经，2026-10-13 冷接入早于第二波语义分块）没开。影子重建必须逐本对齐，否则对照失效（第一版驱动用默认旗标，凤凰块数 3 倍爆炸当场暴露）
- **驱动对齐策略**：先带语义建 → 无表书（meta 无 table_stats）块数比旧库缩水 = 原建没开语义 → `BSP_SEMANTIC=0` 重建对齐；有表书/块数不缩水保留语义建。17 建 0 败：有表书小幅缩减（og-aws −14/SDP −25/凤凰 −7/d2l −5/hello-algo），无表书逐字不变，孟子自动对齐 no-semantic
- **重大纠偏：「名字锚定」只对 tree/relation 边成立**——belongs/mention 边 src 是块 id（d2l belongs 5500 条 src_type='chunk' 实证）。四本 id 平移的书（og-aws/SDP/凤凰/d2l + hello-algo）直接拷边=毒数据。fix-shadow-catalog.mjs：belongs/mention 边「文本对齐」重映射（旧块文本必是某新合并块子串——升序+前向窗口 120+游标不后退），重拷 llm 节点/relation 边/theme_vecs + 补 catalog_* meta
- **丢弃 219/~14000 ≈1.5% 属管线形态差异的预期损耗**（抽查定性：旧库表格碎片行被整表合并重排、数学公式链切分边界跨块、TOC/日文目录被清洗重排），模糊对齐成本高且有投毒风险，不做
- **影子考卷两跑**：首跑 85/92=92（漏 attention 题外新增）→ 根因=影子库缺 `catalog_model` 键，主题提名路被门禁 `meta.catalog_model === embedKey` 拦死（catalog.mjs:578）；修后单测两库 top3 逐字一致（#13 复试分 0.3399 回首位）→ 二跑 **86/92=93，漏题 6 条与基线完全一致，双门过线**
- **换库落地**：`npm run backup`（bsp-backup-20261019-021627）→ **拷出项目 D:\bsp-backups\**（铁律）→ `mv library library-pre-p3 && mv library-new library`（旧库保留可回滚）→ 17 本 WAL checkpoint 全清（wal/shm 0 残留）→ 账实健康（17 本 15349 块全带向量、325 llm 节点）
- **换库后两红及修复**：
  - enrich-nom 2 红：夹具=真库论语（唯一洗过数据书），新库有意不拷 enrich → 但论语/MapReduce **id+text 全等**（无表书逐字不变），enrich 数据面有效补拷四样（`tags`/`questions` 列 + `chunk_tags` + `summaries`；enrich-signal 门禁要 tags+questions 两列都在）
  - catalog-test 2 红：①P&P belongs 1010≠1011（文本对齐丢的那 1 条）——P&P 全文 id 完全对齐、唯一差异块 #394（P2 清洗剥块首孤引号 `”\n`），**id 直映补回 2 边**（belongs 1011=1011 闭环）②`catalog_text_bytes` 账实漂移——全 17 本同步为实际值（P&P 710793→710791 恰好=被剥 2 字符，账义一致）
- **终态六门**：fast 1468 PASS/0 FAIL；slow eval-gate 见下节验收

### 验收（P3-5 换库后，全部收官）
- fast 1468 PASS / 0 FAIL（enrich 补拷 + P&P 补边 + 账实同步后）
- slow **EXIT=0 全绿**：eval-gate 93 ≥ 93、漏题 6 条不变、全文 0 FAIL
- 换库后第三红（slow 门 similar-fuzz P3-C2）：损坏库夹具灌垃圾固定在第 11~12 页——依赖旧 lunyu 页布局，新库 enrich 表加入后 chunks 页不再固定 → 灌不中查询路径夹具失效。修复：灌垃圾从第 11 页扩到文件尾（meta 第 1 页保持完好）；similar-fuzz 28 pass / 0 fail
- **P3 切片 v4 全程收官**：①表格整表成块 ②chapter_path 层级 ③邻块扩展（默认关）④六门 ⑤17 本影子重建+考卷对照+换库落地。正式库=新管线（P2 清洗 + P3 切片 + 语义旗标逐本对齐），旧库留存 library-pre-p3/ 待真机验收后删除
