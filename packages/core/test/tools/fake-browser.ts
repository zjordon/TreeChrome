// tools 层测试夹具：FakeBrowser（ToolsBrowser 的可编程轻量实现）+ makeNode
// （selector_map 条目构造）+ makeTools（睡眠记录 + 日志静默）。
import { EMPTY_DOM_STATE, EnhancedDOMTreeNode, SerializedDOMState } from "@tw/dom-snapshot";
import type { PageSettleResult, ScrollResult } from "../../src/browser/navigation.js";
import type { BrowserStateSummary, TabInfo } from "../../src/browser/views.js";
import type { ToolsContext } from "../../src/tools/actions/context.js";
import { Tools } from "../../src/tools/actions/index.js";
import type { ToolsBrowser } from "../../src/tools/types.js";

export function makeNode(
  init: Partial<{
    nodeId: number;
    backendNodeId: number;
    nodeName: string;
    nodeValue: string;
    attributes: Record<string, string>;
  }>,
): EnhancedDOMTreeNode {
  return new EnhancedDOMTreeNode({
    nodeId: init.nodeId ?? init.backendNodeId ?? 1,
    backendNodeId: init.backendNodeId ?? 1,
    nodeType: 1,
    nodeName: init.nodeName ?? "BUTTON",
    nodeValue: init.nodeValue ?? "",
    attributes: init.attributes ?? {},
  });
}

export class FakeBrowser implements ToolsBrowser {
  navigations: Array<{ url: string; newTab: boolean }> = [];
  /** navigate 抛错（net::ERR_* 形态用） */
  navigateError: Error | null = null;
  goBackResult: string | null = null;
  goBackError: Error | null = null;
  tabs: TabInfo[] = [{ targetId: "ABCD1234", url: "https://a.example", title: "A" }];
  switchTabCalls: string[] = [];
  clicked: number[] = [];
  highlighted: number[] = [];
  clickResult = true;
  clickError: Error | null = null;
  typed: Array<{ text: string; clear: boolean | undefined }> = [];
  cleared = 0;
  forceSetValues: string[] = [];
  activeText = "";
  sentKeys: string[] = [];
  sendKeysError: Error | null = null;
  scrollResult: ScrollResult = { vertical_percentage: 50, at_edge: false };
  scrollError: Error | null = null;
  html = "<html><body><p>content</p></body></html>";
  htmlError: Error | null = null;
  settle: PageSettleResult & Partial<{ grid_kick: boolean; grid_rows: number }> = {
    ready: true,
    stage: "stable",
    waited: 0.2,
  };
  settleError: Error | null = null;
  /** executeJs 按 code 前缀分派的脚本表 */
  js: Array<{ code: string; result: unknown }> = [];
  stateUrl = "https://a.example";
  /** 健康检查/元素查找走 getState：domState 挂 selectorMap */
  selectorMapEntries: Map<number, EnhancedDOMTreeNode> = new Map();
  domStateEmpty = false;
  currentTargetId = "ABCD1234";

  navigate(url: string, options?: { newTab?: boolean }): Promise<string | null> {
    if (this.navigateError !== null) throw this.navigateError;
    this.navigations.push({ url, newTab: options?.newTab === true });
    return Promise.resolve(null);
  }
  goBack(): Promise<string | null> {
    if (this.goBackError !== null) throw this.goBackError;
    return Promise.resolve(this.goBackResult);
  }
  waitForPageSettle(): Promise<PageSettleResult & Partial<{ grid_kick: boolean }>> {
    if (this.settleError !== null) throw this.settleError;
    return Promise.resolve({ ...this.settle });
  }
  scroll(_direction?: "up" | "down", _amount?: number): Promise<ScrollResult> {
    if (this.scrollError !== null) throw this.scrollError;
    return Promise.resolve(this.scrollResult);
  }
  highlightElement(backendNodeId: number): Promise<void> {
    this.highlighted.push(backendNodeId);
    return Promise.resolve();
  }
  clickElement(backendNodeId: number): Promise<boolean> {
    if (this.clickError !== null) throw this.clickError;
    this.clicked.push(backendNodeId);
    return Promise.resolve(this.clickResult);
  }
  typeText(text: string, options?: { clear?: boolean }): Promise<void> {
    this.typed.push({ text, clear: options?.clear });
    return Promise.resolve();
  }
  clearTextField(): Promise<boolean> {
    this.cleared += 1;
    return Promise.resolve(true);
  }
  forceSetValue(text: string): Promise<void> {
    this.forceSetValues.push(text);
    return Promise.resolve();
  }
  readActiveText(): Promise<string> {
    return Promise.resolve(this.activeText);
  }
  sendKeys(keys: string): Promise<void> {
    if (this.sendKeysError !== null) throw this.sendKeysError;
    this.sentKeys.push(keys);
    return Promise.resolve();
  }
  getTabs(): Promise<TabInfo[]> {
    return Promise.resolve([...this.tabs]);
  }
  switchTab(targetId: string): Promise<void> {
    this.switchTabCalls.push(targetId);
    return Promise.resolve();
  }
  executeJs(code: string): Promise<unknown> {
    for (const entry of this.js) {
      if (code.includes(entry.code.slice(0, 24))) return Promise.resolve(entry.result);
    }
    return Promise.resolve(undefined);
  }
  getPageHtml(): Promise<string> {
    if (this.htmlError !== null) throw this.htmlError;
    return Promise.resolve(this.html);
  }
  getState(): Promise<BrowserStateSummary> {
    const domState = this.domStateEmpty
      ? EMPTY_DOM_STATE
      : new SerializedDOMState({ tag: "html" } as never, this.selectorMapEntries, "[1] button");
    const state: BrowserStateSummary = {
      url: this.stateUrl,
      title: "A",
      tabs: [...this.tabs],
      domState,
      screenshot: null,
      gridMeta: null,
      recentEvents: [],
    };
    return Promise.resolve(state);
  }
}

export interface MakeToolsResult {
  tools: Tools;
  ctx: ToolsContext;
  sleeps: number[];
}

/** Tools + 睡眠记录 + 日志静默（默认收报便于断言） */
export function makeTools(
  options: ConstructorParameters<typeof Tools>[0] = {},
  collectLogs: string[] | null = null,
): MakeToolsResult {
  const sleeps: number[] = [];
  const tools = new Tools({
    log: collectLogs === null ? () => {} : (m) => collectLogs.push(m),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...options,
  });
  return { tools, ctx: tools.ctx, sleeps };
}
