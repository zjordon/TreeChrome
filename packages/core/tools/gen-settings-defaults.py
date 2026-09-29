#!/usr/bin/env python
"""生成 settings-defaults.json：tree_walker load_settings() 无 env 产出的 agent 级
运营默认（node-host 方案 §5.1 对拍基准——核心 DEFAULT_AGENT_SETTINGS 的口径依据）。

用法（venv 需 editable 装有 tree_walker）：

    D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe \
      packages/core/tools/gen-settings-defaults.py

确定性：脚本在调用 load_settings() 前清空所有配置类 env 前缀（AGENT_/LLM_/CDP_/
ZHIPU_/DOM_/BROWSER_/FALLBACK_/MESSAGE_/SENSITIVE_/TRACK_/RECONNECT_）——shell 环境
与 .env（_load_dotenv 在 import 时已合并进 os.environ）带入的覆盖一并洗掉，
产出恒为「无 env」运营默认。agent dict 全量落盘（不做删减）——TS 对拍测试持有
排除清单，Python 侧新增 agent 设置时测试失败、强制显式映射或排除（漂移警报）。
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, is_dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent  # packages/core
OUT = REPO_ROOT / "test" / "fixtures" / "python-anchors" / "settings-defaults.json"

SCRUB_PREFIXES = (
    "AGENT_",
    "LLM_",
    "CDP_",
    "ZHIPU_",
    "DOM_",
    "BROWSER_",
    "FALLBACK_",
    "MESSAGE_",
    "SENSITIVE_",
    "TRACK_",
    "RECONNECT_",
)


def main() -> int:
    # import 后清（_load_dotenv 已在 import 时跑过；load_settings 在调用时读 env）
    from tree_walker.config import load_settings

    for key in list(os.environ):
        if key.upper().startswith(SCRUB_PREFIXES):
            del os.environ[key]

    settings = load_settings()
    agent = asdict(settings.agent)
    assert is_dataclass(settings.agent)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "_meta": {
            "source": "tree_walker.config.load_settings()（无 env 运营默认）",
            "scope": "Settings.agent 全量（host 卡片面 llm/browser/tui 不含）",
            "note": "TS 对拍：packages/core/test/agent/settings-defaults.test.ts 持映射与排除清单",
        },
        "agent": agent,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"written: {OUT} ({len(agent)} agent keys)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
