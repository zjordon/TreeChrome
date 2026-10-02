# examples/file-system

从 [browser-use](https://github.com/browser-use/browser-use) 的 `examples/file_system/` 移植而来（经 TreeWalker），演示 TreeChrome 的**本地文件工具**（`read_file` / `write_file` / `replace_file`）与浏览器自动化结合使用。

## 与 browser-use 原版的关键差异

| 维度 | browser-use | TreeChrome |
|---|---|---|
| 文件层 | 内存 `FileSystem`，挂载到 `file_system_path` | 无内存层，直接写**真实文件**到绝对路径 |
| 写沙箱 | `file_system_path`（相对路径，虚拟根） | `allowed_write_paths` 白名单（前缀匹配，gate `write_file` / `replace_file`，**不** gate `read_file`） |
| 追加写 | 独立的 `append_file` 工具 | `write_file` 的 `append=true` 参数 |
| LLM | OpenAI（`ChatOpenAI`） | 智谱 GLM（`LLMClient` + `ZHIPU_API_KEY`） |
| 浏览器 | 内置 | 需 Chrome `--remote-debugging-port=9222`（`BrowserSession`） |

> 沙箱实现见 `packages/core/src/agent/settings.ts`（`AgentSettings.allowedWritePaths`）与 `packages/core/src/tools/actions/index.ts`（`Tools` 构造接线）；示例经 `runAgent({ overrides: { agent: { allowedWritePaths: [...] } } })` 传入。

## 示例

| 文件 | 场景 | 练习的工具 |
|---|---|---|
| `file-system.mjs` | 抓取博客标题 → 写文件 → 追加首句 → 读回校验 | `write_file`（write + append）/ `read_file` |
| `alphabet-earnings.mjs` | 打开 PDF → 取 3 个数据点 → 写文件 → 读回 | `write_file` / `read_file` |
| `excel-sheet.mjs` | 查股价 → 生成 CSV → 读回 | `write_file` / `read_file` |

每个示例会自建一个同级的 `*_workspace/` 目录作为写沙箱（`allowedWritePaths` 指向它）；运行结束**保留工作区供检查**（Python 版的按回车清理改为提示路径，方案 D1 登记偏离）。

## 前置条件

1. `pnpm install`
2. 启动 Chrome 远程调试：`chrome --remote-debugging-port=9222`
3. 设置 API Key：`$env:ZHIPU_API_KEY = "your_key"`（或写 cwd/.env）

## 运行

```powershell
node examples/file-system/file-system.mjs
node examples/file-system/alphabet-earnings.mjs
node examples/file-system/excel-sheet.mjs
```

> 注：`alphabet-earnings.mjs` 依赖 Chrome 内置 PDF 阅读器把 PDF 文本暴露给 DOM；若取不到文本，可改用 `extract` 工具或换一个 HTML 报告页。本目录示例仅为演示文件工具链路，不在 CI 中运行（依赖真实浏览器 + 网络 + API Key）。
