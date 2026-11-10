# CLI 双形态供给面——详细设计（Python 移植版）

> **目的**：把 TreeChrome v0.3.0 的「任务级 + 会话级」CLI 供给面完整移植到公司内部
> Python agent 项目。本文从已落地的实现与三轮外部评审（9 条意见全采纳，含 2 条 P1）
> 沉淀而成——**每条设计规则都对应真实的踩坑或裁决**，移植时逐条对齐可避免重新踩一遍。
>
> 基准：TreeChrome `v0.3.0`（commit `62eef6a`）。参照实现（TypeScript）：
> `packages/node-host/src/cli.ts`（命令分发）、`src/daemon/`（protocol / server /
> session-holder / client / doctor 五件）、`src/auto-chrome.ts`、`src/skill-card.ts`。
> 文中「教训」编号对应评审轮次发现，均已在参照实现中修复并测试锚定。

---

## 0. 全景与核心概念

### 0.1 双形态

| | 任务级 `run` | 会话级 `<动作>` |
|---|---|---|
| 控制权 | **本项目 LLM** 驱动整段 agent loop | **调用方 LLM** 逐步直驱浏览器原语 |
| 进程模型 | one-shot：一条命令一个进程，跑完即退 | daemon 常驻 + 每命令一次 IPC 往返 |
| 供给物 | 终态 JSON（finalResult/lastUrl/attachments…） | 每动作单 JSON（get_state 的元素树是核心） |
| LLM 凭据 | 需要（本项目跑 LLM） | **零**（daemon 内部无 LLM） |
| 适合 | 一句话能写清目标与验收的完整委派 | 一步完事 / 探索诊断 / 中途改道 / 浏览器内外交织 / 多轮同页 |
| 类比 | browser-use 的 `run agent` | browser-use 3.0 的 session 动作 API |

两形态并存而非互斥：run 失败（exit 1）时读 stopReason/errors 决定改写重发，或切
会话级进同一页面现场诊断——这一点写进 skill 卡（见 §3）。

### 0.2 daemon 化的根因（为什么不是每次调用拉起进程）

浏览器 agent 的核心状态是**两层 selector map**（页面元素索引 ↔ DOM 节点的映射表），
它活在进程内存里：

- one-shot 形态下每次调用都要重建（导航→快照→建索引），多轮操作重复成本极高；
- 会话级要求「跨调用保持当前 tab」，索引与 tab 亲和性必须进程内常驻。

因此会话级 = 常驻 daemon 持有 BrowserSession + 动作注册表；CLI 命令只是向 daemon
发动作的薄客户端。daemon 内部**绝无 LLM**——决策循环完全在调用方。

### 0.3 路由阶梯（写给调用方 agent 的分流规则，随 skill 卡分发）

收到自然语言任务时按序判定：

1. **不需要浏览器**（公开信息，fetch/curl 可得）→ 不用本 CLI；
2. **一句话能写清目标与验收** → `run` 委派，一条命令拿终态 JSON；
3. **任一信号 → 会话级**：一步完事（看标题/截图/读一个值）；探索诊断（「看看」
   「为什么」）；调用方要看路或中途改道；浏览器内外交织（查一半读本地文件再回来
   点）；多轮围绕同一页面；
4. **模糊 → 默认 run**（省调用方上下文），并告知所用形态。

### 0.4 安全边界（v1 拍板，登记偏离）

- daemon **无鉴权**，绑定恒 `127.0.0.1`——暴露面与本机 CDP 调试端口同级（能读
  daemon 端口的进程本来就能直接连 CDP，加鉴权不改变威胁模型）；
- 会话级 upload / 文件动作**不设白名单**——调用方 agent 即信任边界（本机同权进程）；
  `run` 面的 `--allow-*` 护栏语义不变（run 是把任务文本交给本项目 LLM，信任模型不同）；
- 内网服务若跨机暴露 daemon 端口，须自行加 TLS + token 反代——设计上不支持。

---

## 1. 任务级 `run`

### 1.1 命令面

```
run [task...] [选项]
  --json            stdout 只出终态 JSON（过程日志全走 stderr）
  --task-file <p>   从文件读任务文本（UTF-8，显式覆盖 stdin/argv）
  --max-steps <n>   覆盖单 run 步数预算（正整数）
  --allow-write <dir>   可重复旗标，文件面白名单前缀
  --allow-read <dir>    同上
  --allow-upload <dir>  同上
  --auto-chrome     无显式 CDP 目标时自动拉起临时 Chrome（§1.7）
  --keep-chrome     配合 --auto-chrome：结束时保留实例不回收
```

### 1.2 任务文本解析序（已拍板「stdin 优先」）

```
--task-file > stdin（管道）> 位置参数
```

- 三通道都 trim（echo/heredoc 尾换行不进任务文本）；空白等价于未提供；
- 三者皆无 → 用法错（exit 2）；
- `--task-file` 就绪即**跳过 stdin 读取**：spawn 场景 stdin 管道可能永不关闭，
  无条件读会永久挂起（教训：评审轮早期 [1]）；
- stdin 读取失败（管道异常/坏 fd）按前置失败收口 exit 2，而不是崩成未处理异常——
  退出码 1 会被调用方误读为「跑完但未成功」（教训 [2]）。

### 1.3 输出契约

- `--json` 模式：stdout **只有一行 JSON**（camelCase 投影），过程日志全部注入
  stderr——调用方 `subprocess` 捕获 stdout 直接 `json.loads`，永不混合噪声；
- 非 `--json`（人类模式）：过程日志走 stdout，终态渲染人类可读摘要；
- JSON 字段（对齐 agent 终态历史）：`isDone / isSuccessful / finalResult /
  stopReason / nSteps / errors / attachments / lastUrl` 等。

### 1.4 退出码（与信封联动，两形态统一）

| 码 | 含义 | 调用方动作 |
|---|---|---|
| 0 | 成功 | 读 finalResult |
| 1 | 跑完/执行但未成功 | **stdout 仍有 JSON**，读 stopReason/errors 后决定改写重发或放弃 |
| 2 | 用法/前置失败（参数错、缺凭据、Chrome 不可达、daemon 拉起失败） | **不要重试**，先修环境 |

### 1.5 护栏

`--max-steps` / `--allow-*` 透传 agent 配置（步数预算、文件面前缀白名单）；
**未设旗标 = core 默认放行**——给外部 agent 调用时建议显式收紧。这是文档口径
问题不是代码问题：写进 skill 卡。

### 1.6 凭据链（仅 CLI 面）

```
OS 环境变量 > TC_ENV_FILE 指向文件 > ~/.tc/.env > 当前目录 .env
```

逐键先到先得（OS env 恒最高）；.env 解析只做 `KEY=VALUE` 平面读取，不引依赖。

**教训 [3]（评审轮 1，P2）**：凭据链必须在**所有**端口/配置计算之前应用。曾出现
daemon 子命令分支先算端口后应用凭据链、status/stop 分支干脆不应用——用户在
`~/.tc/.env` 写 `TC_DAEMON_PORT=9999` 时，动作命令连 9999、`--status` 探缺省 9780，
永远停不掉真 daemon。**规则：每个子命令分支第一件事 = 应用凭据链，再取任何派生值。**

### 1.7 --auto-chrome（临时 Chrome 生命周期）

```
显式 CDP_WS_URL → no-op（调用方自管连接）
否则：discover(CDP_HOST:CDP_PORT) 成功 → attach 既有实例
      失败 → 拉起临时 headless Chrome（独立 user-data-dir 临时目录）
           → 二次 discover 失败 → 回收实例 + exit 2
结束时（finally）：按 PID 树回收临时实例（--keep-chrome 除外）
```

**铁律：绝不按映像名（chrome.exe / Google Chrome）杀进程**——会杀掉用户日常
Chrome。只杀自己 spawn 出来的 PID 树（Windows `taskkill /PID <pid> /T /F`；
POSIX 进程组 `os.killpg`）。

---

## 2. 会话级 daemon

### 2.1 IPC 选型：localhost HTTP + daemon.json

**拍板：HTTP，恒绑 127.0.0.1，缺省端口 9780（`TC_DAEMON_PORT` 覆盖）**。

- 理由：可 curl 调试、跨平台零差异、与 CLI 的 JSON 契约同构；
- 弃选 named pipe / unix socket：不占端口但平台 API 分叉、难调试；
- 运行态写 `~/.tc/daemon/daemon.json`（`{pid, port, startedAt}`）供 CLI 发现与
  doctor 诊断；日志 append `~/.tc/daemon/daemon.log`。

Python 适配：标准库 `http.server.ThreadingHTTPServer` 足够（本场景请求率极低），
无需 web 框架；JSON 用标准 `json` 模块，响应统一 `application/json; charset=utf-8`。

### 2.2 HTTP 面

| 路由 | 行为 |
|---|---|
| `GET /health` | 活性：`{pid, port, startedAt, idleSecs, sessionStarted}`，会话惰性（未建也报活） |
| `POST /action` | `{"action": string, "params": object}` → 执行 → 信封应答 |
| `POST /shutdown` | 回包 `{stopped:true}` 后**下一 tick** 再关停（先落盘响应再关连接） |

**信封协议**（CLI 退出码映射的根基）：

```json
{"ok": true,  "data": {...}}                          // 成功
{"ok": false, "error": "...", "kind": "usage|env|exec"} // 失败
```

- **动作执行失败**（元素找不到、页面超时等业务失败）走 `ok:true + data.error`
  （CLI exit 1，stdout 仍有 JSON——与任务级「1 = 跑完未成功带 JSON」同构）；
- `env`（连不上/会话断）与 `usage`（参数错）走 `ok:false`（CLI exit 2）；
- 请求体上限 20MB；坏 JSON / 缺字段 → 400 + usage 信封；未知动作 → 404 + usage。

### 2.3 串行队列（FIFO）

**单 Chrome 单 daemon：并发动作必须串行**。多调用方并发切 tab / 刷新索引会竞态
（browser-use 同款纪律）。实现为 promise 链（TS）/ 单把 `threading.Lock`（Python）：

- ThreadingHTTPServer 每请求一线程，动作执行段整体持锁——天然 FIFO、无重入；
- 锁内包括会话惰性建连（首个请求才解析 wsUrl 并 start）。

### 2.4 会话持有（session holder）

- **惰性单例**：首个动作请求才建 BrowserSession + 动作注册表；
- **wsUrl 解析序**：`CDP_WS_URL`（显式，绝不自拉）> discover(`CDP_HOST:CDP_PORT`
  缺省 127.0.0.1:9222) > 复用 auto-chrome 自拉（拉起后二次 discover，仍失败 →
  env 错误并回收实例）；
- **死会话重建**：连接中断（`is_connected == false`）后，**catch 里不要置空会话**
  ——跳过优雅 stop 会泄漏浏览器连接；下一次请求进来时做「优雅 stop + 重建」；
- shutdown 幂等：browser.stop + 自拉 Chrome PID 树回收，清理失败只记日志不抛。

### 2.5 空闲回收（含在途门禁——教训 [5]，评审轮 1，P2）

缺省 900s 无活动自动关停（`TC_DAEMON_IDLE_SECS <= 0` 关闭）。两条规则缺一不可：

1. **在途/排队计数门禁**：`running_jobs > 0` 时回收定时器跳过——否则一个 90s 的
   长动作遇上 60s 空闲阈值，daemon 会在动作执行中途 `close` 掐断在途连接并杀会话；
2. **任务结束时刷新活跃时刻**：`last_activity = now()` 放在 job 的 finally——
   长任务跑完不能立刻算「已空闲 90s」。

已知语义（接受不改）：`/health` 探测也刷新活跃时刻——外部持续 status 轮询会阻
回收。15min 缺省下无实际影响（轮询者即关心者）。

### 2.6 客户端：自起 + 重发门禁（两次评审迭代的最终形态）

**自起**：动作命令遇连接失败 → detached 自 spawn 同一入口脚本 `daemon --serve`
→ 轮询 /health 就绪（250ms × 20s 预算）→ 重试一次。daemon 侧 `--serve` 遇端口
被占（EADDRINUSE）按幂等成功 exit 0——双客户端同时自起的竞态收口。

**重发门禁——仅 `ECONNREFUSED`（连接被拒）才允许自起+重试**（教训 [4] P1 +
教训 [7] 评审轮 2）：

```
post 失败
 ├─ 错误是 ECONNREFUSED（连接从未建立 = 请求从未到达 daemon）
 │    → 自起（若需要）→ 重试一次            # 重发必安全
 └─ 其余任何失败（600s 超时 / 连接中断 / 响应截断）
      → 不重发，env 信封交还调用方：
        daemon 仍存活 → "动作可能已在服务端执行或仍在队列，请确认副作用后手动重发"
        daemon 已退出   → "动作执行状态未知，…"
```

为什么不是「探活判断」：探活有假阴性（探测超时预算 1.5s，daemon 事件循环被长
任务阻塞即超时）。初版门禁（失败后探活，活着不重发）被击穿的竞态：探活假阴性 →
ensure 阶段宽容轮询（20s）探活成功而未 spawn → 外层仍盲目重发 → **非幂等动作
（click 提交按钮）被点两下**。`ECONNREFUSED` 是唯一可机器证明「请求从未到达」的
错误形态；其余失败一律把重试决策交还调用方。

Python 注意：`http.client` / `requests` / `urllib` 的连接被拒异常需取 `errno`
（`ConnectionRefusedError` 原生；requests 包 `ConnectionError` 要看 `__cause__`）。

### 2.7 doctor（三类故障诊断）

`daemon --doctor` 输出 findings 数组（name/status/detail/hint）+ summary
（healthy/degraded/down）：

| 检查 | 判定 | 建议（hint） |
|---|---|---|
| daemon | daemon.json 记录 pid 活着但 /health 无响应 → **僵死**（fail） | `taskkill /PID <pid> /F`；任一动作命令也会自动重拉 |
| | 无 daemon.json / pid 已退出 → 未运行（warn，无害） | 无需处理 |
| Chrome | CDP `/json/version` 探测（显式 CDP_WS_URL 时跳过——自管语义） | 装 Chrome / 设路径 / 自起调试实例 |
| 端口 | daemon 不在听时才有信息量：connected=被别的进程占（fail）/ refused=空闲（ok） | 换 `TC_DAEMON_PORT`；`netstat -ano` 定位占用者 |

**教训 [6]（评审轮 1，两条意见同根因，P2）**：僵死诊断依赖读 `daemon.json`——
初版诊断模块的「读盘」依赖在生产 CLI 接线处**从未注入**，僵死分支是生产不可达
的死代码，用户只会拿到误导性的「换端口」建议而僵死进程永不回收。**规则：诊断的
每个数据源在生产入口显式接线，并有针对该接线的测试。**

### 2.8 动词表与类型化旗标

15 动词 v1 子集（`get_state / navigate / click / input_text / select_dropdown /
scroll / find_text / read_grid / evaluate / screenshot / upload_file / go_back /
tabs / switch_tab / close_tab`），旗标→动作参数的类型化映射，含四类校验：

- **必填**（navigate 的 url、input_text 的 text）；
- **XOR 组**（click 的 `--index`/`--element-id` 二选一；select_dropdown 的
  `--value`/`--values` 二选一）；
- **int 校验**（拒绝非整数）；
- **invert 反向布尔**：core 缺省 true 的参数（input_text 的 clear、evaluate 的
  await_promise、read_grid 的 fresh）用 `--no-clear/--no-await/--no-fresh` 形态。

**教训 [8]（评审轮 1，P1——移植到 argparse 会原样复现）**：argparse 的
`store_true` 旗标缺省是 `False`，**False ≠ 未给**。参数构造若只判「值是否为
None」会放过 False，反向布尔在默认调用下恒产出 `clear=False` 覆盖 core 缺省
true——有旧值的输入框变成**追加输入**、异步 evaluate 立刻返回空结果、read_grid
不清遗留过滤器。三条默认路径全错，且单测（手拼 values 不带缺省值）照常全绿。

**规则（Python 版）**：

```python
parser.add_argument("--no-clear", action="store_true", default=False)
# 构造参数时：布尔旗标仅当值为 True（即用户给出）才写入 params：
if args.no_clear:
    params["clear"] = False        # invert 形态：给出时置 False
if args.new_tab:
    params["new_tab"] = True       # 普通布尔：给出时置 True
# 缺省 False 一律「视同未给」，让 core 用自己的缺省
```

配套口径：**空串旗标值视同未给**（与 allow-* 收集口径一致），否则
`select_dropdown --value ""` 会误触 XOR。

**upload / screenshot 的路径参数在 CLI 侧 resolve 成绝对路径**——daemon 的 CWD
可能与调用方不同（教训 [9]：screenshot 无 save_path 时 core 只回字节数回执，
不落盘不回传图片，「看看页面」静默落空——**screenshot 旗标必须含 save-path**，
且文档示例一律带它）。

### 2.9 serve 模式生命周期

- 日志 append daemon.log（进程 stdout 全静默——detached 无处可去）；
- daemon.json 启动写 / 关停删；
- `SIGTERM`/`SIGINT` 优雅关停（会话 + 自拉 Chrome）；
- EADDRINUSE → 记「已在运行」exit 0（幂等，见 §2.6）。

---

## 3. skill 卡与分发

- 用法卡是**给调用方 agent 读的**最小决策面（不是给人的 README）：两形态各一节 +
  路由阶梯（§0.3）+ When Not to Use（公开信息用 fetch/curl，别开浏览器）+
  JSON 契约 + 退出码语义 + 凭据差异行；
- **单源常量**（参照实现用 TS 常量；Python 用一个模块级字符串），`skill install`
  写到 `~/.claude/skills/<cmd>/SKILL.md`（或目标 agent 的技能目录），`--print`
 打到 stdout 供管道进任意 agent 配置；
- 教训 [10]（P2）：卡片承诺的字段名必须与实际返回**逐字节核对**——曾发生卡片写
  `element_tree_text`（snake_case 惯例想当然）而实际返回 `elementTreeText`，
  agent 照卡读键拿到 undefined，会话级的核心供给链路整体落空。发卡前加一条测试
  断言卡片示例键名 ⊆ 实际投影键名。

---

## 4. Python 适配要点

| 面 | TS 参照 | Python 建议 |
|---|---|---|
| CLI 解析 | util.parseArgs strict | `argparse`（strict 语义天然具备：未知旗标报错）；布尔陷阱见 §2.8 |
| HTTP 服务 | node:http | `http.server.ThreadingHTTPServer` + 单把 `threading.Lock` 串行动作 |
| HTTP 客户端 | fetch + AbortSignal.timeout | `urllib.request`（零依赖）或 requests；**显式 timeout**；连接被拒取 `errno`/`__cause__` 判 ECONNREFUSED |
| detached 自 spawn | spawn(detached)+unref+吞 error | `subprocess.Popen(..., stdin/out/err=DEVNULL, close_fds=True, creationflags=DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP)`（Win）/ `start_new_session=True`（POSIX） |
| PID 树回收 | taskkill /T /F（Win） | 同左；POSIX `os.killpg(os.getpgid(pid), SIGTERM)`；**只杀自 spawn 的 PID，绝不按映像名杀** |
| 惰性会话/常驻 | 事件循环持活 | serve 主线程 join HTTP server；`signal.signal(SIGTERM/SIGINT, ...)` 优雅关停 |
| 打包分发 | esbuild 单文件 + npm link | 内部 wheel + `pipx install` / `uv tool install`（隔离全局命令）；需免 Python 环境分发时用 shiv/PyInstaller |
| 编码 | UTF-8 恒定 | 子进程与文件 IO 全部显式 `encoding="utf-8"`；Windows 控制台 `chcp 65001`；JSON 输出 `ensure_ascii=False` |

跨平台注意：若贵项目仅内网 Linux，§1.7/§2.6 的 Windows 分支可删，但
「只杀自 spawn PID 树」纪律保留。

---

## 5. 测试策略

### 5.1 单元测试（CI，零真 Chrome / 零真网络）

- **全注入**：会话工厂、wsUrl discover、Chrome launch、fetch、spawn、时钟全部
  可替换假件；HTTP 服务端测**真绑定 127.0.0.1 临时端口**（port 0）；
- 协议纯函数直测（端口/空闲解析、动词校验、XOR、int、invert 布尔缺省——
  §2.8 教训 [8] 的回归用例必须含「生产形态」：经完整 CLI 解析而非手拼 values）；
- 服务端：health 形态 / FIFO 串行（两并发请求事件序 `start:A end:A start:B end:B`）/
  惰性单例 / shutdown 回包后关停 / 空闲回收（注入小周期）+ **在途门禁**（350ms
  任务 vs 100ms 空闲阈值：任务必须完整应答）；
- 客户端：ECONNREFUSED→自起→重试；**存活不重发**（actionCalls 断言 = 1、spawn
  断言不触发）；连接中断且 daemon 已死 → 不自起不重发；
- doctor：三诊分支 + 缺省探测件（pid 真探/端口真连的本机拒绝/占用面）；
- CLI 分发：注入假客户端断言退出码与 stdout 单 JSON。

### 5.2 红绿双向验证

行为级修复做一次「临时还原旧实现 → 新测试必红 → 还原修复 → 绿」——单测全绿
但行为错的教训 [8] 正是缺这一步才漏到评审。

### 5.3 真机 smoke（手动，不进 CI）

1. 两次独立 CLI 调用共享同一 tab（第二次见第一次的页面与索引）；
2. 并发三命令 FIFO 串行全成；
3. 硬杀 daemon 后下一命令自愈重拉；
4. status/doctor 三类诊断；
5. `--stop` 优雅关停零残留（进程/端口/临时目录/daemon.json 全清）；
6. 打包产物（wheel 安装态）同链路过一遍。

---

## 6. 教训清单（移植验收对照表）

| # | 教训 | 落成的设计规则 | 级别 |
|---|---|---|---|
| 4 | 网络失败盲重试 → 非幂等动作重复执行 | 重发门禁仅 ECONNREFUSED；其余失败 env 信封交还调用方（§2.6） | P1 |
| 7 | 探活假阴性击穿存活门禁（1.5s 探测预算 vs 事件循环阻塞） | 同上——重发决策只看错误形态，不看探活结果（§2.6） | P2 |
| 8 | 布尔旗标缺省 False 穿透「未给」守卫，invert 参数恒 False | 仅 `raw === True` 才置参；argparse store_true 同陷阱（§2.8） | P1 |
| 1 | 卡片/文档键名与实际返回不符（snake vs camel） | 卡片示例键名测试断言 ⊆ 实际投影（§3） | P2 |
| 2 | screenshot 无 save-path 只回字节数，承诺落空 | 动词表必含 save-path；相对路径 CLI 侧 resolve（§2.8） | P2 |
| 3 | 凭据链应用时序不一致（status/stop 不应用/serve 后算端口） | 每个子命令分支先应用凭据链再算任何派生值（§1.6） | P2 |
| 5 | 空闲回收掐断在途长动作 | running_jobs 在途门禁 + 任务结束刷新活跃时刻（§2.5） | P2 |
| 6 | doctor 的 daemon.json 读取在生产未接线（僵死诊断死代码） | 诊断数据源在生产入口显式接线并测试（§2.7） | P2 |
| — | 绝不按映像名杀 Chrome（会杀用户日常实例） | 只杀自 spawn 的 PID 树（§1.7/§2.4） | 铁律 |
| — | /health 探测计活跃（外部轮询阻回收） | 已知语义，接受不改；文档登记（§2.5） | P3 |

---

## 7. 待贵项目拍板的决策点

参照实现的四处拍板，按贵项目上下文重审：

1. **IPC**：localhost HTTP + daemon.json（建议）vs named pipe/unix socket——
   内网 Linux 环境若已有惯例（如 systemd socket activation）可重议；
2. **会话级 upload/文件动作白名单**：v1 不设（调用方即信任边界，建议）；若调用方
   是不受控的多租户 agent 则必须加；
3. **动词子集**：15 个是否裁剪/扩充（建议先跑真实调用方再扩）；
4. **缺省值**：端口 / 空闲回收时长 / 无鉴权三处——跨机使用场景下「无鉴权」必须推翻。

---

## 附：参照实现文件索引

| 文件（packages/node-host/src/） | 职责 |
|---|---|
| `daemon/protocol.ts` | 端口/空闲解析、15 动词表、类型化旗标→参数（必填/XOR/int/invert）、信封构造（纯函数，零 IO） |
| `daemon/server.ts` | HTTP 服务端：路由、FIFO 串行队列、空闲回收（在途门禁）、shutdown、PortInUse |
| `daemon/session-holder.ts` | 惰性单例会话：wsUrl 三段解析、死会话重建、自拉 Chrome 回收 |
| `daemon/client.ts` | 自起客户端：ECONNREFUSED 门禁重试、ensureDaemonRunning、doctor 探测件 |
| `daemon/doctor.ts` | 三类诊断 + parseDaemonInfo |
| `cli.ts` | 四面分发（run/skill/daemon/动作）、任务文本解析序、serveDaemon、退出码 |
| `auto-chrome.ts` | 临时 Chrome 拉起与 PID 树回收 |
| `skill-card.ts` | 用法卡单源常量 |
| `test/daemon.test.ts` | 172 用例中的 daemon 面（真 HTTP 临时端口 + 全注入假件） |
