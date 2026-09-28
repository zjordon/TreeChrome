// dropdown_options（actions.py :1954-2013）+ select_dropdown（:2014-2146）。
// 动作层廉价预分类（native select / combobox aria-controls / 其余委托 session
// dispatcher）；读写共用 _describe_dropdown 回显 + _format_options_result 短长拆
// （:1278-1308 逐字节锚定 batch2b.json）；issue #192 多选与 #160 开态 fallback。

import { ActionResult } from "../../agent/views.js";
import type { DropdownOption, DropdownSetterResult } from "../../browser/dropdown.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import {
  describeDropdown,
  getElementByIndex,
  isAutocompleteField,
} from "./shared/element-lookup.js";

/** :31-37 空选项按下拉类型给诊断（native 不在此表 → 沿用 P0 仅 hint） */
export const EMPTY_OPTIONS_DIAGNOSTIC: Record<string, string> = {
  aria: "Listbox/menu found but no [role=option] children (may need expanding).",
  custom: "Custom dropdown found but no .item/.option/[data-value] children (may need expanding).",
  combobox: "Combobox listbox found but empty (options may load on demand).",
  "click-select":
    "Select element has no <option> children (may populate lazily — try dropdown_options again after the page settles).",
  "custom-open":
    "Custom dropdown opened but no options found (may load on demand — retry after settle, or scroll).",
};

const jsonDumps = (s: unknown): string => JSON.stringify(s);

/**
 * :1278-1308 共享下拉回显（短/长拆）：json 编码 + 序号 + 用法提示；source 折进
 * long_term_memory 作诊断通道（native 无 via 后缀——与 P0 字节一致）。
 */
export function formatOptionsResult(
  rawOptions: DropdownOption[],
  desc: string,
  index: number,
  source: string,
): ActionResult {
  const lines: string[] = [];
  rawOptions.forEach((opt, i) => {
    const text = jsonDumps(opt.text ?? "");
    const value = jsonDumps(opt.value ?? "");
    const status = opt.selected ? " (selected)" : "";
    lines.push(`${i}: text=${text}, value=${value}${status}`);
  });
  const hint = `Use the value in select_dropdown(index=${index}, value=...)`;
  let extracted: string;
  if (lines.length === 0) {
    const diag = EMPTY_OPTIONS_DIAGNOSTIC[source];
    extracted = diag !== undefined ? `${diag}\n${hint}` : hint;
  } else {
    extracted = `${lines.join("\n")}\n${hint}`;
  }
  let via: string;
  if (source === "native") {
    via = "";
  } else if (source.startsWith("child-depth-")) {
    via = ` via ${source}`;
  } else {
    via = ` via [${source.toUpperCase()}]`;
  }
  const memory = `Got ${rawOptions.length} options from ${desc}${via}`;
  return new ActionResult({ extractedContent: extracted, longTermMemory: memory });
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createDropdownOptionsHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    if (typeof params.index !== "number") {
      return new ActionResult({ error: "dropdown_options requires a number `index` parameter." });
    }
    const index = params.index;
    const [entry, lookupError] = await getElementByIndex(index, browser, ctx);
    if (lookupError !== null) return lookupError;
    const node = entry as NonNullable<typeof entry>;

    const tag = node.tagName.toUpperCase();
    const backendId = node.backendNodeId;
    const [isCombo] = isAutocompleteField(node);
    const attrs = node.attributes ?? {};

    try {
      // native <select>：P0 路径零改动（source=native 无 via 后缀）
      if (tag === "SELECT") {
        const rawOptions = await browser.fetchSelectOptions(backendId);
        return formatOptionsResult(rawOptions, describeDropdown(node, index), index, "native");
      }
      // combobox（aria-controls 独立 listbox）：Python flow（展开→读→收起）
      if (isCombo && (attrs["aria-controls"] || attrs["aria-owns"])) {
        const rawOptions = await browser.expandAndFetchComboboxOptions(backendId);
        return formatOptionsResult(rawOptions, describeDropdown(node, index), index, "combobox");
      }
      // 其余：session dispatcher（aria / custom / 子树）
      const dispatched = await browser.fetchDropdownOptions(backendId);
      if (dispatched.source !== null) {
        return formatOptionsResult(
          dispatched.options,
          describeDropdown(node, index),
          index,
          dispatched.source,
        );
      }
      // FALLBACK（issue #160）：闭态判型 miss → 开态 discover+read
      let rawOptions: DropdownOption[];
      try {
        rawOptions = await browser.expandAndFetchCustomOptions(backendId);
      } catch (ex) {
        return new ActionResult({
          error:
            `Index ${index} is a [${tag}] element, not a recognized dropdown ` +
            `(native <select>, ARIA listbox/menu, custom dropdown, or combobox). ` +
            `Open-then-discover also failed: ${errText(ex)}`,
        });
      }
      if (rawOptions.length === 0) {
        return new ActionResult({
          error:
            `Index ${index} opened but exposed no options — it may not be a ` +
            "dropdown, or options load on a trigger other than a click.",
        });
      }
      return formatOptionsResult(rawOptions, describeDropdown(node, index), index, "custom-open");
    } catch (e) {
      return new ActionResult({ error: `Failed to read dropdown options: ${errText(e)}` });
    }
  };
}

export function createSelectDropdownHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    if (typeof params.index !== "number") {
      return new ActionResult({ error: "select_dropdown requires a number `index` parameter." });
    }
    const index = params.index;
    const [entry, lookupError] = await getElementByIndex(index, browser, ctx);
    if (lookupError !== null) return lookupError;
    const node = entry as NonNullable<typeof entry>;

    const tag = node.tagName.toUpperCase();
    const backendId = node.backendNodeId;
    // issue #192 运行时守卫（registry 不校验 execute 路径）
    const value = params.value;
    const values = params.values;
    if (value !== undefined && value !== null && values !== undefined && values !== null) {
      return new ActionResult({
        error: "Pass either value (single option) or values (multi-select), not both",
      });
    }
    if ((value === undefined || value === null) && (values === undefined || values === null)) {
      return new ActionResult({
        error: "select_dropdown requires value (single option) or values (multi-select list)",
      });
    }
    if (
      values !== undefined &&
      values !== null &&
      (!Array.isArray(values) ||
        values.length === 0 ||
        !values.every((v) => typeof v === "string" && v !== ""))
    ) {
      return new ActionResult({
        error: "values must be a non-empty list of non-empty strings",
      });
    }
    if (values !== undefined && values !== null && tag !== "SELECT") {
      return new ActionResult({
        error:
          "values (multi-select) is only supported for native <select multiple>; " +
          "for this element use value= (single option)",
      });
    }
    const [isCombo] = isAutocompleteField(node);
    const attrs = node.attributes ?? {};

    let result: DropdownSetterResult;
    try {
      if (values !== undefined && values !== null) {
        // multi（<select multiple>，issue #192）：一次设全
        result = await browser.setSelectOptionMulti(backendId, values as string[]);
      } else if (tag === "SELECT") {
        result = await browser.setSelectOption(backendId, value as string);
      } else if (isCombo && (attrs["aria-controls"] || attrs["aria-owns"])) {
        result = await browser.setComboboxOption(backendId, value as string);
      } else {
        result = await browser.setDropdownOption(backendId, value as string);
        if (result.source === null || result.source === undefined) {
          // FALLBACK（issue #160）：闭态判型 miss → 开态 discover+select
          result = await browser.setCustomDropdownOption(backendId, value as string);
        }
      }
    } catch (e) {
      return new ActionResult({ error: `Failed to select option: ${errText(e)}` });
    }

    const desc = describeDropdown(node, index);
    if (values !== undefined && values !== null) {
      // issue #192 multi echo：独立格式（单选提示语有测试断言 endswith value=...）
      if (result.success) {
        const message = result.message ?? `Selected options: ${jsonDumps(values)}`;
        const memory = `Selected ${jsonDumps(values)} in ${desc}`;
        return new ActionResult({ extractedContent: message, longTermMemory: memory });
      }
      const available = result.availableOptions ?? [];
      if (available.length > 0) {
        const lines = available.map(
          (o, i) =>
            `${i}: text=${jsonDumps(o.text ?? "")}, value=${jsonDumps(o.value ?? "")}` +
            `${o.selected ? " (selected)" : ""}`,
        );
        const missed = result.missed ?? [];
        let reason: string;
        if (missed.length > 0) {
          reason = `Options not found: ${missed.join(", ")}`;
        } else if (result.error !== undefined && result.error !== "") {
          reason = String(result.error);
        } else {
          reason = "";
        }
        const head = reason === "" ? "" : `${reason}\n`;
        const extracted =
          `${head}${lines.join("\n")}\n` +
          `Use the values in select_dropdown(index=${index}, values=[...])`;
        const memory = `Couldn't select ${jsonDumps(values)} in ${desc}${reason === "" ? "" : ` (${reason})`}`;
        return new ActionResult({ extractedContent: extracted, longTermMemory: memory });
      }
      const err = result.error ?? `Failed to select options: ${jsonDumps(values)}`;
      return new ActionResult({ error: err });
    }
    if (result.success) {
      const message = result.message ?? `Selected option: ${jsonDumps(value)}`;
      const memory = `Selected ${jsonDumps(value)} in ${desc}`;
      return new ActionResult({ extractedContent: message, longTermMemory: memory });
    }
    // Miss / 框架回退：回显可用选项供 LLM 自纠
    const available = result.availableOptions ?? [];
    if (available.length > 0) {
      const lines = available.map(
        (o, i) => `${i}: text=${jsonDumps(o.text ?? "")}, value=${jsonDumps(o.value ?? "")}`,
      );
      const extracted =
        `${lines.join("\n")}\n` + `Use the value in select_dropdown(index=${index}, value=...)`;
      const memory = `Couldn't select ${jsonDumps(value)} in ${desc} (not an available option)`;
      return new ActionResult({ extractedContent: extracted, longTermMemory: memory });
    }
    const err = result.error ?? `Failed to select option: ${jsonDumps(value)}`;
    return new ActionResult({ error: err });
  };
}
