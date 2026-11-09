# SCRATCHPAD — issue #27 M2：会话级 daemon CLI（browser-use 3.0 同款常驻会话）

> 状态：**已实施并全量验证（node-host 134→164 tests 绿 / 覆盖率过线 + 真机 smoke 六连含 dist 二进制）；待 `/review-loop` 评审收敛。** 四决策点已拍板（HTTP 9780 / 会话式无白名单 / 15 动词 / 缺省三件）。
> 基准：issue #27 正文；#25/#26 已交付（one-shot run / 全局命令 / --auto-chrome / skill 分发）全部复用不动。
> 分支：`feat/issue-27-cli-m2-daemon`（自 main `9158a93`）。

## 目标

控制权反转：调用方 agent 的 LLM 直接驱动本仓浏览器原语——`tc <动作>` 单命令单 JSON，常驻 daemon 持有
BrowserSession（两层 selector map / element index 活在进程内——**必须 daemon 化的根因**），跨调用保持 tab，
`element_tree_text` 成为核心供给物，daemon 内部无 LLM。

## 设计

### D1 IPC：localhost HTTP（127.0.0.1，建议项 a）

- **HTTP**（建议）：可 curl 调试、跨平台零差异、与 CLI 的 JSON 契约同构；代价是占端口
- 备选 named pipe / unix socket：不占端口但平台 API 分叉、难调试——不建议
- 细节：绑定恒 `127.0.0.1`（不接受外网）；缺省端口 `9780`，`TC_DAEMON_PORT` 覆盖；
  运行态写 `~/.tc/daemon/daemon.json`（port/pid/wsUrl/startedAt）供 CLI 发现与 doctor 诊断；
  **v1 不加鉴权**（与本机 CDP 9222 暴露面同级，登记偏离并写入文档）

### D2 daemon 进程与生命周期

- 新模块 `src/daemon/`（node-host 包内，IO 全注入）：
  - `server.ts`——node:http 服务：路由分发 + **串行队列**（单 Chrome 单 daemon，多调用方 FIFO 排队，
    对齐 browser-use 纪律：并发切 tab 会竞态）；每请求单 JSON 应答（camelCase）+ ok/error 信封
  - `session-holder.ts`——BrowserSession 生命周期：resolve wsUrl（`CDP_WS_URL` > 9222 discover > 复用
    #26 auto-chrome 拉起）→ start → 常驻；daemon 拥有的自拉 Chrome 在 daemon 退出/空闲回收时按 PID 树回收
    （复用 LaunchedChrome.stop，绝不按映像名杀）；空闲回收（缺省 15 分钟无请求 → 优雅退出，`TC_DAEMON_IDLE_SECS` 覆盖）
  - `lifecycle.ts`——单例守卫（daemon.json + 端口探活：已活着则 no-op）、日志 `~/.tc/daemon/daemon.log`、
    detached+unref+吞异步 error（沿 #26 auto-chrome 同款纪律）
- **CLI 面自动启动**：任一动作命令发现 daemon 不可达（ECONNREFUSED）→ 自动拉起（等待 /health 就绪）→ 重发；
  daemon 被杀后下一次调用自愈（验收 3）

### D3 命令面（v1 子集，等真实调用方反馈再扩）

- 动作动词（顶层级，与 run/skill/daemon 保留字并存）：`get_state` / `navigate` / `click` / `input_text` /
  `select_dropdown` / `scroll` / `find_text` / `read_grid` / `evaluate` / `screenshot` / `upload_file` /
  `go_back` / `tabs` / `switch_tab` / `close_tab`
- 参数走类型化旗标（`tc click --index 5`、`tc input_text --index 3 --text "…"`、`tc navigate --url …`），
  中文值经 stdin/旗标均可（UTF-8）
- **tab 语义**：daemon 记住当前 attached tab，跨调用不重开；`tabs/switch_tab/close_tab` 透传 BrowserSession
  既有能力；后台操作不抢前台焦点（无 focus 副作用的动作序列）
- **upload_file 语义（建议项 b）**：会话式 v1 **不设白名单**——调用方 agent 即信任边界（本机同权进程），
  skill 卡写明；M1 的 --allow-* 护栏仍属 run 子命令面不动
- `tc daemon [--status|--stop|--doctor]`：status 报 pid/port/wsUrl/空闲计时；stop 优雅退出（含自拉 Chrome 回收）；
  **doctor** 三类故障诊断（Chrome 没起 / daemon 僵死 / 端口占用）+ 给出动作
- 输出契约：单命令单 JSON（stdout 仅终态 JSON）+ 退出码 0 成功 / 1 执行失败 / 2 用法与环境失败（沿 M1）

### D4 skill 卡与文档

- `skill-card.ts` 增「会话式」章节（daemon 语义/动作表/tab 保持/串行纪律/When-Not-To-Use 保持），
  `tc skill install` 既有管道不变；README 供给面章节同步

### D5 测试

- node-host 单测全注入（不起真 Chrome/真端口绑死）：server 路由与串行队列、session-holder 生命周期
  （wsUrl 解析序/自拉 Chrome 回收/空闲退出）、CLI 客户端（请求构造/退出码映射/ECONNREFUSED 自动拉起重试）、
  doctor 三类诊断分支
- 真机 smoke（手动不入 CI）：①两次连续调用共享 tab ②并发三调用被串行化 ③kill daemon 后下一调用自愈
  ④doctor 三故障注入 ⑤自拉 Chrome 场景 daemon 退出零残留

## 实施步骤

1. daemon server（路由+串行队列+JSON 信封）+ 单测
2. session-holder（wsUrl 解析/BrowserSession 常驻/自拉 Chrome 回收/空闲退出）+ 单测
3. CLI 动作动词与 daemon 子命令（自动启动/退出码映射）+ 单测
4. skill 卡会话式章节 + README + build:cli 顺带验证
5. `pnpm typecheck/test/lint` + gate + 真机 smoke 五连
6. `/review-loop` → `/finish-issue`

## 验收（对齐 issue #27）

- 两次连续 CLI 调用共享同一 tab/会话（第二次可见第一次的页面状态）
- 并发调用被 daemon 串行化，无 tab 竞态
- daemon 被杀后下一次调用自动恢复（重拉 Chrome + 新会话）
- `tc daemon --doctor` 诊断三类故障并给出动作

## 不做

MCP server 通道（另立）、云远端浏览器、多 Chrome 实例池、daemon 鉴权（v1 登记）、npm 公网发布

## 实施记录（2026-11-08）

**落地文件**：`src/daemon/`（新五件：protocol 纯函数面 / session-holder 会话持有 / server HTTP+串行队列 / client 自起客户端 / doctor 三诊断）；`src/cli.ts`（run|skill|daemon|动作动词四面分发 + serveDaemon 常驻入口）；`src/skill-card.ts`（双形态卡）；`src/index.ts` 导出面；测试 `test/daemon.test.ts`（新 30 用例）+ `cli.test.ts` 补字段；README 会话级章节。

**实施期裁定（计划未明确处的落定）**

1. **布尔反向旗标**：core 缺省 true 的参数（clear/fresh/await_promise）用 `--no-clear/--no-fresh/--no-await` 形态（parseArgs 布尔旗标无法传 false）；protocol VerbFlag 增 `invert`
2. **信封语义**：动作执行失败（ActionResult.error）走 `ok:true + data.error`（stdout 仍有 JSON、exit 1——与 M1「1=跑完未成功带 JSON」同构）；`ok:false` 仅 env/usage（exit 2）
3. **连接中断处理**：catch 不自作主张置空 core——下一次 ensure 检测 isConnected 做「优雅 stop + 重建」，避免跳过 stop 泄漏
4. **upload 相对路径**：CLI 侧 `path.resolve` 成绝对路径再发（daemon CWD 可能与调用方不同）
5. **serve 幂等**：EADDRINUSE → 「已在运行」exit 0（双拉起竞态收口）；SIGTERM/SIGINT 优雅关停
6. **空串旗标值视同未给**（与 allow-* 收集口径一致），修掉 select_dropdown `--value ""` 误触 XOR
7. **skill 卡增「怎么选」路由阶梯**（实施后用户追加裁定）：自然语言任务在调用方 agent 分流——
   不需要浏览器→不用；目标+验收一句话写清→run；一步完事/探索诊断/要看路/内外交织/多轮同页→会话级；
   模糊默认 run 并告知形态；run 失败读 stopReason/errors 再决定重发或切会话级诊断

**验证**

- node-host 134→164 tests 全绿（+30：protocol/server 真 HTTP 临时端口/session-holder 全分支/client 自起重试/doctor 三诊/CLI 解析与 main 分发）；覆盖率过 85% 阈值；全仓 7 包 + 扩展 110 test files 绿
- 真机 smoke 六连（隔离端口 daemon 9790/9791 + CDP 9333 强制冷启动，不碰 9222）：
  ① 两次独立 CLI 调用共享同一 tab/会话（第二次见第一次的页面与索引）② 并发三命令 FIFO 串行全成 ③ taskkill 硬杀 daemon 后下一命令自愈重拉（pid 25044）④ status/doctor 三类诊断工作 ⑤ --stop 优雅关停零残留（进程/端口/临时目录/daemon.json 全清）⑥ dist 自包含二进制同链路过（自拉 daemon→动作→关停）
- 真机实证两笔：example.com 此网络不可达（动作 exit 1 + error JSON 契约面顺便验证）；③ 自愈场景的 daemon 由无 CDP_PORT 环境的 CLI 拉起 → 回落缺省 9222，恰逢用户调试 Chrome 已下线而在 9222 起了临时实例（随后优雅回收，用户实例未受影响——taskkill 只杀自己 spawn 的树）

## 待人工审核

1. **IPC 选型**：localhost HTTP 127.0.0.1:9780 + daemon.json 发现（建议）vs named pipe/unix socket
2. **upload_file 会话式白名单**：v1 不设（调用方即信任边界，建议）vs 沿用 M1 --allow-* 语义
3. 命令面 v1 子集（15 动词）与旗标传参形态是否合意
4. 空闲回收缺省 15 分钟、端口缺省 9780、无鉴权三处缺省值

## 评审轮 1（2026-11-09，ocr 全量 main..4604a9e）

8 条意见（自评 critical:1 / high:4 / medium:3）——**逐条核实全部成立，P1×2 / P2×6 全采纳，零驳回零 stale**：

| # | 定级 | 修复 |
|---|---|---|
| 8 布尔缺省穿透（critical） | P1 | protocol.ts buildParams：parseArgs 布尔 default:false 被「未给」守卫放过，invert 旗标恒产 false 覆盖 core 缺省 true（input_text 变追加输入 / evaluate 不等 promise / read_grid 不清过滤器）。改 raw===true 才置参 |
| 4 盲重试重复执行（high） | P1 | client.ts requestDaemon：失败后先探活——daemon 活着（600s 超时/连接中断）不重发（动作可能已执行或在 FIFO 队列），env 信封提示勿盲目重试；死了才自起重试 |
| 1 卡片键名不符（high） | P2 | skill 卡/USAGE/README 三处 element_tree_text → elementTreeText（实际返回键） |
| 2 截图承诺落空（high） | P2 | screenshot 补 --save-path 旗标（core 无 save_path 只回字节回执）；相对路径 CLI 侧 resolve；卡/USAGE/README 示例更新 |
| 3 端口解析时序（medium） | P2 | daemon 分支 applyEnv 提前到端口计算前，status/stop/serve/doctor 四模式统一（.env 写 TC_DAEMON_PORT 不再分裂）；--daemon-port 显式覆盖写入 env 供 doctor 面取用 |
| 5 空闲回收杀在途（medium） | P2 | server.ts runningJobs 在途/排队门禁 + 任务结束刷新 lastActivity |
| 6+7 doctor readInfo 未接线（med+high） | P2 | doctor.ts 增 parseDaemonInfo（坏 JSON/形状 → null）；cli.ts daemonDoctor 缺省接线读 ~/.tc/daemon/daemon.json——僵死诊断生产可达 |

验证：红→绿双向（新测试对未修复代码 7 红→修复后全绿）；node-host 164→171 tests 全绿，覆盖率全维度过线（functions 86.55%）；全仓 8 面 2066 tests 绿；typecheck/biome/gate exit 0。

附带观察（不实施，P3 级）：/health 探测也刷新活跃时刻——外部持续 status 轮询会阻空闲回收（15min 缺省下无实际影响，轮询者即关心者）。
