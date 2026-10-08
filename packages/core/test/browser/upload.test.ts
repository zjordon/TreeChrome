// 上传族 session 层集成（FakeCdpTransport）：setFileInput 直设 + fallback 链
// （显式 bid → ids[0] → shadow DOM 搜索 → 抛错）/ discoverFileInputViaClick
// （拦截守卫拒点 / chooser 命中返回 bid / 超时 null——假钟推进）/
// setFileInputData bytes 注入（M5 段 C）。

import { describe, expect, it } from "vitest";
import {
  discoverFileInputViaClick,
  SET_FILE_INPUT_DATA_FN,
  setFileInput,
  setFileInputData,
  walkForFileInputs,
} from "../../src/browser/upload.js";
import { makeInternals } from "./fake-transport.js";

const clickChain = (h: ReturnType<typeof makeInternals>) => {
  h.transport
    .respond("DOM.scrollIntoViewIfNeeded", {})
    .respond("Runtime.evaluate", (p: Record<string, unknown>) => {
      if (String(p.expression ?? "").includes("clientWidth")) {
        return { result: { value: [1280, 720] } };
      }
      return { result: { value: undefined } };
    })
    .respond("DOM.getContentQuads", { quads: [[10, 10, 110, 10, 110, 40, 10, 40]] })
    .respond("Input.dispatchMouseEvent", {})
    .respond("DOM.resolveNode", (params: Record<string, unknown> | undefined) =>
      params?.backendNodeId === undefined
        ? {}
        : { object: { objectId: `obj-${params.backendNodeId}` } },
    )
    .respond("Runtime.callFunctionOn", { result: { value: undefined } });
};

describe("setFileInput（DOM.setFileInputFiles 直设）", () => {
  it("显式 bid 直发；null + ids → 首个；null 无 ids → shadow 搜索首个", async () => {
    const h = makeInternals();
    h.transport.respond("DOM.setFileInputFiles", {});
    await setFileInput(h.s, 42, "/tmp/a.png");
    const frame = h.transport.framesOf("DOM.setFileInputFiles")[0];
    expect(frame?.params).toEqual({ backendNodeId: 42, files: ["/tmp/a.png"] });

    const h2 = makeInternals();
    h2.transport.respond("DOM.setFileInputFiles", {});
    await setFileInput(h2.s, null, "/tmp/b.png", [71, 72]);
    expect(h2.transport.framesOf("DOM.setFileInputFiles")[0]?.params).toEqual({
      backendNodeId: 71,
      files: ["/tmp/b.png"],
    });

    const h3 = makeInternals();
    h3.transport
      .respond("DOM.getDocument", {
        root: {
          nodeName: "#document",
          backendNodeId: 1,
          attributes: [],
          children: [
            {
              nodeName: "HTML",
              backendNodeId: 2,
              attributes: [],
              children: [
                {
                  nodeName: "INPUT",
                  backendNodeId: 99,
                  attributes: ["type", "file"],
                  children: [],
                },
              ],
            },
          ],
        },
      })
      .respond("DOM.setFileInputFiles", {});
    await setFileInput(h3.s, null, "/tmp/c.png", []);
    expect(h3.transport.framesOf("DOM.setFileInputFiles")[0]?.params).toEqual({
      backendNodeId: 99,
      files: ["/tmp/c.png"],
    });
    expect(h3.logs.some((l) => l.includes("Found file input in shadow DOM"))).toBe(true);
  });
  it("全部落空 → 抛 Python 同款文案", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.getDocument", { root: { nodeName: "#document", children: [] } })
      .respond("DOM.setFileInputFiles", {});
    await expect(setFileInput(h.s, null, "/tmp/x.png")).rejects.toThrow(
      "No file input element found. Ensure the page has an <input type='file'> element.",
    );
    expect(h.transport.framesOf("DOM.setFileInputFiles")).toHaveLength(0);
  });
});

describe("discoverFileInputViaClick（file-chooser 拦截消费）", () => {
  it("拦截未启用 → 拒点直接 null（不发送任何点击帧）", async () => {
    const h = makeInternals();
    h.s.fileChooserInterceptEnabled = false;
    clickChain(h);
    const r = await discoverFileInputViaClick(h.s, 5);
    expect(r).toBeNull();
    expect(h.transport.framesOf("Input.dispatchMouseEvent")).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("refusing to click"))).toBe(true);
  });
  it("点击后 chooser 命中 → 返回其 backendNodeId", async () => {
    const h = makeInternals();
    h.s.fileChooserInterceptEnabled = true;
    clickChain(h);
    // click 的 mousePressed 到达后 chooser 命中（connection.ts 监听器的等效注入——
    // makeInternals 不接 chooser 监听，直接写 lastFileChooser 模拟）
    h.transport.respond("Input.dispatchMouseEvent", (p: Record<string, unknown>) => {
      if (p.type === "mousePressed") {
        h.s.lastFileChooser = {
          backendNodeId: 88,
          mode: "selectSingle",
          frameId: null,
          sessionId: null,
          ts: h.s.now(),
        };
      }
      return {};
    });
    const r = await discoverFileInputViaClick(h.s, 5, 1000);
    expect(r).toBe(88);
    expect(h.logs.some((l) => l.includes("opened file input backendNodeId=88"))).toBe(true);
  });
  it("超时无 chooser → null（假钟由 sleep 推进翻过 deadline）", async () => {
    const h = makeInternals();
    h.s.fileChooserInterceptEnabled = true;
    clickChain(h);
    const r = await discoverFileInputViaClick(h.s, 5, 90);
    expect(r).toBeNull();
    expect(h.logs.some((l) => l.includes("opened no file chooser within 0.1s"))).toBe(true);
  });
});

describe("补面：walk 边界与 chooser 非数字 bid", () => {
  it("contentDoc 非记录跳过；无扩展名/无 accept 字段形态", () => {
    expect(
      walkForFileInputs({
        nodeName: "IFRAME",
        backendNodeId: 1,
        attributes: [],
        children: [],
        contentDocument: 42,
      }),
    ).toEqual([]);
    expect(
      walkForFileInputs({
        nodeName: "INPUT",
        backendNodeId: 2,
        attributes: ["type", "file"],
        children: [],
      }),
    ).toEqual([2]);
    expect(
      walkForFileInputs({
        nodeName: "INPUT",
        backendNodeId: 3,
        attributes: "garbage",
        children: [],
      }),
    ).toEqual([]);
  });
  it("chooser 命中但 backendNodeId 非数字 → null", async () => {
    const h = makeInternals();
    h.s.fileChooserInterceptEnabled = true;
    clickChain(h);
    h.transport.respond("Input.dispatchMouseEvent", (p: Record<string, unknown>) => {
      if (p.type === "mousePressed") {
        h.s.lastFileChooser = {
          backendNodeId: null,
          mode: "selectSingle",
          frameId: null,
          sessionId: null,
          ts: h.s.now(),
        };
      }
      return {};
    });
    const r = await discoverFileInputViaClick(h.s, 5, 1000);
    expect(r).toBeNull();
  });
  it("getDocument 抛错 → findFileInputsInShadowDom 返回 []", async () => {
    const h = makeInternals();
    h.transport.failOn("DOM.getDocument", new Error("denied"));
    const { findFileInputsInShadowDom } = await import("../../src/browser/upload.js");
    expect(await findFileInputsInShadowDom(h.s)).toEqual([]);
    expect(h.logs.some((l) => l.includes("DOM.getDocument(pierce) failed"))).toBe(true);
  });
});

describe("setFileInputData（bytes → 页面内注入，M5 段 C）", () => {
  const PAYLOAD = { base64: "QUJD", filename: "clip.mp4", mimeType: "video/mp4", size: 3 };
  const chain = (h: ReturnType<typeof makeInternals>, value: unknown) => {
    h.transport
      .respond("DOM.resolveNode", (p: Record<string, unknown> | undefined) =>
        p?.backendNodeId === undefined ? {} : { object: { objectId: `obj-${p.backendNodeId}` } },
      )
      .respond("Runtime.callFunctionOn", { result: { value } });
  };
  it("成功链：resolveNode → callFunctionOn（objectId/函数体/参数逐项锚定）+ 日志行", async () => {
    const h = makeInternals();
    chain(h, { success: true, dispatched: true, name: "clip.mp4", size: 3, type: "video/mp4" });
    await setFileInputData(h.s, 77, PAYLOAD);
    const resolve = h.transport.framesOf("DOM.resolveNode")[0];
    expect(resolve?.params).toEqual({ backendNodeId: 77 });
    const call = h.transport.framesOf("Runtime.callFunctionOn")[0];
    expect(call?.params).toEqual({
      objectId: "obj-77",
      functionDeclaration: SET_FILE_INPUT_DATA_FN,
      arguments: [{ value: "QUJD" }, { value: "clip.mp4" }, { value: "video/mp4" }],
      returnByValue: true,
    });
    expect(
      h.logs.some((l) => l === "set_file_input_data: backend_node_id=77, file=clip.mp4, size=3"),
    ).toBe(true);
  });
  it("页面返回 success=false → 抛页面 error 文案（非 file input 分支）", async () => {
    const h = makeInternals();
    chain(h, {
      success: false,
      dispatched: false,
      error: "Target is not an <input type=file>.",
    });
    await expect(setFileInputData(h.s, 8, PAYLOAD)).rejects.toThrow(
      "Target is not an <input type=file>.",
    );
  });
  it("页面返回非对象（undefined/无 error 字段）→ 兜底文案", async () => {
    const h1 = makeInternals();
    chain(h1, undefined);
    await expect(setFileInputData(h1.s, 8, PAYLOAD)).rejects.toThrow(
      "The page did not return an upload result.",
    );
    const h2 = makeInternals();
    chain(h2, { success: false });
    await expect(setFileInputData(h2.s, 8, PAYLOAD)).rejects.toThrow(
      "The page did not return an upload result.",
    );
  });
  it("resolveNode 未返回 objectId → 抛错（不上页面）", async () => {
    const h = makeInternals();
    h.transport.respond("DOM.resolveNode", {});
    await expect(setFileInputData(h.s, 8, PAYLOAD)).rejects.toThrow(
      "setFileInputData: resolveNode 未返回 objectId",
    );
    expect(h.transport.framesOf("Runtime.callFunctionOn")).toHaveLength(0);
  });
  it("注入函数体逐句锚定：File/DataTransfer/files 赋值与 input+change 双 dispatch", () => {
    expect(SET_FILE_INPUT_DATA_FN).toContain(
      "if (!(this instanceof HTMLInputElement) || this.type !== 'file')",
    );
    expect(SET_FILE_INPUT_DATA_FN).toContain("const file = new File([bytes], filename,");
    expect(SET_FILE_INPUT_DATA_FN).toContain("const transfer = new DataTransfer();");
    expect(SET_FILE_INPUT_DATA_FN).toContain("this.files = transfer.files;");
    expect(SET_FILE_INPUT_DATA_FN).toContain(
      "this.dispatchEvent(new Event('input', { bubbles: true }));",
    );
    expect(SET_FILE_INPUT_DATA_FN).toContain(
      "this.dispatchEvent(new Event('change', { bubbles: true }));",
    );
  });
});
