// P4b 段 2 纯函数族锚定（batch2b.json——gen-batch2b-anchors.py venv 实跑 Python 参考实现）：
// 17 个下拉 JS 常量逐字节 / upload 三条 JS / 空选项诊断表 / 无定论引导文案 /
// describe 族与 formatOptionsResult 全 source 形态 / fileMatchesAccept 四态 /
// isAutocomplete / findUploadLabelNear 合成树 / walkForFileInputs / upload_identity 四函数。
// 期望值一律取 fixture 实跑结果，不自行推导。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EnhancedDOMTreeNode } from "@tw/dom-snapshot";
import { describe, expect, it } from "vitest";
import * as DROPDOWN_JS from "../../src/browser/dropdown-js.js";
import { walkForFileInputs } from "../../src/browser/upload.js";
import { EMPTY_OPTIONS_DIAGNOSTIC, formatOptionsResult } from "../../src/tools/actions/dropdown.js";
import {
  describeDropdown,
  describeUpload,
  isAutocompleteField,
} from "../../src/tools/actions/shared/element-lookup.js";
import {
  fileMatchesAccept,
  findUploadLabelNear,
  UPLOAD_INCONCLUSIVE_ADVISORY,
  UPLOAD_PROBE_JS,
} from "../../src/tools/actions/upload-file.js";
import {
  buildUploadClue,
  effectiveClueRect,
  fileInputCandidates,
  nonzeroRect,
  UPLOAD_INPUT_CONTEXT_ON_ELEMENT_JS,
  UPLOAD_INPUT_CONTEXTS_JS,
} from "../../src/tools/actions/upload-identity.js";
import { makeNode } from "./fake-browser.js";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/batch2b.json", import.meta.url)),
    "utf8",
  ),
  // biome-ignore lint/suspicious/noExplicitAny: fixture 是外部 JSON 的弱形态读取面
) as Record<string, any>;

describe("下拉 17 JS 常量 + 滚动上限（session.py :904-1535 逐字节）", () => {
  for (const [name, value] of Object.entries(FIXTURE.js as Record<string, string>)) {
    it(`${name}`, () => {
      const exported = (DROPDOWN_JS as Record<string, unknown>)[name];
      expect(exported).toBe(value);
    });
  }
  it("CUSTOM_SCROLL_CAP = 10", () => {
    expect(DROPDOWN_JS.CUSTOM_SCROLL_CAP).toBe(FIXTURE.customScrollCap);
  });
});

describe("upload 三条 JS + 文案表（逐字节）", () => {
  it("UPLOAD_INPUT_CONTEXTS_JS / ON_ELEMENT / PROBE", () => {
    expect(UPLOAD_INPUT_CONTEXTS_JS).toBe(FIXTURE.uploadContextsJs);
    expect(UPLOAD_INPUT_CONTEXT_ON_ELEMENT_JS).toBe(FIXTURE.uploadContextOnElementJs);
    expect(UPLOAD_PROBE_JS).toBe(FIXTURE.uploadProbeJs);
  });
  it("空选项诊断表 / 无定论引导", () => {
    expect(EMPTY_OPTIONS_DIAGNOSTIC).toEqual(FIXTURE.emptyDiagnostics);
    expect(UPLOAD_INCONCLUSIVE_ADVISORY).toBe(FIXTURE.inconclusiveAdvisory);
  });
});

describe("describeDropdown / describeUpload（生成器同款 entry）", () => {
  const ddCases: Array<[string, Record<string, string>, string, number, string?]> = [
    ["ariaLabel", { "aria-label": "Country" }, "", 7],
    ["title", { title: "T" }, "", 8],
    ["name", { name: "region" }, "", 9],
    ["id", { id: "sel1" }, "", 10],
    ["nodeValue", {}, " 省份 ", 11, "div"],
    ["bare", {}, "", 12],
    ["long", { "aria-label": "x".repeat(80) }, "", 13],
    ["longNodeValue", {}, "y".repeat(80), 14],
  ];
  for (const [key, attrs, value, index, tag = "select"] of ddCases) {
    it(`describeDropdown ${key}`, () => {
      expect(
        describeDropdown(
          makeNode({ nodeName: tag, attributes: attrs, nodeValue: value, backendNodeId: index }),
          index,
        ),
      ).toBe(FIXTURE.describeDropdown[key]);
    });
  }
  const duCases: Array<[string, string, Record<string, string>, string, number]> = [
    ["title", "/tmp/dir/横.png", { title: "Cover" }, "", 3],
    ["name", "/a/b/report.pdf", { name: "file" }, "", 4],
    ["nodeValue", "/a/b/x.mp4", {}, " 拖拽上传 ", 5],
    ["bare", "/a/b/c.txt", {}, "", 6],
    ["longName", `/tmp/${"n".repeat(80)}.png`, {}, "", 7],
  ];
  for (const [key, path, attrs, value, index] of duCases) {
    it(`describeUpload ${key}`, () => {
      expect(
        describeUpload(
          makeNode({
            nodeName: "input",
            attributes: attrs,
            nodeValue: value,
            backendNodeId: index,
          }),
          index,
          path,
        ),
      ).toBe(FIXTURE.describeUpload[key]);
    });
  }
});

describe("formatOptionsResult（全 source 形态 + 空选项诊断）", () => {
  const opts = [
    { value: "a", text: "Alpha", selected: true },
    { value: "b", text: "Beta 'q'", selected: false },
    { value: "", text: "", selected: false },
  ];
  const desc = describeDropdown(
    makeNode({ nodeName: "select", attributes: { name: "qty" }, backendNodeId: 21 }),
    21,
  );
  const sources = [
    "native",
    "aria",
    "custom",
    "combobox",
    "click-select",
    "custom-open",
    "child-depth-2",
  ];
  for (const source of sources) {
    it(`${source} 有选项`, () => {
      const r = formatOptionsResult(opts, desc, 21, source);
      expect(r.extractedContent).toBe(FIXTURE.formatOptions[source].extracted_content);
      expect(r.longTermMemory).toBe(FIXTURE.formatOptions[source].long_term_memory);
      expect(r.error).toBeNull();
    });
    it(`${source} 空选项诊断`, () => {
      const r = formatOptionsResult([], desc, 21, source);
      expect(r.extractedContent).toBe(FIXTURE.formatOptions[`${source}Empty`].extracted_content);
      expect(r.longTermMemory).toBe(FIXTURE.formatOptions[`${source}Empty`].long_term_memory);
    });
  }
});

describe("fileMatchesAccept（:79-113 四态 + 大小写 + 混合 token）", () => {
  const cases: Array<[string, string | null]> = [
    ["x.png", null],
    ["x.png", ""],
    ["x.png", "  "],
    ["x.png", ".png"],
    ["x.PNG", ".png"],
    ["x.png", ".PNG"],
    ["x.png", ".jpg"],
    ["x.png", "image/*"],
    ["x.png", "image/png"],
    ["x.txt", "image/*"],
    ["report.pdf", "application/pdf"],
    ["report.pdf", ".pdf"],
    ["clip.mp4", "video/*"],
    ["clip.mp4", "video/mp4"],
    ["weird.xyz", "image/*"],
    ["weird.xyz", "application/xyz"],
    ["x.png", ".jpg, image/png"],
    ["x.png", " .png , "],
    ["x.png", "doc/x"],
    ["page.html", "text/html"],
    ["data.json", "application/json"],
  ];
  cases.forEach(([path, accept], i) => {
    it(`c${i} ${JSON.stringify(path)} vs ${JSON.stringify(accept)}`, () => {
      expect(fileMatchesAccept(path, accept)).toBe(FIXTURE.fileMatchesAccept[`c${i}`]);
    });
  });
});

describe("isAutocompleteField（:1404-1426）", () => {
  const attrCases: Array<Record<string, string>> = [
    { role: "combobox" },
    { "aria-autocomplete": "list" },
    { "aria-autocomplete": "none" },
    { "aria-autocomplete": "" },
    { list: "dl" },
    { "aria-haspopup": "listbox", "aria-controls": "lb" },
    { "aria-haspopup": "false", "aria-controls": "lb" },
    { "aria-haspopup": "true" },
    {},
  ];
  attrCases.forEach((attrs, i) => {
    it(`c${i}`, () => {
      expect(isAutocompleteField(makeNode({ attributes: attrs }))).toEqual(
        FIXTURE.isAutocomplete[`c${i}`],
      );
    });
  });
});

/** 生成器 node() 的 TS 镜像（children/parent/shadow 后挂） */
function tree(
  tag: string,
  opts: {
    attrs?: Record<string, string>;
    value?: string;
    bid?: number;
    children?: EnhancedDOMTreeNode[];
    shadows?: EnhancedDOMTreeNode[];
    parent?: EnhancedDOMTreeNode | null;
  } = {},
): EnhancedDOMTreeNode {
  const n = makeNode({
    nodeName: tag,
    attributes: opts.attrs,
    nodeValue: opts.value,
    backendNodeId: opts.bid ?? 1,
  });
  n.childrenNodes = opts.children ?? [];
  n.shadowRoots = opts.shadows ?? [];
  n.parentNode = opts.parent ?? null;
  return n;
}

function labelNode(
  cls: string,
  text: string,
  bid: number,
  childrenTexts: string[] = [],
): EnhancedDOMTreeNode {
  return tree("label", {
    attrs: cls === "" ? {} : { class: cls },
    value: text,
    bid,
    children: childrenTexts.map((t) => tree("span", { value: t, bid: 1 })),
  });
}

describe("findUploadLabelNear（:302-361 合成树——期望值取 fixture 实跑）", () => {
  it("class 命中 / 文本命中 / shadow 命中 / 祖先攀爬", () => {
    const t1 = tree("div", {
      bid: 100,
      children: [tree("span", { bid: 101 }), labelNode("semi-upload", "选择文件图片", 102)],
    });
    expect(findUploadLabelNear(t1)).toBe(FIXTURE.findUploadLabelNear.classHit);
    const t2 = tree("div", {
      bid: 200,
      children: [labelNode("", "", 201, ["点击上传"])],
    });
    expect(findUploadLabelNear(t2)).toBe(FIXTURE.findUploadLabelNear.textHit);
    const t3 = tree("div", { bid: 400, shadows: [labelNode("upload", "", 401)] });
    expect(findUploadLabelNear(t3)).toBe(FIXTURE.findUploadLabelNear.shadowHit);
    const target = tree("button", { bid: 501 });
    const container = tree("div", {
      bid: 500,
      children: [target, labelNode("btn upload", "", 502)],
    });
    target.parentNode = container;
    expect(findUploadLabelNear(target)).toBe(FIXTURE.findUploadLabelNear.ancestorClimb);
  });
  it("深度超限 / 深度边界 / miss（fixture 实跑裁决——含 depthOk 实为 null）", () => {
    const deep = tree("div", {
      bid: 300,
      children: [
        tree("div", {
          bid: 301,
          children: [
            tree("div", {
              bid: 302,
              children: [
                tree("div", {
                  bid: 303,
                  children: [tree("div", { bid: 304, children: [labelNode("up", "", 305)] })],
                }),
              ],
            }),
          ],
        }),
      ],
    });
    expect(findUploadLabelNear(deep)).toBe(FIXTURE.findUploadLabelNear.tooDeep);
    const okDepth = tree("div", {
      bid: 310,
      children: [
        tree("div", {
          bid: 311,
          children: [
            tree("div", {
              bid: 312,
              children: [tree("span", { bid: 313, children: [labelNode("up", "", 314)] })],
            }),
          ],
        }),
      ],
    });
    expect(findUploadLabelNear(okDepth)).toBe(FIXTURE.findUploadLabelNear.depthOk);
    const t4 = tree("div", { bid: 600, children: [tree("span", { bid: 601 })] });
    expect(findUploadLabelNear(t4)).toBe(FIXTURE.findUploadLabelNear.miss);
  });
});

describe("walkForFileInputs（:691-721 children/shadowRoots/contentDocument）", () => {
  it("三向穿透", () => {
    const doc = {
      nodeName: "#document",
      backendNodeId: 1,
      attributes: [],
      children: [
        {
          nodeName: "HTML",
          backendNodeId: 2,
          attributes: [],
          children: [
            { nodeName: "INPUT", backendNodeId: 3, attributes: ["type", "text"], children: [] },
            {
              nodeName: "DIV",
              backendNodeId: 4,
              attributes: [],
              children: [],
              shadowRoots: [
                {
                  nodeName: "#shadow-root",
                  backendNodeId: 5,
                  attributes: [],
                  children: [
                    {
                      nodeName: "INPUT",
                      backendNodeId: 6,
                      attributes: ["type", "FILE"],
                      children: [],
                    },
                  ],
                },
              ],
            },
            {
              nodeName: "IFRAME",
              backendNodeId: 7,
              attributes: [],
              children: [],
              contentDocument: {
                nodeName: "#document",
                backendNodeId: 8,
                attributes: [],
                children: [
                  {
                    nodeName: "INPUT",
                    backendNodeId: 9,
                    attributes: ["type", "file", "accept", ".png"],
                    children: [],
                  },
                ],
              },
            },
            { nodeName: "INPUT", backendNodeId: 10, attributes: [], children: [] },
          ],
        },
      ],
    };
    expect(walkForFileInputs(doc)).toEqual(FIXTURE.walkFileInputs);
    expect(
      walkForFileInputs({ nodeName: "HTML", backendNodeId: 1, attributes: [], children: [] }),
    ).toEqual(FIXTURE.walkFileInputsEmpty);
  });
});

describe("upload_identity 纯函数族", () => {
  const smap = new Map<number, EnhancedDOMTreeNode>();
  smap.set(
    2,
    makeNode({
      nodeName: "input",
      attributes: { type: "file", accept: "image/png" },
      backendNodeId: 2,
    }),
  );
  smap.set(
    3,
    makeNode({
      nodeName: "input",
      attributes: { type: "file", accept: "video/mp4" },
      backendNodeId: 3,
    }),
  );
  smap.set(4, makeNode({ nodeName: "input", attributes: { type: "text" }, backendNodeId: 4 }));
  smap.set(5, makeNode({ nodeName: "div", backendNodeId: 5 }));
  smap.set(6, makeNode({ nodeName: "input", attributes: { type: "file" }, backendNodeId: 6 }));
  const pairs = (r: Array<[number, EnhancedDOMTreeNode]>) =>
    r.map(([i, n]) => [i, n.backendNodeId]);
  it("fileInputCandidates（path/hint 双路 kind 过滤）", () => {
    expect(pairs(fileInputCandidates(smap, { path: "/tmp/x.png" }))).toEqual(
      FIXTURE.fileInputCandidates.byPathPng,
    );
    expect(pairs(fileInputCandidates(smap, { path: "/tmp/x.mp4" }))).toEqual(
      FIXTURE.fileInputCandidates.byPathMp4,
    );
    expect(pairs(fileInputCandidates(smap, { path: "/tmp/x.txt" }))).toEqual(
      FIXTURE.fileInputCandidates.byPathTxt,
    );
    expect(pairs(fileInputCandidates(smap, { acceptHint: "image/*" }))).toEqual(
      FIXTURE.fileInputCandidates.byHintImage,
    );
    expect(pairs(fileInputCandidates(smap, { acceptHint: "" }))).toEqual(
      FIXTURE.fileInputCandidates.byHintNone,
    );
  });
  it("buildUploadClue（含 affordance / 无 affordance 两形态）", () => {
    const ctxEntry = {
      accept: "image/png",
      label_text: "封面上传",
      aria_text: "",
      region_text: "上传封面",
      in_dialog: true,
      affordance_text: "点击上传",
      affordance_role: "button",
      affordance_tag: "button",
      affordance_rect: { x: 1.0, y: 2.0, width: 80.0, height: 24.0 },
      container_rect: { x: 0.0, y: 0.0, width: 300.0, height: 200.0 },
    };
    const node = makeNode({
      nodeName: "input",
      attributes: { type: "file", accept: "image/png" },
      backendNodeId: 2,
    });
    node.snapshotNode = { bounds: { x: 0.0, y: 0.0, width: 0.0, height: 0.0 } } as never;
    Object.defineProperty(node, "xpath", { value: "//input" });
    expect(buildUploadClue(node, ctxEntry)).toEqual(FIXTURE.buildUploadClue);
    const ctxNoAff = {
      ...ctxEntry,
      affordance_text: "",
      affordance_role: "",
      affordance_tag: "",
      affordance_rect: null,
    };
    expect(buildUploadClue(node, ctxNoAff)).toEqual(FIXTURE.buildUploadClueNoAffordance);
  });
  it("nonzeroRect / effectiveClueRect", () => {
    expect(nonzeroRect({ width: 0, height: 0 })).toBe(FIXTURE.nonzeroRect.zero);
    expect(nonzeroRect({ width: 1, height: 0 })).toBe(FIXTURE.nonzeroRect.widthOnly);
    expect(nonzeroRect(null)).toBe(FIXTURE.nonzeroRect.none);
    expect(nonzeroRect({ width: "x" })).toBe(FIXTURE.nonzeroRect.garbage);
    expect(effectiveClueRect({ rect: { width: 5, height: 5 } })).toEqual(
      FIXTURE.effectiveClueRect.rect,
    );
    expect(
      effectiveClueRect({ rect: { width: 0, height: 0 }, container_rect: { width: 9, height: 9 } }),
    ).toEqual(FIXTURE.effectiveClueRect.container);
    expect(
      effectiveClueRect({
        rect: null,
        container_rect: null,
        trigger_affordance: { rect: { width: 3, height: 3 } },
      }),
    ).toEqual(FIXTURE.effectiveClueRect.affordance);
    expect(
      effectiveClueRect({
        rect: { width: 0, height: 0 },
        container_rect: null,
        trigger_affordance: null,
      }),
    ).toEqual(FIXTURE.effectiveClueRect.allZero);
  });
});

describe("补面：boundsToDict / candidates kind 分支", () => {
  it("boundsToDict：数值直入属性路径 / 记录原样", async () => {
    const { boundsToDict } = await import("../../src/tools/actions/upload-identity.js");
    expect(boundsToDict(42)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    const obj = { x: 1, y: 2, width: 3, height: 4 };
    expect(boundsToDict(obj)).toBe(obj);
    expect(boundsToDict(null)).toBeNull();
  });
  it("fileInputCandidates acceptHint=video / 无扩展名路径", () => {
    const m = new Map<number, EnhancedDOMTreeNode>();
    m.set(
      1,
      makeNode({
        nodeName: "input",
        attributes: { type: "file", accept: "video/*" },
        backendNodeId: 1,
      }),
    );
    m.set(
      2,
      makeNode({
        nodeName: "input",
        attributes: { type: "file", accept: "image/png" },
        backendNodeId: 2,
      }),
    );
    expect(
      fileInputCandidates(m, { acceptHint: "video/mp4" }).map(([i, n]) => [i, n.backendNodeId]),
    ).toEqual([[1, 1]]);
    expect(
      fileInputCandidates(m, { path: "/tmp/noext" }).map(([i, n]) => [i, n.backendNodeId]),
    ).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe("补面：captureUploadClue 降级路径", () => {
  it("节点不在 selector_map / ctx 非记录 → null", async () => {
    const { captureUploadClue } = await import("../../src/tools/actions/upload-identity.js");
    const node = makeNode({ nodeName: "input", backendNodeId: 2 });
    const browser = {
      evalFunctionOnNode: async () => ({ accept: "image/png" }),
    };
    const smap = new Map([[2, node]]);
    expect(await captureUploadClue(browser, smap, 99)).toBeNull(); // 不在 map
    const badCtx = { evalFunctionOnNode: async () => 42 };
    expect(await captureUploadClue(badCtx, smap, 2)).toBeNull(); // 非记录 ctx
    expect(await captureUploadClue(browser, smap, 2)).not.toBeNull(); // 正常命中
  });
});
