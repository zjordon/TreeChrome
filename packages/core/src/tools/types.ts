// tools 层公共类型：handler 签名 + browser 结构面。纯类型文件。
// ToolsBrowser 是 BrowserSession 的动作消费子集（接口隔离：handler 单测可注入轻量
// fake；BrowserSession 结构满足本接口，4.4 agent 传真实会话）。

import type { ActionResult } from "../agent/views.js";
import type {
  DropdownDispatchResult,
  DropdownOption,
  DropdownSetterResult,
} from "../browser/dropdown.js";
import type { EvaluateRequest } from "../browser/evaluate-enhanced.js";
import type { GridReadPayload } from "../browser/grid-read.js";
import type { PageSettleResult, ScrollResult } from "../browser/navigation.js";
import type { PrintToPdfOptions, ScreenshotOptions } from "../browser/screenshot.js";
import type {
  FindElementsData,
  FindElementsNodeIdsData,
  FindTextResult,
  SearchPageData,
} from "../browser/search-find.js";
import type { BrowserStateSummary, TabInfo } from "../browser/views.js";
import type { AttachmentPayload } from "./fs.js";

/** batch1 十 + P4b 段 1/2 二十三 + 段 3 两动作用到的 BrowserSession 面 */
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
  closeTab(targetId: string): Promise<void>;
  executeJs(code: string): Promise<unknown>;
  getPageHtml(options?: { extractLinks?: boolean; extractImages?: boolean }): Promise<string>;
  getState(options?: { includeScreenshot?: boolean }): Promise<BrowserStateSummary>;
  takeScreenshot(options?: ScreenshotOptions): Promise<Uint8Array>;
  printToPdf(options?: PrintToPdfOptions): Promise<Uint8Array>;
  findText(
    text: string,
    opts?: { nth?: number; caseSensitive?: boolean; highlight?: "box" | "selection" | "none" },
  ): Promise<FindTextResult>;
  findElements(
    selector: string,
    opts?: {
      attributes?: string[] | null;
      maxResults?: number;
      offset?: number;
      includeText?: boolean;
      firstOnly?: boolean;
      includeGeometry?: boolean;
    },
  ): Promise<FindElementsData>;
  findElementsNodeIds(
    selector: string,
    opts?: { maxResults?: number; offset?: number; includeUserAgentShadow?: boolean },
  ): Promise<FindElementsNodeIdsData>;
  searchPage(
    pattern: string,
    opts?: {
      regex?: boolean;
      caseSensitive?: boolean;
      contextChars?: number;
      cssScope?: string | null;
      maxResults?: number;
      offset?: number;
      searchAttributes?: boolean;
    },
  ): Promise<SearchPageData>;
  // ── P4b 段 2（p4b/02）：下拉族 + 上传族 ──
  fetchSelectOptions(backendNodeId: number): Promise<DropdownOption[]>;
  fetchDropdownOptions(backendNodeId: number): Promise<DropdownDispatchResult>;
  setSelectOption(backendNodeId: number, value: string): Promise<DropdownSetterResult>;
  setSelectOptionMulti(backendNodeId: number, values: string[]): Promise<DropdownSetterResult>;
  setDropdownOption(backendNodeId: number, value: string): Promise<DropdownSetterResult>;
  setComboboxOption(backendNodeId: number, value: string): Promise<DropdownSetterResult>;
  setCustomDropdownOption(backendNodeId: number, value: string): Promise<DropdownSetterResult>;
  expandAndFetchComboboxOptions(backendNodeId: number): Promise<DropdownOption[]>;
  expandAndFetchCustomOptions(backendNodeId: number): Promise<DropdownOption[]>;
  setFileInput(
    backendNodeId: number | null,
    filePath: string,
    fileInputBackendIds?: number[] | null,
  ): Promise<void>;
  /** bytes 注入通道（M5 段 C 扩展形态；路径宿主 fake 可编程面镜像 setFileInput） */
  setFileInputData(backendNodeId: number, payload: AttachmentPayload): Promise<void>;
  discoverFileInputViaClick(backendNodeId: number, timeoutMs?: number): Promise<number | null>;
  evalFunctionOnNode(backendNodeId: number, functionDeclaration: string): Promise<unknown>;
  // ── P4b 段 3（p4b/03）：evaluate 增强 + 网格读取 ──
  evaluateEnhanced(req: EvaluateRequest): Promise<string>;
  readUiGrid(payload: GridReadPayload, timeoutMs?: number | null): Promise<Record<string, unknown>>;
  evalGridChannel(js: string, payload: GridReadPayload): Promise<Record<string, unknown> | null>;
  readonly currentTargetId: string | null;
}

/** Python handler 签名 (params, browser) 的 TS 形态 */
export type ActionHandler = (
  params: Record<string, unknown>,
  browser: ToolsBrowser,
) => Promise<ActionResult | string | null>;
