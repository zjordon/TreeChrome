#!/usr/bin/env python3
"""gen-batch2b-anchors.py —— P4b 段 2（下拉+上传）锚点生成（p4b/02 §5 矩阵）。

经 evals venv 实跑 Python 参考实现，产出 batch2b.json fixture：
- 17 个下拉 JS 常量 + _CUSTOM_SCROLL_CAP（session.py :904-1535，逐字节）
- upload 三条 JS（_UPLOAD_PROBE_JS / UPLOAD_INPUT_CONTEXTS_JS / UPLOAD_INPUT_CONTEXT_ON_ELEMENT_JS）
- 空选项诊断表 / 无定论引导文案
- 纯函数族实跑输出：_describe_dropdown / _describe_upload / _format_options_result（全 source 形态）、
  _file_matches_accept（四态+大小写+混合 token）、_is_autocomplete_field、
  _find_upload_label_near（合成树：class/文本命中、深度超限、shadow 命中、祖先攀爬）、
  _walk_for_file_inputs（children/shadowRoots/contentDocument 合成树）、
  upload_identity 四函数（candidates/clue/rect 谓词）
用法：python gen-batch2b-anchors.py --out <dir>
"""

import argparse
import json
import os
from types import SimpleNamespace as NS

from tree_walker.agent import upload_identity as uwa
from tree_walker.browser import session as tws
from tree_walker.tools import actions as twa
from tree_walker.tools.actions import Tools


def ar(result):
    out = {}
    for k in ("extracted_content", "long_term_memory", "error"):
        out[k] = getattr(result, k, None)
    md = getattr(result, "metadata", None)
    if md:
        out["metadata"] = md
    return out


def node(tag, *, attrs=None, value="", children=None, shadows=None, parent=None, bid=None):
    """合成 EnhancedDOMTreeNode（函数走 getattr，SimpleNamespace 即可）。"""
    return NS(
        tag_name=tag,
        attributes=attrs or {},
        node_value=value,
        children_nodes=children or [],
        shadow_roots=shadows or [],
        parent_node=parent,
        backend_node_id=bid,
        node_name=tag.upper(),
        snapshot_node=None,
        xpath=f"//{tag}",
    )


def cdp_node(name, bid, attrs=None, children=None, shadows=None, content_doc=None):
    d = {"nodeName": name, "backendNodeId": bid, "attributes": [], "children": children or []}
    for k, v in (attrs or {}).items():
        d["attributes"].extend([k, v])
    if shadows:
        d["shadowRoots"] = shadows
    if content_doc:
        d["contentDocument"] = content_doc
    return d


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    tools = Tools()
    out = {}

    # ── JS 常量（17 + cap）──
    out["js"] = {
        "SELECT_OPTION_JS": tws._SELECT_OPTION_JS,
        "SELECT_OPTION_MULTI_JS": tws._SELECT_OPTION_MULTI_JS,
        "SELECT_OPTION_CLICK_FALLBACK_JS": tws._SELECT_OPTION_CLICK_FALLBACK_JS,
        "ARIA_OPTIONS_JS": tws._ARIA_OPTIONS_JS,
        "CUSTOM_CLASS_OPTIONS_JS": tws._CUSTOM_CLASS_OPTIONS_JS,
        "COMBOBOX_OPTIONS_JS": tws._COMBOBOX_OPTIONS_JS,
        "SUBTREE_SEARCH_JS": tws._SUBTREE_SEARCH_JS,
        "SET_ARIA_JS": tws._SET_ARIA_JS,
        "SET_CUSTOM_JS": tws._SET_CUSTOM_JS,
        "COMBOBOX_LISTBOX_ID_JS": tws._COMBOBOX_LISTBOX_ID_JS,
        "SET_COMBOBOX_OPTION_JS": tws._SET_COMBOBOX_OPTION_JS,
        "SUBTREE_LOCATE_JS": tws._SUBTREE_LOCATE_JS,
        "EFFECTIVE_CLICK_TARGET_JS": tws._EFFECTIVE_CLICK_TARGET_JS,
        "CUSTOM_LISTBOX_DISCOVER_JS": tws._CUSTOM_LISTBOX_DISCOVER_JS,
        "CUSTOM_OPEN_OPTIONS_JS": tws._CUSTOM_OPEN_OPTIONS_JS,
        "CUSTOM_FIND_OPTION_JS": tws._CUSTOM_FIND_OPTION_JS,
        "SCROLL_LISTBOX_JS": tws._SCROLL_LISTBOX_JS,
    }
    out["customScrollCap"] = tws._CUSTOM_SCROLL_CAP
    out["uploadProbeJs"] = twa._UPLOAD_PROBE_JS
    out["uploadContextsJs"] = uwa.UPLOAD_INPUT_CONTEXTS_JS
    out["uploadContextOnElementJs"] = uwa.UPLOAD_INPUT_CONTEXT_ON_ELEMENT_JS
    out["emptyDiagnostics"] = dict(twa._EMPTY_OPTIONS_DIAGNOSTIC)
    out["inconclusiveAdvisory"] = twa._UPLOAD_INCONCLUSIVE_ADVISORY

    # ── 回显族（SimpleNamespace entry；函数全 getattr）──
    out["describeDropdown"] = {
        "ariaLabel": twa.Tools._describe_dropdown(
            NS(tag_name="select", attributes={"aria-label": "Country"}, node_value=""), 7
        ),
        "title": twa.Tools._describe_dropdown(
            NS(tag_name="select", attributes={"title": "T"}, node_value=""), 8
        ),
        "name": twa.Tools._describe_dropdown(
            NS(tag_name="select", attributes={"name": "region"}, node_value=""), 9
        ),
        "id": twa.Tools._describe_dropdown(NS(tag_name="select", attributes={"id": "sel1"}, node_value=""), 10),
        "nodeValue": twa.Tools._describe_dropdown(NS(tag_name="div", attributes={}, node_value=" 省份 "), 11),
        "bare": twa.Tools._describe_dropdown(NS(tag_name="select", attributes={}, node_value=""), 12),
        "long": twa.Tools._describe_dropdown(
            NS(tag_name="select", attributes={"aria-label": "x" * 80}, node_value=""), 13
        ),
        "longNodeValue": twa.Tools._describe_dropdown(
            NS(tag_name="select", attributes={}, node_value="y" * 80), 14
        ),
    }
    out["describeUpload"] = {
        "title": twa.Tools._describe_upload(
            NS(tag_name="input", attributes={"title": "Cover"}, node_value=""), 3, "/tmp/dir/横.png"
        ),
        "name": twa.Tools._describe_upload(
            NS(tag_name="input", attributes={"name": "file"}, node_value=""), 4, "/a/b/report.pdf"
        ),
        "nodeValue": twa.Tools._describe_upload(
            NS(tag_name="input", attributes={}, node_value=" 拖拽上传 "), 5, "/a/b/x.mp4"
        ),
        "bare": twa.Tools._describe_upload(NS(tag_name="input", attributes={}, node_value=""), 6, "/a/b/c.txt"),
        "longName": twa.Tools._describe_upload(
            NS(tag_name="input", attributes={}, node_value=""), 7, "/tmp/" + "n" * 80 + ".png"
        ),
    }

    # ── _format_options_result：全 source 形态 + 空选项诊断 ──
    entry = NS(tag_name="select", attributes={"name": "qty"}, node_value="")
    opts = [
        {"value": "a", "text": "Alpha", "selected": True},
        {"value": "b", "text": "Beta 'q'", "selected": False},
        {"value": "", "text": "", "selected": False},
    ]
    out["formatOptions"] = {}
    for source in ("native", "aria", "custom", "combobox", "click-select", "custom-open", "child-depth-2"):
        out["formatOptions"][source] = ar(tools._format_options_result(opts, entry, 21, source))
        out["formatOptions"][source + "Empty"] = ar(tools._format_options_result([], entry, 21, source))

    # ── _file_matches_accept ──
    out["fileMatchesAccept"] = {
        f"c{i}": twa._file_matches_accept(p, a)
        for i, (p, a) in enumerate(
            [
                ("x.png", None),
                ("x.png", ""),
                ("x.png", "  "),
                ("x.png", ".png"),
                ("x.PNG", ".png"),
                ("x.png", ".PNG"),
                ("x.png", ".jpg"),
                ("x.png", "image/*"),
                ("x.png", "image/png"),
                ("x.txt", "image/*"),
                ("report.pdf", "application/pdf"),
                ("report.pdf", ".pdf"),
                ("clip.mp4", "video/*"),
                ("clip.mp4", "video/mp4"),
                ("weird.xyz", "image/*"),
                ("weird.xyz", "application/xyz"),
                ("x.png", ".jpg, image/png"),
                ("x.png", " .png , "),
                ("x.png", "doc/x"),
                ("page.html", "text/html"),
                ("data.json", "application/json"),
            ]
        )
    }

    # ── _is_autocomplete_field ──
    out["isAutocomplete"] = {
        f"c{i}": list(twa.Tools._is_autocomplete_field(NS(attributes=attrs)))
        for i, attrs in enumerate(
            [
                {"role": "combobox"},
                {"aria-autocomplete": "list"},
                {"aria-autocomplete": "none"},
                {"aria-autocomplete": ""},
                {"list": "dl"},
                {"aria-haspopup": "listbox", "aria-controls": "lb"},
                {"aria-haspopup": "false", "aria-controls": "lb"},
                {"aria-haspopup": "true"},
                {},
            ]
        )
    }

    # ── _find_upload_label_near：合成树 ──
    def label_node(cls="", text="", bid=None, children_texts=()):
        ch = [node("span", value=t, bid=None) for t in children_texts]
        return node(
            "label",
            attrs={"class": cls} if cls else {},
            value=text,
            children=ch,
            bid=bid,
        )

    # 直接子：class 命中
    t1 = node("div", bid=100, children=[node("span", bid=101), label_node("semi-upload", "选择文件图片", 102)])
    # 子文本命中（上传）
    t2 = node("div", bid=200, children=[label_node("", "", 201, children_texts=("点击上传",))])
    # 深度超限（label 在 depth 4 —— max_depth=3 内不可达）vs 达标（depth 3）
    deep = node("div", bid=300, children=[
        node("div", bid=301, children=[
            node("div", bid=302, children=[
                node("div", bid=303, children=[node("div", bid=304, children=[label_node("up", "", 305)])])
            ])
        ])
    ])
    ok_depth = node("div", bid=310, children=[
        node("div", bid=311, children=[
            node("div", bid=312, children=[node("span", bid=313, children=[label_node("up", "", 314)])])
        ])
    ])
    # shadow root 命中
    t3 = node("div", bid=400, shadows=[label_node("upload", "", 401)])
    # 祖先攀爬：目标自身无，父容器子树有
    target = node("button", bid=501)
    container = node("div", bid=500, children=[target, label_node("btn upload", "", 502)])
    target.parent_node = container
    # 无 label
    t4 = node("div", bid=600, children=[node("span", bid=601)])
    out["findUploadLabelNear"] = {
        "classHit": twa._find_upload_label_near(t1),
        "textHit": twa._find_upload_label_near(t2),
        "tooDeep": twa._find_upload_label_near(deep),
        "depthOk": twa._find_upload_label_near(ok_depth),
        "shadowHit": twa._find_upload_label_near(t3),
        "ancestorClimb": twa._find_upload_label_near(target),
        "miss": twa._find_upload_label_near(t4),
    }

    # ── _walk_for_file_inputs ──
    doc = cdp_node(
        "#document", 1,
        children=[
            cdp_node("HTML", 2, children=[
                cdp_node("INPUT", 3, attrs={"type": "text"}),
                cdp_node("DIV", 4, shadows=[
                    cdp_node("#shadow-root", 5, children=[cdp_node("INPUT", 6, attrs={"type": "FILE"})])
                ]),
                cdp_node("IFRAME", 7, content_doc=cdp_node(
                    "#document", 8, children=[cdp_node("INPUT", 9, attrs={"type": "file", "accept": ".png"})]
                )),
                cdp_node("INPUT", 10),
            ])
        ],
    )
    out["walkFileInputs"] = tws._walk_for_file_inputs(doc)
    out["walkFileInputsEmpty"] = tws._walk_for_file_inputs(cdp_node("HTML", 1))

    # ── upload_identity ──
    smap = {
        2: node("input", attrs={"type": "file", "accept": "image/png"}, bid=2),
        3: node("input", attrs={"type": "file", "accept": "video/mp4"}, bid=3),
        4: node("input", attrs={"type": "text"}, bid=4),
        5: node("div", attrs={}, bid=5),
        6: node("input", attrs={"type": "file"}, bid=6),
    }
    out["fileInputCandidates"] = {
        "byPathPng": [[i, n.backend_node_id] for i, n in uwa.file_input_candidates(smap, path="/tmp/x.png")],
        "byPathMp4": [[i, n.backend_node_id] for i, n in uwa.file_input_candidates(smap, path="/tmp/x.mp4")],
        "byPathTxt": [[i, n.backend_node_id] for i, n in uwa.file_input_candidates(smap, path="/tmp/x.txt")],
        "byHintImage": [[i, n.backend_node_id] for i, n in uwa.file_input_candidates(smap, accept_hint="image/*")],
        "byHintNone": [[i, n.backend_node_id] for i, n in uwa.file_input_candidates(smap, accept_hint="")],
    }
    ctx_entry = {
        "accept": "image/png",
        "label_text": "封面上传",
        "aria_text": "",
        "region_text": "上传封面",
        "in_dialog": True,
        "affordance_text": "点击上传",
        "affordance_role": "button",
        "affordance_tag": "button",
        "affordance_rect": {"x": 1.0, "y": 2.0, "width": 80.0, "height": 24.0},
        "container_rect": {"x": 0.0, "y": 0.0, "width": 300.0, "height": 200.0},
    }
    clue_node = node(
        "input",
        attrs={"type": "file", "accept": "image/png"},
        bid=2,
    )
    clue_node.snapshot_node = NS(bounds={"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0})
    out["buildUploadClue"] = uwa.build_upload_clue(clue_node, ctx_entry)
    ctx_no_aff = dict(ctx_entry, affordance_text="", affordance_role="", affordance_tag="", affordance_rect=None)
    out["buildUploadClueNoAffordance"] = uwa.build_upload_clue(clue_node, ctx_no_aff)
    out["nonzeroRect"] = {
        "zero": uwa.nonzero_rect({"width": 0, "height": 0}),
        "widthOnly": uwa.nonzero_rect({"width": 1, "height": 0}),
        "none": uwa.nonzero_rect(None),
        "garbage": uwa.nonzero_rect({"width": "x"}),
    }
    out["effectiveClueRect"] = {
        "rect": uwa.effective_clue_rect({"rect": {"width": 5, "height": 5}}),
        "container": uwa.effective_clue_rect(
            {"rect": {"width": 0, "height": 0}, "container_rect": {"width": 9, "height": 9}}
        ),
        "affordance": uwa.effective_clue_rect(
            {
                "rect": None,
                "container_rect": None,
                "trigger_affordance": {"rect": {"width": 3, "height": 3}},
            }
        ),
        "allZero": uwa.effective_clue_rect(
            {"rect": {"width": 0, "height": 0}, "container_rect": None, "trigger_affordance": None}
        ),
    }

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "batch2b.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"batch2b.json -> {path} ({len(json.dumps(out))} bytes)")


if __name__ == "__main__":
    main()
