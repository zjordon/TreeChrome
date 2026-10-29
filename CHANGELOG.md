# Changelog

本文件记录 TreeChrome 的显著变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。CHANGELOG 内版本号不带 v，git tag 带 v。

## [Unreleased]

## [0.2.0] - 2026-10-30

### Added

- 多附件收尾（#3）：拒绝明细反馈、附件预算呈现、分块二进制传输
  （UI 时间线 / SW 注册表状态机 / 协议面）。
- 自进化闭环（#5）：core 任务卡蒸馏器（PII 门、增量 addendum、判停守卫、
  效率棘轮）、node-host 收敛循环脚本、扩展全链（IDB 草稿审阅、蒸馏队列与
  worker、alarm 兜底）、e2e 全链 smoke。
- skill-drafts 通知面（#9）：待审计数广播、蒸馏过程拍（distill-status 过程态）、
  judge 字面 null 归一。
- 蒸馏卡质量三项（#11）：防锚定（TASK_SOP_SPEC）、任务卡步内重匹配、
  附件起跑守卫。
- 收敛效率信号（#12）：bestSteps 步数基线、判停守卫、min 棘轮、自检 footer 效率句。
- 任务卡匹配器超时可配（#16）：taskSkill.callTimeoutMs 可选键 + callFailed 步内重试。
- UI 重构四期（#20）：M1 语义 token 体系（12 族、亮/暗/auto）→ M2 控件原语
  （Button 全状态模型、IconButton/Switch/Segment）→ M3 三区布局（AppShell、
  RunPanelHeader、RunStatusBar、欢迎屏）→ M4 设置收纳（SettingsOverlay 底部
  弹出卡 + OptionsApp 四区 tab 双宿主）。

### Fixed

- enablePlanning 默认回归 dataclass 语义 false（#1）。
- dom-snapshot 表单控件状态可见性：Step 5 以 AX 顶层 value 为正源（#6）。
- LLM 调用失败可见性（#10）：judge 静默失败留痕、超时可配、node-host 蒸馏超时、
  终态停跑原因归因。

### Changed

- 工程治理：接入 AOCI 仓库认知资产（可版本化认知索引）；AGENTS 新工作流
  （issue → 分支 → SCRATCHPAD 计划 → /review-loop → /finish-issue）。

## [0.1.0] - 2026-10-10

首个发布版本：TreeWalker（Python）核心能力的 TypeScript 全量移植 + Chrome 扩展宿主（MVP）。

### Added

- 工程基座：pnpm monorepo（9 工作区）+ Biome lint/format + 提交门禁（覆盖率 ≥85%、
  核心包禁 chrome.\*/process.\*、单文件行数上限）+ 版本化 git hooks。
- `@tw/dom-snapshot`（P1）：Python dom-snapshot 全量移植——三源采集融合（collector）、
  五步过滤序列化（serializer）、interactive/paint_order、buildDomState 组合入口、
  golden fixture 对拍基准（期望值锚定 Python 参考实现实跑）。
- `@tw/core` LLM 多协议客户端（P2）：anthropic-messages / openai-completions / gemini
  三协议适配器（原生 fetch 手写，无 SDK）；extract / structuredCall 双底座。
- `@tw/cdp-ws`（P3）：WebSocket transport（cdp-use 对等物）+ 会话原语 + cookie 注入 +
  真机对拍 smoke。
- `@tw/core` agent 主体（P4/P4b）：BrowserSession Facade（browser 层 16 模块）、五阶段
  step pipeline、judge 评测、权限门五模块；25 动作注册面全量收齐（导航/输入/下拉 25
  方法族/上传全链/文件读写/search-find/evaluate 增强/read_grid 三通道，Python
  parse_template 与 float() 语义逐字节对齐）。
- `@tw/node-host` + examples：Node 宿主共享件（settings 单源、boot.mjs 引导、
  assemble+runAgent、venv 对拍兜底）；27 个示例脚本（getting-started / features /
  custom-functions / file-system / use-cases / upload 六批 + p7 轨迹重跑与匹配回归）。
- skill 面（P5.5）：FsSkillSource 装载层 + domain-skills 185 文件三套内容；
  taskSkillLlm 专用匹配模型；thinkingEffort 思考档位（智谱网关 output_config.effort）；
  p7 离线回归 harness（TS/Python 匹配器全量对拍指标一致）。
- Chrome 扩展（M5）：`@tw/protocol` 请求-应答信封；`@tw/cdp-chrome`
  chrome.debugger transport（与 cdp-ws 跨通道对拍逐字节一致）；core 两缝——upload
  attachmentId 页面内注入 + submit 预确认（缺省关）；SW 运行时（run journal / 权限
  确认卡 / embed-skills 打包 / keepalive）；`@tw/console-ui` + sidepanel/options 全量
  控制台组态（React 组件平台无关 + MV3 粘合层，真 DOM e2e smoke 全链通过）。

### Fixed

- F9 系列真机修复：下载记录 filePath 断链、[Downloads] 通知附完整路径、5xx 有界退避
  接入 extract、变体 B data 行附紧凑 schema、switchTab 全套域重发、model_result
  usage 透传。
- M5 验收期热修：终态错误可见性（lastError 全链显示）、chrome:// 受限页启动守卫、
  skill_active 时间线连续去重、SW 休眠重连保留终态视图。
- LLMClient action→actions 物化缺口（真实模型只回 action 数组的运行时崩溃面）。
- 各阶段评审循环累计百余轮修复收敛，关键缺陷与回归均以测试锚定。

### Docs

- docs/architecture.md 架构基准（五接口宿主模型、包布局、移植对照索引）。
- 各里程碑实施计划与完成记录（docs/implement-plan/ 下 p2 / p4 / p4b / p5 / m5）。
