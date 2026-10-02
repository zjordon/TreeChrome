# examples 移植（第一批：getting_started；第二批：features）

> 分支 `feat/examples`（自 main 97733c5）。基准：TreeWalker @640d52a。
> 前置：@tw/node-host 已合并（merge 4bf404f），薄壳模式（`loadKit` → `runAgent`）就位。

# ── 第二批：features（2026-09-30 追加） ──────────────────────────────

## F1. 范围与分类

`TreeWalker/examples/features/` 全部 12 个文件，逐个依赖核对：

| Python 示例 | 依赖核对 | 结论 |
|---|---|---|
| multi_tab.py | 纯任务（navigate/switch_tab/close_tab 均在 25 动作册） | 直接薄壳 |
| scrolling_page.py | 纯任务（scroll 在册） | 直接薄壳 |
| save_as_pdf.py | 纯任务（save_as_pdf 在册；输出路径 C:/tmp 硬编码改 os.tmpdir 可移植化） | 直接薄壳 |
| structured_output.py | outputModel 变体 B 已移植（P4b）；示例内定义 ParamModel + finalResult 解析打印 | 薄壳 + ~20 行 |
| csv_generation.py | allowedWritePaths 覆盖走 overrides.agent；工作区 mkdir/读回/清理在示例内 | 薄壳 + ~15 行 |
| sensitive_data.py | core AgentOptions.sensitiveData 已有；**node-host 无透传口** | 缺口 F3 后薄壳 |
| download_file.py | trackDownloads+displayFilesInDoneText 覆盖；**core 缺口：Agent.run 不传 downloadsPath，trackDownloads=true 时 browser.start 直接抛** | 缺口 F2-a 后薄壳 |
| extraction_small_model.py | **core 缺口：tools.ctx.extractClient 硬编码主 llm，无注入口**（Python config.py:562-570 extract_llm） | 缺口 F2-b 后薄壳 |
| fallback_model.py | core ProviderConfig.fallback 已有（P2）；**node-host 卡面无 fallback 字段** | 缺口 F3 后薄壳 |
| rerun_history.py | save_history/detect_variables/load_and_rerun 全未移植（偏离 3） | 跳过（F5） |
| douyin_upload_rerun.py | rerun 族 + 真实抖音登录态/本地视频文件（无法自动验证） | 跳过（F5） |
| _debug_selectors.py | rerun 族调试脚本，`_` 前缀惯例不入库 | 跳过（F5） |

## F2. core 缺口（两个注入口，judgeLlm 先例同款）

### F2-a：AgentOptions.downloadsPath

现状：`Agent.run()` 调 `browser.start({trackDownloads, enableRecentEvents})` 不带路径；`BrowserSession.start` 在 trackDownloads=true 且无 downloadsPath 时抛「宿主解析并确保目录存在——核心包不读 env/home」（session.ts:250-252 有意设计）。缺的是 Agent 层注入口。

- `AgentOptions.downloadsPath?: string`；`agent.run()` 的 `browser.start` 增传。
- Python 解析序（session.py:1882：参数 > DOWNLOADS_PATH env > 用户 Downloads）的 env/home 半边归 node-host（F3）。

### F2-b：AgentOptions.extractLlm

现状：`agent.ts` 构造里 `this.tools.ctx.extractClient = this.llm` 硬编码。Python `AgentSettings.extract_llm`（config.py:562-570，None=复用主 llm）。

- `AgentOptions.extractLlm?: LLMClient | null`，构造改 `options.extractLlm ?? this.llm`——与既有 judgeLlm 完全同款（config.py 的 env 面 AGENT_EXTRACT_* 归 host 层，本批不扩——示例硬编码卡片）。

## F3. node-host 缺口

1. **sensitiveData 透传**：AssembleAgentOptions/RunAgentOptions 增 `sensitiveData?: Record<string, SensitiveDataSpec>`，直传 Agent。
2. **downloadsPath**：HostSettings.browser 增 `downloadsPath`（env `DOWNLOADS_PATH`；缺省 `join(homedir(), "Downloads")`——host 层合法读 env/home）；runAgent 在 trackDownloads 开启时 ensureDir 后传 AgentOptions.downloadsPath；overrides.browser 可覆盖。
3. **fallback 卡面**：HostSettings.llm 增 `fallback?: {model; apiKey?; baseUrl?} | null`（env `FALLBACK_LLM_MODEL` 空=无 fallback / `FALLBACK_LLM_API_KEY` 缺省复用主 key / `FALLBACK_LLM_BASE_URL` 缺省主端点——config.py:588-600 同款；maxTokens 缺省 DEFAULT_MAX_TOKENS 16384）；assembleAgent 组 ProviderConfig.fallback 完整卡（name "zhipu-anthropic-fallback"、protocol anthropic-messages）。overrides.llm 可覆盖。

## F4. 示例形态（9 个，examples/features/ kebab-case）

- 纯薄壳 ×3：multi-tab / scrolling-page / save-as-pdf（路径 `join(tmpdir(), "browser_automation.pdf"`）。
- structured-output.mjs：ParamModel 定义 Posts/Post（FieldSpec）+ overrides.agent.outputModel + finalResult JSON.parse 逐条打印（解析失败打印原文，Python :64-70 同款兜底）。
- csv-generation.mjs：workspace=examples/features/csv_workspace（mkdir）→ overrides.agent.allowedWritePaths=[workspace] → 结束读回打印 → 交互清理改「提示路径不自动删」（脚本无 stdin 交互惯例；Python input()+rmtree 登记偏离）。
- sensitive-data.mjs：runAgent({task, sensitiveData})。
- download-file.mjs：overrides.agent={trackDownloads, displayFilesInDoneText}。
- extraction-small-model.mjs：`extractLlm: new LLMClient({glm-4-flash 卡})`（boot-entry 已导出 LLMClient）。
- fallback-model.mjs：overrides.llm.fallback={model:"glm-4-flash"}。

## F5. 跳过登记（rerun 族）

`rerun_history.py` / `douyin_upload_rerun.py` / `_debug_selectors.py`：save_history/detect_variables/load_and_rerun 按既定偏离 3 整体未移植；douyin 另需真实登录态与本地媒体文件（Python 原文自认「无法自动跑通验证」）；`_debug_selectors` 是排查抖音重放 bug 的临时脚本（`_` 前缀不入库惯例）。rerun 族立项后一并补。

## F6. 测试矩阵

core：AgentOptions.downloadsPath（fake browser.start 记录入参断言）；AgentOptions.extractLlm（注入实例落到 tools.ctx.extractClient / 缺省主 llm）。
node-host：sensitiveData 透传落 Agent；downloadsPath（env 命中/缺省 homedir/ensureDir/overrides 覆盖）；fallback（env 三键缺省链 + assembleAgent 落 ProviderConfig.fallback + overrides 覆盖 + 无 fallback 时卡片不挂）。
真机：沙箱可达者自验（download-file@w3.org、sensitive-data@httpbin、csv-generation@wikipedia）；HN/google 系（scrolling/structured/extraction/fallback/multi-tab）留用户网络复验（沙箱此前对 HN 不可达、google 超时）。

## F7. 实施步骤

1. core 两注入口 + 单测 → 2. node-host 三缺口 + 单测 → 3. 9 个示例 → 4. 全绿 + 门禁 → 5. 真机冒烟 → 6. /review-loop 增量轮。

## F8. 实施结果（2026-09-30，提交 7a515ea）

**计划外扩展（实施中发现）**：structured_output 的 `Posts.posts: list[Post]` 暴露 models.ts 表达局限——`paramJsonSchema` 的 `$defs` 收集只走直接 ref 字段，array 字段的 items `$ref` 会悬空、validateParams 对对象项不深校验。补齐 list[Model] 嵌套支持（branchSchema items 直 `$ref` + $defs 收集 array.refModel + 逐项深校验 `i.字段` 错误 loc）——pydantic 原生能力的 TS 等价，不是行为偏离。

**实施细节偏离登记**：
- fallback 缺省链双层应用：原设计只在 env 装载层解析 key/baseUrl 复用主卡——overrides 只传 model 时会绕过链（空串覆盖主卡 key）。改为 env 层与 buildProviderCard 双层幂等应用，HostSettings.llm.fallback 的 apiKey/baseUrl 转可选。
- csv-generation 的 Python 版 `input()` 交互清理工作区改为提示路径不自动删（脚本无 stdin 交互惯例）。
- save-as-pdf 输出路径 `C:/tmp` 硬编码改 `os.tmpdir()`。
- extraction-small-model 的 maxTokens 4096（Python AGENT_EXTRACT_MAX_TOKENS 缺省 config.py:570，非主卡 16384）。

**测试与验收**：core 1284→1288（injections.test.ts：extractLlm 落点/downloadsPath 入参/list[Model] schema+校验）；node-host 49→56（fallback env 三键链/DOWNLOADS_PATH/buildProviderCard 完整与部分覆盖/sensitiveData+extractLlm+downloadsPath 透传/trackDownloads ensureDir）；全仓 1562 绿 + 门禁 exit 0（顺带修 client.ts 三处方括号字面量键 lint）。真机冒烟（沙箱可达三例）：download-file 4 步 190s（`DOWNLOADS_PATH` 精确落盘 13264B dummy.pdf——env 链+ensureDir+注入口全链验证）；sensitive-data 2 步 64s（模型全程只见占位符，结果文本的真实值是还原机制产物属设计内；httpbin 回显确认提交）；csv-generation 8 步 258s（CSV top 10 城市数据正确，allowed_write_paths 白名单链生效）。HN/google 系五例（scrolling/structured/extraction/fallback/multi-tab）沙箱不可达，留用户网络复验。

## F9. 实施后修复：downloadProgress.filePath 断链（用户真机日志暴露，2026-10-02）

用户对照跑 TS 与 Python 的 download-file：Python 3 步干净收尾、附件自动挂真实下载文件全路径；TS 7 步、模型瞎猜下载目录三连落空、附件只能挂 save_as_pdf 重渲染副本。归因：**TS connection.ts 把 completed 下载记录的 path 硬编码 null**（P4b 按协议文档推断「downloadProgress 无 filePath」——协议文档确实未列该字段，但 Chrome 实发；Python 同位置 `event.get("filePath")`，用户 Python 日志附件拿到真实路径即铁证）。下游「二.C 下载自动并入 done 附件」其实已移植（post.ts），但「跳过无 path」使全部下载被跳过——与 F2-a 修复前 trackDownloads 全链是死的同源，此环从未被真机检验。

**修复**：connection.ts 读 `e.filePath`（Python :1914 等价，缺席 null）；begin 处理器的过时注释同步更正（url 只在 begin；filePath 只在 progress completed 实发）。次因（模型方差非代码）：两侧默认模型不同（glm-5.1 vs glm-5.3），TS 模型首步选 save_as_pdf 重渲染而非直接 blob-anchor——不修。

**验证**：core 1290（+2：completed 带/不带 filePath 两形态 + 二.C 附件链纯函数测试——含 Python 同款「只对既有附件去重、不对传入列表内部去重」语义锚定）。真机重跑 download-file：4 步 158.7s successful=true，`👉 Attachment C:\...\tw-dl-verify\dummy.pdf` 即 DOWNLOADS_PATH 真实落盘的 13264B 原始文件（对照修复前 7 步 381s 挂 40906B 副本）。

### F9.1 授权偏离：[Downloads] 通知带完整路径（2026-10-02，用户授权）

用户手工复跑 download-file（F9 修复后）暴露残留模式：附件已自动挂真实文件，但模型仍不知道下载目录——`[Downloads]` 通知按 Python（step.py:403）只报文件名，模型为「亲眼看磁盘文件」瞎猜 `~/Downloads`、`cwd\downloads`、`chrome://downloads`（后者被 Python 同款的补 https:// 前缀逻辑拼坏），白烧 3-4 步。

**偏离**：sense.ts 的下载通知项在 `downloadProgress.filePath` 可得时附带完整路径——`New files available: dummy.pdf (C:\...\dummy.pdf)`；无 path（老 Chrome）保持纯文件名。模型可直接 `read_file` 真实路径一步验证。

**验证**：core 1290 全绿（通知带路径/无 path 退纯文件名双形态断言）。真机重跑：4 步 151.9s successful=true（对照用户手工 7 步 422.5s）；模型首次仍习惯性猜 `~/Downloads`（落空 1 次）后**精确使用通知路径**（随机临时目录名不可能靠猜）read_file 验证真实文件成功；done 的 files_to_display 模型手打路径有笔误被存在性检查跳过，二.C 照样自动挂上运行时正确路径——双保险按设计工作。

### F9.2 授权偏离：5xx 有界退避（2026-10-02，用户授权）

用户对照跑 extraction-small-model（TS vs Python）暴露：同一个智谱网关瞬时 `HTTP 500 "Internal Network Failure"`，Python 被 **anthropic SDK 的内建 5xx 重试**（默认 ×2）无声扛过（Python 日志 `anthropic._base_client:Retrying ...` 即此层），TS 手写 fetch 客户端（架构铁律禁 LLM SDK）没有这层——extract 两次被打死，模型改道 evaluate 兜底（任务仍成功但示例演示目的落空）。

**核对结论**：TreeWalker 代码层的 `_create_with_backoff` except 元组只有 `(RateLimitError, APIConnectionError)`，5xx 不在其内——TS 原实现对此逐字保真；差异全在 SDK 隐式层。**TS 忠实于 TreeWalker 的代码，但丢掉了其运行时栈的实际韧性。**

**偏离**（对齐 Python 的实际运行行为而非其代码）：
- `callWithBackoff`：退避资格单独放行 `LLMServerError`（内联谓词，先于 infra 检查仍走 fallback 切换优先）。**step 分罪的 `isInfraError` 谓词不动**——持续 5xx 仍计能力失败（Python `is_llm_infra_error` 同款；直接扩员会连带改变 #194 分罪语义）。
- `extractCall`（extract/structuredCall/singleShot 的公共底座，judge/messageCompactor 同享）：两处裸 `provider.chat` 改走 `callWithBackoff`——Python 此层代码无退避但 SDK 重试 408/409/429/5xx/连接错，TS 补齐等效；内层 callTimeoutMs 超时仍直抛 LLMCallTimeoutError（Python asyncio.TimeoutError 同款）。
- 注释三处同步（errors.ts 谓词文档 / http.ts 5xx 分支 / extractCall 头注）。

**验证**：core 1292（改写「500 不退避」锚定为「恒败 6 次耗尽」+ 新增 500 自愈 / extract 路径 500×2 后成功两条）。真实 wire：glm-4-flash 卡 extract 成功返回（extractCall 重构 E2E）。retryAfterMs（503 的 Retry-After）自此有退避消费方。

### F9.3 授权偏离：变体 B data 行附紧凑 schema（2026-10-02，用户授权）

用户跑 structured-output.mjs 暴露：3 步 165.3s 后 `successful=false`——模型 6 轮校验梯子仍未产出 schema 合法数据（用了页面自然字段 title/url/points、最后交字符串化数组）。归因（信息面核对）：**outputModel 的字段名对模型完全不可见**——tool schema 的 `action.params` 是通用 object（单工具设计，参数详情走文本），而文本渠道对变体 B 的 `data`（纯 `$ref`）只渲染一句 `Structured final output.`（TS 与 Python 逐字节一致，`Field(..., description=...)` = `description:`）。模型只能从校验错误反馈逐轮猜字段。这是 TreeWalker 设计本体弱点（Python 同款信息面），非移植缺陷。

**偏离**：`models.ts` 新增 `compactModelSchema(model)`（递归紧凑渲染：键带引号、类型不带、可选 `?`、可空 `|null`、`[item]`、`ref` 嵌套 `{...}`）；registry 的变体 B done 行渲染为 `data: Structured final output. Schema: {"posts": [{"post_title": string, ...}]}`——把 browser-use 原版「output model 进 schema」的意图在文本通道找回。fixture 对拍测试改为偏离感知（fixture 行锚定 Python 侧行为，TS 行断言 schema 展开）。

**验证**：core 1294（+2 compactModelSchema 单测：Posts 嵌套形态 / 修饰符全集）。真机 E2E（quotes.toscrape.com + 同构 Quotes 模型，HN 沙箱不可达）：**2 步 56.9s successful=true，首次 done 即合法 JSON**（残留 2 条容器级小错——漏 data/多 success——梯子步内自愈）；对照用户日志 3 步 165.3s successful=false。

## F10. 评审与合并记录

（实施后填写：/review-loop 轮次、意见数、采纳情况、merge commit）

# ── 第一批：getting_started（2026-09-30 已实施+评审收敛） ─────────────

## 1. 背景与范围

本批移植 `TreeWalker/examples/getting_started/` 全部 5 个示例。逐个依赖核对结论：

| Python 示例 | 依赖核对 | 结论 |
|---|---|---|
| data_extraction.py | 纯任务驱动（runAgent 即可） | 直接薄壳 |
| form_filling.py | 纯任务驱动 | 直接薄壳 |
| multi_step_task.py | 纯任务驱动 | 直接薄壳 |
| fast_agent.py | 3 个缺口（§3） | **补线后**薄壳 |
| form_filling-pingkai.py | skills_dir 磁盘源 + save_history 均未移植；个人数据/调试残留 | **本批跳过**（§5 登记） |

## 2. 零阻力三例的薄壳形态

与 `examples/basic-agent.mjs` 同模板（~20 行）：头部注释（一句话职责 + Python 源路径）→ `loadKit()` → `runAgent({ task })` → `isDone()/finalResult()`。TASK 逐字保留 Python 原文。目录 `examples/getting-started/`，文件名 kebab-case（`data-extraction.mjs` / `form-filling.mjs` / `multi-step-task.mjs`）。

## 3. fast_agent 的三个缺口与补线

fast_agent.py 需要 `output_mode="flash"`（LLM 覆盖）+ `wait_between_actions=0.1` / `page_settle_timeout=0.5`（Browser 覆盖）。核对结果：

**output_mode 的 Python 消费面**（全仓 grep 收敛，排除 `output_model` 变体 B 误匹配——views/models/actions 的命中全是后者，已移植）：

- `config.py:285` LLMSettings 字段（缺省 `"standard"`）+ `:601-604` env `LLM_OUTPUT_MODE`（非法值 warn + 回退 standard）
- `llm/client.py:147` `self.output_mode = s.output_mode`（LLMClient 存实例字段）
- `agent/agent.py:218` `getattr(llm, "output_mode", "standard")` + `:254` 初始 tool schema
- `agent/step.py:702/759/775` 三处 `get_tool_schema(output_mode=...)`
- `registry.py:155/193/223` flash/thinking schema 分支——**TS registry.ts:200/:234 已完整实现，但从未被传入**（4 个调用点全部缺参，见缺口 A）

### 缺口 A：outputMode 全链路（core，移植保真补线）

- `LLMClient` 卡片加可选 `outputMode?: string`，实例 `readonly outputMode`，缺省 `"standard"`。
- `Agent` 构造读 `llm.outputMode ?? "standard"`（getattr 带默认值等价；注入的 fake client 无该字段 → undefined → standard，兼容既有测试）。
- `StepCtx` 加 `outputMode`；`sense.ts` 三处 + `agent.ts` 初始 `getToolSchema` 共 4 个调用点传参。
- think 层无需改动：缺字段已按 `typeof === "string" ? … : ""` 收窄（think.ts:103-119），flash 响应（只有 action）天然兼容。

### 缺口 B：Agent.waitBetweenActionsS 接线（core）

- 现状：agent.ts:185 硬编码 `0`（注释自认「Python 读 BrowserSettings.waitBetweenActions——宿主经 browser 设置传入」，但没有任何传入路径）。
- Python agent.py:93：`self.wait_between_actions = browser._settings.wait_between_actions`——从 BrowserSession 实例读。
- 补线：`BrowserSession` 暴露 public `readonly waitBetweenActionsS`（构造时取 `settings.waitBetweenActions`，Python 私有字段读取的公开化）；`Agent` 构造改读 `options.browser.waitBetweenActionsS`。
- 消费侧已就位：act.ts:42 `ctx.waitBetweenActionsS > 0` 时步内动作间隔 sleep。

### 缺口 C：node-host 设置透传

- `HostSettings.llm` 加 `outputMode`（env `LLM_OUTPUT_MODE` 解析：合法值直传，非法 warn + 回退 `"standard"`，config.py:601-604 同款；空串 = 未设置）。
- `HostSettings.browser` 加可选 `pageSettleTimeout` / `waitBetweenActions`——**不加 env**（Python 这两字段无 env，fast_agent 经 `replace()` 硬编码；保持 programmatic 口径）。
- `assembleAgent`：BrowserSession 第二参 `{}` → 透传 browser 覆盖；LLM 卡片带 `outputMode`。
- `runAgent` 加 `overrides?: { llm?; browser?; agent? }`：env 装载后合并（对应 Python `replace(settings.llm, output_mode="flash")` 模式）。合并器 `mergeHostSettings(base, overrides)` 独立导出（直连 assembleAgent 的宿主也要用）。

## 4. fast-agent.mjs 目标形态

```js
const history = await kit.runAgent({
  task: TASK,
  overrides: {
    llm: { outputMode: "flash" },
    browser: { waitBetweenActions: 0.1, pageSettleTimeout: 0.5 },
  },
});
```

## 5. form_filling-pingkai.py 跳过（偏离登记）

1. **skills_dir 磁盘源未移植**：core 只有 skillSource 注入接口（sense.ts:319 `loadHostSkill` / agent.ts:369 `taskCatalog` 消费面就位），无 `domain-skills/<host>/{_sop,selectors,quirks}.md` 读取实现，AgentSettings 也无 `skillsDir` 键（settings-defaults 对拍 EXCLUDED 名单在列）。这是**特性移植**（host 侧技能源 + 目录约定），超出示例移植范围。
2. **save_history 未移植**：rerun 录制族按 P4 立项决策整体偏离（`rerunHistoryDir` 仅存目录名，`Agent.saveHistory()` 不存在）。
3. **文件性质**：form_filling 的个性化调试变体——内嵌真实姓名+手机号、`DUMP_STEP_DOM` 调试残留（issue #157）；skill 注入与录制缺失时退化为普通 form_filling，无独立移植价值。

→ 待 skill 源 / rerun 族立项后按需补。

## 6. 测试矩阵

core（缺口 A/B）：
- LLMClient：outputMode 缺省 `"standard"` / 卡片显式 `"flash"`。
- Agent：读 llm.outputMode → 初始 toolSchema 为 flash 形态（仅 action 必填）；llm 无字段 → standard。
- StepCtx 透传：forceDoneOnLastStep / forceDoneAfterFailure 两分支 schema 含 outputMode（flash 下 done-only schema 也走 flash 形态）。
- BrowserSession：公开 waitBetweenActionsS = 设置值（缺省 0.0 / 自定义 0.1）。
- Agent：waitBetweenActionsS 从 browser 实例读取（fake browser 带 0.1 → agent 字段 0.1）。

node-host（缺口 C）：
- settings：`LLM_OUTPUT_MODE` 合法（flash）/ 非法（warn + 回退 standard）/ 空串（= 未设置）。
- mergeHostSettings：三面（llm/browser/agent）各自覆盖与保留语义。
- assembleAgent/runAgent：browser 覆盖落 BrowserSession 实例；llm.outputMode 落卡片。

真机（行为改动验收）：
- `fast-agent.mjs` headless 9333 冒烟（flash 接线是本批唯一行为改动，必须真机）。
- `data-extraction.mjs` 薄壳冒烟（任一零阻力例代表）。
- 用户网络复验（沿 basic-agent 惯例）。

## 7. 实施步骤

1. core 补线（缺口 A + B）+ 单测。
2. node-host 透传（缺口 C）+ 单测。
3. 4 个薄壳示例落 `examples/getting-started/`。
4. 真机冒烟（fast-agent + data-extraction）→ `pnpm typecheck && pnpm test` 全绿 → 门禁。

## 8. 验收

- `pnpm typecheck && pnpm test` 全绿（含新增测试）；`node scripts/gate.mjs pre-commit` exit 0。
- fast-agent.mjs 真机跑通（flash schema 生效：请求体 tool schema 仅 action 必填）。
- 4 个示例各自 `node examples/getting-started/<name>.mjs` 可直接运行（.env 配 key + Chrome 9222/9333）。

**实施结果（2026-09-30）**：全仓 1550 例绿（dom-snapshot 167 + cdp-ws 51 + core 1283 + node-host 49），typecheck/biome 过。真机冒烟（headless 9333 + .env key）：
- fast-agent.mjs：6 步 246s done（HN 站点网络不可达，模型自行降级 Algolia API 完成任务——环境因素非代码问题）；flash 全程生效（每步「目标」为空 = flash 无 next_goal 字段形态，think 层空串收窄如设计）。
- data-extraction.mjs：3 步 46s done=true successful=true（5 条名言+作者全对）；标准模式「目标」字段有值——与 flash 空目标形成正对照，模式差异线上真实生效。
- 单测锚定 wire 证据：output-mode.test.ts 断言 LLM 每步收到的 tool.parameters.required——flash 普通步与 LAST STEP done-only 步均 `["action"]`，standard 对照组四必填字段。

## 9. 实施后修复：交互高亮 Overlay 域未启用（用户真机日志暴露，2026-09-30）

用户跑 form-filling.mjs 的日志出现 5 条 `Highlight failed (non-critical): Overlay must be enabled before a tool can be shown`。归因：CDP 要求先 `Overlay.enable` 才能发 `Overlay.highlightNode`，而 **Python TreeWalker 同样从不启用 Overlay 域**（session.py:1682-1694 只 enable Page/DOM/Network）——Python 侧同款失败被 `logger.debug` 吞掉不可见，TS 的 `[browser]` 日志通道把它暴露了出来。移植保真层面行为逐字节一致，非本批移植引入。

**修复（登记偏离——修 Python 的 bug，超出移植范围）**：
- `connection.ts`：connectSession 序列在 DOM.enable 后补 `Overlay.enable`（best-effort，失败降级为无高亮不阻断连接）；偏离登记进文件头注释。
- `tabs.ts`：switchTab 随 file-chooser 拦截的 per-session 重发先例一并重发 `Overlay.enable`（否则新 tab 上高亮回到未启用态——tabs.ts 头注释的「不重发域 enable」现状对该命令开例外）。
- 测试：connect 顺序断言插入 Overlay.enable + 降级容错测试 + switchTab/closeTab/createTab 假件补脚本化与重发断言；core 1283→1284。
- 真机验证：form-filling.mjs 重跑——`Highlight failed` 5→0，任务 2 步 `successful=true`，高亮成功即静默（无降级日志）。

## 10. 评审与合并记录

**轮 1（2026-09-30，全量 main..feat/examples = 1939909+269a96a）**：实跑零意见即收敛（complete / 23 文件 / 5m8s，模型 glm-5.3）。零采纳零驳回零 stale；P3 backlog 空。dump：docs/code-review/_r_examples_1.md（不入库）。
