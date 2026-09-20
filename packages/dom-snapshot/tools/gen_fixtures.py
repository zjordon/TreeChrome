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
import hashlib
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
    # 稳定后缀：md5 而非内建 hash()——后者对字符串进程随机化，重生成会换文件名
    digest = hashlib.md5(url.encode("utf-8")).hexdigest()[:5]
    return (s[:80] or "page") + f"-{digest}"


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
    from dom_snapshot.models import DOMCollectionConfig, DOMDegradationLevel
    from tree_walker import BrowserSession

    out_dir.mkdir(parents=True, exist_ok=True)

    # 录像补丁：同一 session 的第二次 _collect_cdp_sources（build_dom_state 内部
    # 会重新采集）回放首次结果——保证 fixture 的 input 与 output 派生自同一份
    # 字节，动态页面（时间戳/轮播）不会破坏对拍前提（review #11）。
    recorded: dict[object, tuple] = {}
    orig_collect = collector._collect_cdp_sources

    async def recording_collect(client, session_id=None, config=None):
        if session_id in recorded:
            return recorded[session_id]
        result = await orig_collect(client, session_id, config)
        recorded[session_id] = result
        return result

    collector._collect_cdp_sources = recording_collect

    browser = BrowserSession(ws_url=ws_url)
    await browser.start()
    try:
        for url in urls:
            recorded.clear()
            await browser.navigate(url)
            await asyncio.sleep(wait)
            client = browser.client
            sid = browser.current_session_id
            if client is None or sid is None:
                raise RuntimeError("BrowserSession 未连接（navigate 后应有活跃 session）")

            cfg = DOMCollectionConfig()
            # 返回顺序（collector.py:551）：snapshot, dom_tree, ax_tree, dpr, degradation, metrics。
            # 解包护栏：上游若调整顺序且类型恰好兼容，会静默产出错误 fixture（review #14）
            result = await recording_collect(client, sid, cfg)
            snap, dom_tree, ax_tree, dpr, level, metrics = result
            if not isinstance(dpr, (int, float)) or not isinstance(level, DOMDegradationLevel):
                raise RuntimeError(
                    f"_collect_cdp_sources 返回顺序与预期不符：dpr={dpr!r}, level={level!r}"
                )
            if not (isinstance(snap, dict) and "documents" in snap) or not (
                isinstance(dom_tree, dict) and "root" in dom_tree
            ):
                raise RuntimeError(
                    f"三源结构校验失败：snapshot 应含 documents、dom_tree 应含 root"
                )

            state, build_metrics = await collector.build_dom_state(client, session_id=sid, config=cfg)
            # 库在采集路径不填 element_count，用交互元素数作规模参考
            build_metrics.element_count = len(state.selector_map)

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
                    "element_count": build_metrics.element_count,
                    "note": "由 Python dom-snapshot 生成；TS 端对 input 跑管线后须与 output 对拍",
                },
                "input": {
                    "dom_tree": dom_tree,
                    "snapshot": snap,
                    "ax_tree": ax_tree,
                    "dpr": dpr,
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
            def _strict_default(o: object) -> None:
                # 严禁 default=str 式静默兜底：不可序列化对象会让 fixture 含非确定
                # 内容、重生成漂移、逐字节对拍失效，必须在生成时暴露（review #13）
                raise TypeError(f"fixture 含不可序列化对象: {type(o).__name__}: {o!r}")

            path.write_text(
                json.dumps(fixture, ensure_ascii=False, indent=1, default=_strict_default),
                encoding="utf-8",
            )
            print(
                f"[ok] {url} -> {path} (degradation={level.value}, elements={build_metrics.element_count})"
            )
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

    chrome = Path(args.chrome)
    if not chrome.exists():
        raise SystemExit(
            f"[gen_fixtures] Chrome 不存在：{chrome}（用 --chrome 指定路径，或改用 --ws-url 附着已运行的浏览器）"
        )
    proc = subprocess.Popen(
        [
            str(chrome),
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
        # Chrome 派生大量子进程：terminate 后必须 wait 收割，超时升级 kill（review #15）
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


if __name__ == "__main__":
    sys.exit(main())
