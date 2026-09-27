# -*- coding: utf-8 -*-
"""P4.3 锚点生成器：tools 层（models/registry/extract_markdown）Python 实跑参考值。

跑法（借用 evals 仓 venv，editable 装了 tree_walker）：
  D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe \
    packages/core/tools/gen-tools-anchors.py

产物：packages/core/test/fixtures/python-anchors/tools.json
- actions：25 个动作的四元组（className/description/terminates）+ model_json_schema()
- batch1：batch1 十动作注册下的 registryVersion / get_tool_schema 矩阵 / 描述文本
- structuredDone：make_structured_done_params(样例模型) 的 schema
- validate：pydantic 校验错误文案样例（step 梯 `"; ".join(f"{loc}: {msg}")` 格式）
- chunk：chunk_markdown_by_structure 分块边界对拍样例
- cleanMarkdown：extract_clean_markdown 参考快照（TS 侧不锚字节，仅对照）
"""

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "test/fixtures/python-anchors/tools.json"

from tree_walker.tools.models import ACTION_DEFINITIONS, make_structured_done_params  # noqa: E402
from tree_walker.tools.registry import ActionRegistry  # noqa: E402
from tree_walker.tools.extract_markdown import (  # noqa: E402
    chunk_markdown_by_structure,
    extract_clean_markdown,
)

BATCH1 = [
    "navigate", "click", "input_text", "scroll", "extract",
    "wait", "go_back", "switch_tab", "send_keys", "done",
]


def main() -> None:
    data: dict = {}

    # ── 1. 全量 25 动作：四元组 + schema ──
    actions = {}
    for name, (param_model, description, terminates) in ACTION_DEFINITIONS.items():
        actions[name] = {
            "className": param_model.__name__,
            "description": description,
            "terminates": terminates,
            "schema": param_model.model_json_schema(),
        }
    data["actions"] = actions

    # ── 2. batch1 注册面：version / tool schema 矩阵 / 描述文本 ──
    registry = ActionRegistry()
    for name in BATCH1:
        param_model, description, terminates = ACTION_DEFINITIONS[name]
        registry.action(
            name=name, description=description, param_model=param_model,
            terminates=terminates,
        )(lambda *a, **k: None)

    data["batch1"] = {
        "names": BATCH1,
        "registryVersion": registry.registry_version,
        "toolSchema": {
            "flash-single": registry.get_tool_schema(output_mode="flash"),
            "flash-multi": registry.get_tool_schema(output_mode="flash", max_actions=3),
            "standard-single": registry.get_tool_schema(output_mode="standard"),
            "standard-multi": registry.get_tool_schema(output_mode="standard", max_actions=3),
            "thinking-single": registry.get_tool_schema(output_mode="thinking"),
            "thinking-single-planning": registry.get_tool_schema(
                output_mode="thinking", enable_planning=True),
            "standard-multi-planning": registry.get_tool_schema(
                output_mode="standard", max_actions=3, enable_planning=True),
        },
        "descriptionsText": registry.get_action_descriptions_text(),
    }

    # page_patterns 可见性（fnmatch，Windows normcase 小写化——本机即 Windows 语义）
    registry.actions["extract"].page_patterns = ["https://example.com/*"]
    data["batch1"]["pageFiltered"] = {
        "descriptionsText": registry.get_action_descriptions_text("https://example.com/x"),
        "descriptionsTextOther": registry.get_action_descriptions_text("https://other.org/x"),
        "schemaNames": registry.get_tool_schema(
            page_url="https://example.com/x")["input_schema"]["properties"]["action"]
            ["properties"]["name"]["enum"],
        "schemaNamesOther": registry.get_tool_schema(
            page_url="https://other.org/x")["input_schema"]["properties"]["action"]
            ["properties"]["name"]["enum"],
    }

    # ── 3. 变体 B done：结构化输出参数模型 ──
    from pydantic import BaseModel, ConfigDict

    class SampleOutput(BaseModel):
        model_config = ConfigDict(extra="forbid")

        total: int
        note: str = ""

    structured = make_structured_done_params(SampleOutput)
    data["structuredDone"] = {
        "className": structured.__name__,
        "schema": structured.model_json_schema(),
    }
    reg_b = ActionRegistry(output_model=SampleOutput)
    for name in ("done", "navigate"):
        param_model, description, terminates = ACTION_DEFINITIONS[name]
        if name == "done":
            param_model = make_structured_done_params(SampleOutput)
        reg_b.action(name=name, description=description, param_model=param_model,
                     terminates=terminates)(lambda *a, **k: None)
    data["structuredDone"]["descriptionsText"] = reg_b.get_action_descriptions_text()

    # ── 4. 校验错误文案样例（step._validate_action_params 同款拼接） ──
    def validate_error(model_cls, raw):
        from pydantic import ValidationError
        try:
            model_cls.model_validate(raw)
            return None
        except ValidationError as e:
            parts = []
            for err in e.errors():
                field = ".".join(str(loc) for loc in err["loc"])
                parts.append(f"{field}: {err['msg']}")
            return "; ".join(parts)

    cases = {
        "click-both-missing": (ACTION_DEFINITIONS["click"][0], {}),
        "click-both-given": (ACTION_DEFINITIONS["click"][0],
                             {"index": 1, "element_id": 2}),
        "click-extra-field": (ACTION_DEFINITIONS["click"][0],
                              {"index": 1, "foo": "bar"}),
        "click-index-string": (ACTION_DEFINITIONS["click"][0], {"index": "abc"}),
        "click-index-numeric-string": (ACTION_DEFINITIONS["click"][0], {"index": "12"}),
        "navigate-missing-url": (ACTION_DEFINITIONS["navigate"][0], {}),
        "navigate-newtab-string": (ACTION_DEFINITIONS["navigate"][0],
                                    {"url": "x.com", "new_tab": "true"}),
        "navigate-url-int": (ACTION_DEFINITIONS["navigate"][0], {"url": 42}),
        "scroll-amount-low": (ACTION_DEFINITIONS["scroll"][0], {"amount": 0}),
        "scroll-amount-high": (ACTION_DEFINITIONS["scroll"][0], {"amount": 11}),
        "scroll-amount-string": (ACTION_DEFINITIONS["scroll"][0], {"amount": "3"}),
        "scroll-direction-bad": (ACTION_DEFINITIONS["scroll"][0], {"direction": "left"}),
        "extract-already-collected-dedupe": (ACTION_DEFINITIONS["extract"][0],
                                             {"query": "q", "already_collected": ["", " a ", "b"]}),
        "sendkeys-empty": (ACTION_DEFINITIONS["send_keys"][0], {"keys": ""}),
        "switchtab-empty": (ACTION_DEFINITIONS["switch_tab"][0], {"tab_id": ""}),
        "wait-range": (ACTION_DEFINITIONS["wait"][0], {"seconds": 31}),
        "dropdown-xor": (ACTION_DEFINITIONS["select_dropdown"][0],
                         {"index": 1, "value": "a", "values": ["a"]}),
        "dropdown-values-bad": (ACTION_DEFINITIONS["select_dropdown"][0],
                                {"index": 1, "values": []}),
        "done-missing-text": (ACTION_DEFINITIONS["done"][0], {}),
        "screenshot-quality-range": (ACTION_DEFINITIONS["screenshot"][0], {"quality": 101}),
        "screenshot-clip-nested": (ACTION_DEFINITIONS["screenshot"][0],
                                   {"clip": {"x": 0, "y": 0, "width": -1, "height": 10}}),
        "evaluate-timeout-range": (ACTION_DEFINITIONS["evaluate"][0],
                                   {"code": "return 1", "timeout_ms": 0}),
        "find-elements-max-range": (ACTION_DEFINITIONS["find_elements"][0],
                                    {"selector": "a", "max_results": 500}),
    }
    data["validate"] = {
        key: {"error": validate_error(model, raw), "input": raw}
        for key, (model, raw) in cases.items()
    }

    # ── 5. chunk 分块对拍 ──
    table_md = (
        "# Title\n\nintro paragraph here\n\n"
        + "| h1 | h2 |\n| --- | --- |\n"
        + "".join(f"| r{i}a | r{i}b |\n" for i in range(20))
        + "\ntail text after table\n"
    )
    one_line = "x" * 300
    island = "short head\n\n" + "".join(f"line {i} with some text\n" for i in range(60))
    multi_table = (
        "| a | b |\n| --- | --- |\n| 1 | 2 |\n\npara\n\n"
        + "| c | d |\n| --- | --- |\n| 3 | 4 |\n"
    )
    chunk_samples = {
        "small": ("hello world", 50),
        "empty": ("", 50),
        "table": (table_md, 120),
        "hard-split-line": (one_line, 100),
        "island": (island, 200),
        "multi-table": (multi_table, 40),
    }
    data["chunk"] = [
        {
            "name": name,
            "input": md,
            "maxChars": mc,
            "output": [
                {"content": c.content, "start": c.start_index, "end": c.end_index}
                for c in chunk_markdown_by_structure(md, max_chars=mc)
            ],
        }
        for name, (md, mc) in chunk_samples.items()
    ]

    # ── 6. clean markdown 参考快照（不锚字节） ──
    html_samples = {
        "basic": "<html><body><h1>T</h1><p>Hello <b>world</b></p></body></html>",
        "links": '<p>See <a href="/x">docs</a> and <a href="/y">more</a></p>',
        "strip-nav": '<body><nav><a href="/m">menu</a></nav><main><p>content</p></main></body>',
        "image": '<p>pic</p><img src="/i.png" alt="i">',
    }
    data["cleanMarkdown"] = [
        {
            "name": name,
            "html": html,
            "links": links,
            "images": images,
            "out": extract_clean_markdown(html, extract_links=links, extract_images=images),
        }
        for name, html in html_samples.items()
        for links, images in ((True, True), (False, False))
    ]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"written: {OUT}")
    print(f"actions={len(actions)} batch1={len(BATCH1)}")


if __name__ == "__main__":
    sys.exit(main())
