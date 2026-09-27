// tools 层公共类型：handler 签名 + browser 结构面。纯类型文件。
// ToolsBrowser 是 BrowserSession 的动作消费子集（接口隔离：handler 单测可注入轻量
// fake；BrowserSession 结构满足本接口，4.4 agent 传真实会话）。

import type { ActionResult } from "../agent/views.js";
import type { PageSettleResult, ScrollResult } from "../browser/navigation.js";
import type { BrowserStateSummary, TabInfo } from "../browser/views.js";

/** batch1 十动作用到的 BrowserSession 面（batch2 增补时在此扩维） */
export interface ToolsBrowser {
  navigate(url: string, options?: { newTab?: boolean }): Promise<string | null>;
  goBack(): Promise<string | null>;
  waitForPageSettle(options?: {
    timeout?: number;
    poll?: number;
    stablePolls?: number;
  }): Promise<PageSettleResult & Partial<{ grid_kick: boolean; grid_rows: number }>>;
  scroll(direction?: "up" | "down", amount?: number): Promise<ScrollResult>;
  highlightElement(backendNodeId: number): Promise<void>;
  clickElement(backendNodeId: number): Promise<boolean>;
  typeText(text: string, options?: { clear?: boolean }): Promise<void>;
  clearTextField(): Promise<boolean>;
  forceSetValue(text: string): Promise<void>;
  readActiveText(): Promise<string>;
  sendKeys(keys: string): Promise<void>;
  getTabs(): Promise<TabInfo[]>;
  switchTab(targetId: string): Promise<void>;
  executeJs(code: string): Promise<unknown>;
  getPageHtml(options?: { extractLinks?: boolean; extractImages?: boolean }): Promise<string>;
  getState(options?: { includeScreenshot?: boolean }): Promise<BrowserStateSummary>;
  readonly currentTargetId: string | null;
}

/** Python handler 签名 (params, browser) 的 TS 形态 */
export type ActionHandler = (
  params: Record<string, unknown>,
  browser: ToolsBrowser,
) => Promise<ActionResult | string | null>;
