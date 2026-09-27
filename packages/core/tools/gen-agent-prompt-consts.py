# -*- coding: utf-8 -*-
"""P4.4 字节锚定 prompt 常量的再生成器（产物 src/agent/prompt-consts.ts 已入库，
仅刻意更新基准时重跑）：
  D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe \
    packages/core/tools/gen-agent-prompt-consts.py
"""
import json
from pathlib import Path

from tree_walker.prompts.system_prompt import SYSTEM_PROMPT, FILE_UPLOAD_RULES, DROPDOWN_RULES
from tree_walker.observability.decision_prompt import get_decision_attribution_prompt
from tree_walker.skills.task_matcher import (
    _MATCH_PROMPT_TEMPLATE,
    _MATCH_SYSTEM_PROMPT,
    _TASK_SKILL_HEADER_SAME_TASK,
    _TASK_SKILL_HEADER_SAME_TEMPLATE,
    _TASK_SKILL_READ_APPENDIX,
)
from tree_walker.agent.judge import _JUDGE_SYSTEM_PROMPT, _JUDGE_TOOL_SCHEMA


def lit(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def main() -> None:
    out: list[str] = []
    out.append("// 字节锚定常量（由 tools/gen-agent-prompt-consts.py 实跑生成——勿手改；")
    out.append("// 再生成：D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe tools/gen-agent-prompt-consts.py）。")
    out.append("// 来源 TreeWalker @640d52a：prompts/system_prompt.py / observability/decision_prompt.py /")
    out.append("// skills/task_matcher.py / agent/judge.py。占位符 {task}/{action_descriptions}/{max_actions}")
    out.append("// 与 Python str.format 同名（build 时替换）。")
    out.append("")
    out.append(f"export const SYSTEM_PROMPT_TEMPLATE = {lit(SYSTEM_PROMPT)};")
    out.append("")
    out.append(f"export const FILE_UPLOAD_RULES = {lit(FILE_UPLOAD_RULES)};")
    out.append("")
    out.append(f"export const DROPDOWN_RULES = {lit(DROPDOWN_RULES)};")
    out.append("")
    out.append(f"export const DECISION_ATTRIBUTION_PROMPT = {lit(get_decision_attribution_prompt())};")
    out.append("")
    out.append(f"export const MATCH_SYSTEM_PROMPT = {lit(_MATCH_SYSTEM_PROMPT)};")
    out.append("")
    out.append(f"export const MATCH_PROMPT_TEMPLATE = {lit(_MATCH_PROMPT_TEMPLATE)};")
    out.append("")
    out.append(f"export const TASK_SKILL_HEADER_SAME_TASK = {lit(_TASK_SKILL_HEADER_SAME_TASK)};")
    out.append("")
    out.append(f"export const TASK_SKILL_HEADER_SAME_TEMPLATE = {lit(_TASK_SKILL_HEADER_SAME_TEMPLATE)};")
    out.append("")
    out.append(f"export const TASK_SKILL_READ_APPENDIX = {lit(_TASK_SKILL_READ_APPENDIX)};")
    out.append("")
    out.append(f"export const JUDGE_SYSTEM_PROMPT = {lit(_JUDGE_SYSTEM_PROMPT)};")
    out.append("")
    out.append(
        "export const JUDGE_TOOL_SCHEMA = "
        + json.dumps(_JUDGE_TOOL_SCHEMA, ensure_ascii=False, indent=2)
        + " as Record<string, unknown>;"
    )
    out.append("")
    target = Path(__file__).resolve().parents[1] / "src/agent/prompt-consts.ts"
    target.write_text("\n".join(out), encoding="utf-8", newline="\n")
    print("written:", target, target.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
