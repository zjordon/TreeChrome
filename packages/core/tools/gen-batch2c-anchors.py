#!/usr/bin/env python3
"""gen-batch2c-anchors.py —— P4b 段 3（read_grid + evaluate 增强）锚点生成（p4b/03 §5）。

经 evals venv 实跑 Python 参考实现，产出 batch2c.json fixture：
- 4 个网格 JS 体（_TABLE_ROWS_CORE_JS / _LEGACY_GRID_READ_JS / _DOM_TABLE_READ_JS /
  BrowserSession._GRID_READ_JS）逐字节
- _parse_grid_number / _grid_footer_row_role 纯函数全分支
- _eval_long_term_memory / _extract_data_images
- evaluate / read_grid 两 handler 全输出（StubBrowser：ui_result/eval 队列可编程，
  通道降级链 / group_count / totals-check / 三类零行诊断 / 参数守卫全形态；
  大结果落盘走 tmp 目录并稳定化为 /ANCHOR_TMP）
用法：python gen-batch2c-anchors.py --out <dir>
"""

import argparse
import json
import os
import tempfile

from tree_walker.browser.session import BrowserSession
from tree_walker.config import TruncationSettings
from tree_walker.tools.actions import (
    _DOM_TABLE_READ_JS,
    _LEGACY_GRID_READ_JS,
    _TABLE_ROWS_CORE_JS,
    Tools,
    _eval_long_term_memory,
    _extract_data_images,
    _grid_footer_row_role,
    _parse_grid_number,
)


def ar(result):
    out = {}
    for k in ("extracted_content", "long_term_memory", "error"):
        out[k] = getattr(result, k, None)
    md = getattr(result, "metadata", None)
    if md:
        out["metadata"] = md
    return out


class StubBrowser:
    """read_ui_grid / evaluate 可编程 stub（_action_read_grid/_action_evaluate 消费面）"""

    def __init__(self, ui_result=None, eval_queue=None):
        self.ui_result = ui_result if ui_result is not None else {}
        self.eval_queue = list(eval_queue or [])
        self.ui_calls = []
        self.eval_calls = []

    async def read_ui_grid(self, payload, timeout_ms=None):
        self.ui_calls.append(payload)
        v = self.ui_result
        if isinstance(v, Exception):
            raise v
        return v

    async def evaluate(self, code, **kw):
        self.eval_calls.append((code, kw))
        v = self.eval_queue.pop(0) if self.eval_queue else ""
        if isinstance(v, Exception):
            raise v
        return v


def stabilize(obj, tmp):
    """tmp 路径 → /ANCHOR_TMP；时间戳 → _TS；分隔符归一为 /（段 1 同款纪律——
    仅作用于 save 节的输出串，JS 常量节不经此函数，反斜杠内容无腐蚀面）。"""
    if isinstance(obj, str):
        out = obj.replace(tmp, "/ANCHOR_TMP")
        import re

        out = re.sub(r"(evaluate|grid)_\d{10,}(?=\.txt|\.json)", r"\1_TS", out)
        return out.replace("\\", "/")
    if isinstance(obj, list):
        return [stabilize(x, tmp) for x in obj]
    if isinstance(obj, dict):
        return {k: stabilize(v, tmp) for k, v in obj.items()}
    return obj


async def main_async(args):
    tools = Tools()
    out = {}

    # ── JS 体 ──
    out["js"] = {
        "TABLE_ROWS_CORE_JS": _TABLE_ROWS_CORE_JS,
        "LEGACY_GRID_READ_JS": _LEGACY_GRID_READ_JS,
        "DOM_TABLE_READ_JS": _DOM_TABLE_READ_JS,
        "GRID_READ_JS": BrowserSession._GRID_READ_JS,
    }

    # ── 纯函数 ──
    out["parseGridNumber"] = {
        f"c{i}": _parse_grid_number(v)
        for i, v in enumerate([
            None, True, False, 42, 3.5, "42", " 42 ", "1,234", "1,234.5", "1,2345",
            "12,34", "1,234.5678", "$1,234.50", "€99", "45%", "50 %", "-42", "+42",
            "- $1,234.50", "1_000", "", "   ", "abc", "12.5.6", "NaN", "inf",
            "-inf", "1e3", "－5", "٣", "1,234 ", " 1,234 ", "$", "¥12,345.67",
            "12,345,678", "1,234,567", "0.005", "-0.5", "\t\r\n 42 \xa0",
        ])
    }
    out["footerRowRole"] = {
        f"c{i}": _grid_footer_row_role(f)
        for i, f in enumerate([
            {"": "Total", "amount": "150.00"},
            {"": "Grand Total"},
            {"": "总计"},
            {"": "合计"},
            {"": "totals"},
            {"": "Subtotal", "amount": "10"},
            {"": "小计"},
            {"": "Tax"},
            {"": "shipping"},
            {"": "Discount"},
            {"": "freight"},
            {"": "subtotal", "x": "total"},  # skip 优先
            {"": "Net"},
            {"amount": "150.00"},
            {},
            {"": "  TOTAL  "},
            {"": "Total Tax"},
        ])
    }
    out["evalLongTermMemory"] = {
        "short": _eval_long_term_memory("hello"),
        "boundary200": _eval_long_term_memory("x" * 200),
        "over201": _eval_long_term_memory("x" * 201),
        "number": _eval_long_term_memory("42"),
    }
    out["extractDataImages"] = {
        "mixed": _extract_data_images(
            'before data:image/png;base64,AAAA middle data:image/jpeg;base64,BBBB= after'
        ),
        "none": _extract_data_images("plain text"),
    }

    # ── evaluate handler ──
    E = {}

    async def ev(name, params, queue=None, trunc=None, call=None):
        b = StubBrowser(eval_queue=queue)
        t = Tools(truncation=trunc) if trunc else tools
        r = ar(await getattr(t, f"_action_{call or 'evaluate'}")(params, b))
        E[name] = {"out": r, "evalCalls": len(b.eval_calls)}

    await ev("missingCode", {})
    await ev("timeoutZero", {"code": "1", "timeout_ms": 0})
    await ev("timeoutOver", {"code": "1", "timeout_ms": 300001})
    await ev("timeoutOk", {"code": "1", "timeout_ms": 299999}, queue=["ok"])
    await ev(
        "argsUnserializable",
        {"code": "return 1", "args": {"s": {"x"}}},
    )
    await ev("elementsBadType", {"code": "return 1", "elements": ["a"]})
    await ev("elementsBadShape", {"code": "return 1", "elements": 5})
    await ev("raiseCdp", {"code": "return 1"}, queue=[RuntimeError("node detached")])
    await ev("short", {"code": "return document.title"}, queue=["My Page"])
    await ev("num", {"code": "return 42"}, queue=["42"])
    await ev("boundaryEcho", {"code": "return s"}, queue=["x" * 200])
    await ev("overEcho", {"code": "return s"}, queue=["x" * 201])
    await ev("nodeIdEcho", {"code": "return el"}, queue=["backendNodeId:55"])
    await ev(
        "extractImages",
        {"code": "return s", "extract_images": True},
        queue=["a data:image/png;base64,QUJD b"],
    )
    out["evaluate"] = E

    # ── read_grid handler ──
    G = {}

    async def rg(name, params, ui_result=None, queue=None):
        b = StubBrowser(ui_result=ui_result, eval_queue=queue)
        r = ar(await tools._action_read_grid(params, b))
        G[name] = {"out": r, "uiCalls": len(b.ui_calls), "evalCalls": len(b.eval_calls)}

    await rg("badNamespace", {"namespace": 5})
    await rg("badFilters", {"filters": [1]})
    await rg("badSearch", {"search": 5})
    await rg("badPageSize", {"page_size": "x"})
    await rg("badFields", {"fields": [1]})
    await rg("blankGroup", {"group_count": "  "})

    ch1 = {
        "channel": "uiregistry", "namespace": "sales_order_grid",
        "rows": [
            {"entity_id": "1", "status": "complete", "grand_total": "100.50"},
            {"entity_id": "2", "status": "pending", "grand_total": "49.50"},
        ],
        "rows_returned": 2, "total_records": 42,
        "applied": {"sorting": {"field": "entity_id", "direction": "asc"}},
        "active_before": {"filters": {"status": "pending"}, "search": "foo"},
        "partial": True,
    }
    await rg("ch1Success", {"namespace": "sales_order_grid"}, ui_result=ch1)
    await rg(
        "ch1SortingParse",
        {"namespace": "n", "sorting": "entity_id DESC", "page_size": "3000", "page": "0"},
        ui_result={"channel": "uiregistry", "rows": [], "rows_returned": 0, "total_records": 0},
    )
    legacy_ok = {
        "channel": "legacy_ajax",
        "rows": [{"ID": "1", "Status": "complete"}, {"ID": "2", "Status": "pending"}],
        "headers": ["ID", "Status"], "rows_returned": 2,
    }
    await rg(
        "ch2Legacy",
        {"namespace": "n", "filters": {"status": "x"}, "search": "y"},
        ui_result={"channel_error": "no-grid"},
        queue=[json.dumps(legacy_ok)],
    )
    dom_ok = {"channel": "dom_table", "rows": [{"Name": "A"}], "headers": ["Name"], "rows_returned": 1}
    await rg(
        "ch3Dom",
        {"namespace": "n"},
        ui_result={"channel_error": "no-requirejs"},
        queue=[json.dumps({"channel_error": "no-store"}), json.dumps(dom_ok)],
    )
    await rg(
        "allFail",
        {"namespace": "n"},
        ui_result={"channel_error": "no-grid"},
        queue=[json.dumps({"channel_error": "no-store"}), json.dumps({"channel_error": "no-table"})],
    )
    await rg(
        "ch2EvalRaise",
        {"namespace": "n"},
        ui_result={"channel_error": "no-grid"},
        queue=[RuntimeError("cdp boom"), json.dumps(dom_ok)],
    )
    await rg(
        "ch2Unparseable",
        {"namespace": "n"},
        ui_result={"channel_error": "no-grid"},
        queue=["not json {", json.dumps(dom_ok)],
    )

    gc_rows = [
        {"billing_name": "Emma Davis", "entity_id": "1"},
        {"billing_name": "Emma Davis", "entity_id": "2"},
        {"billing_name": "Bob Li", "entity_id": "3"},
        {"billing_name": "  ", "entity_id": "4"},
        {"entity_id": "5"},
    ]
    await rg(
        "groupCount",
        {"namespace": "n", "group_count": " billing_name "},
        ui_result={"channel": "uiregistry", "rows": gc_rows, "rows_returned": 5, "total_records": 40},
    )
    await rg(
        "groupCountMissing",
        {"namespace": "n", "group_count": "nope"},
        ui_result={"channel": "uiregistry", "rows": gc_rows, "rows_returned": 5, "total_records": 5},
    )
    await rg(
        "groupCountPageLocal",
        {"namespace": "n", "group_count": "billing_name"},
        ui_result={"channel": "dom_table", "rows": gc_rows, "rows_returned": 5},
    )

    await rg(
        "totalsMatch",
        {"namespace": "n"},
        ui_result={
            "channel": "dom_table",
            "rows": [
                {"Item": "A", "amount": "100.50"},
                {"Item": "B", "amount": "49.50"},
                {"Item": "C", "amount": ""},
            ],
            "rows_returned": 3,
            "footer": [{"label": "Total", "amount": "150.00"}],
        },
    )
    await rg(
        "totalsMismatch",
        {"namespace": "n"},
        ui_result={
            "channel": "dom_table",
            "rows": [{"Item": "A", "amount": "100.50"}, {"Item": "B", "amount": "49.50"}],
            "rows_returned": 2,
            "footer": [{"label": "Total", "amount": "999.00"}],
        },
    )
    await rg(
        "totalsSkipSubtotal",
        {"namespace": "n"},
        ui_result={
            "channel": "dom_table",
            "rows": [{"amount": "10.00"}],
            "rows_returned": 1,
            "footer": [{"label": "Subtotal", "amount": "555.00"}, {"label": "Total", "amount": "10.00"}],
        },
    )
    await rg(
        "totalsNonAdditive",
        {"namespace": "n"},
        ui_result={
            "channel": "dom_table",
            "rows": [{"Avg. Price": "5", "amount": "10"}],
            "rows_returned": 1,
            "footer": [{"label": "Total", "Avg. Price": "5", "amount": "10"}],
        },
    )
    await rg(
        "totalsSingleRowNoLabel",
        {"namespace": "n"},
        ui_result={
            "channel": "dom_table",
            "rows": [{"amount": "7.5"}],
            "rows_returned": 1,
            "footer": [{"amount": "7.5"}],
        },
    )
    await rg(
        "legacyTruncatedHint",
        {"namespace": "n", "page_size": 2},
        ui_result={"channel_error": "no-grid"},
        queue=[json.dumps({
            "channel": "legacy_ajax",
            "rows": [{"amount": "100.50"}, {"amount": "49.50"}],
            "rows_returned": 2,
            "footer": [{"label": "Total", "amount": "999.00"}],
        })],
    )
    await rg(
        "domZeroRowsWithFilters",
        {"namespace": "n", "filters": {"a": "b"}},
        ui_result={"channel_error": "no-grid"},
        queue=[json.dumps({"channel_error": "no-store"}), json.dumps({"channel": "dom_table", "rows": [], "headers": ["X"], "rows_returned": 0})],
    )
    await rg(
        "domZeroRowsPlain",
        {"namespace": "n"},
        ui_result={"channel_error": "no-grid"},
        queue=[json.dumps({"channel_error": "no-store"}), json.dumps({"channel": "dom_table", "rows": [], "headers": ["X"], "rows_returned": 0})],
    )
    await rg(
        "legacyAllEmptyRows",
        {"namespace": "n", "fields": ["a", "b"]},
        ui_result={"channel_error": "no-grid"},
        queue=[json.dumps({"channel": "legacy_ajax", "rows": [{}, {}], "headers": ["ID", "Status"], "rows_returned": 2})],
    )
    await rg(
        "uiregistryAllEmptyRows",
        {"namespace": "n", "fields": ["zz"]},
        ui_result={"channel": "uiregistry", "rows": [{}, {}], "rows_returned": 2, "total_records": 2},
    )
    await rg(
        "queryTotalUiregistry",
        {"namespace": "n", "filters": {"s": "x"}},
        ui_result={"channel": "uiregistry", "rows": [{}], "rows_returned": 1, "total_records": 7},
    )
    out["readGrid"] = G

    # ── 大结果落盘（tmp 稳定化）──
    tmp = tempfile.mkdtemp(prefix="ts_anchor_grid_")
    tr = TruncationSettings(
        eval_save_threshold=10, eval_output_dir=os.path.join(tmp, "out"),
        eval_result_max_chars=20,
    )
    tools_save = Tools(truncation=tr)
    S = {}
    b = StubBrowser(eval_queue=["A" * 30])
    S["evaluateSave"] = ar(await tools_save._action_evaluate({"code": "return s"}, b))
    grid_big = {"channel": "dom_table", "rows": [{"c": "v" * 5}] * 3, "rows_returned": 3}
    b2 = StubBrowser(eval_queue=[json.dumps({"channel_error": "no-store"}), json.dumps(grid_big)])
    S["gridSave"] = ar(
        await tools_save._action_read_grid(
            {"namespace": "n"}, StubBrowser(ui_result={"channel_error": "no-grid"}, eval_queue=b2.eval_queue)
        )
    )
    out["save"] = stabilize(S, tmp)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "batch2c.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"batch2c.json -> {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    import asyncio

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
