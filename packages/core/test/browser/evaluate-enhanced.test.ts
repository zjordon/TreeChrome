// evaluate 增强 session 层（FakeCdpTransport）：单发/args 编组/elements 句柄/
// return_element_ids 节点回投/frame 会话切换/语法自愈重试（成功/全败+失衡提示）/
// wasThrown。pyFormatG 单元。

import { describe, expect, it } from "vitest";
import { evaluateEnhanced, pyFormatG } from "../../src/browser/evaluate-enhanced.js";
import { makeInternals } from "./fake-transport.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const resolveByBackend = (params: Record<string, unknown> | undefined) =>
  isRecord(params) && typeof params.backendNodeId === "number"
    ? { object: { objectId: `obj-${params.backendNodeId}` } }
    : { object: { objectId: "obj-doc" } };

describe("单发路径（Runtime.evaluate 参数透传）", () => {
  it("缺省 timeout=30000 + returnByValue/awaitPromise；显式值透传", async () => {
    const h = makeInternals();
    h.transport.respond("Runtime.evaluate", (p: Record<string, unknown>) => {
      expect(p.timeout).toBe(30000);
      expect(p.returnByValue).toBe(true);
      expect(p.awaitPromise).toBe(true);
      expect(p.userGesture).toBe(false);
      return { result: { value: 42 } };
    });
    expect(await evaluateEnhanced(h.s, { code: "return 42" })).toBe("42");
    const h2 = makeInternals();
    h2.transport.respond("Runtime.evaluate", (p: Record<string, unknown>) => {
      expect(p.timeout).toBe(1234);
      expect(p.awaitPromise).toBe(false);
      expect(p.userGesture).toBe(true);
      return { result: { value: true } };
    });
    expect(
      await evaluateEnhanced(h2.s, {
        code: "return 1",
        awaitPromise: false,
        timeoutMs: 1234,
        userGesture: true,
      }),
    ).toBe("true");
  });
});

describe("args 编组路径（callFunctionOn this=document）", () => {
  const setup = (h: ReturnType<typeof makeInternals>) => {
    h.transport
      .respond("DOM.getDocument", { root: { nodeId: 7 } })
      .respond("DOM.resolveNode", (p: Record<string, unknown> | undefined) =>
        p?.nodeId === 7 ? { object: { objectId: "doc-obj" } } : resolveByBackend(p),
      );
  };
  it("function(...a) 包装 + arguments {value} 编组", async () => {
    const h = makeInternals();
    setup(h);
    h.transport.respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
      expect(p.objectId).toBe("doc-obj");
      expect(p.functionDeclaration).toBe("function(...a){\nreturn a[0] + a[1]\n}");
      expect(p.arguments).toEqual([{ value: 1 }, { value: "x" }]);
      expect(p.returnByValue).toBe(true);
      return { result: { value: "1x" } };
    });
    expect(await evaluateEnhanced(h.s, { code: "return a[0] + a[1]", args: [1, "x"] })).toBe("1x");
  });
  it("elements 句柄在 args 后（...a, ...e 签名）", async () => {
    const h = makeInternals();
    setup(h);
    h.transport.respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
      expect(p.functionDeclaration).toContain("function(...a, ...e){");
      expect(p.arguments).toEqual([{ value: 5 }, { objectId: "obj-11" }, { objectId: "obj-12" }]);
      return { result: { value: "ok" } };
    });
    expect(
      await evaluateEnhanced(h.s, { code: "return 'ok'", args: [5], elements: [11, 12] }),
    ).toBe("ok");
  });
});

describe("return_element_ids 节点回投", () => {
  it("object/node 结果 → describeNode → backendNodeId:55", async () => {
    const h = makeInternals();
    h.transport
      .respond("Runtime.evaluate", {
        result: { type: "object", subtype: "node", objectId: "n-obj" },
      })
      .respond("DOM.describeNode", (p: Record<string, unknown>) => {
        expect(p.objectId).toBe("n-obj");
        return { node: { backendNodeId: 55 } };
      });
    expect(await evaluateEnhanced(h.s, { code: "return el", returnElementIds: true })).toBe(
      "backendNodeId:55",
    );
  });
});

describe("frame 会话切换（跨源 iframe）", () => {
  const frameSetup = (h: ReturnType<typeof makeInternals>, matching: boolean) => {
    h.transport
      .respond("DOM.resolveNode", (p: Record<string, unknown> | undefined) => {
        if (p?.backendNodeId === 90) return { object: { objectId: "ifr-obj" } };
        return { object: { objectId: "doc-obj" } };
      })
      .respond("DOM.describeNode", (p: Record<string, unknown>) =>
        p.objectId === "ifr-obj" ? { node: { frameId: "F1" } } : {},
      )
      .respond("Target.getTargets", {
        targetInfos: matching
          ? [{ type: "iframe", parentFrameId: "F1", targetId: "T-IFR" }]
          : [{ type: "iframe", parentFrameId: "OTHER", targetId: "T-X" }],
      })
      .respond("Target.attachToTarget", { sessionId: "S2" })
      .respond("Runtime.evaluate", { result: { value: "in-frame" } });
  };
  it("命中 iframe target → 后续求值帧携带 S2", async () => {
    const h = makeInternals();
    frameSetup(h, true);
    expect(await evaluateEnhanced(h.s, { code: "return 'in-frame'", frame: 90 })).toBe("in-frame");
    const evalFrame = h.transport.framesOf("Runtime.evaluate")[0];
    expect(evalFrame?.sessionId).toBe("S2");
  });
  it("无匹配 target → 可操作 error", async () => {
    const h = makeInternals();
    frameSetup(h, false);
    await expect(evaluateEnhanced(h.s, { code: "return 1", frame: 90 })).rejects.toThrow(
      /could not resolve iframe target for frame "F1"/,
    );
  });
});

describe("语法自愈重试（仅无输入路径）", () => {
  it("首个候选成功 → 结果替换 + 自愈日志", async () => {
    const h = makeInternals();
    h.transport
      .respondOnce("Runtime.evaluate", {
        result: { value: undefined },
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "SyntaxError: Illegal return statement" },
        },
      })
      .respond("Runtime.evaluate", { result: { value: "healed" } });
    expect(await evaluateEnhanced(h.s, { code: "return 'healed'" })).toBe("healed");
    expect(h.logs.some((l) => l.includes("syntax self-heal applied"))).toBe(true);
  });
  it("全部候选失败 → 原始异常上抛（无失衡提示——代码定界平衡）", async () => {
    const h = makeInternals();
    h.transport.respond("Runtime.evaluate", {
      result: { value: undefined },
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "SyntaxError: Illegal return statement" },
      },
    });
    await expect(evaluateEnhanced(h.s, { code: "return 1" })).rejects.toThrow(
      /Illegal return statement/,
    );
  });
  it("失衡代码 + 全败 → 追加 unbalanced 提示", async () => {
    const h = makeInternals();
    h.transport.respond("Runtime.evaluate", {
      result: { value: undefined },
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "SyntaxError: Unexpected end of input" },
      },
    });
    await expect(evaluateEnhanced(h.s, { code: "((function(){return 1" })).rejects.toThrow(
      /unbalanced braces\/parens/,
    );
  });
  it("运行期异常（Uncaught 前缀 description）不触发自愈", async () => {
    const h = makeInternals();
    h.transport.respond("Runtime.evaluate", {
      result: { value: undefined },
      exceptionDetails: {
        text: "Uncaught TypeError: x is not a function",
        exception: { description: "Uncaught TypeError: x is not a function\n    at <anonymous>" },
      },
    });
    await expect(evaluateEnhanced(h.s, { code: "x()" })).rejects.toThrow(/TypeError/);
    expect(h.transport.framesOf("Runtime.evaluate")).toHaveLength(1); // 无重试
  });
  it("wasThrown → 常规失败", async () => {
    const h = makeInternals();
    h.transport.respond("Runtime.evaluate", { result: { wasThrown: true } });
    await expect(evaluateEnhanced(h.s, { code: "1" })).rejects.toThrow(
      "JavaScript execution failed (wasThrown=true)",
    );
  });
});

describe("pyFormatG（Python %g 六位有效数字）", () => {
  it("整数去尾零 / 大数科学计数 / 小数", () => {
    expect(pyFormatG(150)).toBe("150");
    expect(pyFormatG(150.0)).toBe("150");
    expect(pyFormatG(999)).toBe("999");
    expect(pyFormatG(0.005)).toBe("0.005");
    expect(pyFormatG(10)).toBe("10");
    expect(pyFormatG(7.5)).toBe("7.5");
    expect(pyFormatG(1234567)).toBe("1.23457e+06"); // Python %g 形态（指数两位）
    expect(pyFormatG(1e6)).toBe("1e+06"); // 尾零剥除（%g 实跑锚定）
    expect(pyFormatG(999999.5)).toBe("1e+06");
  });
});

describe("补面：回投/attach/句柄边界", () => {
  it("describeNode 无 backendNodeId → 回退归一化输出", async () => {
    const h = makeInternals();
    h.transport
      .respond("Runtime.evaluate", { result: { type: "object", subtype: "node", objectId: "n2" } })
      .respond("DOM.describeNode", { node: {} });
    expect(await evaluateEnhanced(h.s, { code: "return el", returnElementIds: true })).toBe(
      "undefined",
    );
  });
  it("frame attach 抛错 / 无 sessionId → could not attach", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", (p: Record<string, unknown> | undefined) =>
        p?.backendNodeId === 90 ? { object: { objectId: "ifr-obj" } } : {},
      )
      .respond("DOM.describeNode", { node: { frameId: "F1" } })
      .respond("Target.getTargets", {
        targetInfos: [{ type: "iframe", parentFrameId: "F1", targetId: "T-IFR" }],
      })
      .respond("Target.attachToTarget", () => {
        throw new Error("attach denied");
      });
    await expect(evaluateEnhanced(h.s, { code: "return 1", frame: 90 })).rejects.toThrow(
      "Evaluate failed: could not attach to iframe target",
    );
    expect(h.logs.some((l) => l.includes("Failed to attach to iframe target T-IFR"))).toBe(true);
    const h2 = makeInternals();
    h2.transport
      .respond("DOM.resolveNode", (p: Record<string, unknown> | undefined) =>
        p?.backendNodeId === 90 ? { object: { objectId: "ifr-obj" } } : {},
      )
      .respond("DOM.describeNode", { node: { frameId: "F1" } })
      .respond("Target.getTargets", {
        targetInfos: [{ type: "iframe", parentFrameId: "F1", targetId: "T-IFR" }],
      })
      .respond("Target.attachToTarget", {});
    await expect(evaluateEnhanced(h2.s, { code: "return 1", frame: 90 })).rejects.toThrow(
      "Evaluate failed: could not attach to iframe target",
    );
  });
  it("elements resolveNode 无 objectId → 空句柄退单发路径", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", {})
      .respond("Runtime.evaluate", { result: { value: "plain" } });
    expect(await evaluateEnhanced(h.s, { code: "return 'plain'", elements: [3] })).toBe("plain");
    expect(h.transport.framesOf("Runtime.callFunctionOn")).toHaveLength(0);
  });
  it("pyFormatG 负指数与非有限", () => {
    expect(pyFormatG(0.000012345)).toBe("1.2345e-05");
    expect(pyFormatG(Number.NaN)).toBe("NaN");
    expect(pyFormatG(Number.POSITIVE_INFINITY)).toBe("Infinity");
  });
});
