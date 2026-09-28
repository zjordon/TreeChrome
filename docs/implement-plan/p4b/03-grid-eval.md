# 03 · read_grid 三通道 + evaluate 增强（评测 Tier1 前置）

> 参照：actions.py :2730-2815（evaluate handler）/ :2816-3139（read_grid handler + 
> `_eval_grid_channel`）；session.py :3735-3940（evaluate 增强）/ :3114-3187（read_ui_grid）。
> **已就位可复用**：grid-meta.ts（:3116-3191 `_read_grid_meta` 已移植）、navigation 的
> 网格 kick JS（:2866-2985 已移植）、evaluate-basic.ts 的 JS 工具族（delimiterScan /
> syntaxRepairCandidates 位置验证——P4 移植时「语法自愈接线留 P4b」的欠账在此还）。

## 1. evaluate 增强（handler :2730-2815 + session :3735-3940）

- **参数面**（models 已冻结）：code 必填；args（数组）/ elements（index 列表）/
  await_promise / timeout_ms / user_gesture / return_element_ids / frame。
- **执行路由**（session.evaluate 契约）：
  - 无 args/elements → 既有 `evaluateScript` 单发路径（Runtime.evaluate，
    returnByValue+awaitPromise+timeout 透传）——P4 已有，仅接线参数；
  - **args 非空 → `Runtime.callFunctionOn`（this=document，CDP 编组参数——无字符串拼接、
    无注入面）**：code 包 `function(...a){...}`（Python :3774-3790 同款包装与校验——
    非 function 表达式报可操作 error）；
  - elements → index→backendNodeId 解析后以 nodeId 数组传入（DOM.resolveNode 链）；
  - frame → Target 会话切换（flatten sessionId 绑定面复用 transport.bindSend）；
  - return_element_ids → 返回值中的节点投影为 backendNodeId 列表（`_format_node_id_results`
    复用）。
- **语法自愈重试**：单发路径异常（exceptionDetails）→ `syntaxRepairCandidates` 产修复
  候选 → 位置验证 fail-safe 重试一次（evaluate-basic 已有工具，接线点在此；Python 阶段一
  preprocess + 阶段二重试语义照搬，含「修复也失败时原始异常优先上报」）。
- 结果归一化：值 → LLM 友好字符串（Python 归一化函数照搬——undefined/null/数组/对象
  截断层级）；大结果落盘走 evaluate 同款分级（saveOversizedResult 复用）。
- **权限门**：EXECUTE_JS（已冻结）。

## 2. read_grid（handler :2816-3124，308 行）

- **参数守卫**（Python :2828-2860 逐条照搬，含 error 文案）：namespace/filters/search/
  sorting（"field desc" 解析）/page_size（1-2000 钳制）/page/fields/group_count。
- **三通道降级链**（`_eval_grid_channel` :3125-3139 逐字照搬）：
  1. **uiRegistry**：`read_ui_grid` :3114-3187（KO/UI 组件网格——payload 透传
     namespace/filters/search/sorting/page；冻结网格先 kick 复用 navigation）；
  2. **legacy AJAX**：ExtJS 老网格（store 读取 JS 通道）；
  3. **DOM 表格**：纯 DOM `<table>` 解析（表头映射 + 行提取）。
- **数值归一**：`_parse_grid_number` :688-728（千分位/百分号/货币符/全角——逐字节）；
  **合计行角色**：`_grid_footer_row_role` :729-754。
- **合计交叉校验**：数值列求和 vs footer 合计比对（容差照搬）——不一致在元信息标注而非
  报错（只读数据通道，不更新页面 UI/过滤芯片）。
- 大结果落盘分级同 evaluate；grid 元信息（total/sorting/活动过滤残留）进 extractedContent。

## 3. 模块布局

- `browser/grid-read.ts`：read_ui_grid + legacy AJAX 通道 + DOM 表格通道（JS 体逐字节，
  venv dump）；grid-meta/kick 复用不重写。
- `browser/evaluate-enhanced.ts`：callFunctionOn 包装/elements 解析/frame 切换/语法自愈
  重试接线/结果归一化（evaluateScript 与其并存——单发子集不回归）。
- `tools/actions/grid.ts` / `tools/actions/evaluate.ts`：两 handler。
- ToolsBrowser 扩面：`readUiGrid(payload, timeoutMs?)` / `evaluateEnhanced(req)`。

## 4. 评测对接提醒（P5 前置）

cdp_evaluator 的 CDPPageAdapter 消费**增强版 evaluate**（args/elements/timeout 面）——
本段验收含「adapter 消费面签名对齐」检查项：evaluate 的 TS 公开签名须覆盖 Python
`session.evaluate` 的全参数面（架构 §10 移植对照索引同步更新）。

## 5. 测试矩阵

| 对象 | 覆盖要点 | 假件 |
|---|---|---|
| `_parse_grid_number` | 千分位/百分号/货币/全角/负数/非数值（venv 锚定全分支） | 纯函数 |
| `_grid_footer_row_role` | 合计行识别/非 footer | 纯函数 |
| 三通道降级链 | ch1 成功短路 / ch1 失败落 ch2 / 双失败落 ch3 / 三失败 error 文案（逐字节） | FakeCdpTransport（三通道各自脚本） |
| 合计交叉校验 | 一致/不一致标注/容差边界/非数值列跳过 | 纯函数 + 集成 |
| evaluate 参数守卫 | 非 function 表达式 error / elements 越界 / timeout 非法值 | — |
| callFunctionOn 编组 | args CDP 序列化（原始值/数组/对象）/ this=document 断言 / 返回归一化各形态 | FakeCdpTransport（帧捕获） |
| 语法自愈 | 可修复语法（引号/括号）重试成功 / 修复候选全失败报原始异常 / 位置验证拒绝误修复 | Fake 脚本（第一次异常第二次成功） |
| frame 切换 | sessionId 绑定断言 | FakeCdpTransport |
| 大结果落盘 | 分级阈值/落盘路径/metadata 标注 | 内存 fs |

## 6. 有意偏离清单

| # | 偏离 | 理由 |
|---|---|---|
| 1 | evaluate 结果归一化的截断层级数值照搬 Python，但 TS 侧 Map/Set/BigInt 的归一化分支为 TS 语义新增（Python 无此类型面）——新增分支单测锚定自身行为 | 语言面差异；不虚构 Python 不存在的对照 |
| 2 | 语法自愈的「位置验证」沿用 evaluate-basic 既有 fail-safe 实现（P4 已锚定），不重复移植 Python 阶段一 preprocess 的重复部分 | 单源纪律 |
| 3 | read_grid 的 legacy AJAX 通道若依赖站点特定 ExtJS 全局（window.grid 等），JS 体逐字节但**不做站点适配**——Python 同款「有则用无则降级」 | 保真；站点适配属宿主/评测侧 |
