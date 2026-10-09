// M5 段 C 缝二单元：SubmitProbe 预筛矩阵（tag/type）+ probe 返回解析契约（8 项/
// 40 字符/形态过滤）+ probeSubmitForClick 全链（预筛短路零 CDP / eval 异常与
// 挂起超时 fail-open——评审轮 1 [2]）。JS 体锚定关键语句（closest/defaultChecked/
// defaultSelected/password 打码）——页面真值验证在段 F 真机。

import { describe, expect, it, vi } from "vitest";
import {
  isSubmitCandidateNode,
  parseSubmitProbeResult,
  probeSubmitForClick,
  SUBMIT_PROBE_JS,
  SUBMIT_PROBE_TIMEOUT_MS,
} from "../../src/agent/submit-probe.js";
import type { EnhancedDOMTreeNode } from "../../src/browser/views.js";
import { makeNode } from "../tools/fake-browser.js";

describe("isSubmitCandidateNode（快照预筛矩阵）", () => {
  const node = (nodeName: string, attributes: Record<string, string> = {}) =>
    makeNode({ nodeName, attributes, backendNodeId: 1 });
  it("命中面：input[type=submit] / button[type=submit] / button 无 type", () => {
    expect(isSubmitCandidateNode(node("INPUT", { type: "submit" }))).toBe(true);
    expect(isSubmitCandidateNode(node("BUTTON", { type: "submit" }))).toBe(true);
    expect(isSubmitCandidateNode(node("button"))).toBe(true);
    expect(isSubmitCandidateNode(node("INPUT", { type: "SUBMIT" }))).toBe(true); // 大小写不敏感
  });
  it("矩阵外：input 其他 type / input 无 type / button[type=button] / 其他 tag", () => {
    expect(isSubmitCandidateNode(node("INPUT", { type: "text" }))).toBe(false);
    expect(isSubmitCandidateNode(node("INPUT", { type: "image" }))).toBe(false);
    expect(isSubmitCandidateNode(node("INPUT"))).toBe(false); // 无 type 默认 text 语义
    expect(isSubmitCandidateNode(node("BUTTON", { type: "button" }))).toBe(false);
    expect(isSubmitCandidateNode(node("BUTTON", { type: "reset" }))).toBe(false);
    expect(isSubmitCandidateNode(node("DIV", { role: "button" }))).toBe(false);
    expect(isSubmitCandidateNode(node("A"))).toBe(false);
  });
});

describe("parseSubmitProbeResult（返回解析契约）", () => {
  it("合法数组直映；password 值原样透传（打码在 JS 侧）", () => {
    expect(
      parseSubmitProbeResult([
        { name: "user", value: "alice" },
        { name: "pwd", value: "***" },
      ]),
    ).toEqual([
      { name: "user", value: "alice" },
      { name: "pwd", value: "***" },
    ]);
  });
  it(">8 项截到 8；值 >40 字符截断加省略号", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, value: "v" }));
    const parsed = parseSubmitProbeResult(many);
    expect(parsed).toHaveLength(8);
    const long = parseSubmitProbeResult([{ name: "q", value: "x".repeat(50) }]);
    expect(long?.[0]?.value).toBe(`${"x".repeat(40)}...`);
  });
  it("null / 空数组 / 非数组 / 全非法条目 → null；非法条目被过滤", () => {
    expect(parseSubmitProbeResult(null)).toBeNull();
    expect(parseSubmitProbeResult([])).toBeNull();
    expect(parseSubmitProbeResult("nope")).toBeNull();
    expect(parseSubmitProbeResult([{ name: 1, value: "x" }])).toBeNull();
    expect(parseSubmitProbeResult([{ bogus: true }, { name: "ok", value: "v" }])).toEqual([
      { name: "ok", value: "v" },
    ]);
  });
});

describe("probeSubmitForClick（挂点消费端）", () => {
  const submitButton = makeNode({ nodeName: "BUTTON", backendNodeId: 42 });
  const domState = { selectorMap: new Map<number, EnhancedDOMTreeNode>([[3, submitButton]]) };
  const calls: Array<{ bid: number; fn: string }> = [];
  const fakeBrowser = (result: unknown, error: Error | null = null) => ({
    evalFunctionOnNode: async (bid: number, fn: string) => {
      calls.push({ bid, fn });
      if (error !== null) throw error;
      return result;
    },
  });

  it("命中 → evalFunctionOnNode 收到 backendNodeId 与 SUBMIT_PROBE_JS，摘要解析回传", async () => {
    calls.length = 0;
    const r = await probeSubmitForClick(fakeBrowser([{ name: "user", value: "alice" }]), domState, {
      index: 3,
    });
    expect(r).toEqual([{ name: "user", value: "alice" }]);
    expect(calls).toEqual([{ bid: 42, fn: SUBMIT_PROBE_JS }]);
  });
  it("无 index / 查无节点 / 预筛矩阵外 → null 且零 CDP 调用", async () => {
    calls.length = 0;
    expect(await probeSubmitForClick(fakeBrowser(null), domState, {})).toBeNull();
    expect(await probeSubmitForClick(fakeBrowser(null), domState, { index: 99 })).toBeNull();
    const plain = makeNode({ nodeName: "DIV", backendNodeId: 43 });
    expect(
      await probeSubmitForClick(
        fakeBrowser(null),
        { selectorMap: new Map([[5, plain]]) },
        { index: 5 },
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it("eval 抛错 → null（fail-open：检测不阻塞点击）", async () => {
    expect(
      await probeSubmitForClick(fakeBrowser(null, new Error("cdp down")), domState, { index: 3 }),
    ).toBeNull();
  });
  it("eval 挂起（页面主线程阻塞，响应永不返回）→ 超时 null 放行不永久挂死（轮 1 [2]）", async () => {
    vi.useFakeTimers();
    try {
      const hanging = {
        evalFunctionOnNode: (_bid: number, _fn: string) => new Promise<unknown>(() => {}),
      };
      const p = probeSubmitForClick(hanging, domState, { index: 3 });
      await vi.advanceTimersByTimeAsync(SUBMIT_PROBE_TIMEOUT_MS);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("probe 返回 null（无 form/无变更字段）→ null", async () => {
    expect(await probeSubmitForClick(fakeBrowser(null), domState, { index: 3 })).toBeNull();
    expect(await probeSubmitForClick(fakeBrowser([]), domState, { index: 3 })).toBeNull();
  });
});

describe("SUBMIT_PROBE_JS 体锚定（关键语句在位）", () => {
  it("submit 复核 + form 祖先 + 变更比对 + password 打码 + 8 项上限 + 40 截断", () => {
    expect(SUBMIT_PROBE_JS).toContain("this.closest('form')");
    expect(SUBMIT_PROBE_JS).toContain("el.checked !== el.defaultChecked");
    expect(SUBMIT_PROBE_JS).toContain("defaultSelected");
    expect(SUBMIT_PROBE_JS).toContain("el.value !== el.defaultValue");
    expect(SUBMIT_PROBE_JS).toContain("etype === 'password' ? '***'");
    expect(SUBMIT_PROBE_JS).toContain("fields.length < 8");
    expect(SUBMIT_PROBE_JS).toContain("value.slice(0, 40) + '...'");
    expect(SUBMIT_PROBE_JS).toContain("return fields.length > 0 ? fields : null");
  });
});
