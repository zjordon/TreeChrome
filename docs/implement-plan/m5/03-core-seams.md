# M5 段 C：core 缝（upload attachmentId 二态 + submit 预确认）

> 分支 `feat/m5-core-seams`。前置：无硬依赖（建议排段 B 后——评审聚焦 core 改动）。
> 纪律：**两处缝都不改变 Node 宿主可观测行为**——`NodeFs` 不实现新可选方法 → 分支在 Node 侧是
> 死代码（可证）；`submitConfirmEnabled` 缺省 false → 评测/examples 行为不变。红绿双向验证为验收项。
> Python 参照：两缝均为 TreeChrome 净新增（Python 无扩展形态）；upload 现有路径分支的 Python
> parity 锚点测试**不动且必须全绿**。

## 1. 缝一：upload attachmentId 二态

### 1.1 动机与总原则

扩展无 OS 路径（用户在侧边栏选文件 → SW 持 bytes）。架构 §5.2：UPLOAD 走 attachmentId 模式
（用户亲手选文件，agent 只能引用句柄）。**`ACTION_DEFINITIONS` 零改动**（schema 是 prompt 契约）；
attachment 引用塞进 `params.path`（自由字符串 `attachment:att_1`），用法说明由宿主写进任务文本
（§1.4）——core 不感知「扩展」，只多一条 bytes 通道。

### 1.2 接口面

`tools/fs.ts`（五接口之一的可选扩员——不破坏既有实现）：

```ts
export interface AttachmentPayload {
  base64: string;
  filename: string;
  mimeType: string;
  size: number;          // 字节（空文件校验复用）
}
export interface FileSystemProvider {
  /* …既有十方法不动… */
  /** 附件句柄解析（扩展形态）：ref 形如 "attachment:att_1"；不识别/未注册 → null。
   *  可选方法——不实现即纯路径宿主（NodeFs 不实现，Node 行为零变化） */
  readAttachment?(ref: string): Promise<AttachmentPayload | null>;
}
```

`browser/upload.ts` 新函数（与 `setFileInput` 并列；机制源 webbrain `setFileInputData`
cdp-client.js:2189-2222，代码重写）：

```ts
/** bytes → 页面内 File+DataTransfer 注入（无 OS 路径宿主的上传执行端）。
 *  DOM.resolveNode(backendNodeId) → objectId → Runtime.callFunctionOn：
 *  页面内 new File(bytes) → DataTransfer → input.files = transfer.files →
 *  dispatch input+change（bubbles）。注入函数体逐句对齐 webbrain 实证版
 *  （非 file input 目标返回结构化 error——与 setFileInput 的 Python 文案分支互补） */
export async function setFileInputData(
  s: SessionInternals,
  backendNodeId: number,
  payload: AttachmentPayload,
): Promise<void>   // 失败抛 Error（调用方包 ActionResult.error，文案含页面返回 error）
```

`BrowserSession` 公开方法 `setFileInputData(backendNodeId, payload)`（与既有 `setFileInput`
对称——upload-file.ts 经 `ToolsBrowser` 调用）。

### 1.3 upload-file.ts 动作分支（唯一改动点）

现流程（:214-236）：`resolve → 白名单 → fs null 检查 → isFile → stat 空检查`。新流程：

```
params.path ──► ctx.fs?.readAttachment?.(path) 命中？
                ├─ 命中（AttachmentPayload）──► 附件分支：
                │     跳过路径白名单与 isFile/stat（附件由用户手势亲手选定——白名单
                │     防的是 agent 指定服务端路径，附件不在威胁面；size===0 沿用空文件
                │     校验文案）──► 元素查找/双 input 纠正（共用，不动）──►
                │     browser.setFileInputData(backendId, payload) ──►
                │     accept 软校验 + 页面验证（共用，不动；set 后页面状态与注入方式无关）
                └─ 未命中（null / fs 无可选方法）──► 原路径分支（逐字节不动）
```

要点：

- 判定次序：**readAttachment 先问**（NodeFs 无该方法 → 短路原分支，零开销）；
- 日志：附件分支新日志行 `set_file_input_data: backend_node_id=…, file=<filename>, size=…`
  （net-new 面，格式自定但风格对齐既有 `set_file_input` 行）；
- 错误文案：注入函数返回结构化 error 时上翻（`File upload failed (data channel): <页面 error>`）；
- capability/权限门：upload 动作 capability=UPLOAD 不变（扩展侧 confirm 卡照弹）。

### 1.4 任务文本约定（宿主侧，core 不实现）

宿主装配任务文本时追加（模型可读）：

```
[Attachments]
- att_1: video.mp4 (12.3 MB, video/mp4)
使用 upload_file 动作上传附件：path 参数填 "attachment:att_1"（不是文件路径）。
```

### 1.5 测试（红绿双向）

- **绿向（新面）**：fake fs（实现 readAttachment）+ fake browser：
  命中→setFileInputData 收到 payload 与 backendId（含双 input 纠正场景）/ 未注册 ref→error 文案 /
  size=0→空文件文案 / 注入函数返回 error→上翻；setFileInputData 单测锚定 JS 函数体逐句
  （Runtime.callFunctionOn 参数/ objectId 解析链/事件 dispatch 断言）。
- **红向（保真）**：NodeFs（无 readAttachment）全量 upload 单测**原样全绿**（不修改任何既有用例）；
  「readAttachment 返回 null → 走路径分支」显式用例。
- mock 链路零真网络零真 CDP（session fake 惯例）。

## 2. 缝二：submit 预确认

### 2.1 动机

架构 §5.3「检测 submit 特征的 click 单独确认，展示变更字段摘要（≤8）」。core 现状：
`PolicyInteraction.confirmSubmit` 接口就位（policy.ts:29 注释自述 M5 落地），无调用点、无检测。

### 2.2 设计

**三件**：

1. **`SubmitProbe`（纯件，agent/ 下新文件）**：判定 click 目标是否 submit 特征 + 采集字段摘要。
   - 结构判定（语言无关、确定性——与门模型同哲学）：快照节点 tag=`input[type=submit]` /
     `button[type=submit]` / `button`（无 type，HTML 默认 submit 语义）**且**可探到 form 祖先。
     快照节点缺 form 归属信息 → 判定延到运行时 JS probe（一步完成判定+摘要）。
   - 字段摘要 JS（经 browser 的 evaluate 通道）：目标元素 `closest("form")` 内
     `input/select/textarea`（跳过 password 值显示——字段名可见值打码为 `***`），
     取 value 非默认（`defaultValue`/`defaultChecked` 比对）的前 8 项：
     `[{name|label, value 截断 40 字符}]`；无 form 或无变更字段 → null（不确认）。
   - **实施前侦察点**：快照 interactive 节点的 tag/type 暴露面（selector_map entry 字段）——
     若无 tag 信息则判定全走 JS probe（一次 evaluate 完成判定+摘要，快照侧零依赖）。
2. **`PolicyGate.submitGate`（新方法）**：CLICK 已放行后的二道门。
   ```ts
   async submitGate(req: GateCheckRequest, summary: SubmitFieldSummary[]): Promise<GateCheckResult>
   // 语义：interaction.confirmSubmit(req+summary)；异常/超时按 deny（边界纪律同 requestPermission）；
   // deny 文案：「用户拒绝在 <host> 上提交表单，不要重试，可改道或询问」（deniedReason 变体，
   // 新增独立模板常量——不复用 CLICK 文案避免模型误解为点击被拒）
   ```
   `AutoAllowPolicy.confirmSubmit` → `true`（评测/examples 零阻塞——现签名已是 boolean）。
3. **挂点（act.ts 守卫链，权限门之后）**：
   ```
   policy.check(req) 放行
     && actionName === "click"
     && settings.submitConfirmEnabled        // AgentSettings 新可选键，缺省 false
     && (summary = await SubmitProbe.probe(browser, index)) !== null
     → policy.submitGate(req, summary) → deny 则 denied ActionResult（不计 consecutive_failures，
       与权限 deny 同款记账——挂点相邻实现复用）
   ```

`AgentSettings` + `submitConfirmEnabled?: boolean`（缺省 false）——**resolveAgentSettings 默认值
与 Python 对拍 fixture（settings-defaults.json）不动**，可选键不进 fixture（对拍面零变化）。

### 2.3 测试

- SubmitProbe：结构判定表（tag/type 矩阵 / 无 form → null / password 打码 / >8 截断 / 值截断 40）；
  JS probe 体经 fake browser 断言（evaluate 参数与返回解析）；
- PolicyGate.submitGate：allow/deny/超时/异常四分支（mock interaction）；
- 挂点集成：enabled+submit 特征 → confirmSubmit 被调（一次）+ deny 不计失败；
  enabled+非 submit → 不调；**disabled（缺省）→ 全链零调用**（红向保真用例）；
- AutoAllow：confirmSubmit=true 恒过（评测形态回归）。

## 3. 出界项（登记）

- submit 卡 UI（段 E）；任务文本附件清单拼接（段 D 宿主装配）；
- NodeFs 永不实现 readAttachment（路径宿主语义——若未来 Node 侧要传 bytes，另开缝评审）；
- 「计划审批永不预授权动作」边界（架构 §5.1）不涉——submit 卡在动作粒度。

## 4. 段内工作项

| # | 项 | 验收 |
|---|---|---|
| C1 | FileSystemProvider.readAttachment + setFileInputData + upload-file.ts 分支 | §1.5 测试全绿（红绿双向） |
| C2 | SubmitProbe + PolicyGate.submitGate + act.ts 挂点 + AgentSettings 键 | §2.3 测试全绿（含 disabled 红向） |
| C3 | Python parity 锚点回归 | core 既有 1301+ 例全绿（零用例修改）；settings-defaults fixture 不动 |
| C4 | 门禁 | typecheck/test/gate exit 0；覆盖率 ≥85% |
