// P4b 段 2 三动作 handler（FakeBrowser 可编程面）：dropdown_options 预分类四路 +
// select_dropdown 守卫/单选/多选三态回显 + upload_file 五段链（白名单/纠偏/label
// 发现/accept 软校验/验证探针）。回显形态锚定 batch2b.json 的 formatOptions 期望。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SerializedDOMState } from "@tw/dom-snapshot";
import { describe, expect, it } from "vitest";
import type { BrowserStateSummary } from "../../src/browser/views.js";
import type { Tools } from "../../src/tools/actions/index.js";
import { FakeBrowser, makeNode, makeTools } from "./fake-browser.js";
import { makeFakeFs } from "./fake-fs.js";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/python-anchors/batch2b.json", import.meta.url)),
    "utf8",
  ),
  // biome-ignore lint/suspicious/noExplicitAny: fixture 是外部 JSON 的弱形态读取面
) as Record<string, any>;

const stateOf = (
  selectorMap: Map<number, ReturnType<typeof makeNode>>,
  fileInputBackendIds: number[] = [],
  fileInputsMeta: Array<{
    backend_node_id: number;
    accept: string;
    visible: boolean;
    upload_ancestor: boolean;
    class_name: string;
  }> = [],
): BrowserStateSummary => ({
  url: "https://a.example",
  title: "A",
  tabs: [{ targetId: "ABCD1234", url: "https://a.example", title: "A" }],
  domState: new SerializedDOMState(
    { tag: "html" } as never,
    selectorMap,
    "[1] x",
    fileInputBackendIds,
    fileInputsMeta,
  ),
  screenshot: null,
  gridMeta: null,
  recentEvents: [],
});

const execWith = async (
  tools: Tools,
  browser: FakeBrowser,
  state: BrowserStateSummary | null,
  action: string,
  params: Record<string, unknown>,
) => tools.execute(action, params, browser, state);

describe("dropdown_options（预分类：native/combobox/dispatcher/开态 fallback）", () => {
  const run = async (
    browser: FakeBrowser,
    _node: ReturnType<typeof makeNode>,
    state: BrowserStateSummary | null,
    params: Record<string, unknown>,
  ) => {
    const { tools } = makeTools();
    return execWith(tools, browser, state, "dropdown_options", params);
  };
  it("native SELECT → fetchSelectOptions（回显 = fixture formatOptions.native）", async () => {
    const browser = new FakeBrowser();
    browser.fetchSelectOptionsResult = [
      { value: "a", text: "Alpha", selected: true },
      { value: "b", text: "Beta 'q'", selected: false },
      { value: "", text: "", selected: false },
    ];
    const node = makeNode({ nodeName: "select", attributes: { name: "qty" }, backendNodeId: 21 });
    const state = stateOf(new Map([[21, node]]));
    const r = await run(browser, node, state, { index: 21 });
    expect(r.extractedContent).toBe(FIXTURE.formatOptions.native.extracted_content);
    expect(r.longTermMemory).toBe(FIXTURE.formatOptions.native.long_term_memory);
  });
  it("combobox（role + aria-controls）→ expandAndFetchComboboxOptions", async () => {
    const browser = new FakeBrowser();
    browser.expandComboboxResult = [{ value: "z", text: "Z", selected: false }];
    const node = makeNode({
      nodeName: "input",
      attributes: { role: "combobox", "aria-controls": "lb1" },
      backendNodeId: 3,
    });
    const r = await run(browser, node, stateOf(new Map([[3, node]])), { index: 3 });
    expect(r.extractedContent).toBe(
      '0: text="Z", value="z"\nUse the value in select_dropdown(index=3, value=...)',
    );
    expect(r.longTermMemory).toBe("Got 1 options from [INPUT] at index 3 via [COMBOBOX]");
  });
  it("其余 → dispatcher source 命中（aria via 后缀）", async () => {
    const browser = new FakeBrowser();
    browser.fetchDropdownOptionsResult = { options: [{ value: "a", text: "A" }], source: "aria" };
    const node = makeNode({ nodeName: "div", backendNodeId: 4 });
    const r = await run(browser, node, stateOf(new Map([[4, node]])), { index: 4 });
    expect(r.longTermMemory).toBe("Got 1 options from [DIV] at index 4 via [ARIA]");
  });
  it("闭态 miss → 开态 fallback 失败/空选项两路 error", async () => {
    const browser = new FakeBrowser();
    browser.expandCustomError = new Error("boom");
    const node = makeNode({ nodeName: "div", backendNodeId: 5 });
    const r = await run(browser, node, stateOf(new Map([[5, node]])), { index: 5 });
    expect(r.error).toBe(
      "Index 5 is a [DIV] element, not a recognized dropdown (native <select>, ARIA listbox/menu, custom dropdown, or combobox). Open-then-discover also failed: boom",
    );
    const browser2 = new FakeBrowser();
    browser2.expandCustomResult = [];
    const r2 = await run(browser2, node, stateOf(new Map([[5, node]])), { index: 5 });
    expect(r2.error).toBe(
      "Index 5 opened but exposed no options — it may not be a dropdown, or options load on a trigger other than a click.",
    );
  });
  it("index 非数字守卫；元素查无", async () => {
    const browser = new FakeBrowser();
    const { tools } = makeTools();
    const r = await tools.execute("dropdown_options", { index: "x" }, browser, null);
    expect(r.error).toBe("dropdown_options requires a number `index` parameter.");
    const miss = await tools.execute("dropdown_options", { index: 99 }, browser, null);
    expect(miss.error).toContain("not found");
  });
});

describe("select_dropdown（守卫 + 单/多选三态回显）", () => {
  const run = (params: Record<string, unknown>, node: ReturnType<typeof makeNode>) => {
    const browser = new FakeBrowser();
    const { tools } = makeTools();
    return execWith(tools, browser, stateOf(new Map([[7, node]])), "select_dropdown", params);
  };
  const select = makeNode({ nodeName: "select", backendNodeId: 7 });
  it("value/values 互斥与形态守卫", async () => {
    expect((await run({ index: 7, value: "a", values: ["a"] }, select)).error).toBe(
      "Pass either value (single option) or values (multi-select), not both",
    );
    expect((await run({ index: 7 }, select)).error).toBe(
      "select_dropdown requires value (single option) or values (multi-select list)",
    );
    expect((await run({ index: 7, values: [] }, select)).error).toBe(
      "values must be a non-empty list of non-empty strings",
    );
    expect((await run({ index: 7, values: ["a", 1] }, select)).error).toBe(
      "values must be a non-empty list of non-empty strings",
    );
    const div = makeNode({ nodeName: "div", backendNodeId: 7 });
    expect((await run({ index: 7, values: ["a"] }, div)).error).toBe(
      "values (multi-select) is only supported for native <select multiple>; for this element use value= (single option)",
    );
  });
  it("native 单选成功（message 缺省 Selected option）与 miss 回显", async () => {
    const browser = new FakeBrowser();
    browser.setterResults = {
      a: { success: true, message: "Selected: a" },
      nope: {
        success: false,
        availableOptions: [
          { value: "a", text: "A" },
          { value: "b", text: "B" },
        ],
      },
    };
    const { tools } = makeTools();
    const state = stateOf(new Map([[7, select]]));
    const ok = await execWith(tools, browser, state, "select_dropdown", { index: 7, value: "a" });
    expect(ok.extractedContent).toBe("Selected: a");
    expect(ok.longTermMemory).toBe('Selected "a" in [SELECT] at index 7');
    const miss = await execWith(tools, browser, state, "select_dropdown", {
      index: 7,
      value: "nope",
    });
    expect(miss.extractedContent).toBe(
      '0: text="A", value="a"\n1: text="B", value="b"\nUse the value in select_dropdown(index=7, value=...)',
    );
    expect(miss.longTermMemory).toBe(
      'Couldn\'t select "nope" in [SELECT] at index 7 (not an available option)',
    );
  });
  it("multi：成功 / missed（Options not found 前缀）/ 裸 error", async () => {
    const browser = new FakeBrowser();
    browser.setterResults = {
      multi: {
        success: false,
        missed: ["z"],
        availableOptions: [{ value: "a", text: "A", selected: true }],
      },
    };
    const { tools } = makeTools();
    const state = stateOf(new Map([[7, select]]));
    const miss = await execWith(tools, browser, state, "select_dropdown", {
      index: 7,
      values: ["z"],
    });
    expect(miss.extractedContent).toBe(
      'Options not found: z\n0: text="A", value="a" (selected)\nUse the values in select_dropdown(index=7, values=[...])',
    );
    expect(miss.longTermMemory).toBe(
      'Couldn\'t select ["z"] in [SELECT] at index 7 (Options not found: z)',
    );
    const browser2 = new FakeBrowser();
    browser2.setterResults = { multi: { success: true, message: "Set all" } };
    const { tools: t2 } = makeTools();
    const ok = await execWith(t2, browser2, state, "select_dropdown", {
      index: 7,
      values: ["a", "b"],
    });
    expect(ok.extractedContent).toBe("Set all");
    // Python json.dumps 默认分隔符（评审轮 1 [1]）：["a", "b"] 非 ["a","b"]（venv 锚定）
    expect(ok.longTermMemory).toBe('Selected ["a", "b"] in [SELECT] at index 7');
    const browser3 = new FakeBrowser();
    const { tools: t3 } = makeTools();
    const bare = await execWith(t3, browser3, state, "select_dropdown", {
      index: 7,
      values: ["q"],
    });
    expect(bare.error).toBe('Failed to select options: ["q"]');
  });
  it("dispatcher source null → 开态 setCustomDropdownOption fallback", async () => {
    const browser = new FakeBrowser();
    browser.setterResults = { zz: { success: true, message: "custom ok" } };
    const { tools } = makeTools();
    const div = makeNode({ nodeName: "div", backendNodeId: 9 });
    const state = stateOf(new Map([[9, div]]));
    const r = await execWith(tools, browser, state, "select_dropdown", { index: 9, value: "zz" });
    // setDropdownOption 默认 source null → 触发 fallback（FakeBrowser 按 value 查表）
    expect(r.extractedContent).toBe("custom ok");
  });
});

describe("upload_file（五段链）", () => {
  const _fileInput = makeNode({
    nodeName: "input",
    attributes: { type: "file", accept: "image/png" },
    backendNodeId: 30,
  });
  const baseRun = async (
    browser: FakeBrowser,
    selectorMap: Map<number, ReturnType<typeof makeNode>>,
    params: Record<string, unknown>,
    fileInputIds: number[] = [],
    meta: Array<{
      backend_node_id: number;
      accept: string;
      visible: boolean;
      upload_ancestor: boolean;
      class_name: string;
    }> = [],
    toolsOptions: ConstructorParameters<typeof Tools>[0] = {},
  ) => {
    const { tools } = makeTools(toolsOptions);
    tools.ctx.fs = makeFakeFs({ "/up/cover.png": "PNGDATA" });
    return execWith(
      tools,
      browser,
      stateOf(selectorMap, fileInputIds, meta),
      "upload_file",
      params,
    );
  };
  it("守卫与白名单/存在性", async () => {
    const browser = new FakeBrowser();
    const { tools } = makeTools({ allowedUploadPaths: ["/ok"] });
    tools.ctx.fs = makeFakeFs({ "/up/cover.png": "PNG" });
    const r = await tools.execute(
      "upload_file",
      { path: "/up/cover.png", index: 1 },
      browser,
      null,
    );
    expect(r.error).toBe("File path not in allowed upload paths: /up/cover.png");
    const { tools: t2 } = makeTools();
    t2.ctx.fs = makeFakeFs({ "/up/x.png": "P" });
    const nf = await t2.execute("upload_file", { path: "/up/ghost.png", index: 1 }, browser, null);
    expect(nf.error).toBe("File not found: /up/ghost.png");
  });
  it("目标即 file input（唯一）→ 直传 + describeUpload 回显 + accept 匹配无注记", async () => {
    const browser = new FakeBrowser();
    const input30 = makeNode({
      nodeName: "input",
      attributes: { type: "file", accept: "image/png" },
      backendNodeId: 30,
    });
    const r = await baseRun(
      browser,
      new Map([[30, input30]]),
      { path: "/up/cover.png", index: 30 },
      [30],
      [
        {
          backend_node_id: 30,
          accept: "image/png",
          visible: true,
          upload_ancestor: false,
          class_name: "",
        },
      ],
    );
    expect(r.error).toBeNull();
    expect(r.extractedContent).toContain("Uploaded 'cover.png' to [INPUT] at index 30");
    expect(browser.setFileInputCalls).toEqual([
      { backendNodeId: 30, filePath: "/up/cover.png", ids: null },
    ]);
    // 验证开启：探针 undefined → 无定论引导追加（best-effort 非阻塞）
    expect(r.extractedContent).toContain("ℹ️ File was set on the input successfully");
  });
  it("非 file input + 唯一 input → 自动切 + ℹ️ 注记；accept 不匹配 → ℹ️ Note", async () => {
    const browser = new FakeBrowser();
    const dropzone = makeNode({ nodeName: "div", backendNodeId: 40 });
    // 唯一 file input（accept 不含 png 之外……用 accept=video/* 制造不匹配）
    const realInput = makeNode({
      nodeName: "input",
      attributes: { type: "file", accept: "video/*" },
      backendNodeId: 41,
    });
    const r = await baseRun(
      browser,
      new Map([
        [40, dropzone],
        [41, realInput],
      ]),
      { path: "/up/cover.png", index: 40 },
      [41],
      [
        {
          backend_node_id: 41,
          accept: "video/*",
          visible: true,
          upload_ancestor: false,
          class_name: "",
        },
      ],
    );
    expect(r.error).toBeNull();
    expect(r.extractedContent).toContain(
      "ℹ️ index 40 is not a file input; uploaded to the only file input on the page (backendNodeId=41).",
    );
    expect(r.extractedContent).toContain(
      'ℹ️ Note: file extension does not match this input\'s accept="video/*".',
    );
    expect(browser.setFileInputCalls[0]?.backendNodeId).toBe(41);
  });
  it("多 input + replace class（Semi 双 input）→ 纠偏到 hidden-input + ⚠️ 注记", async () => {
    const browser = new FakeBrowser();
    const replaceInput = makeNode({
      nodeName: "input",
      attributes: { type: "file", class: "semi-upload-replace-input" },
      backendNodeId: 51,
    });
    const r = await baseRun(
      browser,
      new Map([[51, replaceInput]]),
      { path: "/up/cover.png", index: 51 },
      [51, 52],
      [
        {
          backend_node_id: 51,
          accept: "image/*",
          visible: false,
          upload_ancestor: true,
          class_name: "semi-upload-replace-input",
        },
        {
          backend_node_id: 52,
          accept: "image/*",
          visible: false,
          upload_ancestor: true,
          class_name: "semi-upload-hidden-input",
        },
      ],
    );
    expect(r.extractedContent).toContain("⚠️ You picked [51] which is a replace(替换封面)");
    expect(r.extractedContent).toContain("Auto-switched to [52].");
    expect(browser.setFileInputCalls[0]?.backendNodeId).toBe(52);
  });
  it("多 input 保持选择 → 软警告；非 input 无 input 可用 → error", async () => {
    const browser = new FakeBrowser();
    const plainInput = makeNode({
      nodeName: "input",
      attributes: { type: "file" },
      backendNodeId: 61,
    });
    const r = await baseRun(
      browser,
      new Map([[61, plainInput]]),
      { path: "/up/cover.png", index: 61 },
      [61, 62],
      [
        { backend_node_id: 61, accept: "", visible: true, upload_ancestor: true, class_name: "" },
        { backend_node_id: 62, accept: "", visible: true, upload_ancestor: true, class_name: "" },
      ],
    );
    expect(r.extractedContent).toContain(
      "⚠️ Page has 2 file inputs; uploaded to the one you specified (index 61).",
    );
    expect(r.extractedContent).toContain(
      // Python f-string repr 列表带空格（[61, 62]——venv 锚定）
      "Likely-live candidates (visible + upload container): [61, 62].",
    );

    const browser2 = new FakeBrowser();
    const dropzone = makeNode({ nodeName: "div", backendNodeId: 70 });
    const none = await baseRun(
      browser2,
      new Map([[70, dropzone]]),
      { path: "/up/cover.png", index: 70 },
      [],
      [],
    );
    expect(none.error).toBe("Element is not a file input and no file input found on page");
  });
  it("多 input + dropzone → label 发现 chooser 命中/失败两路", async () => {
    // label 兄弟（class upload）→ findUploadLabelNear 命中 82
    const label = makeNode({
      nodeName: "label",
      attributes: { class: "btn upload" },
      backendNodeId: 82,
    });
    const dropzone = makeNode({ nodeName: "div", backendNodeId: 80 });
    label.parentNode = dropzone;
    dropzone.childrenNodes = [label];
    const meta = [
      { backend_node_id: 81, accept: "", visible: false, upload_ancestor: false, class_name: "" },
      { backend_node_id: 83, accept: "", visible: false, upload_ancestor: false, class_name: "" },
    ];
    const hit = new FakeBrowser();
    hit.discoverResult = 83;
    const r = await baseRun(
      hit,
      new Map([
        [80, dropzone],
        [82, label],
      ]),
      { path: "/up/cover.png", index: 80 },
      [81, 83],
      meta,
    );
    expect(hit.discoverCalls).toEqual([82]);
    expect(r.extractedContent).toContain(
      "ℹ️ index 80 is not a file input; clicked its upload button and uploaded to the file input the page opened (backendNodeId=83).",
    );
    const missBrowser = new FakeBrowser();
    missBrowser.discoverResult = null;
    const miss = await baseRun(
      missBrowser,
      new Map([
        [80, dropzone],
        [82, label],
      ]),
      { path: "/up/cover.png", index: 80 },
      [81, 83],
      meta,
    );
    expect(miss.error).toContain(
      "Element 80 is not a file input, and clicking its upload button did not open a file chooser",
    );
  });
  it("clue 采集命中 → metadata.upload_clue；验证关闭 → 无引导文案", async () => {
    const browser = new FakeBrowser();
    browser.evalFunctionResults = {
      30: {
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
      },
    };
    const node = makeNode({
      nodeName: "input",
      attributes: { type: "file", accept: "image/png" },
      backendNodeId: 30,
    });
    Object.defineProperty(node, "xpath", { value: "//input" });
    node.snapshotNode = { bounds: { x: 0, y: 0, width: 0, height: 0 } } as never;
    const r = await baseRun(
      browser,
      new Map([[30, node]]),
      { path: "/up/cover.png", index: 30 },
      [30],
      [],
      { uploadVerifyEnabled: false },
    );
    expect(r.metadata).toEqual({ upload_clue: FIXTURE.buildUploadClue });
    expect(r.extractedContent).not.toContain("File was set on the input successfully");
  });
});

describe("probeUploadSignals / verifyUpload / uploadInputContexts 单元", () => {
  it("probe：JSON 串解析 / 对象直用 / 非法 / 抛错 → null", async () => {
    const mk = (result: unknown, throwErr = false) =>
      ({
        executeJs: async () => {
          if (throwErr) throw new Error("cdp down");
          return result;
        },
      }) as unknown as FakeBrowser;
    const { probeUploadSignals } = await import("../../src/tools/actions/upload-file.js");
    expect(
      await probeUploadSignals(mk(JSON.stringify({ canvases: 2, imgPreviews: 1, bgPreviews: 0 }))),
    ).toEqual([2, 1, 0]);
    expect(await probeUploadSignals(mk({ canvases: 1, imgPreviews: 3, bgPreviews: 4 }))).toEqual([
      1, 3, 4,
    ]);
    expect(await probeUploadSignals(mk(42))).toBeNull();
    expect(await probeUploadSignals(mk(undefined, true))).toBeNull();
  });
  it("verify：delta 命中 ✅ / 无 delta → 无定论 / before null → 无定论 / 关闭 → 空串", async () => {
    const { verifyUpload } = await import("../../src/tools/actions/upload-file.js");
    const { tools } = makeTools();
    let n = 0;
    const growing = {
      executeJs: async () => JSON.stringify({ canvases: n, imgPreviews: 0, bgPreviews: 0 }),
    } as unknown as FakeBrowser;
    n = 1;
    const ok = await verifyUpload(growing, [0, 0, 0], "a.png", tools.ctx);
    expect(ok).toContain("✅ Upload verified on page: new <canvas> preview appeared (count 0→1).");
    const flat = {
      executeJs: async () => JSON.stringify({ canvases: 0, imgPreviews: 0, bgPreviews: 0 }),
    } as unknown as FakeBrowser;
    expect(await verifyUpload(flat, [0, 0, 0], "a.png", tools.ctx)).toContain(
      "File was set on the input successfully",
    );
    expect(await verifyUpload(flat, null, "a.png", tools.ctx)).toContain(
      "File was set on the input successfully",
    );
    const { tools: off } = makeTools({ uploadVerifyEnabled: false });
    expect(await verifyUpload(flat, [0, 0, 0], "a.png", off.ctx)).toBe("");
  });
  it("uploadInputContexts：对齐命中 / 数量不符 / 非 list / 异常 → 降级", async () => {
    const { uploadInputContexts, UPLOAD_INPUT_CONTEXTS_JS } = await import(
      "../../src/tools/actions/upload-identity.js"
    );
    const mk = (result: unknown, throwErr = false) => ({
      executeJs: async (code: string) => {
        if (throwErr) throw new Error("x");
        expect(code).toBe(UPLOAD_INPUT_CONTEXTS_JS);
        return result;
      },
    });
    const candidates: Array<[number, ReturnType<typeof makeNode>]> = [
      [1, makeNode({ nodeName: "input", backendNodeId: 1 })],
      [2, makeNode({ nodeName: "input", backendNodeId: 2 })],
    ];
    const aligned = await uploadInputContexts(
      mk([
        { accept: "image/png", label_text: "a" },
        { accept: "image/png", label_text: "b" },
      ]),
      candidates,
      "image",
    );
    expect(aligned.get(1)?.label_text).toBe("a");
    expect(aligned.get(2)?.label_text).toBe("b");
    expect(
      await uploadInputContexts(mk([{ accept: "image/png" }]), candidates, "image").then(
        (m) => m.size,
      ),
    ).toBe(0);
    expect(await uploadInputContexts(mk("nope"), candidates, "").then((m) => m.size)).toBe(0);
    expect(await uploadInputContexts(mk(undefined, true), candidates, "").then((m) => m.size)).toBe(
      0,
    );
    expect(await uploadInputContexts(mk([]), [], "").then((m) => m.size)).toBe(0);
  });
});

describe("dropdown/select 错误映射与 combobox 写路由", () => {
  it("dropdown_options CDP 异常 → Failed to read dropdown options", async () => {
    const node = makeNode({ nodeName: "select", backendNodeId: 9 });
    const { tools } = makeTools();
    const throwBrowser = new FakeBrowser();
    (throwBrowser as unknown as { fetchSelectOptions: () => Promise<never> }).fetchSelectOptions =
      () => Promise.reject(new Error("cdp boom"));
    const r = await tools.execute(
      "dropdown_options",
      { index: 9 },
      throwBrowser,
      stateOf(new Map([[9, node]])),
    );
    expect(r.error).toBe("Failed to read dropdown options: cdp boom");
  });
  it("select_dropdown combobox（role+aria-controls 输入框）→ setComboboxOption", async () => {
    const browser = new FakeBrowser();
    browser.setterResults = { zz: { success: true, message: "combo ok" } };
    const node = makeNode({
      nodeName: "input",
      attributes: { role: "combobox", "aria-controls": "lb" },
      backendNodeId: 15,
    });
    const { tools } = makeTools();
    const r = await tools.execute(
      "select_dropdown",
      { index: 15, value: "zz" },
      browser,
      stateOf(new Map([[15, node]])),
    );
    expect(r.extractedContent).toBe("combo ok");
    expect(r.longTermMemory).toBe('Selected "zz" in [INPUT] at index 15');
  });
  it("select_dropdown setter 抛错 → Failed to select option", async () => {
    const browser = new FakeBrowser();
    (browser as unknown as { setSelectOption: () => Promise<never> }).setSelectOption = () =>
      Promise.reject(new Error("oops"));
    const node = makeNode({ nodeName: "select", backendNodeId: 16 });
    const { tools } = makeTools();
    const r = await tools.execute(
      "select_dropdown",
      { index: 16, value: "v" },
      browser,
      stateOf(new Map([[16, node]])),
    );
    expect(r.error).toBe("Failed to select option: oops");
  });
});

describe("补面：multi error 原因档与 value 显式 null 边界", () => {
  it("multi 失败无 missed 但有 error → reason 走 error 档", async () => {
    const browser = new FakeBrowser();
    browser.setterResults = {
      multi: { success: false, error: "framework reverted", availableOptions: [{ value: "a" }] },
    };
    const node = makeNode({ nodeName: "select", backendNodeId: 7 });
    const { tools } = makeTools();
    const r = await tools.execute(
      "select_dropdown",
      { index: 7, values: ["a"] },
      browser,
      stateOf(new Map([[7, node]])),
    );
    expect(r.extractedContent).toContain("framework reverted\n");
    expect(r.longTermMemory).toBe(
      'Couldn\'t select ["a"] in [SELECT] at index 7 (framework reverted)',
    );
  });
  it("value=null 与 values=null 视同未传（显式 null 守卫边界）", async () => {
    const browser = new FakeBrowser();
    const node = makeNode({ nodeName: "select", backendNodeId: 7 });
    const { tools } = makeTools();
    const r = await tools.execute(
      "select_dropdown",
      { index: 7, value: null, values: null },
      browser,
      stateOf(new Map([[7, node]])),
    );
    expect(r.error).toBe(
      "select_dropdown requires value (single option) or values (multi-select list)",
    );
  });
  it("multi 失败 available 空且无 error → 缺省 Failed 文案", async () => {
    const browser = new FakeBrowser();
    const node = makeNode({ nodeName: "select", backendNodeId: 7 });
    const { tools } = makeTools();
    const r = await tools.execute(
      "select_dropdown",
      { index: 7, values: ["a"] },
      browser,
      stateOf(new Map([[7, node]])),
    );
    expect(r.error).toBe('Failed to select options: ["a"]');
  });
});

describe("补面：setFileInput 失败映射", () => {
  it("CDP 设文件抛错 → File upload failed", async () => {
    const browser = new FakeBrowser();
    browser.setFileInputError = new Error("node detached");
    const node = makeNode({
      nodeName: "input",
      attributes: { type: "file" },
      backendNodeId: 30,
    });
    const { tools } = makeTools({ uploadVerifyEnabled: false });
    tools.ctx.fs = makeFakeFs({ "/up/cover.png": "PNG" });
    const r = await tools.execute(
      "upload_file",
      { path: "/up/cover.png", index: 30 },
      browser,
      stateOf(
        new Map([[30, node]]),
        [30],
        [
          {
            backend_node_id: 30,
            accept: "",
            visible: true,
            upload_ancestor: false,
            class_name: "",
          },
        ],
      ),
    );
    expect(r.error).toBe("File upload failed: node detached");
    expect(browser.highlighted).toEqual([30]);
  });
});
