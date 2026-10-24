# SCRATCHPAD — 实施计划草稿（随实施持续更新）

> 分支：`feat/issue-6-form-control-state`（自 main @ c07d9a4——**不含 #5 的 bee0f46**：dom-snapshot 层与 #5 无代码耦合，两分支独立合并；dump 工具加开关挪 #5 后续段防撞文件）
> 目标：实现 [issue #6](https://github.com/zjordon/TreeChrome/issues/6) — 快照表单控件状态可见性（formControlState）：select 选中值 / input 当前值 / checked 进 element_tree_text
> 状态：**计划初稿，待人工审核（未过审不写实现代码）**

## 0. 背景与结论（实证已完成，见 issue #6 全文）

模型能看到控件存在、看不到控件状态（Period 当前值 / input 当前文本 / checked）。AX 源每次 get_state 都在送状态（`CdpAxTreeNode.value`，a11y 快照实证 `combobox "Period" … value="Day"`、`textbox "From *" … value="1/1/22"`），融合层投影无槽位丢弃，序列化层 `current=` 渲染槽位现成。a11y 树系（chrome-devtools/Playwright ariaSnapshot）与截图系工具天然显示表单值——DOM 序列化系是唯一缺口家族。参照实现：browser-use fork `serializer.py:230-269`（file input 的 AX→valuenow→current= 接线，注释 "Always shows state"）。

## 1. 方案总览

```
AX getFullAXTree（已在采）
  → collector.buildEnhancedAxNode 补提取顶层 value（EnhancedAXNode 新增字段）
  → serializer 开关 formControlState（缺省关 = 输出与现状逐字节一致）：
      select         → compound Dropdown Toggle 组件 valuenow = AX value → 现成 current= 渲染
      text input     → 元素顶层 value=…（password 掩码、长值截断）
      checkbox/radio → 元素顶层 checked=true/false（AX properties.checked）
  → buildDomState(opts) / BrowserSession 透传 → node-host 默认开；扩展接线留 #5 S3 段
```

### 关键设计决策（待审）

| # | 决策 | 理由 |
|---|---|---|
| F1 | ~~开关缺省关，产品宿主开~~ **已推翻（用户裁定 2026-10-24）**：定性为 bug 修复（Step 5「表单当前值」设计本就存在、数据源接错抽屉），**无条件渲染、无开关**。代价：TS 输出与未修的 Python 不再逐字节一致 → 两页受影响 fixture 的 output 经 TS 修复版管线重放原 input 重新生成（选 B：Python 侧同 bug 暂不修，基准以 TS 为准，fixtures README 登记技术债；Python 同修后须重对齐） | 用户：「这明显是一个 bug」——bug 修复不藏在开关后；golden 的 Python 参考语义对这两页暂时破损，登记在案 |
| F2 | 数据源 = AX 顶层 `value`（select/input 文本）+ AX `properties.checked`（checkbox/radio） | 零额外 CDP 调用（AX 源已在采）；fork file input 已验证同款模式（valuetext/value → valuenow） |
| F3 | 防护：password 类型掩码（`value=***`）；值截断对齐 compound 截断口径（30 code points + 省略号，实现评审可调）；AX 源失败/字段缺失 → 属性整体缺席不炸（现有降级链语义不变） | 状态泄露（password）与 token 膨胀（长值）两头堵；降级一致性 |
| F4 | select 走 compound `current=`（复用现成渲染槽位，slider 同款）；input/checked 走元素顶层属性 | 候选 B（全走顶层 `value=`/`checked=`）更直观但 select 需新渲染分支；倾向 A，实现评审定 |
| F5 | 透传链：`BrowserSession` 构造配置（实例缺省）而非 getState 每次传参 | getState 调用点在 sense 阶段深处（core agent），逐参透传改动面大；构造期一次配置符合"配置显式传入"铁律 |

## 2. 组件改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| dom-snapshot | `src/types.ts` | `EnhancedAXNode` + `value: string \| null` 字段（snake_case 对齐投影惯例；Python 对齐口径登记为 TS 扩展先行） |
| dom-snapshot | `src/collector.ts` | `buildEnhancedAxNode` 提取 `axNode.value?.value`（string 收窄，非串丢弃） |
| dom-snapshot | `src/serializer.ts` | `SerializeOptions.formControlState`（缺省 false）：select compound valuenow 填充；input 顶层 value=（password 掩码/截断）；checkbox/radio checked=。**缺省路径零字节漂移** |
| dom-snapshot | `src/index.ts` | 开关类型导出 |
| dom-snapshot 测试 | `test/serializer*.test.ts` 扩 | 开关关 = 现有输出不变；开关开 = select/input/checkbox 三类渲染断言（AX value 有/无/password/超长四象限） |
| core | `src/browser/session.ts` | 构造 options 增 `formControlState`（透传 buildDomState）；getState 不改签名 |
| core 测试 | session 系测试 | 配置透传断言（fake transport 层面即可，不重测 dom-snapshot） |
| node-host | `src/agent-boot.ts` | `assembleAgent` 构造 BrowserSession 时默认 `formControlState: true`（产品口径；env 覆盖键后续按需） |
| node-host 测试 | agent-boot 系 | 默认开断言 |
| 不动 | golden fixtures、extension、examples | 开关关回归零影响；dump 工具加开关 + 扩展宿主接线登记到 #5 后续段（SCRATCHPAD 跨 issue 依赖） |

## 3. 测试计划

| 层 | 用例 |
|---|---|
| collector | AX value（string/非 string/缺失）→ EnhancedAXNode.value 收窄正确 |
| serializer | 开关关：既有 golden/单测逐字节不变；开关开：select 渲染含 `current=Day`（AX value 在）、无 current（AX value 缺、降级缺席）；input `value=01/01/2022`、password 掩码、超长截断；checkbox `checked=true/false`；AX 源整体缺失 → 全部属性缺席不炸 |
| core session | 构造配置透传到 buildDomState（fake transport） |
| node-host | assembleAgent 默认开 |
| 真机验收（登记性） | dump 工具（#5 分支）+ 开关在 Bestsellers 页显示 value=Day/日期值；自进化循环 --fresh 重跑 task 1 记录 Period 决策变化 |

## 4. 实施进度

- [x] S1 dom-snapshot：types/collector/serializer + 单测（2026-10-24 完成；**实施期发现**：Step 5「表单当前值」/password 保护/白名单 value、checked/Step 8 截断**全部已存在**，唯一断链是数据源——Step 5 扫 properties 而 Chrome 把原生控件状态放 AX 顶层 value。实际改动：EnhancedAXNode 补可选 value（collector string 收窄）+ Step 5 正源分支（顶层优先，properties 回退保持）+ ~~开关穿线~~（后按用户裁定拆除，无条件渲染）。F4 之争消解——既有路径即顶层 value= 形态。dom-snapshot 173 用例全绿含 golden 逐字节（两页 fixture 基准重生成后对拍恢复））
- [x] S2 ~~core session 透传 + node-host 默认开~~（开关拆除后此步消解：session/agent-boot 的开关接线全部移除，恢复原签名；相关测试同步回退）
- [x] S3 真机验收（2026-10-24 完成：用户 Chrome 实跑两态对照——开态 `select … value=Day`、`input … value=1/1/22 / value=3/31/22`，与 a11y 视角逐字段一致、行数 87vs87 结构零变化；当时验证的是开关版，开关拆除后行为即该"开态"无条件生效。自进化循环 --fresh 登记性验收仍延期至两分支并 main 后）
- [ ] S4 全量门禁（绿）→ 提交（fixtures 重生成须注明原因）→ `/review-loop` → `/finish-issue`

## 5. 风险与已知项

- AX 与 DOM 采集时点：AX value 与 DOM 树同批 get_state 内采集，时点一致（无跨批漂移面）
- 自定义下拉（非原生 select）：AX combobox role 的 value 一般有效，验收时抽验 douyin 站；覆盖不到的走既有 compound options 兜底（不劣于现状）
- 合并顺序：#6 不碰扩展侧与 examples → 与 #5 分支零文件冲突，任意顺序合并
- Python 对齐：`EnhancedAXNode.value` 为 TS 先行扩展（缺省关不影响契约）；长期如需 Python 侧同步另议
- AOCI 认知维护：分支收尾时与 #5 一并评估（两分支各自收尾时点分别触发）

## 6. 变更记录

- 2026-10-24 计划初稿（issue #6 → 本计划；替换 #5 期 SCRATCHPAD 内容，其历史在 feat/issue-5-self-evolution 分支 bee0f46）
- 2026-10-24 S1 完成（含实施期重大发现：管线设计本就完整——Step 5/password/白名单/截断皆在，断链仅数据源一处；实际改动远小于计划，F4 消解）。S2 完成（session 构造期配置 + 公开只读面 + node-host 默认开）。全量门禁绿。S3 验收脚本 `_verify-form-state.mjs` 就绪待真机跑
- 2026-10-24 **用户裁定拆开关**（「这明显是一个 bug」）：无条件渲染，S2 的全部接线移除、测试回退；golden 2/4 红（Python 同 bug 未修）→ 选 B：两页 fixture output 由 TS 修复版重放原 input 重生成（外科手术式保留 input 原文/格式/dpr 浮点形态；selector_map 键序改数值升序），fixtures README 登记技术债（Python 同修后须重对齐）。S3 真机验收通过（value=Day/1/1/22 与 a11y 一致）。dom-snapshot 173 全绿 + 全仓门禁绿

## 7. 评审轮登记（/review-loop，base=main）

### 轮 1（2026-10-24，ocr 耗时 19m，3 条意见 high:1 medium:2 → 全采纳，驳回 0）

- **#1/#3（P1，同根采纳）**：Step 5 真值判断漏空态——collector 对空串透传（`""` 非 null），用户清空输入框后 AX 顶层 value 为 `""` → falsy 跳过正源分支 → Step 1 从 DOM `value` 属性种入的初始值无人清除，快照渲染陈旧旧值（全空白输入同理：外层 truthy 进分支、折叠为空后内层 `if (v)` 漏删）。修复：外层 `typeof node.axNode?.value === "string"` 显式收空串 + 内层折叠为空 `attrsToInclude.delete("value")`（`serializer.ts:320-332`）。新测试 2 条（空串/全空白清种子必红验证过；`value=null` 不清种子——降级语义「AX 无状态 ≠ AX 报空态」钉死）
- **#2（P2 采纳，夹具影响表述有误但契约主张实证成立）**：新字段经 `toJson` 的 `ax_node: {...spread}` 泄入投影——Python `models.py` `EnhancedAXNode` dataclass 无 `value` 字段、`__json__` 用 `asdict`（实测行号 592-613），TS 泄漏即超出唯一获准的 element_tree_text 偏离面（现有 fixture output 不含 ax_node 故潜伏不炸；SimplifiedNode.toJson 嵌套传播）。修复：投影前剔除该键（`types.ts:663-667`），字段注释补「仅限 Step 5 消费」。新测试 1 条（ax_node 投影无 value 键）
- 驳回 0 / stale 0；dom-snapshot 173→176 全绿（golden 逐字节不受影响——夹具页无「属性种子+AX 空态」组合，无需重生成）；全仓 typecheck+test+biome 绿

