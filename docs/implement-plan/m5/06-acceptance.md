# M5 段 F：验收（抖音全链路 + Playwright e2e + 门禁收口）

> 分支 `feat/m5-acceptance`。前置：段 A-E 全合并。
> 本段无新功能代码——验收剧本、e2e 用例、文档登记；暴露的缺陷回修走本分支（小）或回对应段分支（大）。

## 1. 验收面（架构 §9 M5 门操作化）

| 面 | 判据 |
|---|---|
| 权限卡 | 抖音任务首次 click/type 弹卡；allow-always 后同 host 后续动作直过；拒绝回流文案进 ActionResult（模型改道） |
| submit 确认 | 发布表单 submit 特征 click 弹 SubmitCard（字段摘要 ≤8，password 打码）；取消不计 consecutive_failures |
| attachmentId 上传 | `upload_file path=attachment:att_1` 走 DataTransfer 注入；页面文件名/大小核对；OS 原生文件对话框不出现 |
| skill 注入 | creator.douyin.com 卡命中：journal 的 skill_active 事件 + state 消息含 `[Domain Skill]` 段 |
| run journal | SW 手动 kill（chrome://serviceworker-internals 停止）后侧边栏重开：interrupted 呈现 + 提示重跑 |
| Node 宿主回归 | examples 抽样 3 例（fast-agent/upload-file/sensitive）真机全绿——core 缝零行为变化 |

## 2. 抖音真机剧本（用户执行，agent 侧准备清单）

前置：Chrome 加载 `.output/chrome-mv3`（未打包扩展）→ options 配智谱 provider 卡
（anthropic 协议 / 智谱兼容端点 / glm-5.3 / apiKey）→ 浏览器登录 creator.douyin.com。

1. 打开（或新建）目标 tab，开侧边栏；
2. 任务文本：同 examples/uploader 同款上传任务（含「起始页: https://creator.douyin.com/…」）；
3. TaskBar 选本地视频文件（attachment att_1 注册，清单显示）；
4. 起跑 → 观察链路：初始导航（NAVIGATE 首过弹卡→allow-always）→ 上传区定位 →
   `upload_file path=attachment:att_1`（UPLOAD 弹卡）→ 表单填写（TYPE 弹卡）→
   封面/合集等交互 → 发布 submit（SubmitCard）→ done；
5. **动作回溯核对**（不以模型自评为准——谎报三部曲教训）：journal 导出（options 的导出按钮或
   storage 直读）逐步核对关键动作真实发生（upload_file 成功、表单字段值、提交动作、发布后页面
   状态截图/URL）；9 项关键动作清单对齐 examples/uploader 验收口径；
6. 已知概率性风险：模型谎报/形态抖动——复跑一次（UP5-c 手段）；仍失败则按 journal 归因，
   缺陷回修不放过门。

注意项：agent tab 须前台（vision 模式截图饿帧限制——M5 默认文本模式不受影响，vision 复验时注意）；
「正在被调试」横幅为 chrome.debugger 固有行为（首跑提示文案已说明）。

## 3. Playwright e2e（进仓，`apps/extension/e2e/`）

fixture：本地 http server 起 `e2e/fixtures/*.html`（表单页 + file input 页 + 多步任务页）；
LLM：localhost mock 端点（剧本化响应序列——按请求序返回预编排动作，非真模型）。

| 用例 | 断言 |
|---|---|
| e2e-permission | mock 剧本触发 click → 侧边栏 DOM 出现权限卡 → 点 allow-always → 动作执行 → 再次 click 不再弹卡；`tc_permissions` 落一条 always grant；剧本触发拒绝路径 → ActionResult 文案含「用户拒绝」 |
| e2e-journal-recovery | run 进行中 `chrome://serviceworker-internals` 停 SW（或 Playwright CDP `ServiceWorker.stopWorker`）→ 重开侧边栏 → interrupted 呈现 + 重跑按钮可用 |
| e2e-e2e-task | mock 三步任务（navigate→click→done）全链：事件流渲染顺序正确、final_result 展示、journal `tc_runUi:<tabId>` 键存在且 seq 单调 |
| （段 B 已有）smoke-attach / （段 D 已有）smoke-mock-run | golden 对拍 / 全链 smoke——并入 e2e 套件常驻 |

运行：`pnpm --filter extension e2e`（独立 script；真机依赖 Chrome 本体，不进默认 test）。

## 4. 文档与登记收口

- `docs/architecture.md`：§2 布局表四包落地状态更新；§5.4 run journal 模式定稿引用；
  偏离登记汇总（见 §5）；
- `docs/implementation-plan.md`：M5 完成标记；
- README（仓根/扩展内）：扩展加载/配置/使用三步说明；
- memory 更新：M5 收官事实。

## 5. 本里程碑偏离登记汇总（随段增量，本节汇总）

| # | 偏离 | 理由 | 段 |
|---|---|---|---|
| 1 | SW 被杀 = interrupted 终态，不做续跑 | checkpoint 续跑过度工程；journal 呈现 + 重跑够 M5 面 | D |
| 2 | 不打包 content script（file-picker-guard 页面层） | 协议级拦截 core 已常开；真机暴露 OS 弹窗再补 | A 起，F 复核 |
| 3 | 附件 bytes 不持久化（SW 被杀即失效，UI 提示重选） | storage 塞大视频不合理；绑 run 生命周期语义干净 | D |
| 4 | 扩展不开 trackDownloads/downloadsPath | Chrome 自管下载落盘；OPFS 覆盖 write 族 | D |
| 5 | done 附件不出 OS 文件系统（journal 内展示） | OPFS 边界；OS 落盘后置 M6 | D |
| 6 | apiKey 明文存 chrome.storage.local | webbrain 同款；扩展本地边界 | D |
| 7 | i18n 不做（中文硬编码） | 单语用户；后置 | E |
| 8 | root 会话拦截合成（若探针判方案 S） | chrome.debugger 无浏览器级端点——机制必然 | B |

## 6. 段内工作项

| # | 项 | 验收 |
|---|---|---|
| F1 | e2e 三用例 + fixtures + mock LLM server | 本机 `pnpm --filter extension e2e` 全绿 |
| F2 | 抖音剧本执行（用户）+ 动作回溯核对 | §2 判据过 |
| F3 | Node 宿主回归 3 例 | 全绿 |
| F4 | 文档/登记/memory 收口 | architecture/implementation-plan/README 更新 |
| F5 | 门禁终检 | `pnpm install && pnpm typecheck && pnpm test` + gate exit 0（全仓四新包计入） |
