// capability 解析决策表（04 §1.1）：send_keys 键型分流（与 keyboard.ts 三路由同源）
// + READ/未注册直过 + normalizeHost/hostForAction 计费面（webbrain normalizeHost
// 同款语义）。权限门为净新增——决策表单测代替对拍（04 §5 偏离 1）。

import { describe, expect, it } from "vitest";
import {
  CAPABILITY_LABEL,
  hostForAction,
  normalizeHost,
  resolveCapability,
} from "../../src/policy/capability.js";

describe("resolveCapability（batch1 面）", () => {
  it("只读动作直过（none）：extract/wait/scroll + done/未注册", () => {
    expect(resolveCapability("extract", {})).toBe("none");
    expect(resolveCapability("wait", {})).toBe("none");
    expect(resolveCapability("scroll", { direction: "down" })).toBe("none");
    expect(resolveCapability("done", {})).toBe("none");
    expect(resolveCapability("no_such_action", {})).toBe("none");
  });

  it("单 capability 动作：click→CLICK input_text→TYPE navigate/go_back/switch_tab→NAVIGATE", () => {
    expect(resolveCapability("click", { index: 1 })).toBe("CLICK");
    expect(resolveCapability("input_text", { index: 1, text: "x" })).toBe("TYPE");
    expect(resolveCapability("navigate", { url: "https://a.example" })).toBe("NAVIGATE");
    expect(resolveCapability("go_back", {})).toBe("NAVIGATE");
    expect(resolveCapability("switch_tab", { tab_id: "ABCD" })).toBe("NAVIGATE");
  });

  it("send_keys 分流：组合键与 Enter（含别名）→ CLICK；纯文本与其余命名键 → TYPE", () => {
    expect(resolveCapability("send_keys", { keys: "Control+a" })).toBe("CLICK");
    expect(resolveCapability("send_keys", { keys: "Shift+T" })).toBe("CLICK");
    expect(resolveCapability("send_keys", { keys: "Enter" })).toBe("CLICK");
    expect(resolveCapability("send_keys", { keys: "return" })).toBe("CLICK");
    expect(resolveCapability("send_keys", { keys: "hello" })).toBe("TYPE");
    expect(resolveCapability("send_keys", { keys: "Tab" })).toBe("TYPE");
    expect(resolveCapability("send_keys", { keys: "Escape" })).toBe("TYPE");
    expect(resolveCapability("send_keys", { keys: "F5" })).toBe("TYPE");
  });

  it("send_keys 异常参数落 TYPE（keys 非 string / 缺失——判型规则不抛）", () => {
    expect(resolveCapability("send_keys", {})).toBe("TYPE");
    expect(resolveCapability("send_keys", { keys: 123 })).toBe("TYPE");
  });
});

describe("normalizeHost（webbrain 同款语义）", () => {
  it.each([
    ["https://Example.com/path", "example.com"],
    ["https://www.example.com/", "example.com"],
    ["https://example.com:8443/x", "example.com"],
    ["http://localhost:7780/app", "localhost"],
    ["example.com", "example.com"],
    ["WWW.Example.com/x", "example.com"],
    ["//cdn.example.com/lib.js", "cdn.example.com"],
    ["", ""],
    ["   ", ""],
  ])("%s → %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it("IPv6 方括号形态保留（端口剥离不误伤）", () => {
    expect(normalizeHost("http://[::1]:9000/x")).toBe("[::1]");
  });
});

describe("hostForAction（host 计费，架构 §5.1）", () => {
  it("navigate 按目标 URL：绝对/相对（对当前页解析）/www 剥离", () => {
    expect(hostForAction("navigate", { url: "https://b.example/x" }, "https://a.example")).toBe(
      "b.example",
    );
    expect(hostForAction("navigate", { url: "about.html" }, "https://a.example/page")).toBe(
      "a.example",
    );
    expect(hostForAction("navigate", { url: "https://www.b.example/" }, "https://a.example")).toBe(
      "b.example",
    );
  });

  it("navigate 缺 url 落当前页；其余动作按当前页 host", () => {
    expect(hostForAction("navigate", {}, "https://a.example")).toBe("a.example");
    expect(hostForAction("click", { index: 1 }, "https://a.example/page?q=1")).toBe("a.example");
    expect(hostForAction("input_text", { index: 1 }, "http://localhost:7780")).toBe("localhost");
    expect(hostForAction("go_back", {}, "https://a.example")).toBe("a.example");
  });

  it("当前页识别不出 → 空 host（调用方 fail-closed）", () => {
    expect(hostForAction("click", { index: 1 }, "")).toBe("");
    expect(hostForAction("input_text", { index: 1 }, "not a url")).toBe("not a url");
  });
});

describe("CAPABILITY_LABEL（拒绝文案动词全键覆盖）", () => {
  it("七个过门 capability 均有非空动词", () => {
    const keys = ["CLICK", "TYPE", "NAVIGATE", "UPLOAD", "EXECUTE_JS", "FS", "DOWNLOAD"] as const;
    for (const k of keys) {
      expect(CAPABILITY_LABEL[k].length).toBeGreaterThan(0);
    }
  });
});
