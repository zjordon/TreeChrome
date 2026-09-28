// printToPdf（browser/screenshot.ts :100-148）参数映射与失败分支——save_as_pdf
// 动作（P4b 段 1）的 session 侧依赖，此前整函数无测试。

import { describe, expect, it } from "vitest";
import { printToPdf } from "../../src/browser/screenshot.js";
import { makeInternals } from "./fake-transport.js";

describe("printToPdf", () => {
  it("缺省参数映射（letter/inches 精度、printBackground 恒发）", async () => {
    const h = makeInternals();
    h.transport.respond("Page.printToPDF", { data: "QUJD" }); // "ABC"
    const bytes = await printToPdf(h.s);
    expect(new TextDecoder().decode(bytes)).toBe("ABC");
    const frame = h.transport.framesOf("Page.printToPDF")[0];
    expect(frame.params).toEqual({
      printBackground: true,
      landscape: false,
      scale: 1.0,
      paperWidth: 8.5,
      paperHeight: 11,
      preferCSSPageSize: true,
    });
  });
  it("paper 格式映射与显式选项", async () => {
    const h = makeInternals();
    h.transport.respond("Page.printToPDF", { data: "" });
    await printToPdf(h.s, {
      paperFormat: "a4",
      landscape: true,
      printBackground: false,
      scale: 0.5,
    });
    const params = h.transport.framesOf("Page.printToPDF")[0].params as Record<string, number>;
    expect(params.paperWidth).toBeCloseTo(8.27, 2);
    expect(params.paperHeight).toBeCloseTo(11.69, 2);
    expect(params.landscape).toBe(true);
    expect(params.printBackground).toBe(false);
    expect(params.scale).toBe(0.5);
  });
  it("CDP 失败上抛 + 无 data 报错", async () => {
    const h = makeInternals();
    h.transport.failOn("Page.printToPDF", new Error("printing not available"));
    await expect(printToPdf(h.s)).rejects.toThrow("printing not available");
    const h2 = makeInternals();
    h2.transport.respond("Page.printToPDF", {});
    await expect(printToPdf(h2.s)).rejects.toThrow("no data returned");
  });
});
