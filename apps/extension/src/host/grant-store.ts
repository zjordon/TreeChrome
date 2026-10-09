// GrantStore 的 chrome.storage 实现（m5/04 §3.1）：`tc_permissions` 键直存 core
// Grant 形状数组（always 授权持久；once 在 PolicyGate 内存——不落盘）。存储不可
// 读 → 抛（PolicyGate.loadAlways 的 try/catch 已按空授权降级——webbrain hydrate
// 同款边界）。

import type { Grant, GrantStore } from "@tw/core";
import type { StorageArea } from "./chrome-apis.js";

export const PERMISSIONS_KEY = "tc_permissions";

function isGrantLike(v: unknown): v is Grant {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.capability === "string" &&
    typeof g.host === "string" &&
    (g.decision === "allow" || g.decision === "deny") &&
    (g.duration === "once" || g.duration === "always") &&
    (g.tabId === null || typeof g.tabId === "string") &&
    typeof g.createdAt === "number"
  );
}

export class ChromeGrantStore implements GrantStore {
  private readonly area: StorageArea;

  constructor(area: StorageArea) {
    this.area = area;
  }

  async loadAlways(): Promise<Grant[]> {
    const items = await this.area.get(PERMISSIONS_KEY);
    const raw = items[PERMISSIONS_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter(isGrantLike);
  }

  async saveAlways(grants: Grant[]): Promise<void> {
    await this.area.set({ [PERMISSIONS_KEY]: grants });
  }
}
