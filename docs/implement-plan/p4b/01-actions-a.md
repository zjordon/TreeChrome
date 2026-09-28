# 01 · 轻族十动作：search / find 族 / 截图导出 / tab / 文件族

> 参照：actions.py 各 handler + session.py search/find 段。handler 形态=batch1 工厂
> 模式（`tools/actions/*.ts` 一族一文件，收 ToolsContext 闭包）；必填参数 typeof 守卫
> 与 batch1 同款（P4 tools 评审轮 1 #1 的泛化面）。

## 1. 动作清单与行为契约

| 动作 | handler（Python 行号） | 行为要点 | session 侧 |
|---|---|---|---|
| search | :1530-1540 | 引擎 URL 模板直导航（`_SEARCH_ENGINE_URLS` :360-365 四引擎 + `&udm=14` 照搬）+ quote_plus 编码；terminatesSequence（已冻结） | 复用 navigate |
| find_elements | :1769-1837 | CSS 选择器查询（max_results 截断 + 总数恒上报 + 属性绝对化 src/href）；`return_node_ids=True` 变体返回 backendNodeId 列表（find_elements_node_ids）；渲染走 `_format_find_results` :187-237 / `_format_node_id_results` :238-268（逐字节锚定） | `findElements` :4239-4277 / `findElementsNodeIds` :4278-4343（JS 查询体 `_FIND_ELEMENTS_JS_BODY` :286+） |
| find_text | :1838-1892 | 滚动到并高亮第 n 个可见匹配（index 从 1；0/越界给可操作 error）；Case-insensitive 缺省 | `findText` :3941-4032（CDP `DOM.performSearch` 主路径 + `_find_text_js_fallback` :4033-4068 + `_highlight_search_node` :4069-4102 + `_select_text_via_window_find` :4103-4191） |
| search_page | :3140-3201 | 页内结构化搜索（正则/大小写/匹配数上限），返回匹配上下文列表 | `searchPage` :4192-4238（`_SEARCH_PAGE_JS_BODY` :105-279——browser-use service.py:181-255 镜像，JS 体逐字节锚定） |
| screenshot | :1893-1923 | takeScreenshot（batch1 已有）+ format/quality/clip/fullPage 参数透传 + save_path 白名单落盘（fs.writeBytes）+ base64 提示 | `takeScreenshot` 已就位（screenshot.ts 护栏超时文案已锚定） |
| save_as_pdf | :1924-1953 | printToPdf（已移植）参数透传 + save_path 白名单落盘 + 字节数回报 | `printToPdf` 已就位 |
| close_tab | :1682-1722 | tab_id 后缀匹配 + **撞车检测**（多匹配要求更长后缀）+ 未命中列出全部 open tabs（`_summarize_tabs` :1673-1681）；空 tab_id=当前 tab；关闭后摘要回显 | `closeTab` 已就位（tabs.ts）；补 ToolsBrowser 委托 |
| write_file | :2348-2412 | 白名单（前缀匹配，None=全放行，置于 makedirs/open 前 fail fast）→ newline 簿记（leading/trailing 守卫式幂等，不破坏 CRLF）→ **append 直写（O(1) 非原子）与 overwrite tmp+rename（原子）分叉照搬**；encoding 非法名（LookupError 类）单独兜底 + tmp 残骸清理；memory 文案 `Wrote/Appended N bytes to path` | fs |
| read_file | :2413-2465 | 读白名单 → `_sniff_file_kind` :114-144（magic 头优先 12 字节：PNG/JPEG/GIF/RIFF+WEBP/%PDF-/PK+扩展名/ELF/MZ/gzip 家族）→ text 走窗口；pdf/docx/image 走 `_read_rich_document` :2528-2582 **降级形态**（见偏离 1） | fs |
| replace_file | :2583-2729 | old 非空运行时守卫（防 str.replace("",x) 逐字符膨胀）→ regex/case_sensitive/count/expected_count/backup 参数全量 → 读侧 UnicodeDecodeError 单独兜底 → tmp+rename 原子写回 → 回显 `Replaced N (of M) occurrence(s) of ... (B bytes)`（pyRepr 引号形态照搬） | fs |

## 2. FileSystemProvider 增量（tools/fs.ts）

```ts
/** P4b 增两成员（既有六成员不动） */
stat(path: string): Promise<{ size: number } | null>;   // 总字节（window_and_echo 计量）
readHead(path: string, n: number): Promise<Uint8Array | null>; // magic 头嗅探（12 字节）
```

- 内存实现进 test 公共假件；未注入（null）时文件三动作的降级文案与 batch1 大结果落盘
  同款（error 通道明确提示宿主注入）。
- 白名单匹配：`path.startsWith(p)` 逐前缀（Python :2418-2420 同款），大小写敏感。

## 3. ToolsBrowser 扩面（tools/types.ts）

新增委托：`closeTab(targetId)` / `printToPdf(options)` / `takeScreenshotBytes(options)`
（截图返回 Uint8Array——batch1 的截图经 getState，此处动作面要原始字节）/ `findText(text,
index, opts)` / `findElements(selector, opts)` / `findElementsNodeIds(selector, max)` /
`searchPage(payload)`。BrowserSession 侧按 Python 公开签名实现；Fake 走 FakeCdpTransport
脚本化。

## 4. session 侧新模块（browser/）

- `search-find.ts`：`_FIND_ELEMENTS_JS_BODY` / `_SEARCH_PAGE_JS_BODY` 两个 JS 常量体
  （逐字节，经 venv dump 锚定）+ findElements / findElementsNodeIds / findText（performSearch
  主路径 + JS fallback + window.find 选区三段）/ searchPage 四方法。Python :105-279（JS 体）
  + :3941-4343（方法族）。

## 5. 测试矩阵

| 对象 | 覆盖要点 | 假件 |
|---|---|---|
| 三个 formatter | `_format_search_results` / `_format_find_results` / `_format_node_id_results` 输出逐字节（venv 锚定 fixture：空结果/截断/node_id 变体） | 纯函数 |
| `_sniffFileKind` | 全 magic 分支（PNG/JPEG/GIF/WEBP/AVI/PDF/docx-zip/普通 zip/ELF/MZ/gz/bz2/rar/7z/text）+ 扩展名兜底（PK+.docx） | 纯函数（字节面） |
| `_windowAndEcho` | offset/limit 分页、total_bytes utf-8 计量（CJK）、空文件 | 纯函数 |
| `_literalReplacer` | 多 literal 计数/重叠顺序/dry_run diff 形态 | 纯函数 |
| find_elements/search_page/find_text 集成 | Fake 脚本化：查询→渲染；index 越界 error 文案；performSearch 空结果 fallback 路径 | FakeCdpTransport |
| 文件三动作 | 白名单拒/放行四态（None/命中/未命中/空数组）、append、dry_run、嗅探路由（pdf→降级文案、image→提示文案逐字节） | 内存 fs 假件 |
| screenshot/save_as_pdf/close_tab | 参数透传断言（Fake 捕获 CDP 帧）、save_path 白名单、base64 提示、关最后 tab 分支 | FakeCdpTransport |

## 6. 有意偏离清单

| # | 偏离 | 理由 |
|---|---|---|
| 1 | `_read_rich_document` 只落**降级形态**：image 给 Python 同款提示文案（:2546-2553 逐字节）；pdf/docx 给「宿主未注入解析器」可操作 error（**不逐字节**照搬 pip install 提示——TS 无 extras 概念），`FileSystemProvider` 留可选 `parseRichDocument` hook（M5 宿主接 pdf/docx 库） | 核心包不背 pypdf/python-docx 等重依赖；Python 无 `[docs]` extra 时同样是降级文案——行为等价面保真 |
| 2 | `_SEARCH_ENGINE_URLS` 与 `&udm=14` 原样照搬不校验时效 | 保真优先；引擎形态变更是上游关注点 |
| 3 | write_file 临时文件+rename 的原子性语义：Python `os.replace`，TS 经 fs 注入接口无 rename——直写 + 注释登记（宿主实现自行决定原子性） | FileSystemProvider 最小接口不扩 rename |
