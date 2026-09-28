// 授权记录与存储接口（p4/04 §3）：once 绑 tab（回合结束清），always 经 GrantStore
// 持久化（扩展侧 chrome.storage tc_permissions——M5 接线；P4 内存实现）。

import type { GatedCapability } from "./capability.js";

export interface Grant {
  capability: GatedCapability;
  /** normalizeHost 产物 */
  host: string;
  decision: "allow" | "deny";
  duration: "once" | "always";
  /** once 授权所属 tab（PolicyGate 匹配用；always 恒 null） */
  tabId: string | null;
  createdAt: number;
}

/**
 * always 授权持久化面（核心包禁 chrome.storage——架构 §4，宿主注入实现）。
 * 全量读写口径：saveAlways 覆盖写，loadAlways 返回当前全量。
 */
export interface GrantStore {
  loadAlways(): Promise<Grant[]>;
  saveAlways(grants: Grant[]): Promise<void>;
}

/** 内存实现（测试/评测宿主；always 不跨实例持久） */
export class InMemoryGrantStore implements GrantStore {
  private grants: Grant[] = [];

  async loadAlways(): Promise<Grant[]> {
    return [...this.grants];
  }

  async saveAlways(grants: Grant[]): Promise<void> {
    this.grants = [...grants];
  }
}
