"""Golden fixture 生成器：把 Python dom-snapshot 的三源原始输入与序列化产物落盘。

用途：packages/dom-snapshot 的 TS 移植完成后，golden 测试用 fixture 的
input（三源原始 CDP 响应）喂 TS 采集/序列化管线，对 output.element_tree_text
逐字节对拍（验收标准见 docs/architecture.md §7）。

用法（在装有 tree_walker + dom_snapshot 的 venv 里跑，推荐 evals/webarena 的）：

  D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe \\
      packages/dom-snapshot/tools/gen_fixtures.py \\
      --url "https://example.com" --url "http://localhost:7780/admin/" \\
      --out packages/dom-snapshot/test/fixtures [--wait 2.5]

默认自动拉起 headless Chrome（--remote-debugging-port=9224）；也可 --ws-url 附着
已运行的浏览器。fixture 提交入库（golden 是测试资产）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
import urllib.request
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

CHROME_DEFAULT = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PROFILE_DEFAULT = r"C:\tmp\treechrome-fixture-profile"


def slugify(url: str) -> str:
    s = re.sub(r"^https?://", "", url)
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return (s[:80] or "page") + f"-{abs(hash(url)) % 100000:05d}"


def wait_version(port: int, timeout_s: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://localhost:{port}/json/version", timeout=2) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(0.5)
    raise RuntimeError(f"chrome {port} 未起来: {last_err}")


async def generate(urls: list[str], out_dir: Path, ws_url: str, wait: float) -> None:
    from dom_snapshot import collector
    from dom_snapshot.models import DOMCollectionConfig
    from tree_walker import BrowserSession

    out_dir.mkdir(parents=True, exist_ok=True)
    browser = BrowserSession(ws_url=ws_url)
    await browser.start()
    try:
        for url in urls:
            await browser.navigate(url)
            await asyncio.sleep(wait)
            client = browser.client
            sid = browser.current_session_id
            if client is None or sid is None:
                raise RuntimeError("BrowserSession 未连接（navigate 后应有活跃 session）")

            cfg = DOMCollectionConfig()
            dom_tree, snap, ax_tree, _elapsed, level, metrics = collector._collect_cdp_sources(
                client, sid, cfg
            )
            state, _ = collector.build_dom_state(client, session_id=sid, config=cfg)

            selector_map_proj: dict[str, dict] = {}
            for idx, node in state.selector_map.items():
                selector_map_proj[str(idx)] = {
                    "backend_node_id": node.backend_node_id,
                    "node_name": node.node_name,
                    "node_value": node.node_value,
                    "attributes": node.attributes,
                    "is_visible": node.is_visible,
                    "is_scrollable": node.is_scrollable,
                    "has_js_click_listener": node.has_js_click_listener,
                    "xpath": node.xpath,
                }

            fixture = {
                "meta": {
                    "url": url,
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "degradation": level.value,
                    "source_statuses": metrics.source_statuses,
                    "element_count": metrics.element_count,
                    "note": "由 Python dom-snapshot 生成；TS 端对 input 跑管线后须与 output 对拍",
                },
                "input": {
                    "dom_tree": dom_tree,
                    "snapshot": snap,
                    "ax_tree": ax_tree,
                },
                "output": {
                    "element_tree_text": state.element_tree_text,
                    "selector_map": selector_map_proj,
                    "file_input_backend_ids": state.file_input_backend_ids,
                    "file_inputs_meta": [asdict(x) for x in state.file_inputs_meta],
                    "page_stats": state.page_stats,
                },
            }
            path = out_dir / f"{slugify(url)}.json"
            path.write_text(
                json.dumps(fixture, ensure_ascii=False, indent=1, default=str),
                encoding="utf-8",
            )
            print(f"[ok] {url} -> {path} (degradation={level.value}, elements={metrics.element_count})")
    finally:
        await browser.stop()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", action="append", required=True, help="要抓取的 URL，可重复")
    ap.add_argument("--out", type=Path, default=Path(__file__).parents[1] / "test" / "fixtures")
    ap.add_argument("--chrome", default=CHROME_DEFAULT)
    ap.add_argument("--port", type=int, default=9224)
    ap.add_argument("--profile", default=PROFILE_DEFAULT)
    ap.add_argument("--ws-url", default=None, help="附着已运行浏览器，跳过自动拉起")
    ap.add_argument("--wait", type=float, default=2.5, help="navigate 后等渲染的秒数")
    args = ap.parse_args()

    if args.ws_url:
        asyncio.run(generate(args.url, args.out, args.ws_url, args.wait))
        return

    proc = subprocess.Popen(
        [
            args.chrome,
            f"--remote-debugging-port={args.port}",
            f"--user-data-dir={args.profile}",
            "--headless=new",
            "--no-first-run",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ver = wait_version(args.port)
        asyncio.run(generate(args.url, args.out, ver["webSocketDebuggerUrl"], args.wait))
    finally:
        proc.terminate()


if __name__ == "__main__":
    sys.exit(main())
