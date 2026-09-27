// input_text 动作（actions.py :1402-1483）：exactly-one 守卫 → highlight+click 聚焦 →
// 直赋值分支（date/time/color/range）或 typeText → combobox 等待 → 回读验证 +
// 验证标记 + combobox 提示。

import { ActionResult } from "../../agent/views.js";
import { requiresDirectValueAssignment } from "../../browser/index.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import { readValidationState } from "./shared/click-evidence.js";
import {
  describeInput,
  getElementByIndex,
  isAutocompleteField,
  pyRepr,
} from "./shared/element-lookup.js";
import { errText } from "./shared/nav-health.js";

export function createInputTextHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    // element_id 是 index 的别名。二选一——执行路径 registry 不校验，在此守卫
    const index = params.index ?? null;
    const elementId = params.element_id ?? null;
    if ((index === null) === (elementId === null)) {
      return new ActionResult({
        error: "input_text requires exactly one of `index` or `element_id`.",
      });
    }
    const resolvedIndex = index !== null ? Number(index) : Number(elementId);
    const [entry, error] = await getElementByIndex(resolvedIndex, browser, ctx);
    if (error !== null) return error;
    if (entry === null) {
      return new ActionResult({ error: `Element ${resolvedIndex} not found in DOM state` });
    }
    const backendId = entry.backendNodeId;
    // 必填守卫（Python params["text"] KeyError → execute 包装 error 的等价补偿）：
    // 漏传/非串若落到 String(undefined ?? "") 会以 clear 默认值静默清空字段（数据损坏）
    if (typeof params.text !== "string") {
      return new ActionResult({ error: "input_text requires a string `text` parameter." });
    }
    const text = params.text;
    const clear = params.clear === undefined ? true : params.clear === true;

    // 1. Focus: highlight -> click_element（映射 bool 信号；聚焦失败不静默成功）
    let clicked: boolean;
    try {
      await browser.highlightElement(backendId);
      clicked = await browser.clickElement(backendId);
    } catch (e) {
      return new ActionResult({ error: `Input focus failed: ${errText(e)}` });
    }
    if (!clicked) {
      return new ActionResult({
        error:
          `Could not focus element ${resolvedIndex} for input ` +
          "(no coordinates and JS click fallback failed; " +
          "the element may be detached, hidden, or in a cross-origin iframe)",
      });
    }
    await ctx.sleep(100); // 原聚焦 settle

    // 2. Type：date/time/特殊输入拒收逐键事件——原生 setter 直赋值（_force_set_value）
    try {
      if (requiresDirectValueAssignment(entry)) {
        if (clear) {
          await browser.clearTextField();
        }
        await browser.forceSetValue(text);
      } else {
        await browser.typeText(text, { clear });
      }
    } catch (e) {
      return new ActionResult({
        error: `Failed to type text into element ${resolvedIndex}: ${errText(e)}`,
      });
    }

    // 3. autocomplete/combobox：JS 驱动子集 sleep ~0.4s，下拉在下个动作前完成填充
    const [isCombo, needsJsWait] = isAutocompleteField(entry);
    if (needsJsWait) {
      await ctx.sleep(400);
    }

    // 4. 回读验证：activeElement 与意图文本不符时附 ⚠️ Note（_read_active_text 吞异常返 ""）
    let memory = describeInput(entry, resolvedIndex, text);
    const actual = await browser.readActiveText();
    if (actual && actual !== text) {
      memory +=
        `  ⚠️ Note: the field's actual value ${pyRepr(actual)} differs from ` +
        `the intended ${pyRepr(text)}. The site may have reformatted, truncated, ` +
        "or rejected the input — re-observe before continuing.";
    }
    // R7-2：值可能在但被页面验证器拒绝——回读验证标记，LLM 当步自愈
    const vstate = await readValidationState(browser, ctx.log);
    if (vstate) {
      memory +=
        `  ⚠️ The field is marked INVALID by the page validator (${vstate}) — ` +
        "the value will likely be rejected on submit. Re-observe the field, " +
        "use the component's own picker/API, or set it via evaluate.";
    }
    if (isCombo) {
      memory +=
        "  💡 autocomplete field — select from the JS-populated dropdown " +
        "if applicable instead of typing the full value.";
    }
    ctx.log(memory);
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
