# 05 · 测试与 smoke

> 纪律基线：不发真网络请求、不真调 LLM（AGENTS.md）；覆盖率 ≥85% 门禁。真机验证收敛到单一 smoke 脚本（P3 先例：vitest 集成用例引入环境依赖 + CI 假绿面）。

## 1. 假件（test/ 公共）

- **FakeCdpTransport**（实现 01 §1 接口）：脚本化 `respond(method, handlerOrValue)` 规则表 + `emit(method, params, sessionId?)` 事件发射 + sentFrames 捕获 + `failOn(method, err)`。形态对齐 P3 FakeWebSocket 的使用体验，但作用于 core 层（不依赖 cdp-ws）。
- **ScriptedLLMProvider**（实现 P2 `LLMProvider`）：预编 `chat()` 应答序列（agent_response 形态），记录收到的 systemPrompt/messages/toolSchema；支持「按收到的 state 内容断言」驱动数据敏断言。
- **InMemorySkillSource / InMemoryGrantStore / 内存 FileSystemProvider**。
- **FakeTimers**：时序间隔断言（01 §5.5 的 50/80/300ms 序列、退避 5/10/20/40/60、0.6s 点击效果等待）。

## 2. Python 锚定值（P2/P1 方法延续）

`_gen_p4_anchors.py`（`_` 前缀草稿不入库）经 evals venv（`D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe`）实跑，产物落 `packages/core/test/fixtures/python-anchors/`：

| 锚定对象 | Python 来源 | 产物 |
|---|---|---|
| SYSTEM_PROMPT / 条件段 / buildStateMessage 17 段 / buildStateBlocks / agent_history 格式 / task_matcher prompt+schema+三段头 / judge prompt+schema | system_prompt.py / task_matcher.py / judge.py / agent.py:599-649 | 逐字节字符串 fixture（batch1 动作集与全动作集各一套——FILE_UPLOAD/DROPDOWN 条件段只在全动作集触发） |
| getToolSchema 三 mode × 单/多动作 × planning / descriptions text | registry.py:90-255 | JSON fixture |
| validator 报错样例（exactly-one / xor / extra 字段 / 范围） | models.py 各 validator | 错误文案 fixture（语义对齐，不逐字节——TS 文案可重组，但拒收/放行的**判定结果**必须逐例一致） |
| action_shape 归一化 / loop 指纹 / chunk 边界 / 退避与文案 | action_shape.py / loop_detector.py / extract_markdown.py:195-212 / step.py | 期望值 fixture |

## 3. 单测矩阵（按工作项）

| 项 | 测试文件 | 覆盖要点 |
|---|---|---|
| 4.0 | views / action-shape / constants | ActionResult 校验（success⇒is_done）、归一化策略表全分支、honest done 带外标记 |
| 4.1 | event-bus | 同步投递、`*` 通配、handler 异常隔离、3 次熔断、close 汇总 |
| 4.2 | connection（enable 序列逐条、自愈、事件注册/解订幂等）/ navigation（settle 两版、grid kick、scroll 回读）/ element-pointer（三级回退、遮挡、js click 降级）/ text-input（拼接守卫、force set、CJK insertText、框架事件不 blur）/ keyboard（三路由）/ tabs（switch 重挂拦截）/ screenshot（超时护栏、TimeoutError 前置）/ network-idle（长连接剔除、stability window、degraded）/ circuit-breaker / session（get_state 九步顺序、缓存轮转与 **5 处失效**、熔断短路 EMPTY、injectStorageState 的 localhost url 坑、rawSend 绑 sessionId） | FakeCdpTransport 全程 |
| 4.3 | models（25 validator 矩阵）/ registry（schema 锚定 + pagePatterns 可见性 + registryVersion）/ Tools（flatten 嵌套包裹/unknown/异常包装）/ 十动作（每动作 2~5 例：正常 + 关键边界——navigate 空 DOM 三阶段、click 无效果检测与新标签、input 回读验证、done 变体 B）/ extract-markdown（chunk 锚定）/ llm 扩面（extract 的 schema 降级与 fallback 重入、structuredCall 的 text 兜底） | FakeCdpTransport + ScriptedLLM |
| 4.4 | pipeline 编排（finally 单点步数 + skip 豁免）/ sense（state 替换式、丢图留文、done-only 两触发）/ think（双梯全分支：外梯 2 次去图、内梯 3 次共用预算、门禁封顶 2 次、动作截断）/ act（五守卫 + 漂移截断 + actionability 降级）/ post（计数三分支 + infra 清零时序）/ finalize（投影、denied 排除）/ 错误四分支（#194 退避序列 fake timers）/ run 外层（三种破环、keepAlive、skill 匹配失败不注入）/ prompts 字节锚定 / skills matcher / judge / compactor / 消息信封 | ScriptedLLM + FakeCdpTransport |
| 4.5 | capability 解析（send_keys 分流）/ gate 决策表（全组合）/ 挂点集成（deny 回流文案 + 不计失败 + ToolResultEvent 发射）/ AutoAllow 记账 / 异常按 deny | 决策表驱动 |
| 契约 | cdp-ws 侧新增 contract：`CdpWsClient` 满足 core `CdpTransport` | 类型断言 |

## 4. agent-loop 真机 smoke（4.6，`tools/agent-loop-smoke.mjs`）

**目的**：不发真 LLM 请求的前提下，端到端验证「transport → BrowserSession → get_state → 五阶段 → 动作执行 → history/judge/事件」全链在真实 Chrome 上成立（undici 长会话 = 风险 7 的覆盖）。

- **Chrome 拉起**：复用 P3 page-parity-smoke 形态（headless=new、临时 profile、独立端口、退出清理 try/catch）。
- **页面**：smoke 内起本地静态 HTTP 服务（node:http）挂两个 fixture 页：`index.html`（含链接 About、文本输入框、按钮）与 `about.html`。URL 进 task 文本（`_extractUrl` 提取）。
- **LLM**：ScriptedLLMProvider 预编三步——①click(About 链接) ②wait ③done(text, success=true)；Judge 应答 verdict=pass。**脚本按 state 内容自适应选动作 index**（从 element_tree_text 解析目标元素的编号，避免 brittle 硬编码）。
- **断言**：exitCode 0 当且仅当全部成立——isDone() && isSuccessful()；history 步数=3；interactedElement 投影非空且 index 命中；URL 漂移截断在 click 后生效（步 1 余下动作被截）；EventBus 收到 step_start/model_result/tool_call/tool_result/step_end/session_end 完整序列；judge verdict 写入末步 result.judgement；连接健康（全程零 reconnect）。
- **变体**：`--policy auto`（AutoAllowPolicy 记账断言）与默认（注入一个 ScriptedPolicy 返回 deny 一次——验证 denied 通道与「不计失败」）。
- 打包：esbuild stdin（resolveDir=包根，P2/P3 同款）。

## 5. 验收命令

```bash
pnpm install && pnpm typecheck && pnpm test          # 日常（含新矩阵与锚定 fixture）
node scripts/gate.mjs pre-commit                      # 提交门
node packages/core/tools/agent-loop-smoke.mjs         # 真机 smoke（4.6 后）
# Python 锚定值再生成（刻意更新基准时；提交信息注明原因）：
D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe _gen_p4_anchors.py --out packages/core/test/fixtures/python-anchors/
```
