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
    expect(kit.DEFAULT_MAX_TOKENS).toBe(16384);
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
