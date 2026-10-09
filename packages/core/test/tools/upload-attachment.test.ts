// M5 段 C 缝一红绿双向：附件 ref 二态（readAttachment 命中 → bytes 注入通道，
// 跳路径白名单与 isFile/stat；未命中/无可选方法 → 原路径分支逐字节不动）。
// 红向保真：makeFakeFs（无 readAttachment）+ 路径形态全部沿用既有行为与文案。

import { SerializedDOMState } from "@tw/dom-snapshot";
import { describe, expect, it } from "vitest";
import type { BrowserStateSummary } from "../../src/browser/views.js";
import type { Tools } from "../../src/tools/actions/index.js";
import type { AttachmentPayload, FileSystemProvider } from "../../src/tools/fs.js";
import { DEFAULT_MAX_ATTACHMENT_BYTES } from "../../src/tools/settings.js";
import { FakeBrowser, makeNode, makeTools } from "./fake-browser.js";
import { makeFakeFs } from "./fake-fs.js";

const ATT: AttachmentPayload = {
  base64: "QUJD",
  filename: "video.mp4",
  mimeType: "video/mp4",
  size: 3,
};

/** makeFakeFs + 可编程 readAttachment（命中表外的 ref → null） */
function makeAttachmentFs(
  attachments: Record<string, AttachmentPayload>,
  files: Record<string, string> = {},
): FileSystemProvider {
  return {
    ...makeFakeFs(files),
    readAttachment: async (ref: string) => attachments[ref] ?? null,
  };
}

const fileInputNode = (backendNodeId: number, accept = "") =>
  makeNode({
    nodeName: "input",
    attributes: { type: "file", ...(accept === "" ? {} : { accept }) },
    backendNodeId,
  });

const stateOf = (selectorMap: Map<number, ReturnType<typeof makeNode>>): BrowserStateSummary => ({
  url: "https://a.example",
  title: "A",
  tabs: [{ targetId: "ABCD1234", url: "https://a.example", title: "A" }],
  domState: new SerializedDOMState(
    { tag: "html" } as never,
    selectorMap,
    "[1] input",
    [30],
    [{ backend_node_id: 30, accept: "", visible: true, upload_ancestor: false, class_name: "" }],
  ),
  screenshot: null,
  gridMeta: null,
  recentEvents: [],
});

const runWith = async (
  fs: FileSystemProvider,
  browser: FakeBrowser,
  params: Record<string, unknown>,
  toolsOptions: ConstructorParameters<typeof Tools>[0] = {},
) => {
  const { tools } = makeTools(toolsOptions);
  tools.ctx.fs = fs;
  const node = fileInputNode(30);
  return tools.execute("upload_file", params, browser, stateOf(new Map([[30, node]])));
};

describe("附件分支（绿向：命中 → bytes 注入通道）", () => {
  it("命中 → setFileInputData 收到 payload 与 backendId；回显用 filename", async () => {
    const browser = new FakeBrowser();
    const r = await runWith(makeAttachmentFs({ "attachment:att_1": ATT }), browser, {
      path: "attachment:att_1",
      index: 30,
    });
    expect(r.error).toBeNull();
    expect(browser.setFileInputDataCalls).toEqual([
      { backendNodeId: 30, filename: "video.mp4", size: 3 },
    ]);
    expect(browser.setFileInputCalls).toEqual([]); // 路径通道未被触碰
    expect(browser.highlighted).toEqual([30]);
    expect(r.extractedContent).toContain("Uploaded 'video.mp4' to [INPUT] at index 30");
  });

  it("白名单不拦附件（allowedUploadPaths 不含 ref 也不报错）", async () => {
    const browser = new FakeBrowser();
    const r = await runWith(
      makeAttachmentFs({ "attachment:att_1": ATT }),
      browser,
      { path: "attachment:att_1", index: 30 },
      { allowedUploadPaths: ["/safe/dir"] },
    );
    expect(r.error).toBeNull();
    expect(browser.setFileInputDataCalls).toHaveLength(1);
  });

  it("size===0 → 空文件文案（沿用路径分支文案形态，ref 原样）", async () => {
    const browser = new FakeBrowser();
    const r = await runWith(
      makeAttachmentFs({ "attachment:att_9": { ...ATT, size: 0 } }),
      browser,
      { path: "attachment:att_9", index: 30 },
    );
    expect(r.error).toBe("File is empty: attachment:att_9");
    expect(browser.setFileInputDataCalls).toEqual([]);
  });

  it("体积超上限 → 快速失败可操作 error（不触注入通道；轮 1 [1]）", async () => {
    const browser = new FakeBrowser();
    const r = await runWith(
      makeAttachmentFs({ "attachment:att_1": { ...ATT, size: 100 } }),
      browser,
      { path: "attachment:att_1", index: 30 },
      { maxAttachmentBytes: 99 },
    );
    expect(r.error).toBe(
      "Attachment too large for data channel upload: attachment:att_1 (100 bytes > 99 bytes limit)",
    );
    expect(browser.setFileInputDataCalls).toEqual([]);
  });

  it("上限边界：恰等放行；显式 null 解除；构造缺省 32MB", async () => {
    const browser = new FakeBrowser();
    const atLimit = await runWith(
      makeAttachmentFs({ "attachment:att_1": { ...ATT, size: 99 } }),
      browser,
      { path: "attachment:att_1", index: 30 },
      { maxAttachmentBytes: 99 },
    );
    expect(atLimit.error).toBeNull();
    expect(browser.setFileInputDataCalls).toHaveLength(1);

    const browser2 = new FakeBrowser();
    const uncapped = await runWith(
      makeAttachmentFs({ "attachment:att_1": { ...ATT, size: 999 } }),
      browser2,
      { path: "attachment:att_1", index: 30 },
      { maxAttachmentBytes: null },
    );
    expect(uncapped.error).toBeNull();

    const { tools } = makeTools();
    expect(tools.ctx.maxAttachmentBytes).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
  });

  it("注入通道抛错 → File upload failed (data channel) 前缀 + 页面 error 上翻", async () => {
    const browser = new FakeBrowser();
    browser.setFileInputDataError = new Error("Target is not an <input type=file>.");
    const r = await runWith(makeAttachmentFs({ "attachment:att_1": ATT }), browser, {
      path: "attachment:att_1",
      index: 30,
    });
    expect(r.error).toBe("File upload failed (data channel): Target is not an <input type=file>.");
  });

  it("accept 软校验与回显均以 filename 计（displayPath 语义）", async () => {
    const browser = new FakeBrowser();
    const { tools } = makeTools();
    tools.ctx.fs = makeAttachmentFs({ "attachment:att_1": ATT });
    const node = fileInputNode(30, "image/png");
    const r = await tools.execute(
      "upload_file",
      { path: "attachment:att_1", index: 30 },
      browser,
      stateOf(new Map([[30, node]])),
    );
    expect(r.error).toBeNull();
    // filename=video.mp4 不匹配 accept=image/png → 软校验注记照发
    expect(r.extractedContent).toContain(`accept="image/png"`);
    expect(browser.setFileInputDataCalls).toEqual([
      { backendNodeId: 30, filename: "video.mp4", size: 3 },
    ]);
  });
});

describe("路径分支（红向：保真——未命中回原路径行为）", () => {
  it("readAttachment 返回 null（未注册 ref）→ 走路径分支（File not found）", async () => {
    const browser = new FakeBrowser();
    const r = await runWith(makeAttachmentFs({}, { "/up/a.png": "P" }), browser, {
      path: "/up/ghost.png",
      index: 30,
    });
    expect(r.error).toBe("File not found: /up/ghost.png");
    expect(browser.setFileInputDataCalls).toEqual([]);
  });

  it("fs 无 readAttachment（makeFakeFs 形态）+ 路径存在 → 原路径分支直传", async () => {
    const browser = new FakeBrowser();
    const r = await runWith(makeFakeFs({ "/up/a.png": "PNG" }), browser, {
      path: "/up/a.png",
      index: 30,
    });
    expect(r.error).toBeNull();
    expect(browser.setFileInputCalls).toEqual([
      { backendNodeId: 30, filePath: "/up/a.png", ids: null },
    ]);
    expect(browser.setFileInputDataCalls).toEqual([]);
  });

  it("白名单拦截文案原样（附件表为空——不软化路径校验）", async () => {
    const browser = new FakeBrowser();
    const r = await runWith(
      makeAttachmentFs({}, { "/up/a.png": "P" }),
      browser,
      { path: "/up/a.png", index: 30 },
      { allowedUploadPaths: ["/ok"] },
    );
    expect(r.error).toBe("File path not in allowed upload paths: /up/a.png");
  });

  it("fs 为 null → 原文案（no filesystem provider injected）", async () => {
    const browser = new FakeBrowser();
    const { tools } = makeTools();
    tools.ctx.fs = null;
    const node = fileInputNode(30);
    const r = await tools.execute(
      "upload_file",
      { path: "attachment:att_1", index: 30 },
      browser,
      stateOf(new Map([[30, node]])),
    );
    expect(r.error).toBe("File upload failed: no filesystem provider injected");
  });
});
