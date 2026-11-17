// 活动可驱动 tab 挑选（issue #32 M2 从 run-manager 抽出共享）：三级降级链
// currentWindow → lastFocusedWindow → 任意窗口 active，每级先取可驱动页（http/https
// ——chrome:// 等内部页 chrome.debugger 拒绝附着，段 F 验收）；url 不可读（权限
// 缺失/注入测试）不判形态。纯注入零 chrome。

import type { TabsQueryApi } from "../host/chrome-apis.js";

/** 可驱动 URL 判定：http/https；url 未知（undefined）不判形态 */
export function isDrivableUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

export function drivableOf(
  tabs: Array<{ id: number | undefined; url?: string }>,
): { id: number | undefined; url?: string } | undefined {
  return tabs.find((t) => t.url === undefined || isDrivableUrl(t.url));
}

export interface TabPick {
  tabId: number | undefined;
  /** 链上见过内部页面（chrome:// 等）——调用方据此给可行动文案 */
  sawRestricted: boolean;
}

/** 指定 tab 现存且可驱动（会话绑定 tab 校验——#37 评审轮 1 [10] 排队续播用）。
 *  url 未知（权限缺失/注入测试）不判形态，与 drivableOf 同口径 */
export async function tabByIdDrivable(
  tabsQuery: TabsQueryApi,
  tabId: number,
): Promise<{ ok: true } | { ok: false; reason: "closed" | "restricted" }> {
  const tabs = await tabsQuery.query({});
  const tab = tabs.find((t) => t.id === tabId);
  if (tab === undefined) return { ok: false, reason: "closed" };
  if (tab.url !== undefined && !isDrivableUrl(tab.url)) return { ok: false, reason: "restricted" };
  return { ok: true };
}

/**
 * 三级降级链挑选活动可驱动 tab。sawRestricted 取最后一级查询结果的形态
 * （早命中时即该级结果）——与 run-manager 既有语义逐字一致（抽出不改行为）。
 */
export async function pickActiveDrivableTab(tabsQuery: TabsQueryApi): Promise<TabPick> {
  // headless/SW 语境 currentWindow 可能为空（无聚焦窗口）——逐级降级
  let tabs = await tabsQuery.query({ active: true, currentWindow: true });
  let pick = drivableOf(tabs);
  if (pick === undefined) {
    tabs = await tabsQuery.query({ active: true, lastFocusedWindow: true });
    pick = drivableOf(tabs);
  }
  if (pick === undefined) tabs = await tabsQuery.query({ active: true });
  const sawRestricted = tabs.some((t) => t.url !== undefined && !isDrivableUrl(t.url));
  return { tabId: pick?.id ?? drivableOf(tabs)?.id, sawRestricted };
}
