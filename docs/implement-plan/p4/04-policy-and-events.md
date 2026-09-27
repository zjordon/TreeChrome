# 04 · 权限门（policy）与事件（events）

> 参照：webbrain permission-gate 设计（架构 §5「设计照搬，代码重写」）+ TreeWalker `observability/{events,event_bus}.py`。权限门是 TreeChrome 净新增（Python 侧无 deny 概念——快照审查已确认），行为基准 = architecture.md §5 本身。

## 1. 权限门模型（架构 §5.1-5.2 落地）

### 1.1 capability 映射（batch1 面 + scroll 补行）

| 门行为 | batch1 动作 | batch2 增补（P4b） |
|---|---|---|
| 不过门（只读） | extract / wait / **scroll（架构 §5.2 补行，4.0 修订）** | find_elements / find_text / search_page / read_grid / dropdown_options / screenshot |
| CLICK | click、send_keys（含 Enter） | select_dropdown |
| TYPE | input_text、send_keys（普通键） | — |
| NAVIGATE | navigate（按目标 URL 计费）/ go_back / switch_tab | search / close_tab |
| UPLOAD | — | upload_file（attachmentId 模式） |
| EXECUTE_JS | — | evaluate |
| FS/DOWNLOAD | — | write_file / replace_file / save_as_pdf |

- send_keys 键型分流：含 Enter/组合提交键 → CLICK；普通文本键 → TYPE（判型规则实现于门前置的 capability 解析函数）。
- done 不过门（终止动作，无宿主副作用）。

### 1.2 门逻辑（`core/src/policy/`）

```
capability.ts   // Capability 类型 + resolveCapability(action, params): Capability | "none"
gate.ts         // decide(capability, host, grants): "allow" | "deny" | "prompt" —— 纯函数，决策表驱动单测
grants.ts       // Grant{capability, host, decision, once/always} + GrantStore 接口（once 绑 tab；always 持久化——StorageProvider 注入，评测用内存实现）
policy.ts       // PolicyGate：组合 decide + PolicyInteraction + GrantStore；deny 结果构造（§3）
auto-allow.ts   // AutoAllowPolicy：无条件放行 + 记账（评测口径标注）
```

- 确定性映射：不读页面内容、不问 LLM、语言无关、注入免疫。
- host 计费：navigate 按目标 URL；click/type 按当前页 host；host 识别不出 → **fail-closed 拒绝**。
- 拒绝回流：`ActionResult{ success:false, denied:true, error:"用户拒绝在 <host> 上 <动词>，不要重试，可改道或询问" }`，**不计 consecutiveFailures**（03 §3.4 增补）。
- 任何 PolicyInteraction 异常/超时一律按 deny（边界纪律）。
- **PolicyInteraction 接口**（架构 §4）：`requestPermission(req): Promise<"allow-once"|"allow-always"|"deny">` + `confirmSubmit(req)`（submit 预确认的**接口就位**；表单摘要 UI 与 submit 特征检测 M5 落地——README §3 出界项）。

## 2. 挂点与 denied 通道

- 挂点：`_execute_actions` 串行循环内，**ToolCallEvent 之后、actionability 等待之前**，逐动作（对齐架构 §5.3 与 Python step.py 相对位置 :1447-1499）。
- 流程：`resolveCapability(action, params)` → "none" 直过 → `policy.gate(capability, host, context)` → prompt 则经 PolicyInteraction（评测 AutoAllowPolicy 即时返回）→ allow/deny。deny：构造 denied ActionResult（上文文案），跳过执行，走 ToolResultEvent 正常发射（error 通道）。
- `ActionResult` 增 `denied?: boolean` 字段（Python 无此字段——TreeChrome 扩展；`__str__` 渲染对齐 error 形态）。
- 批准后执行前**重跑元素校验**：actionability 等待本身承担（03 §3.3 既有顺序天然满足）；元素漂移走 Guard#5。

## 3. grant 生命周期

- once 绑 tab（context.tabId）；回合结束清 once（`_finalizeSession` 挂点）；always 经 GrantStore 持久化（扩展侧 chrome.storage `tc_permissions`，M5 接线；P4 用内存实现 + 接口）。
- 权限判定顺序：once grant → always grant → 决策表 → PolicyInteraction。

## 4. EventBus 与事件类型（`core/src/events/`）

- `events.ts`：9 类事件 discriminated union（events.py:19-99 字段照搬，camelCase 化但 `event_type` 字符串值保原值）：step_start / model_call / model_result / tool_call（含 params + elementBbox/elementXpath）/ tool_result / step_end / anomaly（rule/severity）/ session_end / skill_active。发射点锚点见 03 各阶段（ModelResultEvent :863-876、ToolCallEvent :1447-1464、ToolResultEvent :1552-1560、StepEndEvent :1745-1753、SkillActiveEvent :432-442）。
- `event-bus.ts`（event_bus.py:121 全量）：`subscribe(type | "*", handler)` / `emit(event)` **同步**投递（事件循环同线程假设，TS 单线程天然满足）；handler 异常不穿透 + 连续 3 次失败熔断该订阅 + close 汇总告警；`onClose(cb)`。
- `@tw/protocol` 独立包后置 M5（README §3）：core 直接导出 `TwEvent` 联合类型，抽包时纯类型搬迁。

## 5. 有意偏离清单

| # | 偏离 | 理由 |
|---|---|---|
| 1 | 权限门整体为新增设计（无 Python 对照） | 架构 §5 是行为基准；决策表单测代替对拍 |
| 2 | GrantStore 接口化（内存实现），扩展侧持久化 M5 | 核心包禁 chrome.storage |
| 3 | submit 预确认只留 PolicyInteraction.confirmSubmit 接口 | 表单摘要检测 M5（架构 §5.3 的 UI 部分） |
| 4 | 事件字段 camelCase，`event_type` 判别值保原字符串 | TS 判别联合惯例；消费端（未来 SSE/protocol）以判别值为准 |
| 5 | AnomalyDetector（Python agent.py:239-244 订阅侧）不移植 | 观测消费者归属宿主/评测；发射面已就位 |
