# 02 · tools 层：models / registry / actions + llm 扩面

> 参照：TreeWalker `tools/models.py`（801）/ `tools/registry.py`（255）/ `tools/actions.py`（3264）/ `tools/extract_markdown.py`（212）/ `llm/client.py` 的 extract(:635-730) 与 structured_call(:732-771)。行号锚点均属 `640d52a`。
>
> 冻结：参数模型与校验语义、四元组与 capability 映射、schema 生成规则、Tools 编排器、batch1 十动作行为契约、batch2 索引边界。

## 1. models.ts：25 个参数模型 + ACTION_DEFINITIONS 四元组

- **全量定义 25 个动作的参数模型**（batch2 动作也先定义类型——它们是 registry schema 的组成部分，且 P4b 只填 handler 不再动 models）：模型清单与字段约束按 models.py 逐个照搬（探查锚点：navigate :651/NavigateParams :27 … done :794/DoneParams :596；`_LocatorParamsMixin` exactly-one :6-24；ExtractParams._drop_empty_items :126；SelectDropdownParams._value_xor_values :282）。
- **校验 = 手写 validator**：TS 端 `validateParams(model, raw): { ok: true; value } | { ok: false; errors: string[] }`。语义对齐 pydantic v2 `extra="forbid"`（未知字段拒收）、Literal 枚举、范围（ge/le/min_length）。**执行路径不校验**（Python memory: action-params-no-runtime-validation）——校验只发生在 step 预检梯（03 §3.2），报错文案锚定 Python 实跑样例。
- **四元组**：`ACTION_DEFINITIONS: Record<string, { params: ParamModel; description: string; terminatesSequence: boolean; capability: Capability }>`（架构 §3.3 三元组扩四元组）。batch1 的 capability 映射（04 §1 全表）：navigate→NAVIGATE、click→CLICK、input_text→TYPE、scroll→READ（不过门，架构 §5.2 补行）、extract/wait→READ、go_back/switch_tab→NAVIGATE、send_keys→CLICK|TYPE（按键型分流，04 §1）、done→无（终止动作，权限门在 done 前的动作上已拦）。
- `make_structured_done_params`（:633-646，output_model 变体 B）照搬：`data` 必填、success/files_to_display 对 LLM 隐藏（registry 摘字段用）。
- terminates=True 共 6 个：navigate/search/switch_tab/go_back/evaluate/read_grid（Python 现状）。

## 2. registry.ts

照搬 registry.py：`RegisteredAction{name, description, params, handler, terminatesSequence, pagePatterns?}`；`ActionRegistry`：

- `registryVersion`（动作名集合 sha256[:12]，:50-59）——历史漂移校验用
- `action()` 装饰器语义 → TS 直接传注册对象
- `getToolSchema({ pageUrl?, outputMode, maxActions, enablePlanning })`（:90-234）：Anthropic `agent_response` tool schema；flash/standard/thinking 三 output_mode；maxActions>1 时 action 包 array（multi_act）；enablePlanning 附加 plan_update/current_plan_item。**schema JSON 逐字节锚定 Python 实跑**（三 mode × 单/多动作 × planning 开关的矩阵）
- `getActionDescriptionsText(pageUrl?)`（:236-255）：system prompt 的动作列表文本，字节锚定
- `pagePatterns` 用 fnmatch 语义（TS 实现通配匹配）只影响可见性不拦截执行（架构 §3.3）

## 3. Tools 编排器（actions/ 目录骨架）

```
core/src/tools/
  models.ts  registry.ts
  actions/
    index.ts          // Tools 类：execute / _flatten_params / _normalize / _get_element_by_index / _register_all
    shared/           // 元素定位族 / 导航健康族 / 点击证据族 / 查询落盘族（§4）
    navigate.ts click.ts input-text.ts scroll.ts extract.ts
    wait.ts go-back.ts switch-tab.ts send-keys.ts done.ts
  extract-markdown.ts
```

- `Tools.execute(name, params, browser, browserState)`（actions.py:743-765）：registry 查名（未知名→`ActionResult{error:"Unknown action"}`）→ `_flattenParams`（:3236-3251，拆 LLM 嵌套包裹 `{"click":{...}}`，尊重参数模型真 dict 字段如 done.data）→ handler(params, browser)（browserState 经缓存间接传 :756）→ 异常包 `ActionResult{error}`。
- `_get_element_by_index`（:769-784）：优先 browserState.selectorMap，miss 则 `browser.get_state()` 刷新。
- 循环依赖破除（探查警示）：Python 的 tools↔agent 双向 import 靠延迟解析容忍——TS 把 `ActionResult`/`DownloadInfo` 等 views 类型放 `agent/views.ts`，tools **只 import 类型**（import type 不产生运行时环）。

## 4. batch1 十动作行为契约

| 动作 | Python 锚点 | 移植要点（探查已核实的调用链） |
|---|---|---|
| navigate | :816-861 | URL 补 https → `browser.navigate`（new_tab 走 createTarget+switch）→ `_navigate_health_check`（:875-910 空 DOM 三阶段：get_state 检查 → 3s 重查 → 重新 navigate+5s → 仍空 raise）→ 增强 settle → `_map_navigation_error`（:912-919 net::ERR_* 映射） |
| click | :921-1044 | exactly-one 守卫 → 元素查找 → **file-input 守卫**（:942-949 引导 upload_file——batch1 无 upload_file，引导文案改为提示该动作未启用）→ 下拉降级（:956-980，batch1 无下拉族——**该分支跳过**，登记：batch1 的 click 直达真点击，P4b 补回降级链）→ 按钮类先取指纹 → highlight+click_element → 新标签检测（:1110-1135 diff targetId 自动 switch）→ 无效果检测（0.6s 比对页面指纹+表单值摘要 :1015-1035）→ `_read_page_messages` |
| input_text | :1369-1450 | highlight+click 聚焦 → `requiresDirectValueAssignment`（date/time/color/range）分支走 clear+forceSetValue；否则 typeText（逐字符 + 框架事件 + 拼接守卫）→ combobox 等待 0.4s → 回读验证（readActiveText + `_read_validation_state` :1074-1084） |
| scroll | :1452-1470 | `browser.scroll`（视口中心 mouseWheel、回读 vertical_percentage/at_edge）；CDP 失败必须报 error（非幂等） |
| extract | :1483-1577 | getPageHtml（失败降级 executeJs outerHTML）→ extractCleanMarkdown → 无 extract LLM 则截断片段降级 → chunkMarkdownByStructure 定位 start_from_char → `llm.extract(...)` → 分页 hint → 大结果按 extractSaveThreshold 落盘（FileSystemProvider 未注入则跳过落盘 + metadata 标注，风险 10） |
| wait | :1665-1667 | sleep，空 ActionResult |
| go_back | :1669-1684 | `browser.go_back`（无历史返 None→报错）→ `_go_back_health_check`（:1686-1709 轻量：只等待+warning 不 reload） |
| switch_tab | :1593-1612 | get_tabs 后缀匹配（targetId 后 4 位）+ 撞车报错 → switchTab |
| send_keys | :1579-1591 | `browser.sendKeys` 三路由；失败报 error（非幂等） |
| done | :3144-3232 | success 默认推导（text/data 存在才 true）→ files_to_display 白名单+存在性→attachments（FS 未注入降级）→ 变体 B：outputModel 校验失败→success=false 但 is_done=true；变体 A 空 text 兜底 "(no summary provided)" 仍终止 |

`shared/` 四族（模块级函数，行锚点）：元素定位族（_get_element_by_index/_find_node_by_backend_id/_is_autocomplete_field/_is_file_input_node + 回显族 _describe_*）；导航健康族（_dom_appears_empty/_navigate_health_check/_go_back_health_check/_map_navigation_error + 常量）；点击证据族（_read_page_messages/_page_fingerprint/_form_values_digest/_read_validation_state/_detect_new_tab_opened + 4 个 JS 常量 :374-441——JS 体逐字节照抄）；查询落盘族（_format_search_results 等格式化 + 公共 saveLargeResult——Python 在 6 处内联重复，TS 抽公共函数，登记为等价重构）。

## 5. extract-markdown.ts

- `extractCleanMarkdown`（extract_markdown.py:33-55）：**turndown 替代 markdownify**（README 决策 6）+ 噪声标签 strip 列表 + link/image 正则门控照搬。输出**不锚定字节**（LLM 消费非契约），但 strip 规则与门控正则逐条对照移植。
- `chunkMarkdownByStructure`（:195-212）：算法**保真移植**（行级 unit → 贪心打包 → 表头延续 + 反孤岛两条业务规则），锚定 Python 实跑（构造含表格/短尾块的 markdown 样例对拍 chunk 边界）。

## 6. P2 client 扩面：extract / structuredCall（llm/client.ts 增量）

P2 公共面仅 `getAction/setCallWindow/testConnection`；Python client.py 的两个通用底座未移植，P4 补齐（消费者：extract 动作、task_matcher、Judge）：

- `extract(prompt, content, { maxContentChars=8000, outputSchema?, alreadyCollected?, callTimeout? })`（client.py:635-730）：schema 校验（非 object+properties 降级 free-text）→ alreadyCollected 拼去重块（≤200 条）→ 有 schema 走 forced tool `extract_result`（system 文案 :660-666 字节照搬）+ toolUse 提取 + text 兜底；无 schema 直接 text。maxTokens=2048。RateLimit/APIError 先走 fallback 单向切换再重入自身。
- `structuredCall(systemPrompt, userPrompt, outputSchema, { maxTokens?, callTimeout? })`（:732-771）：forced tool `structured_result` + text 兜底 `tryParseJson`（P2 已有）；返回解析后对象或 null；失败先 fallback 切换再抛。
- 协议适配：两者经 `provider.chat`（ToolDefinition + toolChoice 强制）走通——对 supportsForcedTool=false 的端点自动落 P2 的 prompt 约束 + JSON 兜底链（承重墙复用）。单测锚定 Python 行为（fallback 切换重入 / text 兜底 / schema 降级 warning）。

## 7. batch2 索引（P4b，预估 4~5d，此处只冻结边界）

| 族 | 动作 | session 侧依赖（01 §2 预留槽） |
|---|---|---|
| 搜索族 | search / find_elements / find_text / search_page | search-find.ts（:3920-4321 + XPath 工具） |
| 下拉族 | dropdown_options / select_dropdown | dropdown/（25 方法 + 17 JS 常量） |
| 上传族 | upload_file | upload.ts + upload_identity.py（285 行）+ file chooser 拦截的消费端 |
| 文件族 | write_file / read_file / replace_file | FileSystemProvider 实装 + 白名单 + 富文档嗅探（:114-144/:2470-2523） |
| 网格族 | read_grid | grid-read.ts（uiRegistry/legacy ExtJS/DOM 表格三通道 + 合计交叉校验） |
| JS 通道 | evaluate | evaluate-enhanced.ts（语法自愈重试/UTF-16 列偏移/frame 切换/args+elements） |
| 截图/导出 | screenshot / save_as_pdf | printToPdf 已在 batch1 移植；动作 handler + save_path 白名单 |
| tab 补全 | close_tab | tabs.ts 已有 closeTab |

**评测 Tier1 依赖提醒**：cdp_evaluator 的 CDPPageAdapter 需要 `evaluate`（增强版）——P5 parity 启动前 P4b 必须完成 JS 通道族。

## 8. 有意偏离清单

| # | 偏离 | 理由 |
|---|---|---|
| 1 | pydantic → 手写 validator（语义锚定） | README 决策 5 |
| 2 | click 的下拉降级链 batch1 跳过（batch1 无下拉族） | 分批边界；P4b 补回并加对拍 |
| 3 | file-input 守卫文案改为「动作未启用」提示 | batch1 无 upload_file |
| 4 | 6 处内联落盘 → 公共 saveLargeResult | 等价重构，消除 Python 的重复 |
| 5 | markdownify → turndown（chunk 算法保真） | README 决策 6 |
| 6 | 大结果落盘/附件经可选 FileSystemProvider，未注入降级 + metadata 标注 | 核心包禁 fs；宿主注入 |
| 7 | `allowed_*_paths` 白名单校验保留但 FS 动作在 P4b（白名单配置面先行入 Settings） | 分批边界 |
