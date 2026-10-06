// boot-entry（boot.mjs 打包入口）：合并导出面存在性——example 消费面的契约锁。

import { describe, expect, test } from "vitest";
import * as kit from "../src/boot-entry.js";

describe("boot-entry 导出面", () => {
  test("core 面", () => {
    expect(typeof kit.Agent).toBe("function");
    expect(typeof kit.LLMClient).toBe("function");
    expect(typeof kit.BrowserSession).toBe("function");
    expect(typeof kit.EventBus).toBe("function");
    expect(typeof kit.PolicyGate).toBe("function");
    expect(typeof kit.AutoAllowPolicy).toBe("function");
    // custom_action.py 消费面（第三批 C2-2）
    expect(typeof kit.Tools).toBe("function");
    expect(typeof kit.ActionResult).toBe("function");
    expect(kit.DEFAULT_MAX_TOKENS).toBe(16384);
    // upload_file_vision.py 消费面（第六批 UP4）：视觉名单预检
    expect(typeof kit.modelSupportsVision).toBe("function");
    expect(kit.modelSupportsVision("glm-5.3-flash")).toBe(true);
    expect(kit.modelSupportsVision("glm-5.3")).toBe(false);
  });

  test("cdp-ws 面", () => {
    expect(typeof kit.CdpWsClient).toBe("function");
    expect(typeof kit.discoverWebSocketUrl).toBe("function");
  });

  test("node-host kit 面", () => {
    expect(typeof kit.runAgent).toBe("function");
    expect(typeof kit.assembleAgent).toBe("function");
    expect(typeof kit.loadHostSettings).toBe("function");
    expect(typeof kit.NodeFs).toBe("function");
  });
});
