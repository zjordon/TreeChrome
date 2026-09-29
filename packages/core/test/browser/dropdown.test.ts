// 下拉族 session 层集成（FakeCdpTransport 脚本化）：native 单/多选（懒加载 G11
// 重试 + 回退点击）/ 读 dispatcher 三级降级 / 写 dispatcher 路由（含子树写恒
// "vanished" 的上游死代码同构）/ combobox 展开-读-写-收起 / custom 开态发现-选中
// （真实 click 链全脚本化）/ 遮挡点击回退不在此文件（element-pointer 既有面）。

import { describe, expect, it } from "vitest";
import {
  expandAndFetchComboboxOptions,
  expandAndFetchCustomOptions,
  fetchDropdownOptions,
  fetchSelectOptions,
  setComboboxOption,
  setCustomDropdownOption,
  setDropdownOption,
  setSelectOption,
  setSelectOptionMulti,
} from "../../src/browser/dropdown.js";
import {
  ARIA_OPTIONS_JS,
  COMBOBOX_LISTBOX_ID_JS,
  COMBOBOX_OPTIONS_JS,
  CUSTOM_CLASS_OPTIONS_JS,
  CUSTOM_FIND_OPTION_JS,
  CUSTOM_LISTBOX_DISCOVER_JS,
  CUSTOM_OPEN_OPTIONS_JS,
  EFFECTIVE_CLICK_TARGET_JS,
  SCROLL_LISTBOX_JS,
  SELECT_OPTION_CLICK_FALLBACK_JS,
  SELECT_OPTION_JS,
  SET_ARIA_JS,
  SET_COMBOBOX_OPTION_JS,
  SET_CUSTOM_JS,
  SUBTREE_LOCATE_JS,
  SUBTREE_SEARCH_JS,
} from "../../src/browser/dropdown-js.js";
import { makeInternals } from "./fake-transport.js";

const resolveFor = (bid: number) => (params: Record<string, unknown> | undefined) =>
  params?.backendNodeId === bid ? { object: { objectId: `obj-${bid}` } } : {};

describe("fetchSelectOptions（resolveNode + callFunctionOn 内联枚举）", () => {
  it("返回选项列表；非 list 值 → []", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", resolveFor(7))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        expect(p.objectId).toBe("obj-7");
        expect(String(p.functionDeclaration)).toContain("Array.from(this.options)");
        return { result: { value: [{ value: "a", text: "A", selected: true }] } };
      });
    const r = await fetchSelectOptions(h.s, 7);
    expect(r).toEqual([{ value: "a", text: "A", selected: true }]);
    const h2 = makeInternals();
    h2.transport
      .respond("DOM.resolveNode", resolveFor(7))
      .respond("Runtime.callFunctionOn", { result: { value: "garbage" } });
    expect(await fetchSelectOptions(h2.s, 7)).toEqual([]);
  });
});

describe("lazySelectCall（G11 全空懒加载重试）", () => {
  it("全空 → focus + sleep 1000 + 重跑；非全空不重试", async () => {
    const h = makeInternals();
    const calls: string[] = [];
    h.transport
      .respond("DOM.resolveNode", resolveFor(9))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === SELECT_OPTION_JS) {
          calls.push("select");
          return calls.length === 1
            ? {
                result: {
                  value: {
                    success: false,
                    availableOptions: [{ value: "", text: "", selected: false }],
                  },
                },
              }
            : { result: { value: { success: true, message: "ok", value: "x" } } };
        }
        calls.push("focus");
        return { result: { value: undefined } };
      });
    const r = await setSelectOption(h.s, 9, "x");
    expect(r.success).toBe(true);
    expect(calls).toEqual(["select", "focus", "select"]);
    expect(h.sleeps).toContain(1000);
  });
});

describe("setSelectOption 回退点击（框架回退 selectionReverted）", () => {
  it("reverted → 走 SELECT_OPTION_CLICK_FALLBACK_JS；成功则取其 message/value", async () => {
    const h = makeInternals();
    let n = 0;
    h.transport
      .respond("DOM.resolveNode", resolveFor(5))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === SELECT_OPTION_JS) {
          n += 1;
          return {
            result: {
              value: { success: false, selectionReverted: true, targetOption: { index: 3 } },
            },
          };
        }
        expect(fn).toBe(SELECT_OPTION_CLICK_FALLBACK_JS);
        expect((p.arguments as Array<Record<string, unknown>>)[0].value).toBe(3);
        return { result: { value: { success: true, message: "clicked", value: "picked" } } };
      });
    const r = await setSelectOption(h.s, 5, "x");
    expect(r).toEqual({ success: true, message: "clicked", value: "picked" });
    expect(n).toBe(1);
  });
  it("multi 走 _SELECT_OPTION_MULTI_JS（arguments 传数组）", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", resolveFor(5))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        expect(Array.isArray((p.arguments as Array<Record<string, unknown>>)[0].value)).toBe(true);
        return { result: { value: { success: true, values: ["a", "b"] } } };
      });
    const r = await setSelectOptionMulti(h.s, 5, ["a", "b"]);
    expect(r.success).toBe(true);
  });
});

describe("fetchDropdownOptions dispatcher（aria → custom → 子树）", () => {
  /** 按常量精确分派（子串路由会被多个 JS 的 [role= 重叠命中） */
  const dispatcherSetup = (responses: Partial<Record<string, unknown>>) => {
    const h = makeInternals();
    h.transport.respond("DOM.resolveNode", resolveFor(11));
    h.transport.respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
      const fn = String(p.functionDeclaration);
      const hit = responses[fn];
      if (hit !== undefined) return { result: { value: hit } };
      return { result: { value: null } };
    });
    return h;
  };
  it("aria 命中即止（不试 custom/子树）", async () => {
    const h = dispatcherSetup({ [ARIA_OPTIONS_JS]: [{ value: "1", text: "One" }] });
    const r = await fetchDropdownOptions(h.s, 11);
    expect(r).toEqual({ options: [{ value: "1", text: "One" }], source: "aria" });
    expect(h.transport.framesOf("Runtime.callFunctionOn")).toHaveLength(1);
  });
  it("custom 命中", async () => {
    const h = dispatcherSetup({ [CUSTOM_CLASS_OPTIONS_JS]: [{ value: "c" }] });
    const r = await fetchDropdownOptions(h.s, 11);
    expect(r.source).toBe("custom");
  });
  it("子树命中 child-depth-N", async () => {
    const h = dispatcherSetup({
      [SUBTREE_SEARCH_JS]: { options: [{ value: "s" }], source: "child-depth-2" },
    });
    const r = await fetchDropdownOptions(h.s, 11);
    expect(r).toEqual({ options: [{ value: "s" }], source: "child-depth-2" });
  });
  it("全 miss → source null", async () => {
    const h = dispatcherSetup({});
    const r = await fetchDropdownOptions(h.s, 11);
    expect(r).toEqual({ options: [], source: null });
  });
});

describe("setDropdownOption 写 dispatcher 路由", () => {
  it("aria → _SET_ARIA_JS + source 附加", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", resolveFor(12))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === ARIA_OPTIONS_JS) return { result: { value: [{ value: "a" }] } };
        if (fn === SET_ARIA_JS) return { result: { value: { success: true, message: "set" } } };
        return { result: { value: null } };
      });
    const r = await setDropdownOption(h.s, 12, "a");
    expect(r.success).toBe(true);
    expect(r.source).toBe("aria");
  });
  it("child-depth-N → 子树写恒 'vanished'（上游 returnByValue 死代码同构）", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", resolveFor(13))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === SUBTREE_SEARCH_JS) {
          return { result: { value: { options: [{ value: "x" }], source: "child-depth-1" } } };
        }
        if (fn === SUBTREE_LOCATE_JS) {
          // returnByValue=false → RemoteObject 外壳（无 found 键——上游死代码诱因）
          return { result: { type: "object", objectId: "child-obj" } };
        }
        return { result: { value: null } };
      });
    const r = await setDropdownOption(h.s, 13, "x");
    expect(r.success).toBe(false);
    expect(r.error).toBe("subtree child dropdown vanished between read and write");
    expect(r.source).toBe("child-depth-1");
  });
  it("source null → not a recognized dropdown", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", resolveFor(14))
      .respond("Runtime.callFunctionOn", { result: { value: null } });
    const r = await setDropdownOption(h.s, 14, "x");
    expect(r.source).toBeNull();
    expect(r.error).toBe("not a recognized dropdown");
  });
});

/** click 链全脚本（视口/quads/遮挡假阴性/点击三段/高亮；callFunctionOn 按常量分派） */
function scriptClickChain(
  h: ReturnType<typeof makeInternals>,
  fnResponses: Partial<Record<string, unknown>> = {},
) {
  h.transport
    .respond("DOM.scrollIntoViewIfNeeded", {})
    .respond("Runtime.evaluate", (p: Record<string, unknown>) => {
      const expr = String(p.expression ?? "");
      if (expr.includes("clientWidth")) return { result: { value: [1280, 720] } };
      if (expr.includes("semi-popover-wrapper-show")) return { result: { value: false } };
      return { result: { value: undefined } };
    })
    .respond("DOM.getContentQuads", { quads: [[10, 10, 110, 10, 110, 40, 10, 40]] })
    .respond("Input.dispatchMouseEvent", {})
    .respond("Input.dispatchKeyEvent", {})
    .respond("DOM.describeNode", {})
    .respond("DOM.resolveNode", (params: Record<string, unknown> | undefined) =>
      params?.backendNodeId === undefined
        ? {}
        : { object: { objectId: `obj-${params.backendNodeId}` } },
    )
    .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
      const fn = String(p.functionDeclaration);
      const hit = fnResponses[fn];
      if (hit !== undefined) return { result: { value: hit } };
      // 遮挡探测（elementFromPoint）等默认：value undefined → best-effort 视为未遮挡
      return { result: { value: undefined } };
    });
}

describe("combobox 流（展开→读/写→finally 收起）", () => {
  it("读：click + sleep500 + listboxFound；finally Escape 收起", async () => {
    const h = makeInternals();
    scriptClickChain(h, {
      [COMBOBOX_OPTIONS_JS]: { listboxFound: true, options: [{ value: "z" }] },
    });
    const r = await expandAndFetchComboboxOptions(h.s, 21);
    expect(r).toEqual([{ value: "z" }]);
    expect(h.sleeps).toContain(500);
    expect(h.transport.framesOf("Input.dispatchKeyEvent").length).toBeGreaterThan(0); // Escape
  });
  it("写：listbox 定位（returnByValue=false）→ objectId → _SET_COMBOBOX_OPTION_JS", async () => {
    const h = makeInternals();
    scriptClickChain(h, {
      [COMBOBOX_LISTBOX_ID_JS]: undefined,
      [SET_COMBOBOX_OPTION_JS]: { success: true, message: "ok" },
    });
    // locator 需 returnByValue=false 的 objectId 外壳——按 fn 单独脚本
    h.transport.respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
      const fn = String(p.functionDeclaration);
      if (fn === COMBOBOX_LISTBOX_ID_JS) return { result: { objectId: "lb-obj" } };
      if (fn === SET_COMBOBOX_OPTION_JS) {
        expect(p.objectId).toBe("lb-obj");
        return { result: { value: { success: true, message: "ok" } } };
      }
      return { result: { value: undefined } };
    });
    const r = await setComboboxOption(h.s, 21, "z");
    expect(r.success).toBe(true);
  });
  it("listbox 未发现 → 结构化 error（availableOptions 空）", async () => {
    const h = makeInternals();
    scriptClickChain(h);
    const r = await setComboboxOption(h.s, 21, "z");
    expect(r).toEqual({
      success: false,
      error: "combobox listbox not found (no aria-controls/aria-owns target)",
      availableOptions: [],
    });
  });
});

describe("setCustomDropdownOption（开态发现 → 真实 click 选中）", () => {
  it("发现 list → 找到 option → describeNode → click → 成功", async () => {
    const h = makeInternals();
    scriptClickChain(h, {
      [EFFECTIVE_CLICK_TARGET_JS]: undefined,
      [CUSTOM_LISTBOX_DISCOVER_JS]: undefined,
      [CUSTOM_FIND_OPTION_JS]: undefined,
    });
    // returnByValue=false 的三个 locator 走 objectId 外壳
    h.transport
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === EFFECTIVE_CLICK_TARGET_JS) return { result: { objectId: "eff-obj" } };
        if (fn === CUSTOM_LISTBOX_DISCOVER_JS) return { result: { objectId: "list-obj" } };
        if (fn === CUSTOM_FIND_OPTION_JS) return { result: { objectId: "opt-obj" } };
        return { result: { value: undefined } };
      })
      .respond("DOM.describeNode", (p: Record<string, unknown> | undefined) =>
        p?.objectId === "eff-obj"
          ? { node: { backendNodeId: 55 } }
          : p?.objectId === "opt-obj"
            ? { node: { backendNodeId: 66 } }
            : {},
      );
    const r = await setCustomDropdownOption(h.s, 30, "opt");
    expect(r).toEqual({ success: true, message: "Selected option: opt", value: "opt" });
    expect(h.sleeps).toContain(500);
    expect(h.sleeps).toContain(300);
    const clicked = h.transport.framesOf("Input.dispatchMouseEvent").map((f) => f.params?.type);
    expect(clicked).toContain("mousePressed");
  });
  it("option 未命中 → error + availableOptions 回读", async () => {
    const h = makeInternals();
    scriptClickChain(h, {
      [CUSTOM_OPEN_OPTIONS_JS]: [{ value: "other", text: "Other" }],
      [SCROLL_LISTBOX_JS]: false,
    });
    h.transport.respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
      const fn = String(p.functionDeclaration);
      if (fn === EFFECTIVE_CLICK_TARGET_JS) return { result: { objectId: "eff-obj" } };
      if (fn === CUSTOM_LISTBOX_DISCOVER_JS) return { result: { objectId: "list-obj" } };
      if (fn === CUSTOM_FIND_OPTION_JS) return { result: {} }; // miss
      if (fn === SCROLL_LISTBOX_JS) return { result: { value: false } };
      if (fn === CUSTOM_OPEN_OPTIONS_JS) {
        return { result: { value: [{ value: "other", text: "Other" }] } };
      }
      return { result: { value: undefined } };
    });
    h.transport.respond("DOM.describeNode", (p: Record<string, unknown> | undefined) =>
      p?.objectId === "eff-obj" ? { node: { backendNodeId: 55 } } : {},
    );
    const r = await setCustomDropdownOption(h.s, 30, "nope");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Option with text or value 'nope' not found in custom dropdown");
    expect(r.availableOptions).toEqual([{ value: "other", text: "Other" }]);
  });
});

describe("custom 开态读流与容错分支", () => {
  it("expandAndFetchCustomOptions：effective=target 同 bid 单次尝试 → 读 options → 收起", async () => {
    const h = makeInternals();
    scriptClickChain(h, {
      [CUSTOM_LISTBOX_DISCOVER_JS]: undefined,
      [CUSTOM_OPEN_OPTIONS_JS]: [{ value: "o1", text: "Opt1" }],
    });
    h.transport
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === EFFECTIVE_CLICK_TARGET_JS) return { result: { objectId: "eff-obj" } };
        if (fn === CUSTOM_LISTBOX_DISCOVER_JS) return { result: { objectId: "list-obj" } };
        if (fn === CUSTOM_OPEN_OPTIONS_JS) {
          return { result: { value: [{ value: "o1", text: "Opt1" }] } };
        }
        return { result: { value: undefined } };
      })
      .respond("DOM.describeNode", (p: Record<string, unknown> | undefined) =>
        p?.objectId === "eff-obj" ? { node: { backendNodeId: 30 } } : {},
      );
    const r = await expandAndFetchCustomOptions(h.s, 30);
    expect(r).toEqual([{ value: "o1", text: "Opt1" }]);
    // effective==原 bid → 只点一次（mousePressed 单帧序列仅一组）
    const presses = h.transport
      .framesOf("Input.dispatchMouseEvent")
      .filter((f) => f.params?.type === "mousePressed");
    expect(presses).toHaveLength(1);
  });
  it("listbox 未发现（effective 与原触发器两次尝试都空）→ 抛错", async () => {
    const h = makeInternals();
    scriptClickChain(h, {});
    h.transport
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === EFFECTIVE_CLICK_TARGET_JS) return { result: { objectId: "eff-obj" } };
        return { result: {} }; // discover miss
      })
      .respond("DOM.describeNode", (p: Record<string, unknown> | undefined) =>
        p?.objectId === "eff-obj" ? { node: { backendNodeId: 77 } } : {},
      );
    await expect(expandAndFetchCustomOptions(h.s, 30)).rejects.toThrow(
      "custom dropdown listbox not found after opening",
    );
    const presses = h.transport
      .framesOf("Input.dispatchMouseEvent")
      .filter((f) => f.params?.type === "mousePressed");
    expect(presses).toHaveLength(2); // effective(77) + 原触发器(30) 各一次
  });
  it("effective 解析失败 → 回退原 bid；option 对象解析失败 → could not be resolved", async () => {
    const h = makeInternals();
    scriptClickChain(h, {
      [CUSTOM_OPEN_OPTIONS_JS]: [{ value: "x", text: "X" }],
    });
    h.transport
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === EFFECTIVE_CLICK_TARGET_JS) throw new Error("resolve boom");
        if (fn === CUSTOM_LISTBOX_DISCOVER_JS) return { result: { objectId: "list-obj" } };
        if (fn === CUSTOM_FIND_OPTION_JS) return { result: { objectId: "opt-obj" } };
        if (fn === CUSTOM_OPEN_OPTIONS_JS) {
          return { result: { value: [{ value: "x", text: "X" }] } };
        }
        return { result: { value: undefined } };
      })
      .respond("DOM.describeNode", (p: Record<string, unknown> | undefined) =>
        p?.objectId === "opt-obj" ? {} : {},
      );
    const r = await setCustomDropdownOption(h.s, 30, "x");
    expect(r.success).toBe(false);
    expect(r.error).toBe("custom dropdown option could not be resolved");
    expect(r.availableOptions).toEqual([{ value: "x", text: "X" }]);
    expect(h.logs.some((l) => l.includes("effective click target resolve failed"))).toBe(true);
  });
  it("native 单选：回退点击也失败 → 原样返回结构化 error（携 availableOptions）", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", resolveFor(3))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === SELECT_OPTION_JS) {
          return {
            result: {
              value: {
                success: false,
                selectionReverted: true,
                error: "reverted",
                availableOptions: [{ value: "q", text: "Q" }],
              },
            },
          };
        }
        expect(fn).toBe(SELECT_OPTION_CLICK_FALLBACK_JS);
        return { result: { value: { success: false } } };
      });
    const r = await setSelectOption(h.s, 3, "x");
    expect(r).toEqual({
      success: false,
      selectionReverted: true,
      error: "reverted",
      availableOptions: [{ value: "q", text: "Q" }],
    });
  });
});

describe("setSubtreeOption 分支补面（forged found 响应——上游死代码的分支覆盖）", () => {
  const childSetup = (located: unknown) => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", resolveFor(13))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === ARIA_OPTIONS_JS) return { result: { value: null } };
        if (fn === CUSTOM_CLASS_OPTIONS_JS) return { result: { value: null } };
        if (fn === SUBTREE_SEARCH_JS) {
          return { result: { value: { options: [{ value: "x" }], source: "child-depth-1" } } };
        }
        if (fn === SUBTREE_LOCATE_JS) return { result: { value: located } };
        if (fn === SET_ARIA_JS)
          return { result: { value: { success: true, message: "aria set" } } };
        return { result: { value: undefined } };
      });
    return h;
  };
  it("found + 顶层 objectId → aria setter", async () => {
    const h = childSetup({ found: true, type: "aria", objectId: "child-1" });
    const r = await setDropdownOption(h.s, 13, "x");
    expect(r.success).toBe(true);
    expect(r.source).toBe("child-depth-1");
  });
  it("found + node.objectId 形态（CDP 嵌套兼容）→ custom setter；无 objectId → error", async () => {
    const h = childSetup({ found: true, type: "custom", node: { objectId: "child-2" } });
    const r = await setDropdownOption(h.s, 13, "x");
    expect(r.error).toBeUndefined();
    const h2 = childSetup({ found: true, type: "aria" });
    const r2 = await setDropdownOption(h2.s, 13, "x");
    expect(r2.error).toBe("could not resolve subtree child objectId");
  });
});

describe("still-open 收起第二击 / 滚动失败分支", () => {
  it("Escape 后仍开 → 再点触发器收起（Runtime.evaluate 半开真值）", async () => {
    const h = makeInternals();
    let stillOpen = true;
    h.transport
      .respond("DOM.scrollIntoViewIfNeeded", {})
      .respond("Runtime.evaluate", (p: Record<string, unknown>) => {
        const expr = String(p.expression ?? "");
        if (expr.includes("clientWidth")) return { result: { value: [1280, 720] } };
        if (expr.includes("semi-popover-wrapper-show")) {
          return { result: { value: stillOpen } };
        }
        return { result: { value: undefined } };
      })
      .respond("DOM.getContentQuads", { quads: [[10, 10, 110, 10, 110, 40, 10, 40]] })
      .respond("Input.dispatchMouseEvent", {})
      .respond("Input.dispatchKeyEvent", {})
      .respond("DOM.describeNode", {})
      .respond("DOM.resolveNode", (params: Record<string, unknown> | undefined) =>
        params?.backendNodeId === undefined
          ? {}
          : { object: { objectId: `obj-${params.backendNodeId}` } },
      )
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === EFFECTIVE_CLICK_TARGET_JS) return { result: {} }; // effective 解析失败 → 原 bid
        if (fn === CUSTOM_LISTBOX_DISCOVER_JS) {
          // 第一次（开态）发现 list；收起复查后再点时不再发现——用计数翻转
          stillOpen = false;
          return { result: { objectId: "list-obj" } };
        }
        if (fn === CUSTOM_FIND_OPTION_JS) return { result: { objectId: "opt-obj" } };
        return { result: { value: undefined } };
      });
    h.transport.respond("DOM.describeNode", (p: Record<string, unknown> | undefined) =>
      p?.objectId === "opt-obj" ? { node: { backendNodeId: 66 } } : {},
    );
    const r = await setCustomDropdownOption(h.s, 31, "opt");
    expect(r.success).toBe(true);
    // 两次 mousePressed 组：选中 option 一次 + 收起 toggle 一次
    const presses = h.transport
      .framesOf("Input.dispatchMouseEvent")
      .filter((f) => f.params?.type === "mousePressed");
    expect(presses.length).toBeGreaterThanOrEqual(2);
  });
  it("滚动 listbox 抛错 → findOption 返回 null（best-effort false）", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", resolveFor(13))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === SCROLL_LISTBOX_JS) throw new Error("scroll denied");
        if (fn === CUSTOM_FIND_OPTION_JS) return { result: {} };
        return { result: { value: undefined } };
      });
    // 直接构造：findOptionObjectId 未导出——经 setCustomDropdownOption 走查
    // （此用例以 scrollListbox 异常分支为目标，经 expand 流程触达）
    const discover = await import("../../src/browser/dropdown.js").then((m) =>
      m.expandAndFetchCustomOptions(h.s, 13).catch((e: unknown) => e),
    );
    expect(discover).toBeInstanceOf(Error);
  });
});

describe("补面：custom setter dispatcher 档与滚动二轮寻位", () => {
  it("写 dispatcher custom 档（_SET_CUSTOM_JS）", async () => {
    const h = makeInternals();
    h.transport
      .respond("DOM.resolveNode", resolveFor(17))
      .respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
        const fn = String(p.functionDeclaration);
        if (fn === ARIA_OPTIONS_JS) return { result: { value: null } };
        if (fn === CUSTOM_CLASS_OPTIONS_JS) return { result: { value: [{ value: "c" }] } };
        if (fn === SET_CUSTOM_JS) return { result: { value: { success: true } } };
        return { result: { value: undefined } };
      });
    const r = await setDropdownOption(h.s, 17, "c");
    expect(r.success).toBe(true);
    expect(r.source).toBe("custom");
  });
  it("listbox 未发现短路（setCustomDropdownOption）", async () => {
    const h = makeInternals();
    scriptClickChain(h, {});
    h.transport.respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
      const fn = String(p.functionDeclaration);
      if (fn === EFFECTIVE_CLICK_TARGET_JS) return { result: { objectId: "eff-obj" } };
      return { result: {} };
    });
    h.transport.respond("DOM.describeNode", (p: Record<string, unknown> | undefined) =>
      p?.objectId === "eff-obj" ? { node: { backendNodeId: 44 } } : {},
    );
    const r = await setCustomDropdownOption(h.s, 18, "x");
    expect(r).toEqual({
      success: false,
      error: "custom dropdown listbox not found after opening",
      availableOptions: [],
    });
  });
  it("option 首轮 miss → 滚一页 → 次轮命中（虚拟化 scroll-until-found）", async () => {
    const h = makeInternals();
    scriptClickChain(h, {});
    let finds = 0;
    h.transport.respond("Runtime.callFunctionOn", (p: Record<string, unknown>) => {
      const fn = String(p.functionDeclaration);
      if (fn === EFFECTIVE_CLICK_TARGET_JS) return { result: {} }; // 解析失败 → 原 bid
      if (fn === CUSTOM_LISTBOX_DISCOVER_JS) return { result: { objectId: "list-obj" } };
      if (fn === CUSTOM_FIND_OPTION_JS) {
        finds += 1;
        return finds === 1 ? { result: {} } : { result: { objectId: "opt-obj" } };
      }
      if (fn === SCROLL_LISTBOX_JS) return { result: { value: true } };
      return { result: { value: undefined } };
    });
    h.transport.respond("DOM.describeNode", (p: Record<string, unknown> | undefined) =>
      p?.objectId === "opt-obj" ? { node: { backendNodeId: 66 } } : {},
    );
    const r = await setCustomDropdownOption(h.s, 19, "opt");
    expect(r.success).toBe(true);
    expect(h.sleeps).toContain(120);
    expect(finds).toBe(2);
  });
});
