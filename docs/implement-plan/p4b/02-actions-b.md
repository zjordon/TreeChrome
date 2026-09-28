# 02 · 下拉族 + 上传族（重 session 侧）

> 参照：actions.py :1954-2347（两 handler）+ session.py :1745-1798/:4344-5014/:5036+
> （25 方法族 + 拦截）+ agent/upload_identity.py :105-285（纯 DOM 树分析）。capability：
> dropdown_options=READ / select_dropdown=CLICK / upload_file=UPLOAD（已冻结）。

## 1. dropdown_options（actions.py :1954-2013）

- index → backendNodeId 解析（element_id 别名同 batch1）→ `fetchDropdownOptions`
  分型：native `<select>`（fetch_select_options :4344-4381 + `_lazy_select_call` :4382-4428
  懒加载轮询）/ `role=combobox|listbox`（fetch_dropdown_options :4628-4665）/ custom
  dropdown（同 fetch_dropdown_options 的 JS 通道）。
- 渲染走 `_format_options_result` :1278-1308（逐字节锚定：值/标签/选中态/分组）。
- 失败链：分型不明 → `search_children_for_dropdowns` :4944-5014 向下搜（max_depth=4）。

## 2. select_dropdown（:2014-2146）

- native 单选 `set_select_option` :4429-4476 / 多选 `set_select_option_multi` :4477-4561
  （`<select multiple>` 全量一次提交）；custom `set_custom_dropdown_option` :4859-4897
  （点击触发器 → `_collapse_custom_dropdown` :4666-4680 收起残留 → `_find_option_object_id`
  :4898-4943 按值找 option 对象 → 点击 → `_custom_dropdown_still_open` :4681-… 轮询闭合断言）。
- role 型 `set_dropdown_option` :4562-4627。
- handler 侧：值解析（字符串/数组归一）、回读验证（选中态断言，失败 error 文案照搬）、
  `_describe_dropdown` :1255-1277 进 long_term_memory。
- **17 JS 常量**：下拉段内联的 JS 片段（选项枚举/点击模拟/闭合检测等）逐字节移植，
  venv dump 锚定。

## 3. upload_file（:2147-2347，最大 handler）

链路五段（照搬，含全部 error 文案）：

1. **入口守卫**：`file_path` 必填 + `_file_matches_accept` :79-113（accept 属性匹配：
   扩展名/MIME/通配三态）+ allowedUploadPaths 白名单。
2. **身份识别**：index/element_id 解析 file input → `upload_identity.py` 移植
   （`file_input_candidates` :105-130 / `upload_input_contexts` :131-167 /
   `build_upload_clue` :227-260 / `capture_upload_clue` :261-285——纯 EnhancedDOMTreeNode
   分析，单测友好）；`_find_upload_label_near` :302-404（标签近邻启发式，逐字节）。
3. **注入**：`set_file_input` :5036+（`DOM.setFileInputFiles`——**不点击 input**）；
   无 backendNodeId 时 `_probe_upload_signals` :1326-1350 + shadow DOM 兜底
   `find_file_inputs_in_shadow_dom` :5015-5029。
4. **验证**：`_verify_upload` :1351-1403（文件名回读 + `_describe_upload` :1224-1254 进
   memory——uploadClue 覆盖 interactedElement 投影的 `_semantic_clue` 槽位已在 4.4
   finalize 预留）。
5. **file-chooser 拦截消费**：`_enable_file_chooser_intercept` :1745-1770 +
   `_on_file_chooser_opened` :1771-1797 + `discover_file_input_via_click` :1798-…（点击后
   拦截器命中即转 setFileInputFiles——P4 browser 已移植拦截器本体，**本段接消费端**）。

## 4. 模块布局

- `browser/dropdown.ts`：25 方法族 + 17 JS 常量（一个文件 ~600 行软提醒内可控；超限拆
  `dropdown-js.ts` 常量文件）。
- `browser/upload.ts`：set_file_input / probe / shadow 兜底 / 拦截消费。
- `tools/actions/upload-identity.ts`：clue 构建纯函数（输入是序列化节点形态，不依赖
  CDP）。
- ToolsBrowser 扩面：`fetchDropdownOptions` / `setSelectOption` / `setSelectOptionMulti` /
  `setDropdownOption` / `setCustomDropdownOption` / `searchChildrenForDropdowns` /
  `setFileInput` / `probeUploadSignals`。

## 5. 测试矩阵

| 对象 | 覆盖要点 | 假件 |
|---|---|---|
| `_format_options_result` / `_describe_dropdown` / `_describe_upload` | 渲染逐字节（venv 锚定：native 分组/多选/无选项/custom 命中） | 纯函数 |
| `_file_matches_accept` | 扩展名/MIME/通配/`accept` 缺省四态 + 大小写 | 纯函数 |
| `_find_upload_label_near` | 近邻启发式边界（深度/遮挡/无标签） | 纯函数（节点树构造） |
| upload_identity 四函数 | candidates 排序 / contexts 过滤 / clue 字段全集 | 纯函数 |
| native select 单/多选集成 | setSelectOption 回读验证链 + 懒加载轮询（脚本化 delayed options） | FakeCdpTransport |
| custom dropdown 集成 | 触发→枚举→点击→闭合断言四段（JS 常量行为以 Fake JS 求值面模拟）+ 收起残留路径 | FakeCdpTransport |
| upload 集成 | accept 拒 / 白名单拒 / setFileInputFiles 帧捕获 / 验证失败（回读不匹配）/ chooser 拦截命中转注入 | FakeCdpTransport（emit Page.fileChooserOpened） |
| handler 参数守卫 | file_path 缺失 / index 与 element_id 双缺 | — |

## 6. 有意偏离清单

| # | 偏离 | 理由 |
|---|---|---|
| 1 | attachmentId 模式（架构 §5.2「用户在侧边栏亲手选文件，agent 只引用句柄」）**不落 P4b**——handler 只实现 path 直传 + setFileInputFiles；句柄注册面是 M5 扩展宿主侧 | 架构 §5.2 的 UPLOAD 语义完整形态依赖侧边栏 UI |
| 2 | 懒加载轮询间隔/上限照搬 `_lazy_select_call` 数值 | 保真（时序常量易被「优化」） |
| 3 | dropdown 17 JS 常量若与 browser-use 上游同源注释保留出处行号 | 溯源纪律（P4 JS 探针同款） |
