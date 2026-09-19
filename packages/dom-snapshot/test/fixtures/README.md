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
