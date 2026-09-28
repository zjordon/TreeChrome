# P4b 实施计划 · batch2 十五动作（冻结契约）

> 前置：P4 五段已全部合并 main（merge `bc2646c`，2026-09-28）。参照实现 TreeWalker
> @640d52a（`src/tree_walker/tools/actions.py` 3322 行 / `browser/session.py` 5102 行 /
> `agent/upload_identity.py` 285 行）。
>
> **models/registry/schema 面已在 P4 4.3 全量冻结**：25 参数模型 + ACTION_DEFINITIONS
> 四元组（含 batch2 十五动作的 capability/terminatesSequence）+ getToolSchema 矩阵 +
> 全动作集 prompt fixture（FILE_UPLOAD/DROPDOWN 条件段）均已字节锚定入库。P4b 只做
> **handler + session 侧族 + 注册接线**，不动 models.ts 既有内容。

## 1. 范围与出界

- **入**：15 个动作 handler（actions/ 目录 batch1 同款工厂模式）、session 侧六族模块
  （search/find、下拉、上传、文件、grid 结构化读、evaluate 增强）、ToolsBrowser 接口
  扩面、FileSystemProvider 最小增量、权限门 capability 消费面核对（ACTION_DEFINITIONS
  已冻结，无需改）、测试与锚点。
- **出**：富文档（PDF/DOCX）文本解析进核心包（见 01 §偏离 1——镜像 Python 无
  `[docs]` extra 的降级形态 + 注入化 hook 留 M5）；evaluate 的 vision 通道（Python
  侧 images 本就是死代码，:2537-2545 注释明确不接线）；rerun/recorder 族；M5 扩展宿主。

## 2. 分段闸门（依赖重量递增 + 评测硬依赖隔离）

| 分支 | 内容 | 动作数 | 冻结契约 | 预估 |
|---|---|---|---|---|
| `feat/p4b-actions-a` | 轻族：search / find_elements / find_text / search_page / screenshot / save_as_pdf / close_tab + 文件族（write/read/replace_file，含 FileSystemProvider 增量与白名单） | 10 | 01 | 1.5~2d |
| `feat/p4b-actions-b` | 重 session 族：下拉（session 25 方法族）/ 上传（file-chooser 拦截消费 + upload_identity clue） | 3 | 02 | 1.5~2d |
| `feat/p4b-grid-eval` | 评测前置：read_grid 三通道 + evaluate 增强（args/elements/frame/语法自愈接线） | 2 | 03 | 1~1.5d |

每段协议与 P4 相同：从最新 main 开分支 → 实现至全绿（覆盖率 ≥85%）→ `/review-loop`
→ 合并 `--no-ff` 删分支。

## 3. 已定决策

| # | 决策 | 依据 |
|---|---|---|
| 1 | 分三段而非两段：文件族随段 1（fs 增量小）、下拉+上传独立段 2（session 侧体量大）、grid+evaluate 独立段 3（**评测 Tier1 硬依赖**——cdp_evaluator 的 CDPPageAdapter 消费增强版 evaluate，P5 parity 启动前必须完成） | 02 §7 提醒 + P4「小 diff 冻结契约」收敛实证 |
| 2 | handler 形态沿用 batch1：工厂函数收 ToolsContext 闭包、必填参数 typeof 守卫（tools 评审轮 1 的 P1 泛化面）、`_registerAll` 对无 handler 动作跳过——P4b 起注册面逐步扩大，段 3 完成后=全 25 | actions/index.ts 既有结构 |
| 3 | ToolsBrowser 扩面走 batch1 同款**委托**（BrowserSession 方法签名镜像 Python 公开面；FakeCdpTransport 测试零真机） | tools/types.ts 既有形态 |
| 4 | FileSystemProvider 增量最小：`stat(path)`（size，window_and_echo 字节计量）+ `readHead(path, n)`（嗅探 magic 头）；文本/二进制全量读写不进核心接口 | Python `_sniff_file_kind` :114-144 只读 12 字节头；`_window_and_echo` :2466-2527 需要 utf-8 字节长度 |
| 5 | 锚点扩展：新 `tools/gen-batch2-anchors.py`（evals venv 实跑）——纯函数族（三个 formatter / sniff 全分支 / parse_grid_number / grid_footer_row_role / replace 的 literal replacer）+ JS 常量体（_SEARCH_PAGE_JS_BODY 等逐字节 dump）；handler 集成行为走 FakeCdpTransport 脚本化 | P4 gen-tools-anchors.py 先例 |
| 6 | 权限门无需改动：batch2 capability 已在 ACTION_DEFINITIONS 冻结（4.3 对拍过全 25 schema），resolveCapability 通用查表即可命中 | p4/04 §1.1 表 + models.ts :1288 |

## 4. 风险

| # | 风险 | 缓解 |
|---|---|---|
| 1 | 下拉族 25 方法 + 17 JS 常量体量大（session.py :4344-5014 ≈ 670 行）且分支多（native select/combobox/listbox/custom 四型） | 段 2 独立闸门；JS 常量逐字节锚定（venv dump）；四型各留 1-2 例 Fake 脚本 |
| 2 | 上传链路横跨三层（handler 发现/验证 + session 拦截 + upload_identity clue），Python 侧 200+150 行 | upload_identity 是纯 DOM 树分析（EnhancedDOMTreeNode 输入）——单测友好；拦截事件流用 FakeCdpTransport emit 脚本化 |
| 3 | evaluate 增强的 args 经 `Runtime.callFunctionOn` this=document 编组——与 evaluateScript 单发路径的分叉面易碎 | 契约钉死「args 非空即 callFunctionOn、无 args 走既有单发」；两路径各锚 |
| 4 | read_grid 308 行三通道降级链（uiRegistry → legacy AJAX → DOM 表格）+ 合计交叉校验 | 三通道各自可独立 Fake；合计校验纯函数锚定 |
| 5 | search 引擎 URL 表与 udm=14 参数时效性（google 反爬形态变更） | 逐字节照搬 :360-365（保真优先，URL 形态是 Python 侧关注点非本仓） |

## 5. 验收命令

```bash
pnpm install && pnpm typecheck && pnpm test          # 日常
node scripts/gate.mjs pre-commit                      # 提交门
node packages/core/tools/agent-loop-smoke.mjs         # 真机 smoke（回归面，P4b 各段收尾各跑一次）
# batch2 锚点再生成（刻意更新基准时）：
D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe \
  packages/core/tools/gen-batch2-anchors.py --out packages/core/test/fixtures/python-anchors/
```

## 6. 评审轮登记（§7）

### feat/p4b-actions-a

- **轮 1（2026-09-28，11 条：自评 high4 / medium4 / low3）**——采纳 7（均 P2）+ 顺手 3 + 驳回 1：
  - [4] close_tab 非字符串 tab_id（数字后缀形态）被静默归空关当前页——Python 端
    endswith(int) TypeError 落 Tools.execute 通用 catch（actions.py :810-822）= error；
    补 string 守卫（switch_tab 同款文案），null/undefined 仍落当前页（Python falsy 同构）。
  - [5] findText nth=0/负数——评审称「Python pydantic ge=1」**不成立**（Python 无任何
    校验，session.py :3990-3999 `visible_ids[nth-1]` 负索引回绕是真实语义；非整数 nth
    两边同样被逐查询 except 吞掉后落 JS 回退）。部分采纳：补 Python 负索引回绕
    （nth=0→末元素），不加 ge=1 校验（加了反而偏离 Python）。
  - [6] 文件三动作白名单裸 startsWith 可被 `../` 穿越绕过——Python 同病（:2361/:2417/
    :2611 均裸 startswith，穿越形态会静默写出白名单外）；按本仓 fs.resolve 契约
    （「白名单前缀比对前归一化」，done.ts 既有模式）收严为 resolve 后比对——
    **登记偏离**：仅多拒 Python 会越狱写出的路径，合法路径行为不变（错误/回显显示
    归一化路径）。
  - [7] write append 读旧拼新会腐蚀既有非 utf-8/二进制字节（Python open(path,"a")
    纯字节追加零接触）——FileSystemProvider 增 `appendTextFile`（open("a") 等价），
    全部实现面同步（fake-fs 字节级拼接 / 三处测试内联假件 / smoke memoryFs）。
  - [9] readTextFile 契约补两条：maxChars 省略=全读（宿主不得自带截断）；严格 utf-8
    解码（非法字节 reject 映射 Python UnicodeDecodeError→error 文件不动，禁止
    U+FFFD lenient 后静默写回）。核心无法强制宿主，契约级收严。
  - [8] count 限量替换重扫替换产物（new ⊇ old 时漏改原文 + replaced 虚报）——重写为
    原文单遍拼接（regex 段切片替换保引擎 $ 展开 + 零宽前进守卫；literal 段 indexOf
    推进）；期望值 venv 实跑锚定（'a\nb\n'.replace、subn count 语义）。
  - [11] 替换模板缺组静默写坏文件（Python re.error/IndexError 皆 error 不动文件）——
    `pythonTemplateToJs` 全量移植 CPython 3.12 re._parser.parse_template（\g<0>=整匹配、
    \1..\99 引用、\0/三连八进制字面量、控制字符、bad escape、位置口径=venv 实跑锚定；
    未知名 IndexError 形态与 re.error 前缀形态均按 Python 包法）。轮内自测揪出三个
    实现 bug（多位数字 off-by-one 把 \1 读成 11、字面 $ 转义差一档、八进制取值多切一位）。
  - 顺手（P3 触内）：[2][3] gen-batch2-anchors.py 死导入/死常量删除；[10] write 回显
    enc 死分支删除（encoding 收窄偏离下不可达）。
  - 驳回 [1]：findElementsNodeIds offset ≥ total 时 fromIndex > toIndex 由 CDP 报错——
    **Python session.py :4310-4314 逐行同构**（to_index=min(total, offset+max)、fromIndex
    裸传、无钳制），错误同样经 action catch 包成 "Find elements failed"；JS 体变体
    （searchPage/findElements）优雅空窗也是 Python 原样（JS 内切片）。移植保真，非缺陷。
  - 测试 984→992（+8，另 2 例 pythonTemplateToJs 单测计入净增）；覆盖率 93.07% /
    85.22%；门禁 exit 0；双向验证：8 个新用例对旧实现全红后恢复。
- **循环收敛（2026-09-28，轮 2 起）**：轮 1 修复提交 `55db23c` 后增量恒空
  （diffBase=lastCommit=tip）——按空增量条款与 p4-policy-smoke 先例（「必然满足」）
  宣布收敛，不空跑评审。累计：1 实跑轮 / 11 意见（P2×7 实施 + P3×3 顺手 + 驳回×1）/
  测试 984→992 / 覆盖率 93.07%·85.22% / 分支 2 提交（c098b61 + 55db23c）待合并。
  注记：修复提交本身未再过评审轮（协议设计——防「修复生产新意见」正反馈）；合并前
  如需可跑一轮定向评审（`--from c098b61`）。

## 7. 完成记录（§8）

### feat/p4b-actions-a（段 1，2026-09-28 实施完成，分支未评审未合并）

- **十动作 handler 全量**（`tools/actions/` 新七文件）：search（引擎 URL 表 :360-365
  逐字节含 udm=14；quote_plus 等价含 !'()* 编码与空格→+）/ find_elements + find_text +
  search_page（三个 formatter :147-268 逐字节锚定；query_total 结构化旁路；大结果分级
  落盘复用 saveOversizedResult）/ screenshot + save_as_pdf（参数透传 + fs 落盘；**保真
  注记**：Python 两动作的 save_path/path 均不经白名单——01 计划初稿的「白名单落盘」
  有误，实施按 Python 直写并在此更正）/ close_tab（后缀匹配 + 撞车检测 + 未命中列举 +
  软降级）/ 文件三动作（write：newline 守卫式簿记 + append 直写；read：magic 嗅探 :114-144
  全分支 + 窗口分页 :2466-2527 含 footer 预算 160；replace：regex/count/expected_count/
  backup 全参数 + Python 替换模板 \1 反向引用转换）。
- **session 侧**：`browser/search-find.ts`（:60-105 XPath 工具 + 两个 JS 常量体逐字节
  ——_SEARCH_PAGE_JS_BODY/_FIND_ELEMENTS_JS_BODY 经 venv dump 对拍 + findText 三查询链
  （G8 nth/G9 可见性优先探测/G10 大小写/G11 高亮三模式 + finally discard 防泄漏）+
  searchPage/findElements/findElementsNodeIds）；BrowserSession 增四方法委托；ToolsBrowser
  扩面七方法（closeTab/takeScreenshot/printToPdf/find 族）。
- **FileSystemProvider 增 stat/readHead** 两成员（窗口计量 + 12 字节 magic 头）；全部
  实现体同步（三处测试内联假件 + smoke memoryFs + 新公共 makeFakeFs）。
- **注册面 10→20**：gen-tools-anchors.py 增 segmentA 面（version/schema 矩阵/descriptions
  全新生成）；registry/agent-anchors/actions 三处既有测试改「batch1 子集 registry + segmentA
  默认面」双锚定（subsetRegistry 复刻生成器注册形态）。
- **新锚点生成器 gen-batch2-anchors.py**：venv 实跑 Python Tools 裸实例产出 batch2.json
  ——三个 formatter / sniff 全 magic 分支 / textQueries / xpath 字面量 / 两 JS builder
  逐字节 / 文件三动作全输出（tmp 路径稳定化 /ANCHOR_TMP；**坑**：稳定化不得全局替换
  反斜杠——正则 fixture 内容会被腐蚀，只替换路径本身+占位段后分隔符归一）。
- **实施要点**：JS 字面量注入用 pyJsonDumps（Python json.dumps 默认分隔符带空格——
  JSON.stringify 不带，容器参数会漂移）；正则替换必须**字符串形态**传 replace（replacer
  函数返回值不做 $ 替换——JS 规范，$n 会变字面文本）；case-insensitive literal 的 new
  按字面量（$ 转义）不展开引用（Python _literal_replacer 同款）；write append 经
  读旧拼新（接口无 append 模式）。
- 偏离落地（01 §6）：富文档降级（image 提示逐字节；pdf/docx 指向 M5 hook 的可操作
  error——Python pip install 提示留档 fixture）；encoding 收窄 utf-8（已知非 utf-8
  Python 会成功、TS 拒并给可操作 error）；tmp+rename 原子性归宿主 fs；正则引擎错误
  文案差异（re.error vs V8——前缀逐字节+包含断言）。
- 测试 892→984（+92：锚定 43 / 文件族 19 / handler 集成 21 / search-find session 13 +
  printToPdf 补面 3（既有缺口）/ 既有面改写若干）；覆盖率 93.12%/分支 85.09%；门禁
  exit 0；真机 smoke deny-once 变体回归 exitCode 0（20 动作面）。

### feat/p4b-actions-b（段 2，2026-09-29 实施完成，分支未评审未合并）

- **下拉 session 侧 25 方法族**（`browser/dropdown.ts` + `browser/dropdown-js.ts`）：
  native 读写（fetchSelectOptions resolveNode+callFunctionOn 作用域限定 / G11 全空懒加载
  focus+1.0s 重试 / selectionReverted 回退点击 / multi 整组设置 issue #192）、ARIA 与
  custom class 读写、读写双 dispatcher（同一份 JS 判型零漂移 D1）、combobox Python flow
  （真实 click 展开 + getElementById(aria-controls) 兼 Portal + finally 强制收起 D3）、
  自定义开态 discover 流（effective click target 4 层最外 select-ish 祖先 / 两次点击尝试
  / 虚拟化 scroll-until-found ≤10 页 / 真实 CDP click 选中）、子树 BFS（JS 侧递归）。
  **17 个 JS 常量逐字节锚定**（dropdown-js.ts 行数组 join 形态——模板字面量转义会腐蚀
  正则/`${` 内容；生成自 batch2b.json，10 处 noTemplateCurlyInString 按行抑制）。
- **上传 session 侧**（`browser/upload.ts`）：setFileInput（DOM.setFileInputFiles 直设
  + ids[0] fallback + shadow DOM 搜索 + RuntimeError 同文案）、walkForFileInputs
  （children/shadowRoots/contentDocument 三向纯函数）、**file-chooser 拦截消费端**
  discoverFileInputViaClick（拦截未启用拒点防原生对话框 / 0.05s 轮询至 2.5s / 命中取
  backendNodeId）。**偏离**：非 ASCII 文件名 ASCII 临时副本不落核心（tempfile+全量二进制
  复制属宿主面——02 §6 预留偏离 1 之外的执行期补充，宿主可在 fs 层前置重命名）。
- **upload_identity 全量移植**（`tools/actions/upload-identity.ts`）：两条身份上下文 JS
  逐字节（全页扫描版 + 单元素 this=input 版）+ fileInputCandidates（acceptHint/path 双路
  kind 过滤）/ uploadInputContexts（DOM 序对齐，数量不符坑③降级空 Map）/ buildUploadClue
  （录制同形，affordance 非空附 trigger_affordance）/ nonzeroRect / effectiveClueRect
  （rect→container_rect→affordance.rect 优先级）/ captureUploadClue（best-effort）。
- **三 handler**（actions/dropdown.ts ×2 + upload-file.ts）：dropdown_options 预分类四路
  （native/combobox/dispatcher/开态 fallback 双 error 形态）+ _format_options_result 全
  source 形态逐字节（fixture 含空选项诊断表）；select_dropdown 运行时守卫（value/values
  互斥与形态、multi 仅 native）+ 单/多选成功/miss/裸 error 三态回显 + dispatcher miss →
  setCustomDropdownOption fallback；upload_file 五段链全量（Semi 双 input replace 纠偏
  Fix C #96 / 多 input 软警告含 live 候选 / 唯一 input ℹ️ / label 近邻 chooser 发现
  issue #34 / accept 软校验 ℹ️ Note / 页面级验证轮询 ✅/无定论）。
- **辅助**：_find_upload_label_near 近邻启发式（class/选择文件/上传三信号 + 祖先攀爬
  maxAncestor 4 × 子树 maxDepth 3，含 shadow）；_file_matches_accept（扩展名/通配/全 MIME
  三态，guessMime 用精简表——Python mimetypes 平台注册表相关，**登记偏离**：锚定用例域
  内等价）；describeUpload 入 element-lookup；ToolsContext 增 uploadVerify 三参（默认
  True/1500ms/250ms 照搬 Tools :765-767）；ToolsBrowser 扩面 12 方法 + BrowserSession 委托；
  注册面 20→23（gen-tools-anchors.py 增 segmentB 面，batch1/segmentA 纯增量稳定）。
- **上游发现（保真复刻并注释钉住）**：`_set_subtree_option` 的 `payload.get("found")` 读
  callFunctionOn 的 result 外壳（returnByValue=False 下无 found 键恒 falsy）→ 子树写路径
  在 Python 实际恒返回 "vanished" 错误、其后 setter 选择段不可达——TS 同构该可观测行为
  （dropdown.ts 注释 + 测试锁定），待反馈上游。
- **新锚点生成器 gen-batch2b-anchors.py**：venv 实跑产出 batch2b.json（17 JS 常量 /
  upload 三 JS / 诊断表与引导文案 / describe 与 formatOptions 全 source / accept 21 例 /
  isAutocomplete 9 例 / label-near 7 合成树 / walk 2 树 / identity 四函数）。
- 偏离落地（02 §6）：attachmentId 模式不落（偏离 1）；懒加载/轮询时序常量照搬（偏离 2）；
  JS 常量上游同源注释以行号锚定形式保留（偏离 3）。执行期补充偏离：非 ASCII 临时副本、
  guessMime 精简表（上文）。
- 测试 992→1148（+156：锚定 86 / handler 26 / dropdown session 27 / upload session 8 +
  既有面改写）；覆盖率 93.52%/分支 85.27%；门禁 exit 0；真机 smoke deny-once 变体回归
  exitCode 0（23 动作面）。
