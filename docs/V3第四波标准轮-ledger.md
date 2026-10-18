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
