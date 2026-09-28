#!/usr/bin/env python3
"""gen-batch2-anchors.py —— P4b 段 1 锚点生成（p4b/01 §5 矩阵）。

经 evals venv 实跑 Python 参考实现，产出 batch2.json fixture：
- 纯函数族：三个 formatter / _text_queries / _xpath_string_literal / 两个 JS builder
- _sniff_file_kind：magic 头全分支（临时文件）
- 文件族 handler 全输出（Tools 裸实例 + 临时文件 + browser=None —— 文件动作不碰浏览器）
用法：python gen-batch2-anchors.py --out <dir>
"""

import argparse
import asyncio
import json
import os
import tempfile

from tree_walker.browser.session import (
    _build_find_elements_js,
    _build_search_page_js,
    _text_queries,
    _xpath_string_literal,
)
from tree_walker.tools.actions import (
    _SEARCH_ENGINE_URLS,
    Tools,
    _format_find_results,
    _format_node_id_results,
    _format_search_results,
    _sniff_file_kind,
)


def ar(result):
    """ActionResult → 可比对 dict（extracted/long_term/error/metadata）。"""
    out = {}
    for k in ("extracted_content", "long_term_memory", "error"):
        v = getattr(result, k, None)
        out[k] = v
    md = getattr(result, "metadata", None)
    if md:
        out["metadata"] = md
    return out


def find_fixtures():
    return {
        "basic": _format_find_results(
            {
                "elements": [
                    {"index": 3, "tag": "a", "text": "About  us", "attrs": {"href": "/about"}, "children_count": 0},
                    {"index": 7, "tag": "button", "text": "", "attrs": {}, "children_count": 2},
                ],
                "total": 2,
                "offset": 0,
                "has_more": False,
            },
            "a.link",
        ),
        "paginationGeometryOrigin": _format_find_results(
            {
                "elements": [
                    {
                        "index": 0,
                        "tag": "div",
                        "text": "x" * 150,
                        "attrs": {"id": "a", "class": "b c"},
                        "children_count": 3,
                        "origin": " (in shadow DOM)",
                        "rect": {"x": 1.2, "y": 3.4, "w": 50.6, "h": 7.8},
                        "visible": True,
                    },
                    {"index": 1, "tag": "span", "text": "", "attrs": {}, "children_count": 0, "visible": False},
                ],
                "total": 12,
                "offset": 10,
                "has_more": True,
            },
            "div.x",
        ),
    }


def node_id_fixtures():
    return {
        "basic": _format_node_id_results(
            {"node_ids": [{"backend_id": 1234, "tag": "a"}, {"backend_id": 5678, "tag": "button"}], "total": 2, "offset": 0, "has_more": False},
            "a.link",
        ),
        "pagination": _format_node_id_results(
            {"node_ids": [{"backend_id": 9, "tag": "input"}], "total": 5, "offset": 3, "has_more": True},
            "input",
        ),
    }


def search_fixtures():
    return {
        "basic": _format_search_results(
            {
                "matches": [
                    {"context": "...hello world...", "element_path": "div > p#intro", "match_text": "hello"},
                ],
                "total": 1,
                "offset": 0,
                "has_more": False,
                "attribute_matches": [],
                "attribute_total": 0,
            },
            "hello",
        ),
        "pagination": _format_search_results(
            {
                "matches": [{"context": "m1", "element_path": "", "match_text": "m"}],
                "total": 9,
                "offset": 4,
                "has_more": True,
                "attribute_matches": [],
                "attribute_total": 0,
            },
            "m",
        ),
        "attributes": _format_search_results(
            {
                "matches": [],
                "total": 0,
                "offset": 0,
                "has_more": False,
                "attribute_matches": [
                    {"attribute": "aria-label", "value": "Search hello", "element_path": "input#q"},
                    {"attribute": "alt", "value": "hello img", "element_path": "img"},
                ],
                "attribute_total": 3,
            },
            "hello",
        ),
    }


def sniff_fixtures(tmp):
    cases = {
        "png": b"\x89PNG\r\n\x1a\n" + b"\x00" * 4,
        "jpeg": b"\xff\xd8\xff\xe0" + b"\x00" * 8,
        "gif87a": b"GIF87a" + b"\x00" * 6,
        "gif89a": b"GIF89a" + b"\x00" * 6,
        "webp": b"RIFF\x00\x00\x00\x00WEBP",
        "avi": b"RIFF\x00\x00\x00\x00AVI ",
        "pdf": b"%PDF-1.7\n" + b"\x00" * 4,
        "docx": b"PK\x03\x04" + b"\x00" * 8,
        "plainZip": b"PK\x03\x04" + b"\x00" * 8,
        "elf": b"\x7fELF" + b"\x00" * 8,
        "mz": b"MZ\x90\x00" + b"\x00" * 8,
        "gzip": b"\x1f\x8b" + b"\x00" * 10,
        "bzip2": b"BZh9" + b"\x00" * 8,
        "rar": b"Rar!\x1a\x07" + b"\x00" * 6,
        "7z": b"7z\xbc\xaf\x27\x1c" + b"\x00" * 6,
        "text": b"just plain text\n",
        "emptyThenText": b"\x00\x01hi",
    }
    out = {}
    for name, data in cases.items():
        p = os.path.join(tmp, f"sniff_{name}" + (".docx" if name == "docx" else ".zip" if name == "plainZip" else ".bin"))
        with open(p, "wb") as f:
            f.write(data)
        out[name] = _sniff_file_kind(p)
    return out


async def file_action_fixtures(tmp):
    tools = Tools()
    out = {}

    async def run(name, params):
        handler = getattr(tools, f"_action_{name}")
        return ar(await handler(params, None))

    # write_file：overwrite / append / newline 簿记 / 非法编码 / 白名单拒
    p1 = os.path.join(tmp, "w1.txt")
    out["writeOverwrite"] = await run("write_file", {"path": p1, "content": "line1\nline2"})
    out["writeOverwriteFile"] = open(p1, "rb").read().decode()
    out["writeAppend"] = await run("write_file", {"path": p1, "content": "line3", "append": True})
    out["writeAppendFile"] = open(p1, "rb").read().decode()
    out["writeNoTrailing"] = await run("write_file", {"path": p1, "content": "x", "trailing_newline": False, "leading_newline": True})
    out["writeNoTrailingFile"] = open(p1, "rb").read().decode()
    out["writeUnknownEncoding"] = await run("write_file", {"path": os.path.join(tmp, "w2.txt"), "content": "x", "encoding": "no-such-codec"})
    tools_wl = Tools(allowed_write_paths=[os.path.join(tmp, "ok")])
    out["writeWhitelistReject"] = ar(
        await tools_wl._action_write_file({"path": os.path.join(tmp, "elsewhere.txt"), "content": "x"}, None)
    )

    # read_file：文本窗口 / 二进制拒 / image 提示 / pdf 降级（venv 无 pypdf 时）/ 嗅探 OSError（目录）
    rp = os.path.join(tmp, "r.txt")
    with open(rp, "w", encoding="utf-8", newline="") as f:
        f.write("A" * 6000)
    out["readWindow"] = await run("read_file", {"path": rp})
    out["readOffsetTail"] = await run("read_file", {"path": rp, "offset": 5990})
    out["readOffsetPastEnd"] = await run("read_file", {"path": rp, "offset": 9999})
    ep = os.path.join(tmp, "empty.txt")
    open(ep, "w").close()
    out["readEmpty"] = await run("read_file", {"path": ep})
    bp = os.path.join(tmp, "r.bin")
    with open(bp, "wb") as f:
        f.write(b"MZ\x90\x00\x03\x00\x00\x00\x04")  # 真 PE 头（\x00 开头的非魔数样本走 text——sniff.emptyThenText 已覆盖）
    out["readBinaryReject"] = await run("read_file", {"path": bp})
    ip = os.path.join(tmp, "r.png")
    with open(ip, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8)
    out["readImageHint"] = await run("read_file", {"path": ip})
    pdf = os.path.join(tmp, "r.pdf")
    with open(pdf, "wb") as f:
        f.write(b"%PDF-1.4\n%%EOF")
    out["readPdfNoParser"] = await run("read_file", {"path": pdf})
    out["readSniffDir"] = await run("read_file", {"path": tmp})
    tools_rl = Tools(allowed_read_paths=[os.path.join(tmp, "ok")])
    out["readWhitelistReject"] = ar(await tools_rl._action_read_file({"path": rp}, None))

    # replace_file：literal / regex / 大小写不敏感 / count / expected_count 失配 / 软失败 0 次 / backup / old 空 / 非法 regex
    tp = os.path.join(tmp, "rep.txt")
    with open(tp, "w", encoding="utf-8", newline="") as f:
        f.write("foo bar foo BAR\n")
    out["replaceLiteral"] = await run("replace_file", {"path": tp, "old": "foo", "new": "BAZ"})
    out["replaceLiteralFile"] = open(tp, "rb").read().decode()
    with open(tp, "w", encoding="utf-8", newline="") as f:
        f.write("foo bar foo BAR\n")
    out["replaceCaseInsensitive"] = await run("replace_file", {"path": tp, "old": "foo", "new": "x", "case_sensitive": False})
    out["replaceCaseInsensitiveFile"] = open(tp, "rb").read().decode()
    with open(tp, "w", encoding="utf-8", newline="") as f:
        f.write("aa bb aa bb aa\n")
    out["replaceCount"] = await run("replace_file", {"path": tp, "old": "aa", "new": "z", "count": 2})
    out["replaceCountFile"] = open(tp, "rb").read().decode()
    out["replaceExpectedMismatch"] = await run("replace_file", {"path": tp, "old": "aa", "new": "z", "expected_count": 99})
    out["replaceSoftMiss"] = await run("replace_file", {"path": tp, "old": "nope", "new": "z"})
    out["replaceOldEmpty"] = await run("replace_file", {"path": tp, "old": "", "new": "z"})
    out["replaceInvalidRegex"] = await run("replace_file", {"path": tp, "old": "([unclosed", "new": "z", "regex": True})
    with open(tp, "w", encoding="utf-8", newline="") as f:
        f.write("v1 v2 v3\n")
    out["replaceRegex"] = await run("replace_file", {"path": tp, "old": r"v(\d)", "new": r"w\1", "regex": True})
    out["replaceRegexFile"] = open(tp, "rb").read().decode()
    out["replaceRegexLiteralNew"] = await run("replace_file", {"path": tp, "old": "w1", "new": r"\1", "case_sensitive": False})
    out["replaceRegexLiteralNewFile"] = open(tp, "rb").read().decode()
    bp2 = os.path.join(tmp, "rep2.txt")
    with open(bp2, "w", encoding="utf-8", newline="") as f:
        f.write("keep me\n")
    out["replaceBackup"] = await run("replace_file", {"path": bp2, "old": "keep", "new": "held", "backup": True})
    out["replaceBackupFile"] = open(bp2 + ".bak", "rb").read().decode()
    out["replaceNotFound"] = await run("replace_file", {"path": os.path.join(tmp, "ghost.txt"), "old": "a", "new": "b"})

    # window_and_echo 边界（limit 小于窗口）
    out["readLimit"] = await run("read_file", {"path": rp, "offset": 10, "limit": 5})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    fixture = {
        "engineUrls": _SEARCH_ENGINE_URLS,
        "formatFindResults": find_fixtures(),
        "formatNodeIdResults": node_id_fixtures(),
        "formatSearchResults": search_fixtures(),
        "textQueries": {
            "plain": _text_queries("hello", False),
            "plainSensitive": _text_queries("hello", True),
            "doubleQuote": _text_queries('say "hi"', False),
            "bothQuotes": _text_queries("'both' and \"kinds\"", True),
        },
        "xpathStringLiteral": {
            "plain": _xpath_string_literal("abc"),
            "doubleQuote": _xpath_string_literal('a"b'),
            "singleQuote": _xpath_string_literal("a'b"),
            "both": _xpath_string_literal('a"b\'c'),
        },
        "searchPageJs": _build_search_page_js(
            "hello + world", True, False, 150, "div#main", 25, 0, True
        ),
        "findElementsJs": _build_find_elements_js("a.link", ["href", "id"], 50, True, False, 10, True),
    }

    with tempfile.TemporaryDirectory() as tmp:
        fixture["sniff"] = sniff_fixtures(tmp)
        fixture["fileActions"] = asyncio.run(file_action_fixtures(tmp))

    # 路径稳定化：tmp 绝对路径 → /ANCHOR_TMP 占位（跨克隆可比）。只替换路径本身——
    # 不得全局替换反斜杠（fixture 内的正则/转义内容会被腐蚀）
    tmp_slash = tmp.replace("\\", "/")

    def stabilize(obj):
        if isinstance(obj, str):
            s = obj.replace(tmp, "/ANCHOR_TMP").replace(tmp_slash, "/ANCHOR_TMP")
            # 占位段后的残留 os.sep 归一为 /（不碰其余内容的反斜杠——正则/转义保真）
            return s.replace("/ANCHOR_TMP\\", "/ANCHOR_TMP/")
        if isinstance(obj, dict):
            return {k: stabilize(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [stabilize(v) for v in obj]
        return obj

    fixture["fileActions"] = stabilize(fixture["fileActions"])
    fixture["anchorTmpPlaceholder"] = True

    # pdf 解析器在位时锚点会漂移——断言 venv 无 pypdf（降级文案面），有则显式记录
    try:
        import pypdf  # noqa: F401

        fixture["venvHasPypdf"] = True
    except ImportError:
        fixture["venvHasPypdf"] = False

    out_path = os.path.join(args.out, "batch2.json")
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"[gen-batch2-anchors] -> {out_path}")


if __name__ == "__main__":
    main()
