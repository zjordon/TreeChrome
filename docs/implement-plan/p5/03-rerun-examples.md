# P7 轨迹重跑三示例移植（03-rerun-examples）

> 状态：2026-10-07 起草，待用户确认后开工（建议并入 `feat/p5-skill-face`——rerun 族是
> skill 面的直接消费方，同分支一并评审）。
> 源：`TreeWalker/examples/p7_rerun_webarena_task.py`（123 行 base）+
> `p7_rerun_with_task_skill.py`（45 行包装）+ `p7_rerun_vision_no_skill.py`（78 行包装）。
> features 批 F5 曾按「rerun 族」整体跳过——P5.5 skill 面落地 + 评测数据在位后解禁。

## T1. 源件形态与依赖核对

| 件 | 内容 | 依赖核对 |
|---|---|---|
| base：p7_rerun_webarena_task | 按 task_id 重跑单 WebArena 任务（轨迹分析）：argv（task-id/port/max-steps/task-timeout/webarena-repo/log-file）→ CDP_PORT env 覆盖 → 读 config_files/<id>.json → task_text=`{intent}\n\n起始页: {start_url}` → agent 跑（wait_for 超时 + keep_alive + finally stop）→ 结果块（is_done/is_successful/n_steps/final_result/参考答案含入对照·null 守卫） | 全就绪：runAgent 的 overrides.agent.maxSteps（Python「env 接线被 AgentSettings(max_steps=…) 丢掉」踩坑在 TS 由 mergeHostSettings definedOnly 天然免疫）；config_files 在本地评测仓；keep_alive 差异=无（Python 也 finally stop，net 同） |
| 包装①：with_task_skill | 进程内预设 `AGENT_ENABLE_TASK_SKILL_INJECTION=true` 再跑 base（argv 透传）+ 口径 C 红线横幅 | env 面已就绪（P5.5）；预期日志三件套：`[skill] task-skill catalog: 44 cards`（FsSkillSource ✓）/`task-skill-match: {...}`（S4 日志 ✓）/`task-skill hit: slug=... chars=...`——**第三条未移植（agent.py:589，TS 缺）→ 本批补一行** |
| 包装②：vision_no_skill | 预设 USE_VISION=true + 双 skill 注入 off + 视觉口径守门（模型不在名单 → 起跑前拦，防静默退化纯文本） | env 面就绪（AGENT_USE_VISION 既有 + P5.5 双开关）；modelSupportsVision 在 kit 面（upload 批扩过） |

## T2. TS 形态（examples/ 根，kebab-case）

- `p7-rerun-webarena-task.mjs`（base）：手搓 argv（复用 p7 回归 harness 修复后的
  value/intArg 值校验形态）；`process.env.CDP_PORT = String(port)` 先于 loadKit（applyDotEnv
  override=false 不覆盖已设键——Python「load_settings 前设 env」同款时序）；`--log-file`
  经 runAgent 的 `log` 注入 tee 落盘（console + 文件双写）；超时用定时器硬退（Python
  wait_for 取消语义的等价——进程级，浏览器随进程关闭）；参考答案对照含 null 守卫
  （url_match 型 reference_answers 为 null 的 374 坑注释保留）；结果块附
  `history.judgement`（TS 侧 judge 结论不进控制台日志的已知日志面差，轨迹分析工具
  直打——登记为有意增补）。
- 包装两件：env 预设 + 横幅打印 + `await import("./p7-rerun-webarena-task.mjs")`（ESM
  动态 import 执行 base 顶层——Python「import base 后调 main」的结构等价）；vision 件
  在 import 前用 loadKit+loadHostSettings 做视觉守门（对齐 Python
  _validate_vision_settings 文案）。
- **不移植**：Python 的 llm.client DEBUG「LLM response blocks」逐块日志（TS 客户端无此
  debug 面；控制台事件行已含决策面）——登记。

## T3. 本批代码改动面（预期）

1. **core 一行**：agent.ts matchTaskSkill 命中后补 `task-skill hit: slug=... chars=...`
   日志（agent.py:589 锚定；S4 同族补线，P5.5 评审轮 1 漏网）。
2. 三个示例文件（零包改动；base 的 log-file 走既有 runAgent.log 注入位）。
3. 测试：core +1（hit 日志断言——既有 S4 测试扩展）；示例无单测（工具脚本惯例）。

## T4. smoke 与真机

- 死端口解析 smoke（纪律）：三件均落 checkReady 友好错误。
- 真机：本地 WebArena 栈不可达（沙箱），留用户（Chrome 9223 + 手动登录 + 本地 docker
  栈）。with_task_skill 件的「三日志齐」验收留在用户真机——检索层已在 184 全量对拍中实证。

## T5. 实施步骤

① core hit 日志 + 测试 → ② 三示例 → ③ 全绿 + 门禁 → ④ 解析 smoke → ⑤ 方案登记 →
⑥ /review-loop（用户触发，增量覆盖本批）。

## T6. 实施结果（2026-10-07）

- core 一行补线：agent.ts `task-skill hit: slug=... chars=...`（agent.py:589 锚定；S4
  测试扩展断言）；三示例落 examples/ 根（base 手搓 argv 含值校验 / 包装经动态 import
  执行 base 顶层；vision 件守门在 import 前独立 loadKit）。judgement 取值修正：挂在
  done 的 ActionResult 上非 AgentHistoryList（示例直打，补偿 TS 日志面差）。
- 全仓 1592 绿（断言并入既有用例）+ 门禁 exit 0；死端口解析 smoke 三件全过（base 到
  Chrome 连接错误、口径 C 包装走完横幅+配置链、vision 件守门按 Python 文案对 glm-5.3
  正确拦截）。真机（9223 + 手动登录 + WebArena 栈）留用户。

## T7. 评审记录（feat/p5-skill-face 轮 3，增量 a3dcdc8）

实跑 1 条意见（low：base 的 configPath 硬编码反斜杠——非 Windows 平台 --webarena-repo
参数失效，Python 原版 os.path.join 跨平台，属移植引入收缩）——**P3 顺手修采纳**（改动
极小且在当轮文件内）：改 `join()` 拼接，Windows 冒烟验证等价（task 1 配置正常装载）。
顺带：`evaluate_output/`、`rerun-history/`（用户 rerun 运行时产物）补入 .gitignore——
grid JSON 曾击穿 biome 门禁。零驳回零 stale；全仓 1592 绿 + 门禁 exit 0。
