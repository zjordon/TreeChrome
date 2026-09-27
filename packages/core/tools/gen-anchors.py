# -*- coding: utf-8 -*-
"""P4 Python 锚定值生成（入库工具，对齐 dom-snapshot tools/gen_fixtures.py 惯例；命令见 test/agent/*.test.ts 头注）。

经 evals venv 实跑 TreeWalker @640d52a 的 action_shape / agent.views，把期望值落
packages/core/test/fixtures/python-anchors/{action-shape,views}.json。
"""
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent / "test/fixtures/python-anchors"
OUT.mkdir(parents=True, exist_ok=True)

from tree_walker.action_shape import (  # noqa: E402
    actions_of,
    describe_action_entry,
    name_of,
    normalize_model_output,
    params_of,
)
from tree_walker.agent.views import (  # noqa: E402
    ActionResult,
    AgentHistory,
    AgentHistoryList,
    redact_sensitive_string,
)


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=False)


# ---------- action-shape ----------
shape_cases = []
def case(mo, ctx="live", known=None):
    work = json.loads(json.dumps(mo))  # 深拷贝隔离
    normalize_model_output(work, context=ctx, known_names=known)
    shape_cases.append({"input": mo, "context": ctx, "known": known, "output": work})

# live：裸字符串 coercion
case({"actions": [" click "]})
# live：单元素非字符串 → 诚实失败 done
case({"actions": [None]})
case({"actions": [123]})
# live：多元素畸形条目原样保留
case({"actions": ["ok", 42]})
case({"actions": [True, {"name": "click"}]})
# live：name 无效（null/空串/非字符串）
case({"actions": [{"name": None, "params": "x"}]})
case({"actions": [{"name": ""}, {"name": "click"}]})
case({"actions": [{"name": 7, "params": None}, {"name": "wait"}]})
# live：params 畸形（字符串/数字/null/缺失）
case({"actions": [{"name": "click", "params": "bad"}]})
case({"actions": [{"name": "click", "params": 5}]})
case({"actions": [{"name": "click", "params": None}]})
case({"action": {"name": "go_back"}})  # 单动作形态物化
# live + known_names：未注册移除 / 响应字段名 / 丢光保留
case({"actions": [{"name": "click"}, {"name": "ghost"}]}, known=["click", "done"])
case({"actions": [{"name": "plan_update"}, {"name": "click"}]}, known=["click"])
case({"actions": [{"name": "ghost"}]}, known=["click"])
# history：非列表容器物化（字符串 action 包装）、畸形条目原样保留
case({"actions": "click"}, ctx="history")
case({"actions": {"name": "click"}}, ctx="history")
case({"action": " done "}, ctx="history")
case({"actions": [42, {"name": "click", "params": "x"}]}, ctx="history")
case({"actions": [{"name": None}]}, ctx="history")
# falsy 容器 → [{}]
case({"actions": []})
case({"actions": None, "action": None})
case({})
# 纯空白字符串（strip 后空 → 不 coercion）
case({"actions": ["   "]})
case({"actions": ["   ", {"name": "click"}]})

# 访问器电池
accessors = {
    "name_of": [
        {"action": {"params": {}}},
        {"action": {"name": None}},
        {"action": {"name": ""}},
        {"action": {"name": 9}},
        {"action": " click "},
        {"action": "  "},
        {"action": 42},
    ],
    "params_of": [
        {"action": {"name": "click"}},
        {"action": {"name": "click", "params": "x"}},
        {"action": {"name": "click", "params": {"index": 1}}},
        {"action": "click"},
    ],
    "actions_of": [
        {"mo": {"actions": [{"name": "a"}, {"name": "b"}]}},
        {"mo": {"actions": [], "action": {"name": "a"}}},
        {"mo": {"action": "done"}},
        {"mo": {}},
        {"mo": None},
    ],
    "describe_action_entry": [
        {"entry": {"name": "click"}},
        {"entry": {"name": None, "params": {}}},
        {"entry": {"params": {"x": 1}}},
        {"entry": {}},
        {"entry": "click"},
        {"entry": 123},
        {"entry": None},
        {"entry": True},
        {"entry": 1.5},
    ],
}
accessor_out = {
    "name_of": [name_of(c["action"]) for c in accessors["name_of"]],
    "params_of": [params_of(c["action"]) for c in accessors["params_of"]],
    "actions_of": [actions_of(c["mo"]) for c in accessors["actions_of"]],
    "describe_action_entry": [
        describe_action_entry(c["entry"]) for c in accessors["describe_action_entry"]
    ],
}
(OUT / "action-shape.json").write_text(
    json.dumps({"normalize": shape_cases, "accessors": {"inputs": accessors, "expected": accessor_out}},
               ensure_ascii=False, indent=2),
    encoding="utf-8",
)
print(f"action-shape.json: {len(shape_cases)} normalize cases + accessors")


# ---------- views ----------
renders = []
def render_case(**kwargs):
    renders.append({"input": kwargs, "expected": str(ActionResult(**kwargs))})

render_case()
render_case(error="boom")
render_case(extracted_content="hello world")
render_case(is_done=True)
render_case(is_done=True, success=True)
render_case(is_done=True, success=False)
render_case(is_done=True, success=None)
render_case(error="e", extracted_content="x", is_done=True, success=True)
long = "A" * 501 + "B" * 10
render_case(extracted_content=long)
render_case(extracted_content="A" * 500)
render_case(is_done=False, success=None, long_term_memory="m", metadata={"q": 1})

redact_cases = [
    {"value": "login password123 ok", "map": {"a": "password123", "b": "password"}, "key_order": "len-desc"},
    {"value": "no secrets here", "map": {"a": "zzz"}, "note": "no match"},
    {"value": "", "map": {"a": "x"}},
    {"value": "k1 and k1", "map": {"k1": "k1"}},  # 全量替换（非首次）
]

# AgentHistory 构造收口：畸形归一化 + 不腐蚀入参
hist_mo = {
    "evaluation_previous_goal": "ok",
    "actions": [42, {"name": "click", "params": "bad"}, " bare "],
}
hist_before = json.loads(json.dumps(hist_mo))
h = AgentHistory(step_number=1, model_output=hist_mo, result=[ActionResult()])
history_case = {
    "input_model_output": hist_before,
    "input_after_construction": hist_mo,  # 必须与 before 全等（拷贝归一化）
    "constructed_model_output": json.loads(json.dumps(h.model_output)),
}

# AgentHistoryList 判定电池
def mk_hist(step, results):
    return AgentHistory(
        step_number=step,
        model_output={"actions": [{"name": "done"}]},
        result=[ActionResult(**r) for r in results],
    )

hl = AgentHistoryList(history=[
    mk_hist(1, [{"extracted_content": "partial"}]),
    mk_hist(2, [{"is_done": True, "extracted_content": "final answer", "success": True}]),
])
hl_fail = AgentHistoryList(history=[
    mk_hist(1, [{"is_done": True, "extracted_content": "gave up", "success": False}]),
])
hl_open = AgentHistoryList(history=[mk_hist(1, [{"extracted_content": "still working"}])])
list_case = {
    "final_result": hl.final_result(),
    "is_done": hl.is_done(),
    "is_successful": hl.is_successful(),
    "fail_final_result": hl_fail.final_result(),
    "fail_is_done": hl_fail.is_done(),
    "fail_is_successful": hl_fail.is_successful(),
    "open_final_result": hl_open.final_result(),
    "open_is_done": hl_open.is_done(),
    "empty_is_done": AgentHistoryList().is_done(),
}

# 构造校验失败样例（success⇒is_done）
validator_case = None
try:
    ActionResult(success=True)
except Exception as e:  # pydantic ValidationError
    validator_case = str(e).splitlines()[1].strip() if str(e).count("\n") > 1 else str(e)

(OUT / "views.json").write_text(
    json.dumps({
        "renders": renders,
        "redact": [
            {"value": c["value"], "map": c["map"],
             "expected": redact_sensitive_string(c["value"], c["map"])}
            for c in redact_cases
        ],
        "history_normalization": history_case,
        "history_list": list_case,
        "action_result_validator_first_line": validator_case,
    }, ensure_ascii=False, indent=2),
    encoding="utf-8",
)
print(f"views.json: {len(renders)} renders + redact/history/list cases")
