// scroll 动作（actions.py :1485-1503）+ wait（:1698-1700）+ send_keys（:1612-1624）。
// 三者同族短 handler 合一文件。

import { ActionResult } from "../../agent/views.js";
import type { ActionHandler } from "../types.js";
import type { ToolsContext } from "./context.js";
import { errText } from "./shared/nav-health.js";

export function createScrollHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser) => {
    const direction =
      params.direction === undefined ? "down" : (String(params.direction) as "up" | "down");
    const amount = Math.trunc(Number(params.amount ?? 3));
    try {
      // G5: scroll 返回 {vertical_percentage, at_edge}（G2 位置读取）
      const position = await browser.scroll(direction, amount);
      // G1 + G2: 回显方向/量 + 当前位置；已到边界则当轮提示
      let memory = `Scrolled ${direction} ${amount} viewport-heights`;
      const pct = position.vertical_percentage;
      if (pct !== null && pct !== undefined) {
        memory += ` (${pct}% down)`;
      }
      if (position.at_edge) {
        memory += ` (already at ${direction}, no further content)`;
      }
      ctx.log(memory);
      return new ActionResult({ extractedContent: memory, longTermMemory: memory });
    } catch (e) {
      // G4: scroll 非幂等，CDP 失败=没滚，必须报 error（区别于 close_tab 的软成功）
      ctx.log(`scroll(${direction}, ${amount}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Scroll failed: ${errText(e)}` });
    }
  };
}

export function createWaitHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>) => {
    await ctx.sleep(Number(params.seconds ?? 3) * 1000);
    return new ActionResult();
  };
}

export function createSendKeysHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser) => {
    // 必填守卫（Python params["keys"] KeyError → execute 包装 error 的等价补偿）
    if (typeof params.keys !== "string") {
      return new ActionResult({ error: "send_keys requires a string `keys` parameter." });
    }
    const keys = params.keys;
    try {
      await browser.sendKeys(keys);
    } catch (e) {
      // send_keys 非幂等（回车可提交表单/触发导航），CDP 失败必须报 error
      ctx.log(`send_keys(${JSON.stringify(keys)}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Send keys failed: ${errText(e)}` });
    }
    const memory = `Sent keys '${keys}'`;
    ctx.log(memory);
    return new ActionResult({ extractedContent: memory, longTermMemory: memory });
  };
}
