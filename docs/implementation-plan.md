# 实施计划

> 状态：2026-09-20 定稿。战术文档——具体做什么、什么顺序、怎么验收；架构决策见 `architecture.md`（冲突时以它为准）。
>
> **背景约束**：TreeWalker 的 agent loop / tools 仍在完善（预计还需数日）。本计划把不依赖它们的基础层前置，等上游稳定后再启动 core 移植，避免移植件跟着上游返工。

## 总体顺序与依赖

```
P1 dom-snapshot 完整移植 ──┐
P2 LLM 多协议客户端 ────────┼─→ （检查点：TreeWalker agent loop/tools 稳定）
P3 cdp-ws transport ───────┘        ↓
                            P4 core 移植（loop/actions/prompts/…）
                                   ↓
                            P5+ 评测 parity（评测仓）/ extension / web-console / 自进化
```

P1/P2/P3 相互独立可并行，都不读 TreeWalker 的 agent/ 与 tools/ 目录。可选并行线（见 §5）同样不依赖上游。

## P1 dom-snapshot 完整移植（当前进行中）

已完成：models 全量移植（types.ts，47 测试全绿含 Python 锚点）、协议类型、serializer 骨架、fixture 生成器；P1.2 collector 移植（2026-09-21，`collector.ts` + `cdp-batch.ts`，golden 四页 selector_map 投影全等 + 降级链/跨源 iframe 单测，分支 `feat/p1.2-collector`）。

| # | 工作项 | 内容 | 验收标准 | 预估 |
|---|---|---|---|---|
| 1.1 | golden fixture 生成 | 用 `tools/gen_fixtures.py`（evals venv）抓页面梯度：静态页 / 重交互 SPA / shadow DOM / iframe / WebArena shopping_admin | fixtures 入库；`golden.test.ts` schema 校验绿；每页记录 degradation | 0.5d |
| 1.2 | collector.py 移植 | 三源并行采集（`DOM.getDocument` / `DOMSnapshot.captureSnapshot` / `Accessibility.getFullAXTree`，逐 frame）+ backendNodeId 交叉融合 + Vue/React 监听器探测（Phase 1 内联 JS） | golden 的 `input` 喂 TS 采集融合，产出的融合树与 Python `selector_map` 投影全等；降级链（FULL→PARTIAL→MINIMAL→FAILED）单测 | 2~3d |
| 1.3 | serializer.py 移植 | 五步过滤：简化树 → paintOrder 遮挡 → 剪空容器 → 包围盒合并 → 交互元素编号 + selector_map | **`element_tree_text` 逐字节对拍全部 fixture**（输出格式是 prompt 契约，架构 §10） | 2~3d |
| 1.4 | interactive.py + paint_order.py | 交互判定（JS 监听器 + AX 角色 + 标签 + cursor）与遮挡标记 | 关键函数期望值锚定 Python 实跑（同 models.test.ts 方法） | 1~2d |
| 1.5 | build_dom_state 组合入口 | 降级链组装 + `prev_map` 轮转（新元素 `*` 前缀）+ page_stats | golden 端到端：`input` → `buildDomState()` → 对拍 `output` 全字段 | 0.5d |
| 1.6 | 真机 smoke（配合 P3） | cdp-ws 连 9222 Chrome 现抓一页 → TS 管线 → 与同页 Python 产物对拍 | 至少 3 个真实页面逐字节一致 | 0.5d |

## P2 LLM 多协议客户端（@tw/core/src/llm/，仅此目录先行）

架构 §3.4 的落地。**不移植** step.py 的消息管理（属 P4），只做客户端层。

| # | 工作项 | 内容 | 验收标准 | 预估 |
|---|---|---|---|---|
| 2.1 | 规范格式 + Provider 接口 | 中立 message/tool/toolCall 类型；`LLMProvider` 接口（chat / supportsTools / supportsVision / testConnection） | 类型冻结评审（这是三适配器的契约）；单测覆盖类型不变量 | 0.5d |
| 2.2 | anthropic-messages 适配器 + 客户端行为 | 协议归一化 + `agent_response` 强制（tool_choice:tool）+ tool_use 解析 + text-not-tool 重试梯 + `_try_parse_json` 兜底 + URL 缩写 + 敏感值占位/还原 + fallback 链 + token 用量统计 | mock 注入 fetch 全路径单测（不发真请求，AGENTS.md 纪律）；重试/兜底分支全覆盖 | 1.5d |
| 2.3 | openai-completions 适配器 | tools + tool_choice 映射；不支持 forced tool_choice 的端点（vLLM/Ollama 形态）走 prompt 约束 + JSON 兜底（承重墙，架构 §3.4） | 同上 mock 单测；兜底路径专项用例 | 1d |
| 2.4 | gemini 适配器 | generateContent + functionConfig mode=ANY 归一化 | 同上 | 1d |
| 2.5 | 真机 smoke 脚本 | `tools/llm-smoke.mjs`：对智谱 OpenAI 端点 / Anthropic 端点各发一次最小 agent_response 调用 | 手工跑通即可，不入 CI（费用与密钥纪律） | 0.5d |

## P3 cdp-ws transport（packages/cdp-ws）

| # | 工作项 | 内容 | 验收标准 | 预估 |
|---|---|---|---|---|
| 3.1 | WebSocket transport | 连 `/json/version` 的 webSocketDebuggerUrl；send（含 sessionId 的 flat 协议）+ 事件订阅 + 超时/重连；实现 `CdpLikeClient` | 对本地 Chrome 的单测（9222，task 级 integration，标记 slow）；mock WebSocket 单测 | 1~1.5d |
| 3.2 | 会话基础原语 | attach target、navigate、cookie 注入（storage_state → Network.setCookie，**localhost 必须用 url 参数**的坑）、getTabs/switchTab 的最小集 | 配合 1.6 真机 smoke 走通 | 0.5~1d |

## P4 core 移植（阻塞：等 TreeWalker agent loop / tools 稳定）

启动前置检查点：

1. TreeWalker 相关目录连续 N 天无结构性提交（用户确认"稳定"为准）；
2. 对当时的 TreeWalker commit 做一次快照审查，把 `architecture.md` §3 移植要点表与实际代码比对更新（上游这期间改了什么）；
3. 记录基准 commit hash——P5 parity 对照以此为 Python 侧版本。

内容按架构 §3.1/§3.3：step pipeline 五阶段、10 核心动作（四元组含 capability）、prompts、消息管理、守卫链（权限门挂点）、Judge。**P2 已完成的 llm 目录直接并入**。

## P5+ （不展开，见架构 §9）

评测仓 parity（闸门）→ extension（WXT）→ web-console → 自进化闭环 / cli / tui → Python 退役评审。

## 可选并行线（等待期富余时做，优先级低于 P1-P3）

- **权限门纯逻辑层**（`@tw/core/src/policy/`）：capability×host 映射、grant 三态模型、fail-closed——纯函数 + 存储接口，不依赖 agent loop；webbrain `permission-gate.js` 设计移植 + 单测（决策表驱动）。挂进 `_execute_actions` 的集成属 P4。
- **`@tw/protocol` 事件类型**：从 TreeWalker `observability/events.py` 抄 schema——该文件相对稳定，可先行；若 P4 快照审查发现字段变更，小改即可。
- **扩展壳脚手架**（apps/extension WXT 骨架 + manifest 权限）：纯脚手架无逻辑，风险低；但 UI 组件等 console-ui 定型后再动。

## 工程纪律（全程有效）

- 每工作项完成即跑 `node scripts/gate.mjs pre-commit`（biome/typecheck/测试/覆盖率 ≥85%/行数门）。
- 移植代码期望值锚定 Python 实跑（AGENTS.md 铁律）；golden fixture 重生成需在提交信息注明。
- 提交粒度按工作项，`fix(dom-snapshot): …` / `feat(llm): …` 前缀；不主动提交（用户明示后执行，走提交门）。
