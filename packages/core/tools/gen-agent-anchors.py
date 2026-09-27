# -*- coding: utf-8 -*-
"""P4.4 锚点生成器：agent 层字节锚定面。

跑法（借用 evals 仓 venv，editable 装了 tree_walker）：
  D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe \
    packages/core/tools/gen-agent-anchors.py

产物：packages/core/test/fixtures/python-anchors/agent.json
- systemPrompt：batch1 十动作 / 全量 25 动作（upload/dropdown 条件段触发）/ decision 段
- stateMessage：全段触发的合成 BrowserStateSummary（含 grid/fileInputs/downloads/nudge 等）
  + blocks 版（含 image）
- agentHistory：滑窗历史描述（3 步窗口含省略行/✗/done/memory）+ 结果状态摘要
- loopDetector：normalize/action_hash/page 指纹 + 三档 nudge 文案样本
- streak：FailureStreak/ZeroResult 的 nudge 文案与 query_key 样本
- uncertainty：scan_uncertainty_markers 命中样本（含否定窗口/URL 剥离/词尾?）
- invalidFeedback：四形态澄清文案 + fallback done 输出
- taskMatcher：system/user prompt（格式化 catalog）/schema/三档注入头
- judge：system prompt/tool schema/两步 trace 序列化 + 组装 prompt
- budgetWorning/forceDone 两段常注入文案
"""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

OUT = Path(__file__).resolve().parents[1] / "test/fixtures/python-anchors/agent.json"

from tree_walker.prompts.system_prompt import (  # noqa: E402
    build_state_blocks,
    build_state_message,
    build_system_prompt,
)
from tree_walker.tools.models import ACTION_DEFINITIONS  # noqa: E402
from tree_walker.tools.registry import ActionRegistry  # noqa: E402
from tree_walker.agent.loop_detector import (  # noqa: E402
    ActionLoopDetector,
    FailureStreakTracker,
    ZeroResultStreakTracker,
    compute_action_hash,
)
from tree_walker.skills.task_matcher import (  # noqa: E402
    _MATCH_OUTPUT_SCHEMA,
    _MATCH_PROMPT_TEMPLATE,
    _MATCH_SYSTEM_PROMPT,
    build_task_skill_text,
)
from tree_walker.skills.task_loader import TaskCardMeta  # noqa: E402
from tree_walker.agent.judge import (  # noqa: E402
    JudgeEvaluator,
    JudgementResult,
    _JUDGE_SYSTEM_PROMPT,
    _JUDGE_TOOL_SCHEMA,
)
from tree_walker.agent.views import (  # noqa: E402
    ActionResult,
    AgentHistory,
    AgentHistoryList,
)
from tree_walker.agent.step import (  # noqa: E402
    _fallback_done_output,
    _invalid_action_feedback,
    scan_uncertainty_markers,
)

BATCH1 = [
    "navigate", "click", "input_text", "scroll", "extract",
    "wait", "go_back", "switch_tab", "send_keys", "done",
]


def registry_for(names):
    reg = ActionRegistry()
    for name in names:
        param_model, description, terminates = ACTION_DEFINITIONS[name]
        reg.action(name=name, description=description, param_model=param_model,
                   terminates=terminates)(lambda *a, **k: None)
    return reg


def main() -> None:
    data: dict = {}
    batch1_desc = registry_for(BATCH1).get_action_descriptions_text()
    all_desc = registry_for(list(ACTION_DEFINITIONS.keys())).get_action_descriptions_text()

    data["systemPrompt"] = {
        "batch1": build_system_prompt(batch1_desc, task="Count the orders", max_actions=5),
        "batch1MaxActions3": build_system_prompt(batch1_desc, task="T", max_actions=3),
        "all": build_system_prompt(all_desc, task="Upload a file", max_actions=5),
        "decision": build_system_prompt(batch1_desc, task="T", enable_decision_attribution=True),
    }

    # ── state message：合成 state（全段触发） ──
    dom = SimpleNamespace(
        element_tree_text="[1] button 'Go'\n[2] input 'Name'",
        selector_map={1: "x", 2: "y"},
        file_inputs_meta=[
            SimpleNamespace(backend_node_id=11, visible=True, upload_ancestor=True,
                            accept="image/*", class_name="cover-input"),
            SimpleNamespace(backend_node_id=12, visible=False, upload_ancestor=False,
                            accept="", class_name=""),
        ],
    )
    state = SimpleNamespace(
        url="https://shop.example/admin/orders",
        title="Orders",
        tabs=[
            SimpleNamespace(target_id="AAA1111", title="Orders", url="https://shop.example/admin/orders"),
            SimpleNamespace(target_id="BBB2222", title="Settings", url="https://shop.example/admin/settings"),
        ],
        recent_events=[SimpleNamespace(type="dialog", message="alert: hello")],
        dom_state=dom,
        grid_meta={
            "namespace": "sales_order_grid", "total_records": 123, "rows_loaded": 20,
            "page": 1, "page_size": 20, "sorting": {"field": "created_at", "direction": "desc"},
            "first_sorted_value": "2026-09-01", "active_filters": {"status": "complete"},
            "active_search": "WH12",
        },
    )
    kwargs = dict(
        task="Ship order #42",
        previous_result=[ActionResult(extracted_content="Clicked [BUTTON] 'Go' at index 1"),
                         ActionResult(error="Element 9 not found in DOM state")],
        previous_evaluation="Goal achieved",
        previous_memory="order id=42",
        previous_goal="Open orders grid",
        current_target_id="AAA1111",
        nudge_message="Heads up: you have repeated a similar action 5 times in the last 8 actions.",
        plan_description="[x] 0: open grid\n[>] 1: ship order",
        planning_nudge="Consider revising the plan.",
        download_notice="New files available: invoice.pdf",
        page_stats={"links": 30, "interactive": 12, "iframes": 1, "skeleton": False},
        sensitive_description="Available secrets (use as <secret>key</secret> in input_text params): password, token",
        skill_description="[SOP]\nopen the admin grid",
        task_skill_description="A recorded task matching your current goal was found (slug: ship-order).",
    )
    data["stateMessage"] = {
        "full": build_state_message(state, **kwargs),
        "minimal": build_state_message(
            SimpleNamespace(url="about:blank", title="", tabs=[], recent_events=[],
                            dom_state=None, grid_meta=None),
            task="T",
        ),
        # 同一 kwargs 下各可选段缺失的形态（段落开关分支）
        "noOptional": build_state_message(
            state, task="T",
            previous_result=None, previous_evaluation=None, previous_memory=None,
            previous_goal=None, current_target_id=None, nudge_message=None,
            plan_description=None, planning_nudge=None, download_notice=None,
            page_stats=None, grid_meta=None, sensitive_description=None,
            skill_description=None, task_skill_description=None,
        ),
        "blocks": build_state_blocks(state, screenshot_b64="aGVsbG8=", **kwargs),
    }

    # ── agent history 滑窗（借 __new__ 绕过 __init__ 构造最小 Agent） ──
    from tree_walker.agent.agent import Agent

    agent = Agent.__new__(Agent)
    agent._max_history_items = 3
    agent._compactor = None

    def hist(step, goal, eval_, memory, action_name, results):
        return AgentHistory(
            step_number=step,
            model_output={
                "evaluation_previous_goal": eval_,
                "memory": memory,
                "next_goal": goal,
                "action": {"name": action_name, "params": {"index": step}},
                "actions": [{"name": action_name, "params": {"index": step}}],
            },
            result=results,
        )

    agent.history = AgentHistoryList(history=[
        hist(1, "open site", "start", "first page", "navigate",
             [ActionResult(extracted_content="Navigated to https://x.example")]),
        hist(2, "find form", "ok", "form at [7]", "click",
             [ActionResult(error="timeout")]),
        hist(3, "fill", "ok", "", "input_text",
             [ActionResult(extracted_content="Typed 'a'")]),
        hist(4, "done", "ok", "all set", "done",
             [ActionResult(is_done=True, success=True, extracted_content="Task finished")]),
    ])
    data["agentHistory"] = {
        "window3": agent._build_agent_history_description(),
        "empty": (lambda a: (setattr(a, "history", AgentHistoryList()),
                             a._build_agent_history_description())[1])(Agent.__new__(Agent)
                                                                       if False else agent) if False else None,
        "summarize": {
            "ok": Agent._summarize_step_result([ActionResult(extracted_content="fine")]),
            "err": Agent._summarize_step_result([ActionResult(error="Element 1 not found in DOM state")]),
            "done": Agent._summarize_step_result([ActionResult(is_done=True, success=True)]),
            "empty": Agent._summarize_step_result([]),
        },
    }
    a_empty = Agent.__new__(Agent)
    a_empty._max_history_items = 10
    a_empty._compactor = None
    a_empty.history = AgentHistoryList()
    data["agentHistory"]["empty"] = a_empty._build_agent_history_description()  # None

    # ── loop detector ──
    det = ActionLoopDetector()
    for i in range(6):
        det.record_action("click", {"index": 7})
    det.record_page_state("https://x.example", "dom text", 5)
    det.record_page_state("https://x.example", "dom text", 5)
    det.record_page_state("https://x.example", "dom text", 5)
    det.record_page_state("https://x.example", "dom text", 5)
    det.record_page_state("https://x.example", "dom text", 5)
    data["loopDetector"] = {
        "hashes": {
            "click": compute_action_hash("click", {"index": 7}),
            "clickElem": compute_action_hash("click", {"element_id": 7}),
            "search": compute_action_hash("search", {"query": "Red Shoes, red shoes!", "engine": "baidu"}),
            "input": compute_action_hash("input_text", {"index": 3, "text": "  Hello World "}),
            "navigate": compute_action_hash("navigate", {"url": "https://x.com", "new_tab": True}),
            "scroll": compute_action_hash("scroll", {"direction": "up", "amount": 2}),
            "default": compute_action_hash("find_elements", {"selector": "a", "max_results": 5, "offset": None}),
        },
        "nudge5": ActionLoopDetector().get_nudge_message(),  # 空 → None
        "nudgeCombined": det.get_nudge_message(),
    }
    det12 = ActionLoopDetector()
    for _ in range(12):
        det12.record_action("click", {"index": 1})
    data["loopDetector"]["nudge12"] = det12.get_nudge_message()

    # ── streak trackers ──
    fs = FailureStreakTracker()
    for _ in range(3):
        fs.record("screenshot", True)
    data["failureStreak"] = {"peek3": fs.peek_nudge()}
    fs2 = FailureStreakTracker()
    for _ in range(4):
        fs2.record("click", True)
    data["failureStreak"]["peek4"] = fs2.peek_nudge()

    zr = ZeroResultStreakTracker()
    zr.record("read_grid", {"namespace": "ns", "search": "abc", "filters": {"b": 2, "a": 1}},
              ActionResult(extracted_content="none", metadata={"query_total": 0}))
    zr.record("read_grid", {"namespace": "ns", "search": "abc", "filters": {"b": 2, "a": 1}},
              ActionResult(extracted_content="none", metadata={"query_total": 0}))
    zr.record("find_elements", {"selector": ".x"},
              ActionResult(extracted_content="no", metadata={"query_total": 0}))
    data["zeroResult"] = {"peek": zr.peek_nudge()}

    # ── uncertainty markers ──
    data["uncertainty"] = {
        "tokenQ": scan_uncertainty_markers("Emma Davis=1? and (=2?) but (???) ok"),
        "keywords": scan_uncertainty_markers("some values unknown, one gap remains"),
        "negated": scan_uncertainty_markers("nothing missing, no gap remains, all verified"),
        "url": scan_uncertainty_markers("see https://x.example/a?b=1 and unknown state"),
        "notSure": scan_uncertainty_markers("No gap found, but not sure about totals"),
        "textOnly": scan_uncertainty_markers.__doc__ and scan_uncertainty_markers("Q: is the total $50?"),
    }
    from tree_walker.agent.step import _scan_uncertainty_keywords
    data["uncertainty"]["textKeywords"] = _scan_uncertainty_keywords("answer with Q? and unknown parts")

    # ── invalid action feedback / fallback done ──
    data["invalidFeedback"] = {
        "nonDict": _invalid_action_feedback("oops"),
        "noAction": _invalid_action_feedback({"memory": "m"}),
        "missingName": _invalid_action_feedback({"action": {"params": {"index": 5}}}),
        "emptyName": _invalid_action_feedback({"action": {"name": "  "}}),
        "fallbackDone": _fallback_done_output(),
    }

    # ── task matcher ──
    cards = [
        TaskCardMeta(slug="disable-product", description="Disable a product in admin",
                     keywords=("product", "disable"), distilled_at="2026-09-01"),
        TaskCardMeta(slug="orders-report", description="Generate the orders report"),
    ]
    catalog_text = "\n".join(c.catalog_line() for c in cards)
    data["taskMatcher"] = {
        "systemPrompt": _MATCH_SYSTEM_PROMPT,
        "userPrompt": _MATCH_PROMPT_TEMPLATE.format(task="Disable product XY-9", catalog=catalog_text),
        "schema": _MATCH_OUTPUT_SCHEMA,
        "catalogLines": [c.catalog_line() for c in cards],
        "headerSameTask": build_task_skill_text("ship-order", "Step 1: open grid\nStep 2: click ship"),
        "headerSameTemplate": build_task_skill_text(
            "ship-order", "CARD", match_kind="same_template"),
        "headerRead": build_task_skill_text("ship-order", "CARD", task_kind="read"),
        "headerEmptyCard": build_task_skill_text("ship-order", ""),
    }

    # ── judge ──
    data["judge"] = {"systemPrompt": _JUDGE_SYSTEM_PROMPT, "toolSchema": _JUDGE_TOOL_SCHEMA}
    judge = JudgeEvaluator(llm=None, settings=None)
    hist = AgentHistoryList(history=[
        AgentHistory(
            step_number=0,
            model_output={"next_goal": "open site",
                          "action": {"name": "navigate", "params": {"url": "https://x.example"}}},
            result=[ActionResult(extracted_content="Navigated to https://x.example")],
            state_summary={"url": "https://x.example", "title": "Home", "duration": 1.2},
        ),
        AgentHistory(
            step_number=1,
            model_output={"next_goal": "report count",
                          "action": {"name": "done", "params": {"text": "3 orders", "success": True}}},
            result=[ActionResult(is_done=True, success=True, extracted_content="3 orders")],
            state_summary={"url": "https://x.example", "title": "Home", "duration": 2.0,
                           "dom_excerpt": "[1] row 3 orders"},
        ),
    ])
    data["judge"]["serialized"] = judge._serialize_history(hist)
    data["judge"]["prompt"] = judge._build_judge_prompt("How many orders?", hist, "3 orders")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"written: {OUT}")


if __name__ == "__main__":
    sys.exit(main())
