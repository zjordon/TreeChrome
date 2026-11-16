// 会话级直驱动词面单测（issue #32 P0）：15 动词表形状、locator/browser 特殊面、
// validateDriveParams 的类型窄校验/必填/XOR/空串口径（与 daemon buildParams 对齐）。

import { describe, expect, it } from "vitest";
import { DRIVE_VERBS, findDriveVerb, validateDriveParams } from "../../src/tools/verb-specs.js";

describe("DRIVE_VERBS 表形状", () => {
  it("15 动词齐备（与 tc daemon 命令面同名同序）", () => {
    expect(DRIVE_VERBS.map((spec) => spec.verb)).toEqual([
      "get_state",
      "navigate",
      "click",
      "input_text",
      "select_dropdown",
      "scroll",
      "find_text",
      "read_grid",
      "evaluate",
      "screenshot",
      "upload_file",
      "go_back",
      "tabs",
      "switch_tab",
      "close_tab",
    ]);
  });

  it("locator 类恰为四件（epoch 簿记对象）——scroll 非 locator（只 direction/amount）", () => {
    expect(DRIVE_VERBS.filter((spec) => spec.locator).map((spec) => spec.verb)).toEqual([
      "click",
      "input_text",
      "select_dropdown",
      "upload_file",
    ]);
  });

  it("browser 特殊面恰为 get_state/tabs，其余 13 件均为 Tools 动作", () => {
    const specials = DRIVE_VERBS.filter((spec) => spec.browser !== null);
    expect(specials.map((spec) => [spec.verb, spec.browser])).toEqual([
      ["get_state", "get_state"],
      ["tabs", "get_tabs"],
    ]);
    for (const spec of DRIVE_VERBS) {
      expect(spec.tool === null ? spec.browser !== null : spec.browser === null).toBe(true);
    }
  });

  it("findDriveVerb：命中与未命中", () => {
    expect(findDriveVerb("click")?.tool).toBe("click");
    expect(findDriveVerb("nope")).toBeNull();
  });
});

describe("validateDriveParams", () => {
  it("click 定位 XOR：index/element_id 恰一——命中/另一态/双给/全缺", () => {
    const spec = findDriveVerb("click");
    if (spec === null) throw new Error("click spec missing");
    expect(validateDriveParams(spec, { index: 3 })).toEqual({ ok: true, params: { index: 3 } });
    expect(validateDriveParams(spec, { element_id: 12 })).toEqual({
      ok: true,
      params: { element_id: 12 },
    });
    expect(validateDriveParams(spec, { index: 1, element_id: 2 }).ok).toBe(false);
    expect(validateDriveParams(spec, {}).ok).toBe(false);
  });

  it("必填缺失与类型窄校验（int/str/bool）", () => {
    const navigate = findDriveVerb("navigate");
    const click = findDriveVerb("click");
    const evaluate = findDriveVerb("evaluate");
    if (navigate === null || click === null || evaluate === null) {
      throw new Error("spec missing");
    }
    const noUrl = validateDriveParams(navigate, {});
    expect(noUrl.ok).toBe(false);
    if (noUrl.ok === false) expect(noUrl.message).toContain("url");
    const badInt = validateDriveParams(click, { index: "3" });
    expect(badInt.ok).toBe(false);
    if (badInt.ok === false) expect(badInt.message).toContain("整数");
    const badStr = validateDriveParams(evaluate, { code: 123 });
    expect(badStr.ok).toBe(false);
    const badBool = validateDriveParams(navigate, { url: "https://x", new_tab: "yes" });
    expect(badBool.ok).toBe(false);
  });

  it("未知参数拒绝；空串视同未给（必填空串 → 缺参数）；显式 false 布尔保留", () => {
    const inputText = findDriveVerb("input_text");
    const findText = findDriveVerb("find_text");
    if (inputText === null || findText === null) throw new Error("spec missing");
    const unknown = validateDriveParams(inputText, { index: 1, text: "x", who: "?" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok === false) expect(unknown.message).toContain("who");
    const emptyText = validateDriveParams(findText, { text: "" });
    expect(emptyText.ok).toBe(false);
    if (emptyText.ok === false) expect(emptyText.message).toContain("text");
    expect(validateDriveParams(inputText, { index: 1, text: "x", clear: false })).toEqual({
      ok: true,
      params: { index: 1, text: "x", clear: false },
    });
  });

  it("str[] 滤非串与空串、单值收编（daemon 口径）；select_dropdown value/values XOR", () => {
    const readGrid = findDriveVerb("read_grid");
    const dropdown = findDriveVerb("select_dropdown");
    if (readGrid === null || dropdown === null) throw new Error("spec missing");
    expect(validateDriveParams(readGrid, { fields: ["a", "", 3, "b"] })).toEqual({
      ok: true,
      params: { fields: ["a", "b"] },
    });
    expect(validateDriveParams(readGrid, { fields: "solo" })).toEqual({
      ok: true,
      params: { fields: ["solo"] },
    });
    expect(validateDriveParams(dropdown, { index: 2, value: "x" }).ok).toBe(true);
    expect(validateDriveParams(dropdown, { index: 2, values: ["x", "y"] }).ok).toBe(true);
    expect(validateDriveParams(dropdown, { index: 2, value: "x", values: ["y"] }).ok).toBe(false);
  });

  it("空参动词（get_state/tabs/go_back）：空入参 ok 且产空参数", () => {
    for (const verb of ["get_state", "tabs", "go_back"]) {
      const spec = findDriveVerb(verb);
      if (spec === null) throw new Error(`spec missing: ${verb}`);
      expect(validateDriveParams(spec, {})).toEqual({ ok: true, params: {} });
    }
  });
});
