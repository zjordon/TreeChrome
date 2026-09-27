// agent 层测试夹具：FakeAgentLLM（getAction 脚本化回放 + 调用记录 + sensitiveMap
// 透传核验）+ FakeAgentBrowser（BrowserSession 消费面）。

import { SerializedDOMState } from "@tw/dom-snapshot";
import type { BrowserStateSummary, TabInfo } from "../../src/browser/views.js";
import type { GetActionOptions, GetActionResult, LLMClient } from "../../src/llm/client.js";
import type { ChatMessage, ChatResponse, ToolDefinition } from "../../src/llm/types.js";

export type LlmScriptEntry =
  | { kind: "ok"; toolInput: Record<string, unknown>; usage?: never }
  | { kind: "empty"; reason: "text-exhausted" | "no-parseable-response" }
  | { throw: Error };

export class FakeAgentLLM {
  /** 脚本队列（耗尽后重复最后一个空条目防挂起） */
  script: LlmScriptEntry[] = [];
  calls: Array<{
    systemPrompt: string;
    messages: ChatMessage[];
    sensitiveMap?: Record<string, string>;
  }> = [];
  model = "glm-test";
  /** 每次 getAction 入口回调（stop/pause 时序模拟） */
  onCall: (() => void) | null = null;

  constructor(script: LlmScriptEntry[] = []) {
    this.script = [...script];
  }

  getAction(
    systemPrompt: string,
    messages: ChatMessage[],
    _tool: ToolDefinition,
    opts: GetActionOptions = {},
  ): Promise<GetActionResult> {
    this.onCall?.();
    this.calls.push({ systemPrompt, messages, sensitiveMap: opts.sensitiveMap });
    const entry =
      this.script.length > 1
        ? this.script.shift()!
        : (this.script[0] ?? { kind: "empty" as const, reason: "text-exhausted" as const });
    if ("throw" in entry) return Promise.reject(entry.throw);
    return Promise.resolve(
      entry.kind === "ok"
        ? { kind: "ok", toolInput: entry.toolInput, usage: null }
        : { kind: "empty", reason: entry.reason, lastUsage: null },
    );
  }
  setCallWindow(): void {}
  singleShot(req: {
    systemPrompt: string | null;
    userPrompt: string;
    maxTokens?: number;
  }): Promise<ChatResponse> {
    return Promise.resolve({
      text: `summary of: ${req.userPrompt.slice(0, 20)}`,
      toolCalls: [],
      stopReason: "stop",
      usage: null,
    });
  }
  extract(): Promise<string> {
    return Promise.resolve("extract-result");
  }
  structuredCall(): Promise<Record<string, unknown> | null> {
    return Promise.resolve(null);
  }
  asLLMClient(): LLMClient {
    return this as unknown as LLMClient;
  }
}

export function makeState(
  options: {
    url?: string;
    title?: string;
    tabs?: TabInfo[];
    treeText?: string;
    selectorEntries?: Map<number, unknown>;
  } = {},
): BrowserStateSummary {
  return {
    url: options.url ?? "https://a.example",
    title: options.title ?? "A",
    tabs: options.tabs ?? [{ targetId: "ABCD1234", url: "https://a.example", title: "A" }],
    domState: new SerializedDOMState(
      { tag: "html" } as never,
      (options.selectorEntries ?? new Map()) as never,
      options.treeText ?? "[1] button 'Go'",
    ),
    screenshot: null,
    gridMeta: null,
    recentEvents: [],
  };
}

export class FakeAgentBrowser {
  started = false;
  stopped = false;
  startCalls: unknown[] = [];
  navigations: string[] = [];
  urls = ["https://a.example"];
  state: BrowserStateSummary;
  /** execute 的动作会触发 URL 变化（模拟漂移/导航） */
  urlAfterAction: string | null = null;
  reconnectResult = false;
  reconnectCalls = 0;
  downloads: Array<{ filename: string; url: string; path: string | null }> = [];

  constructor(state?: BrowserStateSummary) {
    this.state = state ?? makeState();
  }
  get currentTargetId(): string | null {
    return this.state.tabs[0]?.targetId ?? null;
  }
  start(options: unknown = {}): Promise<void> {
    this.startCalls.push(options);
    this.started = true;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
  reconnect(): Promise<boolean> {
    this.reconnectCalls += 1;
    return Promise.resolve(this.reconnectResult);
  }
  navigate(url: string): Promise<string | null> {
    this.navigations.push(url);
    this.urls.push(url);
    this.state = { ...this.state, url };
    return Promise.resolve(null);
  }
  getCurrentUrl(): Promise<string> {
    // 动作副作用模拟：urlAfterAction 在下一次 URL 读取时生效（Guard#5 漂移检测消费）
    if (this.urlAfterAction !== null) {
      this.urls.push(this.urlAfterAction);
      this.state = { ...this.state, url: this.urlAfterAction };
      this.urlAfterAction = null;
    }
    return Promise.resolve(this.urls[this.urls.length - 1]);
  }
  getState(): Promise<BrowserStateSummary> {
    return Promise.resolve(this.state);
  }
  getTabs(): Promise<TabInfo[]> {
    return Promise.resolve([...this.state.tabs]);
  }
  consumeCompletedDownloads() {
    const out = this.downloads;
    this.downloads = [];
    return out;
  }
  getElementCoordinates(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return Promise.resolve({ x: 10, y: 20, width: 100, height: 40 });
  }
  isElementOccluded(): Promise<boolean> {
    return Promise.resolve(false);
  }
  // —— ToolsBrowser 消费面（tools handler 执行）——
  highlightElement(): Promise<void> {
    return Promise.resolve();
  }
  clickElement(): Promise<boolean> {
    return Promise.resolve(true);
  }
  typeText(): Promise<void> {
    return Promise.resolve();
  }
  clearTextField(): Promise<boolean> {
    return Promise.resolve(true);
  }
  forceSetValue(): Promise<void> {
    return Promise.resolve();
  }
  readActiveText(): Promise<string> {
    return Promise.resolve("");
  }
  sendKeys(): Promise<void> {
    return Promise.resolve();
  }
  switchTab(): Promise<void> {
    return Promise.resolve();
  }
  goBack(): Promise<string | null> {
    return Promise.resolve("https://prev.example");
  }
  waitForPageSettle(): Promise<{ ready: boolean; stage?: unknown; waited: number }> {
    return Promise.resolve({ ready: true, stage: "stable", waited: 0 });
  }
  scroll(): Promise<{ vertical_percentage: number | null; at_edge: boolean }> {
    return Promise.resolve({ vertical_percentage: 50, at_edge: false });
  }
  executeJs(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  getPageHtml(): Promise<string> {
    return Promise.resolve("<html><body><p>x</p></body></html>");
  }
  /** 模拟动作副作用：urlAfterAction 设置后 getCurrentUrl 返回它一次 */
  async afterAction(): Promise<void> {
    if (this.urlAfterAction !== null) {
      this.urls.push(this.urlAfterAction);
      this.state = { ...this.state, url: this.urlAfterAction };
      this.urlAfterAction = null;
    }
  }
}
