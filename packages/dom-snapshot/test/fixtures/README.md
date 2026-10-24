# Golden Fixtures

`*.json` 是 Python dom-snapshot 库生成的黄金基准，提交入库。每个文件：

```
meta     url / 生成时间 / 降级级别 / 来源状态
input    三源原始 CDP 响应：dom_tree (DOM.getDocument)、snapshot (captureSnapshot)、ax_tree (getFullAXTree)
output   Python 管线产物：element_tree_text（对拍目标，逐字节）、selector_map 投影、
         file_inputs_meta、page_stats
```

## 生成

```bash
D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe \
  packages/dom-snapshot/tools/gen_fixtures.py \
  --url "https://example.com" \
  --url "http://localhost:7780/admin/"   # WebArena 本地站，覆盖重交互页面
```

建议入库的页面梯度：静态简单页 / 重交互 SPA / 含 shadow DOM / 含 iframe / WebArena shopping_admin。

## 验收（两阶段）

1. **现在**：`test/golden.test.ts` 校验 fixture schema（生成器输出格式不漂移）。
2. **collector + serializer 移植完成后**：golden 测试用 `input` 喂 TS 管线，
   `output.element_tree_text` 必须逐字节一致；`selector_map` 的键集合与投影字段全等。

> 重新生成会使基准随 Chrome 版本/页面变化漂移——仅在刻意更新基准时重抓，并在提交信息里注明原因。

## 基准变更登记（issue #6，2026-10-24）

`basic-html` 与 `iframe-html` 两页的 `output` 由 **TS 修复版管线重放原 input** 重新生成
（外科手术式：input 原文与格式逐字节保留，仅换 output 块与 meta.generated_at）。原因：
serializer Step 5「表单当前值」数据源 bug 修复——原生 select/input 的当前值经 AX 顶层
`value` 渲染为 `value=`（此前只扫 properties 故恒落空）。**Python 库存在同一 bug 未修**
（用户裁定暂不动 Python，选 B）：在 Python 侧同修并重生成前，这两页基准以 TS 修复版
为准；其余两页（interactive/shadow-dom）仍为 Python 原产物（内容本就一致）。
