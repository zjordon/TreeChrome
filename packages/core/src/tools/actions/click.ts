// click 动作（actions.py :949-1077）。batch1 有意偏离（p4/02 §8 偏离 2/3）：
// - 下拉降级链（:979-1008）跳过——batch1 无下拉族，click 直达真点击（P4b 补回）；
// - file-input 守卫文案改为「动作未启用」提示——batch1 无 upload_file。

import { ActionResult } from "../../agent/views.js";
import type { EnhancedDOMTreeNode } from "../../browser/views.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import {
  CLICK_EFFECT_WAIT_S,
  clickEffectWatchTarget,
  detectNewTabOpened,
  formValuesDigest,
  pageFingerprint,
  readPageMessages,
} from "./shared/click-evidence.js";
import { describeClick, getElementByIndex, isFileInputNode } from "./shared/element-lookup.js";
import { errText } from "./shared/nav-health.js";

export function createClickHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    // 0. element_id 是 index 的别名（find_elements(return_node_ids=True) 的 backend
    //    node id；index===backend_id），二选一——执行路径 registry 不校验，在此守卫
    const index = params.index ?? null;
    const elementId = params.element_id ?? null;
    if ((index === null) === (elementId === null)) {
      return new ActionResult({
        error: "click requires exactly one of `index` or `element_id`.",
      });
    }
    const resolvedIndex = index !== null ? Number(index) : Number(elementId);
    // 1. 元素查找
    const [entry, error] = await getElementByIndex(resolvedIndex, browser, ctx);
    if (error !== null) return error;
    if (entry === null) {
      return new ActionResult({ error: `Element ${resolvedIndex} not found in DOM state` });
    }

    const backendId = entry.backendNodeId;

    // 1.5 file-input 守卫：点 <input type=file> 只会弹原生文件框，对上传无有用效果。
    // batch1 偏离 3：无 upload_file 动作，引导文案改为提示该动作未启用
    if (isFileInputNode(entry)) {
      return new ActionResult({
        error:
          `Element ${resolvedIndex} is an <input type='file'>. Clicking it ` +
          "would open the OS file picker. The upload_file action is not enabled " +
          "in this build — set the file programmatically via evaluate if the page " +
          "allows, or enable upload_file.",
      });
    }

    // 2.（batch1 偏离 2：下拉降级链跳过——P4b 随下拉族补回并加对拍）

    // 3. 普通点击：highlight -> click_element，映射 bool 信号
    const tag = entry.tagName.toUpperCase();
    const attrs: Record<string, string> = entry.attributes ?? {};
    const tabsBefore = (await browser.getTabs()).map((t) => t.targetId); // G7 新页检测快照
    // R7-1/#205：可「无效果检测」的目标先取点击前指纹 + 表单值摘要
    let fpBefore: string | null = null;
    let fvBefore: string | null = null;
    if (clickEffectWatchTarget(tag, attrs)) {
      fpBefore = await pageFingerprint(browser, ctx.log);
      fvBefore = await formValuesDigest(browser, ctx.log);
    }
    let clicked: boolean;
    try {
      await browser.highlightElement(backendId);
      clicked = await browser.clickElement(backendId);
    } catch (e) {
      // CDP 异常（连接断开、target 消失等）——友好映射
      return new ActionResult({ error: `Click failed: ${errText(e)}` });
    }

    if (!clicked) {
      // 坐标拿不到 + JS 回退也失败 —— 明确告知，不再静默成功
      return new ActionResult({
        error:
          `Could not click element ${resolvedIndex} ` +
          "(no coordinates and JS click fallback failed; " +
          "the element may be detached, hidden, or in a cross-origin iframe)",
      });
    }

    // 4. 成功回显 + 新标签页检测（G7）
    let memory = describeClick(entry as EnhancedDOMTreeNode, resolvedIndex);
    memory += await detectNewTabOpened(browser, tabsBefore, ctx.sleep);
    // R7-1/B3-2：按钮类目标的「无可见效果」检测
    if (fpBefore !== null) {
      await ctx.sleep(CLICK_EFFECT_WAIT_S * 1000);
      const fpAfter = await pageFingerprint(browser, ctx.log);
      if (fpAfter !== null && fpAfter === fpBefore) {
        const fvAfter = await formValuesDigest(browser, ctx.log);
        if (fvBefore !== null && fvAfter !== null && fvAfter !== fvBefore) {
          memory +=
            "  ⚠️ The click changed form field values but the page did not " +
            "navigate/update — a page widget likely reset the form. Verify the " +
            "field values now; re-enter them or set via JS before resubmitting.";
        } else {
          memory +=
            "  ⚠️ The click had no visible effect (page unchanged). The element may " +
            "have no handler attached, or the click was silently swallowed — re-observe " +
            "the page (values/validation marks). NOTE: if this is an expand/collapse " +
            "(toggle) widget, clicking the same element again will CLOSE it — check " +
            "its current expanded/active state before retrying, or trigger the page's " +
            "own handler via evaluate.";
        }
      }
      // B3：页面消息显式确认——指纹只分「变/没变」，toast 文案才是确定性证据
      const pageMsg = await readPageMessages(browser, ctx.log);
      if (pageMsg) {
        const flag = pageMsg.startsWith("ERROR:") ? "⚠️" : "✅";
        memory += `  ${flag} Page message after click: ${pageMsg}`;
      }
    }
    ctx.log(memory);
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
