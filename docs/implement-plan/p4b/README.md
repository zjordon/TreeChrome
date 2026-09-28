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

（各段 /review-loop 结果逐轮登记于此，格式同 p4/README.md）

## 7. 完成记录（§8）

（各段完成后登记）
