// 交互模块测试：navigation（settle 两版/kick/scroll）、element-pointer（三级回退/
// 遮挡/JS 点击）、text-input（拼接守卫/框架事件/键码）、keyboard（三路由）、tabs、
// screenshot（护栏文案保真）、evaluate-basic（修复器/扫描/候选/归一化）、dom-access、
// grid-meta。时序间隔经假 sleep 断言序列（勿优化清单）。

import { DOMRect } from "@tw/dom-snapshot";
import { describe, expect, it } from "vitest";
import { getPageHtml } from "../../src/browser/dom-access.js";
import { bestQuadRect, clickElement } from "../../src/browser/element-pointer.js";
import {
  delimiterScan,
  normalizeEvalResult,
  syntaxRepairCandidates,
  validateAndFixJavascript,
} from "../../src/browser/evaluate-basic.js";
import { readGridMeta } from "../../src/browser/grid-meta.js";
import { sendKeys } from "../../src/browser/keyboard.js";
import { goBack, navigate, scroll, waitForPageSettle } from "../../src/browser/navigation.js";
import { printToPdf, takeScreenshot } from "../../src/browser/screenshot.js";
import { closeTab, createTab, switchTab } from "../../src/browser/tabs.js";
import {
  clearTextField,
  getCharModifiersAndVk,
  getKeyCodeForChar,
  requiresDirectValueAssignment,
  typeText,
} from "../../src/browser/text-input.js";
import { makeInternals, scriptConnect } from "./fake-transport.js";

function evalValue(value: unknown) {
  return { result: { value } };
}

describe("navigation", () => {
  it("navigate：清缓存 + transitionType + errorText 抛错 + settle", async () => {
    const h = makeInternals();
    h.transport.respond("Page.navigate", {}).respond("Runtime.evaluate", evalValue("complete"));
    await navigate(h.s, "https://example.com/");
    const nav = h.transport.framesOf("Page.navigate");
    expect(nav[0].params).toEqual({ url: "https://example.com/", transitionType: "address_bar" });
    const h2 = makeInternals();
    h2.transport.respond("Page.navigate", { errorText: "net::ERR_NAME_NOT_RESOLVED" });
    await expect(navigate(h2.s, "https://nope/")).rejects.toThrow(
      "Navigation failed: net::ERR_NAME_NOT_RESOLVED",
    );
  });
  it("goBack：清缓存、取历史、无历史返 null", async () => {
    const h = makeInternals();
    h.transport
      .respond("Page.getNavigationHistory", {
        currentIndex: 2,
        entries: [
          { id: 1, url: "https://a/" },
          { id: 5, url: "https://b/" },
          { id: 9, url: "https://c/" },
        ],
      })
      .respond("Page.navigateToHistoryEntry", {})
      .respond("Runtime.evaluate", evalValue("complete"));
    expect(await goBack(h.s)).toBe("https://b/");
    expect(h.transport.framesOf("Page.navigateToHistoryEntry")[0].params).toEqual({ entryId: 5 });
    const h2 = makeInternals();
    h2.transport.respond("Page.getNavigationHistory", { currentIndex: 0, entries: [] });
    expect(await goBack(h2.s)).toBeNull();
  });
  it("waitForPageSettle：no-requirejs 即时就绪；requirejs 计数稳定后放行", async () => {
    const h = makeInternals();
    h.transport.respond(
      "Runtime.evaluate",
      evalValue(JSON.stringify({ ready: true, stage: "no-requirejs", n: 0 })),
    );
    const r = await waitForPageSettle(h.s, { timeout: 2, poll: 0.5, stablePolls: 4 });
    expect(r.ready).toBe(true);
    expect(r.stage).toBe("no-requirejs");
    const h2 = makeInternals();
    let modules = 10;
    h2.transport.respond("Runtime.evaluate", () =>
      evalValue(JSON.stringify({ ready: false, stage: "requirejs", n: modules })),
    );
    h2.transport.respond("Page.captureScreenshot", { data: "aGk=" });
    const p = waitForPageSettle(h2.s, { timeout: 5, poll: 0.5, stablePolls: 4 });
    modules = 12; // 第二次计数变化 → 稳定计数重启
    const r2 = await p;
    expect(r2.ready).toBe(true);
    expect(r2.n).toBe(12);
  });
  it("网格冻结 kick：空行网格触发截图踢帧并回读", async () => {
    const h = makeInternals();
    let call = 0;
    h.transport.respond("Runtime.evaluate", () => {
      call += 1;
      // 调用序列：settle JS（no-requirejs ready）→ 网格探测（空）→ 踢帧后复测（有文本）
      if (call === 1)
        return evalValue(JSON.stringify({ ready: true, stage: "no-requirejs", n: 0 }));
      if (call === 2) return evalValue(JSON.stringify({ grid: true, empty: true, rows: 5 }));
      return evalValue(JSON.stringify({ grid: true, empty: false, rows: 5 }));
    });
    h.transport.respond("Page.captureScreenshot", { data: "aGk=" });
    const r = await waitForPageSettle(h.s, { timeout: 2, poll: 0.5, stablePolls: 2 });
    expect(r.grid_kick).toBe(true);
    expect(r.grid_rendered).toBe(true);
    expect(h.transport.framesOf("Page.captureScreenshot")).toHaveLength(1);
    expect(h.transport.framesOf("Page.captureScreenshot")[0].params).toMatchObject({
      format: "jpeg",
      quality: 20,
    });
  });
  it("scroll：cssLayoutViewport 高度 × amount、方向、at_edge 回读", async () => {
    const h = makeInternals();
    h.transport
      .respond("Input.dispatchMouseEvent", {})
      // 真实协议形状：clientWidth/clientHeight 在 LayoutViewport 类型上（评审轮 1 #7）
      .respond("Page.getLayoutMetrics", {
        cssLayoutViewport: { clientWidth: 1000, clientHeight: 500, pageX: 0, pageY: 0 },
        cssVisualViewport: { width: 1000, height: 500, scale: 1 },
      })
      .respond("Runtime.evaluate", evalValue(JSON.stringify({ sy: 950, sh: 1450, ch: 500 })));
    const r = await scroll(h.s, "down", 2);
    const wheel = h.transport.framesOf("Input.dispatchMouseEvent")[0].params;
    expect(wheel).toMatchObject({ type: "mouseWheel", x: 500, y: 250, deltaY: 1000 });
    expect(r).toEqual({ vertical_percentage: 100, at_edge: true }); // sy=950=maxTop → 100%
    expect(h.sleeps).toContain(200); // 滚动后固定 0.2s
  });
  it("scroll 读不到视口时走兜底（1000/1280）不报错", async () => {
    const h = makeInternals();
    h.transport
      .respond("Input.dispatchMouseEvent", {})
      .respond("Page.getLayoutMetrics", {})
      .respond("Runtime.evaluate", evalValue(JSON.stringify({ sy: 0, sh: 3000, ch: 1000 })));
    const r = await scroll(h.s, "up", 1);
    expect(h.transport.framesOf("Input.dispatchMouseEvent")[0].params).toMatchObject({
      x: 640,
      y: 500,
      deltaY: -1000,
    });
    expect(r.vertical_percentage).toBe(0);
  });
});

describe("element-pointer", () => {
  it("clickElement：scrollIntoView → 坐标中心裁剪视口 → 未遮挡 → 三段点击时序", async () => {
    const h = makeInternals();
    h.transport
      .respond("Input.dispatchMouseEvent", {})
      .respond("DOM.scrollIntoViewIfNeeded", {})
      .respond("Page.getLayoutMetrics", {
        layoutViewport: { clientWidth: 800, clientHeight: 600 },
      })
      .respond("DOM.getContentQuads", {
        quads: [[10, 20, 110, 20, 110, 70, 10, 70]],
      })
      .respond("DOM.resolveNode", { object: { objectId: "obj1" } })
      .respond("Runtime.callFunctionOn", { result: { value: false } }); // 未遮挡
    const ok = await clickElement(h.s, 7);
    expect(ok).toBe(true);
    const seq = h.transport.framesOf("Input.dispatchMouseEvent").map((f) => f.params?.type);
    expect(seq).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    // 时序间隔：scrollIntoView 后 50ms；点击三段 50/80/300ms
    expect(h.sleeps.slice(0, 4)).toEqual([50, 50, 80, 300]);
    const pressed = h.transport.framesOf("Input.dispatchMouseEvent")[1].params;
    expect(pressed).toMatchObject({ x: 60, y: 45, button: "left", clickCount: 1 });
  });
  it("遮挡 → JS click 回退；坐标全失败 + JS 失败 → false", async () => {
    const h = makeInternals();
    h.transport
      .respond("Page.getLayoutMetrics", {})
      .respond("DOM.getContentQuads", { quads: [] })
      .respond("DOM.getBoxModel", {})
      .respond("DOM.resolveNode", { object: { objectId: "o" } })
      .respond("Runtime.callFunctionOn", { result: { value: true } }); // 遮挡判定
    // 第二轮 resolveNode/callFunctionOn 给 JS click：jsClick 失败（resolveNode 抛）
    h.transport.failOn("DOM.resolveNode", new Error("gone")); // 后续 resolve 全失败
    const ok = await clickElement(h.s, 7);
    expect(ok).toBe(false);
  });
  it("bestQuadRect：视口交集最大者；视口未知回退首个", () => {
    const quads = [
      [-100, -100, -50, -100, -50, -50, -100, -50], // 视口外
      [10, 10, 60, 10, 60, 40, 10, 40], // 视口内
    ];
    const best = bestQuadRect(quads, [200, 200]);
    expect(best).toEqual(new DOMRect(10, 10, 50, 30));
    expect(bestQuadRect(quads, null)).toEqual(new DOMRect(-100, -100, 50, 50));
    expect(bestQuadRect([[1, 2]], [100, 100])).toBeNull(); // 不足 8 值跳过
  });
});

describe("text-input", () => {
  it("typeText：clear→逐字符→框架事件；CJK 只发 char 事件", async () => {
    const h = makeInternals();
    h.transport
      .respond("Input.dispatchKeyEvent", {})
      // clear 策略 1 成功（cleared+空 final），不落键盘路径
      .respond("Runtime.evaluate", evalValue({ cleared: true, method: "value", final: "" }));
    await typeText(h.s, "a中", { clear: true });
    const keys = h.transport.framesOf("Input.dispatchKeyEvent").map((f) => f.params ?? {});
    // Strategy 1 清空（无 key 事件）；'a' = keyDown+char+keyUp；'中' = 仅 char
    expect(keys.map((k) => k.type)).toEqual(["keyDown", "char", "keyUp", "char"]);
    expect(keys[1]).toMatchObject({ text: "a", key: "a" });
    expect(keys[3]).toMatchObject({ text: "中", key: "中" });
    // 框架事件 JS 在最后一次 evaluate 链路里（clear 的 strategy1 + readActiveText + framework）
    const exprs = h.transport.framesOf("Runtime.evaluate").map((f) => String(f.params?.expression));
    expect(exprs.some((e) => e.includes("inputType: 'insertText'"))).toBe(true);
  });
  it("拼接守卫：OLD+NEW 时 force_set_value 强写", async () => {
    const h = makeInternals();
    const activeText = "oldnew";
    h.transport
      .respond("Input.dispatchKeyEvent", {})
      .respond("Runtime.evaluate", (p: Record<string, unknown> | undefined) => {
        const expr = String(p?.expression ?? "");
        if (expr.includes("document.activeElement")) {
          if (expr.includes("getBoundingClientRect")) return evalValue(null);
          if (expr.includes("HTMLInputElement.prototype")) return evalValue(true);
          if (expr.includes("el.value !== undefined")) return evalValue(activeText);
          // clear strategy1（值未清掉）
          if (expr.includes("el.value = ''")) return evalValue({ cleared: true, final: "old" });
          if (expr.includes("activeElement")) return evalValue(true);
        }
        return evalValue(undefined);
      });
    await typeText(h.s, "new", { clear: true });
    const forces = h.transport
      .framesOf("Runtime.evaluate")
      .filter((f) => String(f.params?.expression).includes("getOwnPropertyDescriptor"));
    expect(forces).toHaveLength(1);
  });
  it("clearTextField 三层降级：S1 失败 → S2 三击 Delete → 成功", async () => {
    const h = makeInternals();
    h.transport
      .respond("Input.dispatchMouseEvent", {})
      .respond("Input.dispatchKeyEvent", {})
      .respond("Runtime.evaluate", (p: Record<string, unknown> | undefined) => {
        const expr = String(p?.expression ?? "");
        if (expr.includes("el.value = ''")) return evalValue({ cleared: true, final: "leftover" });
        if (expr.includes("getBoundingClientRect")) {
          return evalValue(JSON.stringify({ x: 5, y: 5 }));
        }
        if (expr.includes("el.value !== undefined")) return evalValue("");
        return evalValue(undefined);
      });
    expect(await clearTextField(h.s)).toBe(true);
    const mouse = h.transport.framesOf("Input.dispatchMouseEvent").map((f) => f.params ?? {});
    expect(mouse[0]).toMatchObject({ type: "mousePressed", clickCount: 3 });
    const del = h.transport.framesOf("Input.dispatchKeyEvent").map((f) => f.params?.key);
    expect(del).toEqual(["Delete", "Delete"]);
  });
  it("键码映射：shift 符号/大小写/数字/空格；requiresDirectValueAssignment 判定", () => {
    expect(getCharModifiersAndVk("!")).toEqual([8, 49, "1"]);
    expect(getCharModifiersAndVk("A")).toEqual([8, 65, "a"]);
    expect(getCharModifiersAndVk("z")).toEqual([0, 90, "z"]);
    expect(getCharModifiersAndVk("5")).toEqual([0, 53, "5"]);
    expect(getCharModifiersAndVk(" ")).toEqual([0, 32, " "]);
    expect(getKeyCodeForChar("5")).toBe("Digit5");
    expect(getKeyCodeForChar("q")).toBe("KeyQ");
    expect(getKeyCodeForChar("!")).toBe("Digit1");
    expect(getKeyCodeForChar("{")).toBe("BracketLeft");
    expect(requiresDirectValueAssignment({ tagName: "INPUT", attributes: { type: "date" } })).toBe(
      true,
    );
    expect(
      requiresDirectValueAssignment({
        tagName: "INPUT",
        attributes: { type: "text", class: "my-datepicker x" },
      }),
    ).toBe(true);
    expect(
      requiresDirectValueAssignment({
        tagName: "INPUT",
        attributes: { type: "text", "data-provide": "datepicker" },
      }),
    ).toBe(true);
    expect(requiresDirectValueAssignment({ tagName: "INPUT", attributes: { type: "text" } })).toBe(
      false,
    );
    expect(requiresDirectValueAssignment({ tagName: "TEXTAREA", attributes: {} })).toBe(false);
  });
});

describe("keyboard", () => {
  it("纯文本逐字符；命名特殊键 keyDown/char/keyUp；Enter 后 0.1s", async () => {
    const h = makeInternals();
    h.transport.respond("Input.dispatchKeyEvent", {});
    await sendKeys(h.s, "hi");
    let seq = h.transport.framesOf("Input.dispatchKeyEvent").map((f) => f.params ?? {});
    expect(seq.map((k) => k.type)).toEqual([
      "keyDown",
      "char",
      "keyUp",
      "keyDown",
      "char",
      "keyUp",
    ]);
    expect(seq[0]).toMatchObject({ key: "h", code: "KeyH", windowsVirtualKeyCode: 72 });
    const h2 = makeInternals();
    h2.transport.respond("Input.dispatchKeyEvent", {});
    await sendKeys(h2.s, "Enter");
    seq = h2.transport.framesOf("Input.dispatchKeyEvent").map((f) => f.params ?? {});
    expect(seq[1]).toMatchObject({ type: "char", text: "\r", key: "Enter" });
    expect(h2.sleeps).toEqual([100]); // Enter 后等导航
  });
  it("组合键：Control+a 携带 modifiers=2；别名归一（pgup→PageUp、space→' '）", async () => {
    const h = makeInternals();
    h.transport.respond("Input.dispatchKeyEvent", {});
    await sendKeys(h.s, "Control+a");
    const seq = h.transport.framesOf("Input.dispatchKeyEvent").map((f) => f.params ?? {});
    expect(seq[0]).toMatchObject({ key: "a", modifiers: 2, code: "KeyA" });
    expect(seq).toHaveLength(3);
    const h2 = makeInternals();
    h2.transport.respond("Input.dispatchKeyEvent", {});
    await sendKeys(h2.s, "pgup");
    expect(h2.transport.framesOf("Input.dispatchKeyEvent")[0].params).toMatchObject({
      key: "PageUp",
      code: "PageUp",
      windowsVirtualKeyCode: 33,
    });
    const h3 = makeInternals();
    h3.transport.respond("Input.dispatchKeyEvent", {});
    await sendKeys(h3.s, "space");
    expect(h3.transport.framesOf("Input.dispatchKeyEvent")[0].params).toMatchObject({
      key: " ",
      code: "Space",
    });
  });
  it("未知修饰软降级跳过；Alt+F4 走特殊键路径", async () => {
    const h = makeInternals();
    h.transport.respond("Input.dispatchKeyEvent", {});
    await sendKeys(h.s, "Bogus+F4");
    const seq = h.transport.framesOf("Input.dispatchKeyEvent").map((f) => f.params ?? {});
    expect(seq[0]).toMatchObject({
      key: "F4",
      modifiers: 0,
      code: "F4",
      windowsVirtualKeyCode: 0x73,
    });
    expect(h.logs.some((m) => m.includes("unknown modifier"))).toBe(true);
  });
});

describe("tabs", () => {
  it("switchTab：清缓存 + activate/attach + 重挂拦截与 Overlay + settle", async () => {
    const h = makeInternals();
    scriptConnect(h.transport);
    h.transport
      .respond("Target.activateTarget", {})
      .respond("Runtime.evaluate", evalValue("complete"));
    await switchTab(h.s, "T2");
    expect(h.transport.framesOf("Target.activateTarget")[0].params).toEqual({ targetId: "T2" });
    expect(h.s.currentSessionId).toBe("S1");
    // 拦截重发（per-session）；Overlay.enable 同款重发（偏离修复——新 tab 高亮不落空）
    expect(h.transport.framesOf("Page.setInterceptFileChooserDialog")).toHaveLength(1);
    expect(h.transport.framesOf("Overlay.enable")).toHaveLength(1);
    expect(h.transport.sent[h.transport.sent.length - 1].method).toBe("Runtime.evaluate");
  });
  it("closeTab 当前页：切剩余；全无则开 about:blank", async () => {
    const h = makeInternals();
    h.s.currentTargetId = "T1";
    h.transport
      .respond("Target.closeTarget", {})
      .respond("Target.getTargets", { targetInfos: [{ type: "page", targetId: "T9" }] })
      .respond("Target.activateTarget", {})
      .respond("Target.attachToTarget", { sessionId: "S9" })
      .respond("Page.setInterceptFileChooserDialog", {})
      .respond("Overlay.enable", {})
      .respond("Runtime.evaluate", evalValue("complete"));
    await closeTab(h.s, "T1");
    expect(h.s.currentTargetId).toBe("T9");
    const h2 = makeInternals();
    h2.s.currentTargetId = "T1";
    h2.transport
      .respond("Target.closeTarget", {})
      .respond("Target.getTargets", { targetInfos: [] })
      .respond("Target.createTarget", { targetId: "TNEW" })
      .respond("Target.activateTarget", {})
      .respond("Target.attachToTarget", { sessionId: "S2" })
      .respond("Page.setInterceptFileChooserDialog", {})
      .respond("Overlay.enable", {})
      .respond("Runtime.evaluate", evalValue("complete"));
    await closeTab(h2.s, "T1");
    expect(h2.s.currentTargetId).toBe("TNEW");
    expect(h2.transport.framesOf("Target.createTarget")[0].params).toEqual({ url: "about:blank" });
  });
  it("createTab：createTarget + switch", async () => {
    const h = makeInternals();
    h.transport
      .respond("Target.createTarget", { targetId: "TN" })
      .respond("Target.activateTarget", {})
      .respond("Target.attachToTarget", { sessionId: "SN" })
      .respond("Page.setInterceptFileChooserDialog", {})
      .respond("Overlay.enable", {})
      .respond("Runtime.evaluate", evalValue("complete"));
    expect(await createTab(h.s, "https://x/")).toBe("TN");
  });
});

describe("screenshot / pdf", () => {
  it("解码 base64 → Uint8Array；护栏超时文案逐字节保真", async () => {
    const h = makeInternals();
    h.transport.respond("Page.captureScreenshot", { data: "aGk=" }); // "hi"
    const bytes = await takeScreenshot(h.s);
    expect(bytes).toEqual(new Uint8Array([0x68, 0x69]));
    const h2 = makeInternals({ screenshotTimeout: 0.01 });
    h2.transport.respond("Page.captureScreenshot", () => new Promise(() => undefined)); // 永挂
    await expect(takeScreenshot(h2.s)).rejects.toThrow(
      /^timed out after 0\.01s waiting for a frame — raw media pages \(image\/video URLs have no page DOM to screenshot\) and minimized\/occluded windows both cause this; navigate to an HTML page wrapping the media, or report\/save the media URL instead of screenshotting$/,
    );
  });
  it("screenshotTimeout=0 关护栏（永挂不上报超时——由传输层兜底）；no data 抛错", async () => {
    const h = makeInternals({ screenshotTimeout: 0 });
    h.transport.respond("Page.captureScreenshot", {});
    await expect(takeScreenshot(h.s)).rejects.toThrow("Screenshot failed - no data returned");
  });
  it("printToPdf：纸张表 + preferCSSPageSize；jpeg quality 仅 jpeg 生效", async () => {
    const h = makeInternals();
    h.transport.respond("Page.printToPDF", { data: "aGk=" });
    await printToPdf(h.s, { paperFormat: "a4" });
    expect(h.transport.framesOf("Page.printToPDF")[0].params).toMatchObject({
      paperWidth: 8.27,
      paperHeight: 11.69,
      preferCSSPageSize: true,
    });
    const h2 = makeInternals();
    h2.transport.respond("Page.captureScreenshot", {});
    await takeScreenshot(h2.s, { format: "jpeg", quality: 80 }).catch(() => undefined);
    expect(h2.transport.framesOf("Page.captureScreenshot")[0].params).toMatchObject({
      format: "jpeg",
      quality: 80,
    });
  });
});

describe("evaluate-basic 工具族", () => {
  it("validateAndFix：双转义还原/选择器转模板/正则类还原/裸控制字符正则转义", () => {
    expect(validateAndFixJavascript('a \\"b\\"')).toBe('a "b"');
    expect(validateAndFixJavascript('document.querySelector(".x")')).toBe(
      "document.querySelector(`.x`)",
    );
    expect(validateAndFixJavascript("x.match(/\\\\d+/)")).toBe("x.match(/\\d+/)");
    const withNewline = ".replace(/␊/g, '')".replace("␊", "\n");
    expect(validateAndFixJavascript(withNewline)).toBe(".replace(/\\n/g, '')");
  });
  it("normalizeEvalResult：undefined/bool/null/对象/数字", () => {
    expect(normalizeEvalResult({})).toBe("undefined");
    expect(normalizeEvalResult({ value: true })).toBe("true");
    expect(normalizeEvalResult({ value: null })).toBe("null");
    expect(normalizeEvalResult({ value: { a: 1 } })).toBe('{"a":1}');
    expect(normalizeEvalResult({ value: 3.5 })).toBe("3.5");
    expect(normalizeEvalResult({ value: "s" })).toBe("s");
  });
  it("delimiterScan：字符串/注释感知；首个错位闭合下标", () => {
    expect(delimiterScan("f(a, 'b)')")).toEqual([[], -1]);
    expect(delimiterScan("f(a // (\n)")).toEqual([[], -1]);
    expect(delimiterScan("(a]")).toEqual([["("], 2]);
    expect(delimiterScan("((a)")).toEqual([["("], -1]);
  });
  it("syntaxRepairCandidates：裸 return 包裹/缺 catch 插入/EOF 补全/多余闭合删首错位（位置验证）", () => {
    expect(syntaxRepairCandidates("return 1", "Illegal return statement")).toEqual([
      "(()=>{\nreturn 1\n})()",
    ]);
    const catchCandidates = syntaxRepairCandidates(
      "try { f() }",
      "Missing catch or finally after try",
    );
    expect(catchCandidates[0]).toContain("catch(e){return 'Error: '+e.message}");
    expect(syntaxRepairCandidates("f((1", "Unexpected end of input")).toEqual(["f((1))", "f((1)"]);
    // 删除类：位置证据分叉（regex 幻影）放弃
    expect(syntaxRepairCandidates("x = /[)]/g }}", "Unexpected token '}'", 3)).toEqual([]);
    expect(syntaxRepairCandidates("f(a)}", "Unexpected token '}'", 4)).toEqual(["f(a)"]);
    expect(syntaxRepairCandidates("f(a)}", "Unexpected token '}'")).toEqual([]); // 无位置证据 fail-safe
    expect(syntaxRepairCandidates("f(a)", "ReferenceError: x is not defined")).toEqual([]);
  });
});

describe("dom-access / grid-meta", () => {
  it('getPageHtml：DOM.getDocument depth=-1 pierce → 干净 HTML；失败返 ""', async () => {
    const h = makeInternals();
    h.transport.respond("DOM.getDocument", {
      root: {
        nodeName: "html",
        nodeType: 1,
        children: [{ nodeName: "body", nodeType: 1, children: [{ nodeType: 3, nodeValue: "hi" }] }],
      },
    });
    expect(await getPageHtml(h.s)).toBe("<body>hi</body>"); // 定位 body 后只重建 body 子树
    expect(h.transport.framesOf("DOM.getDocument")[0].params).toEqual({ depth: -1, pierce: true });
    h.transport.failOn("DOM.getDocument", new Error("gone"));
    expect(await getPageHtml(h.s)).toBe("");
  });
  it("readGridMeta：非网格页缓存 URL 跳过二次探测；网格页解析 dict", async () => {
    const h = makeInternals();
    h.transport.respond("Runtime.evaluate", evalValue(""));
    expect(await readGridMeta(h.s, "https://plain/")).toBeNull();
    expect(h.transport.framesOf("Runtime.evaluate")).toHaveLength(1);
    expect(await readGridMeta(h.s, "https://plain/")).toBeNull(); // 缓存命中零调用
    expect(h.transport.framesOf("Runtime.evaluate")).toHaveLength(1);
    const meta = { namespace: "ns", total_records: 42 };
    h.transport.respond("Runtime.evaluate", evalValue(JSON.stringify(meta)));
    expect(await readGridMeta(h.s, "https://grid/")).toEqual(meta);
    expect(h.transport.framesOf("Runtime.evaluate")[1].params).toMatchObject({
      awaitPromise: true,
      timeout: 8000,
    });
  });
});
