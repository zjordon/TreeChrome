// Tools 编排器 + batch1 十动作 handler 行为测试（回显文案锚定 Python f-string 字面量；
// browser 用 FakeBrowser 轻量注入，不发真 CDP）。偏离面（file-input 文案/下拉链跳过）
// 按 p4/02 §8 断言。
import { describe, expect, it } from "vitest";
import type { ActionResult } from "../../src/agent/views.js";
import type { Tools } from "../../src/tools/actions/index.js";
import { FakeBrowser, makeNode, makeTools } from "./fake-browser.js";

async function exec(
  tools: Tools,
  browser: FakeBrowser,
  name: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  return tools.execute(name, params, browser);
}

describe("Tools 编排器", () => {
  it("P4b 段 2 后注册面=23 动作（batch1 十 + 段 1 十 + 段 2 三）；剩余 2 模型不注册", () => {
    const { tools } = makeTools();
    expect([...tools.registry.actions.keys()].sort()).toEqual([
      "click",
      "close_tab",
      "done",
      "dropdown_options",
      "extract",
      "find_elements",
      "find_text",
      "go_back",
      "input_text",
      "navigate",
      "read_file",
      "replace_file",
      "save_as_pdf",
      "screenshot",
      "scroll",
      "search",
      "search_page",
      "select_dropdown",
      "send_keys",
      "switch_tab",
      "upload_file",
      "wait",
      "write_file",
    ]);
    expect(tools.registry.actions.has("evaluate")).toBe(false);
    expect(tools.registry.actions.has("read_grid")).toBe(false);
  });
  it("未知名 → Unknown action error", async () => {
    const { tools } = makeTools();
    const r = await exec(tools, new FakeBrowser(), "nope", {});
    expect(r.error).toBe("Unknown action: nope");
  });
  it("handler 异常包 ActionResult{error}", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(1, makeNode({ backendNodeId: 1, nodeName: "BUTTON" }));
    browser.clickError = new Error("session gone");
    const r = await exec(tools, browser, "click", { index: 1 });
    expect(r.error).toBe("Click failed: session gone");
  });
  it("flattenParams：动作名包裹/单嵌套 dict 拆；done.data 真字段不拆", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(7, makeNode({ backendNodeId: 7, nodeName: "INPUT" }));
    // 动作名包裹
    await exec(tools, browser, "click", { click: { index: 7 } });
    // 单嵌套 dict（非模型字段）
    browser.clicked.length = 0;
    await exec(tools, browser, "click", { foo: { index: 7 } });
    expect(browser.clicked).toEqual([7]);
    // 变体 B done 的 data 是真 dict 字段——不拆
    const { tools: toolsB } = makeTools({
      outputModel: {
        name: "Out",
        fields: [{ name: "total", type: "integer", required: true }],
      },
    });
    const r = await exec(toolsB, new FakeBrowser(), "done", { data: { total: 3 } });
    expect(r.isDone).toBe(true);
    expect(r.extractedContent).toBe('{\n  "total": 3\n}');
  });
  it("cachedBrowserState 命中时不刷新 get_state", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    const entry = makeNode({ backendNodeId: 9, nodeName: "BUTTON", nodeValue: "Go" });
    const state = await browser.getState();
    const cached = { ...state, domState: state.domState };
    cached.domState?.selectorMap.set(9, entry);
    const r = await tools.execute("click", { index: 9 }, browser, cached);
    expect(r.error).toBeNull();
  });
});

describe("navigate", () => {
  it("裸域名补 https；回显 + settle note", async () => {
    const { tools, sleeps } = makeTools();
    const browser = new FakeBrowser();
    const r = await exec(tools, browser, "navigate", { url: "example.com" });
    expect(browser.navigations).toEqual([{ url: "https://example.com", newTab: false }]);
    expect(r.extractedContent).toBe(
      "Navigated to https://example.com (page settled: stable, 0.2s)",
    );
    expect(r.longTermMemory).toBe(r.extractedContent);
    expect(sleeps).toEqual([]); // settle 无额外 handler 侧 sleep
  });
  it("new_tab=True 跳过健康检查与 settle", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    const r = await exec(tools, browser, "navigate", { url: "https://x.com", new_tab: true });
    expect(r.extractedContent).toBe("Opened new tab with URL https://x.com");
  });
  it("settle 未确认 + grid kick 回显", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.settle = { ready: false, stage: "poll", waited: 10, grid_kick: true, grid_rows: 4 };
    const r = await exec(tools, browser, "navigate", { url: "https://x.com" });
    expect(r.extractedContent).toContain(
      "page settle poll not confirmed after 10s — page JS may still be loading",
    );
    expect(r.extractedContent).toContain(
      "(data-grid render kick applied — frozen grid rows forced to render; if rows still look empty, take a screenshot)",
    );
  });
  it('必填参数守卫（Python params["x"] KeyError 等价）：漏 url 不导航空目标', async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    const r = await exec(tools, browser, "navigate", {});
    expect(r.error).toBe("navigate requires a string `url` parameter.");
    expect(browser.navigations).toEqual([]);
  });
  it("settle 异常降级放行（settle 失败不阻断导航）", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.settleError = new Error("boom");
    const r = await exec(tools, browser, "navigate", { url: "https://x.com" });
    expect(r.error).toBeNull();
    expect(r.extractedContent).toBe("Navigated to https://x.com");
  });
  it("net::ERR_* → site unavailable；其他异常原文", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.navigateError = new Error("net::ERR_NAME_NOT_RESOLVED at DNS");
    const r = await exec(tools, browser, "navigate", { url: "https://gone.example" });
    expect(r.error).toBe("Navigation failed - site unavailable: https://gone.example");
    const browser2 = new FakeBrowser();
    browser2.navigateError = new Error("Target closed");
    const r2 = await exec(tools, browser2, "navigate", { url: "https://x.com" });
    expect(r2.error).toBe("Navigation failed: Target closed");
  });
  it("空 DOM 三阶段健康检查：重查有内容即返回（3s sleep 一次）", async () => {
    const { tools, sleeps, ctx } = makeTools({ pageSettleEnabled: false });
    const browser = new FakeBrowser();
    // 首查空（未挂 selectorMap + elementTreeText 空）→ 3s 后重查仍为同一 state——
    // FakeBrowser.getState 恒定，用 domStateEmpty=true 模拟持续空 → 重新 navigate + 5s
    browser.domStateEmpty = true;
    const logs: string[] = [];
    ctx.log = (m) => logs.push(m);
    const r = await exec(tools, browser, "navigate", { url: "https://x.com" });
    expect(browser.navigations.length).toBe(2); // 初次 + 健康检查 reload
    expect(sleeps).toEqual([3000, 5000]);
    // 持续空但 root 非空形态（EMPTY root=null → 抛 RuntimeError）
    expect(r.error).toContain("Page loaded but returned empty content for https://x.com");
  });
});

describe("click", () => {
  it("exactly-one 守卫（双缺/双给）", async () => {
    const { tools } = makeTools();
    const r1 = await exec(tools, new FakeBrowser(), "click", {});
    expect(r1.error).toBe("click requires exactly one of `index` or `element_id`.");
    const r2 = await exec(tools, new FakeBrowser(), "click", { index: 1, element_id: 2 });
    expect(r2.error).toBe("click requires exactly one of `index` or `element_id`.");
  });
  it("element_id 与 index 同路径解析", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(
      5,
      makeNode({ backendNodeId: 5, nodeName: "A", nodeValue: "link" }),
    );
    const r = await exec(tools, browser, "click", { element_id: 5 });
    expect(browser.clicked).toEqual([5]);
    expect(r.extractedContent).toContain("Clicked [A] 'link' at index 5");
  });
  it("元素不存在 → not found（缓存 miss 后 get_state 刷新仍 miss）", async () => {
    const { tools } = makeTools();
    const r = await exec(tools, new FakeBrowser(), "click", { index: 99 });
    expect(r.error).toBe("Element 99 not found in DOM state");
  });
  it("file-input 守卫：batch1 文案提示动作未启用（偏离 3）", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(
      3,
      makeNode({ backendNodeId: 3, nodeName: "INPUT", attributes: { type: "file" } }),
    );
    const r = await exec(tools, browser, "click", { index: 3 });
    expect(r.error).toContain("<input type='file'>");
    expect(r.error).toContain("upload_file action is not enabled");
    expect(browser.clicked).toEqual([]);
  });
  it("普通点击回显：aria-label 优先、60 字符截断", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    const label = "x".repeat(70);
    browser.selectorMapEntries.set(
      4,
      makeNode({ backendNodeId: 4, nodeName: "BUTTON", attributes: { "aria-label": label } }),
    );
    const r = await exec(tools, browser, "click", { index: 4 });
    expect(r.extractedContent).toBe(`Clicked [BUTTON] '${label.slice(0, 60)}...' at index 4`);
  });
  it("clickElement=false → 显式 error（不静默成功）", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.clickResult = false;
    browser.selectorMapEntries.set(4, makeNode({ backendNodeId: 4, nodeName: "BUTTON" }));
    const r = await exec(tools, browser, "click", { index: 4 });
    expect(r.error).toContain("Could not click element 4");
    expect(r.error).toContain("no coordinates and JS click fallback failed");
  });
  it("按钮目标无效果检测：指纹不变 + 表单值变化 → reset 警告", async () => {
    const { tools, sleeps } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(4, makeNode({ backendNodeId: 4, nodeName: "BUTTON" }));
    browser.js = [
      { code: "return [location.href", result: "url|10|100" },
      { code: "var out = [];", result: "1,2" }, // 摘要脚本：before=1,2 after=1
    ];
    // 表单摘要 before/after 用同一脚本——改脚本表第二条 before 后手动换值
    let formValues = "1,2";
    browser.js = [
      { code: "return [location.href", result: "url|10|100" },
      {
        code: "var out = [];",
        get result() {
          const v = formValues;
          formValues = "1";
          return v;
        },
      } as never,
    ];
    const r = await exec(tools, browser, "click", { index: 4 });
    expect(sleeps).toContain(600); // _CLICK_EFFECT_WAIT
    expect(r.extractedContent).toContain(
      "The click changed form field values but the page did not navigate/update",
    );
  });
  it("指纹不变且表单值不变 → no visible effect 警告；页面消息 ERROR → ⚠️ 前缀", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(4, makeNode({ backendNodeId: 4, nodeName: "BUTTON" }));
    browser.js = [
      { code: "return [location.href", result: "url|10|100" },
      { code: "var out = [];", result: "1,2" },
      { code: "var sels = ['.message-success'", result: "ERROR: save failed" },
    ];
    const r = await exec(tools, browser, "click", { index: 4 });
    expect(r.extractedContent).toContain("The click had no visible effect (page unchanged)");
    expect(r.extractedContent).toContain("⚠️ Page message after click: ERROR: save failed");
  });
  it("新标签页检测：自动切换 + 回显", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(4, makeNode({ backendNodeId: 4, nodeName: "BUTTON" }));
    browser.js = [{ code: "var out = [];", result: "1,2" }];
    // 点击后 getTabs 返回多一个新页
    const origGetTabs = browser.getTabs.bind(browser);
    browser.getTabs = async () => {
      const tabs = await origGetTabs();
      return browser.clicked.length > 0
        ? [...tabs, { targetId: "XYZW9999", url: "https://new.example", title: "New" }]
        : tabs;
    };
    const r = await exec(tools, browser, "click", { index: 4 });
    // BUTTON 无指纹脚本 → 不走无效果检测；新页检测不取指纹
    expect(r.extractedContent).toContain(
      "ℹ️ Click opened a new tab [9999] New; auto-switched to it.",
    );
    expect(browser.switchTabCalls).toEqual(["XYZW9999"]);
  });
});

describe("input_text", () => {
  it("exactly-one 守卫", async () => {
    const { tools } = makeTools();
    const r = await exec(tools, new FakeBrowser(), "input_text", { text: "x" });
    expect(r.error).toBe("input_text requires exactly one of `index` or `element_id`.");
  });
  it("漏传 text → error 且不清空字段（Python KeyError 等价；数据损坏防线）", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(2, makeNode({ backendNodeId: 2, nodeName: "INPUT" }));
    const r = await exec(tools, browser, "input_text", { index: 2 });
    expect(r.error).toBe("input_text requires a string `text` parameter.");
    expect(browser.cleared).toBe(0); // 未走到 clearTextField——原值未被销毁
    expect(browser.typed).toEqual([]);
  });
  it("聚焦失败显式 error", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.clickResult = false;
    browser.selectorMapEntries.set(2, makeNode({ backendNodeId: 2, nodeName: "INPUT" }));
    const r = await exec(tools, browser, "input_text", { index: 2, text: "hi" });
    expect(r.error).toContain("Could not focus element 2 for input");
  });
  it("普通输入：typeText + 聚焦 settle 100ms", async () => {
    const { tools, sleeps } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(
      2,
      makeNode({ backendNodeId: 2, nodeName: "INPUT", attributes: { placeholder: "Name" } }),
    );
    const r = await exec(tools, browser, "input_text", { index: 2, text: "hello" });
    expect(browser.typed).toEqual([{ text: "hello", clear: true }]);
    expect(sleeps).toEqual([100]);
    expect(r.extractedContent).toBe("Typed 'hello' into [INPUT] 'Name' at index 2");
  });
  it("date 输入走直赋值分支：clear + forceSetValue", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(
      2,
      makeNode({ backendNodeId: 2, nodeName: "INPUT", attributes: { type: "date" } }),
    );
    const r = await exec(tools, browser, "input_text", { index: 2, text: "2026-01-01" });
    expect(browser.typed).toEqual([]);
    expect(browser.cleared).toBe(1);
    expect(browser.forceSetValues).toEqual(["2026-01-01"]);
    expect(r.error).toBeNull();
  });
  it("回读不一致 → ⚠️ Note；验证标记 → INVALID 警告；combobox → 提示 + 400ms", async () => {
    const { tools, sleeps } = makeTools();
    const browser = new FakeBrowser();
    browser.selectorMapEntries.set(
      2,
      makeNode({ backendNodeId: 2, nodeName: "INPUT", attributes: { role: "combobox" } }),
    );
    browser.activeText = " reformatted ";
    browser.js = [{ code: "var el = document.activeElement", result: "aria-invalid" }];
    const r = await exec(tools, browser, "input_text", { index: 2, text: "x" });
    expect(r.extractedContent).toContain(
      "the field's actual value ' reformatted ' differs from the intended 'x'",
    );
    expect(r.extractedContent).toContain("marked INVALID by the page validator (aria-invalid)");
    expect(r.extractedContent).toContain("💡 autocomplete field");
    expect(sleeps).toEqual([100, 400]);
  });
});

describe("scroll / wait / send_keys / go_back / switch_tab", () => {
  it("scroll 回显位置与边界", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.scrollResult = { vertical_percentage: 100, at_edge: true };
    const r = await exec(tools, browser, "scroll", { direction: "up", amount: 2 });
    expect(r.extractedContent).toBe(
      "Scrolled up 2 viewport-heights (100% down) (already at up, no further content)",
    );
  });
  it("scroll CDP 失败必须报 error（非幂等）", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.scrollError = new Error("wheel failed");
    const r = await exec(tools, browser, "scroll", {});
    expect(r.error).toBe("Scroll failed: wheel failed");
  });
  it("wait 睡指定秒（空 ActionResult）", async () => {
    const { tools, sleeps } = makeTools();
    const r = await exec(tools, new FakeBrowser(), "wait", { seconds: 5 });
    expect(sleeps).toEqual([5000]);
    expect(r.render()).toBe("OK");
  });
  it("send_keys 回显与失败；漏传 keys → error", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    const r = await exec(tools, browser, "send_keys", { keys: "Control+a" });
    expect(r.extractedContent).toBe("Sent keys 'Control+a'");
    const rMissing = await exec(tools, browser, "send_keys", {});
    expect(rMissing.error).toBe("send_keys requires a string `keys` parameter.");
    expect(browser.sentKeys).toEqual(["Control+a"]);
    browser.sendKeysError = new Error("dispatch failed");
    const r2 = await exec(tools, browser, "send_keys", { keys: "Enter" });
    expect(r2.error).toBe("Send keys failed: dispatch failed");
  });
  it("go_back 无历史 → error；正常回显", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.goBackResult = null;
    const r = await exec(tools, browser, "go_back", {});
    expect(r.error).toBe("No previous page in history to go back to");
    const browser2 = new FakeBrowser();
    browser2.goBackResult = "https://prev.example";
    const r2 = await exec(tools, browser2, "go_back", {});
    expect(r2.extractedContent).toBe("Navigated back to https://prev.example");
  });
  it("switch_tab：未命中列出现有页；撞车报多匹配；命中切换；漏传 tab_id → error", async () => {
    const { tools } = makeTools();
    const browser = new FakeBrowser();
    browser.tabs = [
      { targetId: "AAA1111", url: "https://a.example", title: "A" },
      { targetId: "BBB2222", url: "https://b.example", title: "B" },
      { targetId: "CCC3333", url: "https://c.example", title: "C" },
    ];
    const rMissing = await exec(tools, browser, "switch_tab", {});
    expect(rMissing.error).toBe("switch_tab requires a string `tab_id` parameter.");
    const r = await exec(tools, browser, "switch_tab", { tab_id: "9999" });
    expect(r.error).toContain("No tab ending with '9999'. Open tabs: [1111] A - https://a.example");
    const r2 = await exec(tools, browser, "switch_tab", { tab_id: "" });
    expect(r2.error).toContain("Multiple tabs match");
    const r3 = await exec(tools, browser, "switch_tab", { tab_id: "2222" });
    expect(r3.extractedContent).toBe("Switched to tab [2222] B (https://b.example)");
    expect(browser.switchTabCalls).toEqual(["BBB2222"]);
  });
});
