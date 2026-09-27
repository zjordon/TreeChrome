// 软循环检测（loop_detector.py 357 全量）：动作重复（滑窗语义哈希）+ 页面停滞
//（三维指纹）→ nudge 文案；FailureStreakTracker（失败感知止损 2/4 分档 + peek/ack）
// 与 ZeroResultStreakTracker（查询零结果降级）。nudge 文案字节锚定 agent.json。

import { sha256Hex } from "@tw/dom-snapshot";

import { pyJsonDumps } from "../tools/py-json.js";
import { pyReprDeep } from "./py-repr.js";
import type { ActionResult } from "./views.js";

function normalizeActionForHash(name: string, params: Record<string, unknown>): string {
  const elementId = (): string => {
    const idx = params.index;
    return String(idx !== undefined && idx !== null ? idx : params.element_id);
  };
  if (name === "search") {
    const query = String(params.query ?? "");
    const tokens = [
      ...new Set(
        query
          .toLowerCase()
          .replace(/[^\w\s]/g, " ")
          .split(/\s+/),
      ),
    ]
      .filter((t) => t !== "")
      .sort();
    const engine = params.engine ?? "baidu";
    return `search|${String(engine)}|${tokens.join("|")}`;
  }
  if (name === "click") return `click|${elementId()}`;
  if (name === "input_text") {
    const text = String(params.text ?? "")
      .trim()
      .toLowerCase();
    return `input_text|${elementId()}|${text}`;
  }
  if (name === "navigate") return `navigate|${String(params.url ?? "")}`;
  if (name === "scroll") return `scroll|${String(params.direction ?? "down")}`;
  // 默认：动作名 + 排序后非 None 参数（json.dumps(sort_keys=True)）
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v !== undefined && v !== null) filtered[k] = v;
  }
  return `${name}|${pyJsonDumps(filtered, 0, true)}`;
}

/** 稳定 12 位哈希（sha256[:12]，browser-use 同款） */
export function computeActionHash(name: string, params: Record<string, unknown>): string {
  return sha256Hex(normalizeActionForHash(name, params)).slice(0, 12);
}

/** 页面指纹：url + element_count + dom 文本哈希（sha256[:16]） */
export class PageFingerprint {
  constructor(
    readonly url: string,
    readonly elementCount: number,
    readonly textHash: string,
  ) {}
  static fromState(url: string, domText: string, elementCount: number): PageFingerprint {
    return new PageFingerprint(url, elementCount, sha256Hex(domText).slice(0, 16));
  }
  equals(other: PageFingerprint): boolean {
    return (
      this.url === other.url &&
      this.elementCount === other.elementCount &&
      this.textHash === other.textHash
    );
  }
}

export class ActionLoopDetector {
  private readonly recentActions: string[] = [];
  private readonly recentPageFingerprints: PageFingerprint[] = [];
  maxRepetitionCount = 0;
  mostRepeatedHash: string | null = null;
  consecutiveStagnantPages = 0;

  constructor(
    private readonly windowSize = 20,
    private readonly fingerprintWindow = 5,
  ) {}

  recordAction(name: string, params: Record<string, unknown>): void {
    this.recentActions.push(computeActionHash(name, params));
    if (this.recentActions.length > this.windowSize) {
      this.recentActions.splice(0, this.recentActions.length - this.windowSize);
    }
    this.updateRepetitionStats();
  }

  recordPageState(url: string, domText: string, elementCount: number): void {
    const fp = PageFingerprint.fromState(url, domText, elementCount);
    const last = this.recentPageFingerprints[this.recentPageFingerprints.length - 1];
    this.consecutiveStagnantPages = last?.equals(fp) ? this.consecutiveStagnantPages + 1 : 0;
    this.recentPageFingerprints.push(fp);
    if (this.recentPageFingerprints.length > this.fingerprintWindow) {
      this.recentPageFingerprints.splice(
        0,
        this.recentPageFingerprints.length - this.fingerprintWindow,
      );
    }
  }

  private updateRepetitionStats(): void {
    if (this.recentActions.length === 0) {
      this.maxRepetitionCount = 0;
      this.mostRepeatedHash = null;
      return;
    }
    const counts = new Map<string, number>();
    for (const h of this.recentActions) counts.set(h, (counts.get(h) ?? 0) + 1);
    let best = "";
    let bestCount = -1;
    for (const [h, c] of counts) {
      if (c > bestCount) {
        best = h;
        bestCount = c;
      }
    }
    this.mostRepeatedHash = best;
    this.maxRepetitionCount = bestCount;
  }

  getNudgeMessage(): string | null {
    // min-3 guard（比 browser-use 保守；>=5 阈值主导时无害）
    if (this.recentActions.length < 3 && this.consecutiveStagnantPages < 5) return null;
    const messages: string[] = [];
    const n = this.recentActions.length;
    if (this.maxRepetitionCount >= 12) {
      messages.push(
        `Heads up: you have repeated a similar action ${this.maxRepetitionCount} times ` +
          `in the last ${n} actions. ` +
          "If you are making progress with each repetition, keep going. " +
          "If not, a different approach might get you there faster.",
      );
    } else if (this.maxRepetitionCount >= 8) {
      messages.push(
        `Heads up: you have repeated a similar action ${this.maxRepetitionCount} times ` +
          `in the last ${n} actions. ` +
          "Are you still making progress with each attempt? " +
          "If so, carry on. Otherwise, it might be worth trying a different approach.",
      );
    } else if (this.maxRepetitionCount >= 5) {
      messages.push(
        `Heads up: you have repeated a similar action ${this.maxRepetitionCount} times ` +
          `in the last ${n} actions. ` +
          "If this is intentional and making progress, carry on. " +
          "If not, it might be worth reconsidering your approach.",
      );
    }
    if (this.consecutiveStagnantPages >= 5) {
      messages.push(
        `The page content has not changed across ${this.consecutiveStagnantPages} consecutive actions. ` +
          "Your actions might not be having the intended effect. " +
          "It could be worth trying a different element or approach.",
      );
    }
    return messages.length > 0 ? messages.join("\n\n") : null;
  }
}

export interface StreakNudge {
  name: string;
  streak: number;
  message: string;
}

/** #186 现象①：同动作跨步连败跟踪（阈值 2 首报 / 4 升级；done 豁免；peek/ack 去抖） */
export class FailureStreakTracker {
  static readonly NUDGE_AT = 2;
  static readonly ESCALATE_AT = 4;
  private static readonly EXEMPT = new Set(["done"]);

  private readonly streaks = new Map<string, number>();
  private readonly notifiedAt = new Map<string, number>();

  record(name: string, failed: boolean): void {
    if (FailureStreakTracker.EXEMPT.has(name)) return;
    if (failed) {
      this.streaks.set(name, (this.streaks.get(name) ?? 0) + 1);
    } else {
      this.streaks.delete(name);
      this.notifiedAt.delete(name);
    }
  }

  /**（只读）止损候选——查询不落档；streak 降序遍历防新达阈动作被抑制档饿死 */
  peekNudge(): StreakNudge | null {
    const candidates = [...this.streaks.entries()]
      .filter(([, s]) => s >= FailureStreakTracker.NUDGE_AT)
      .sort((a, b) => b[1] - a[1]);
    for (const [name, streak] of candidates) {
      const notified = this.notifiedAt.get(name) ?? 0;
      if (notified >= FailureStreakTracker.ESCALATE_AT) continue;
      if (notified >= FailureStreakTracker.NUDGE_AT && streak < FailureStreakTracker.ESCALATE_AT) {
        continue;
      }
      if (streak >= FailureStreakTracker.ESCALATE_AT) {
        return {
          name,
          streak,
          message:
            `⚠️ You have failed '${name}' ${streak} times in a row. ` +
            "Strongly consider declaring this sub-goal unreachable: complete " +
            "or verify the task's actual deliverable, or finish with an honest " +
            "partial result (done with success=false, describing what was " +
            "accomplished and what is missing).",
        };
      }
      return {
        name,
        streak,
        message:
          `⚠️ You have failed '${name}' ${streak} times in a row. Stop retrying ` +
          "or inventing workarounds for this approach. Re-read the original " +
          "task and switch to a different approach that directly advances the " +
          "task's final goal — also ask whether the failing sub-goal is " +
          "required by the task at all.",
      };
    }
    return null;
  }

  ackNudge(name: string, streak: number): void {
    this.notifiedAt.set(name, streak);
  }

  /** peek + ack 便捷组合（单测/简单场景用；step 侧用分离版） */
  nudge(): string | null {
    const c = this.peekNudge();
    if (c === null) return null;
    this.ackNudge(c.name, c.streak);
    return c.message;
  }
}

export interface ZeroResultNudge {
  key: string;
  message: string;
}

/** #186-c2 形态②：同一精确查询连续零结果（metadata.query_total 旁路；阈值 2） */
export class ZeroResultStreakTracker {
  static readonly NUDGE_AT = 2;

  private readonly streaks = new Map<string, number>();
  private readonly notified = new Set<string>();
  private readonly descs = new Map<string, string>();

  /** 归一化查询身份（read_grid: namespace+search+filters；find_elements: selector；search_page: query） */
  static queryKey(name: string, params: Record<string, unknown>): [string, string] | null {
    if (name === "read_grid") {
      const ns = params.namespace || "";
      const search = params.search || "";
      const filters = params.filters || {};
      const parts: string[] = [];
      if (ns) parts.push(`ns=${String(ns)}`);
      if (search) parts.push(`search=${String(search)}`);
      if (filters && typeof filters === "object" && Object.keys(filters).length > 0) {
        parts.push(`filters=${pyJsonDumps(filters, 0, true)}`);
      }
      const key = `read_grid|${parts.length > 0 ? parts.join("|") : "default"}`;
      const descBits: string[] = [];
      if (filters && typeof filters === "object" && Object.keys(filters).length > 0) {
        descBits.push(`filters=${pyReprDict(filters as Record<string, unknown>)}`);
      }
      if (search) descBits.push(`search='${String(search)}'`);
      return [key, `read_grid ${descBits.length > 0 ? descBits.join(" ") : "(unfiltered)"}`];
    }
    if (name === "find_elements") {
      const selector = String(params.selector ?? "");
      if (!selector) return null;
      return [`find_elements|${selector}`, `selector '${selector}'`];
    }
    if (name === "search_page") {
      const query = String(params.query ?? "");
      if (!query) return null;
      return [`search_page|${query}`, `query '${query}'`];
    }
    return null;
  }

  /** 从 ActionResult.metadata 读 query_total 并更新 streak（无信号直接返回） */
  record(name: string, params: Record<string, unknown>, result: ActionResult): void {
    const metadata = result.metadata ?? {};
    const total = metadata.query_total;
    if (typeof total !== "number" || !Number.isInteger(total)) return;
    const ident = ZeroResultStreakTracker.queryKey(name, params ?? {});
    if (ident === null) return;
    const [key, desc] = ident;
    if (total > 0) {
      this.streaks.delete(key);
      this.notified.delete(key);
      this.descs.delete(key);
    } else {
      this.streaks.set(key, (this.streaks.get(key) ?? 0) + 1);
      this.descs.set(key, desc);
    }
  }

  peekNudge(): ZeroResultNudge | null {
    for (const [key, streak] of this.streaks) {
      if (streak >= ZeroResultStreakTracker.NUDGE_AT && !this.notified.has(key)) {
        const desc = this.descs.get(key) ?? key;
        return {
          key,
          message:
            `Exact-match query returned 0 results ${streak} times in a row ` +
            `(${desc}). The name may be misspelled or partially different — ` +
            "switch to a substring/partial filter, list candidate rows " +
            "unfiltered, or browse the catalog and match by similarity.",
        };
      }
    }
    return null;
  }

  ackNudge(key: string): void {
    this.notified.add(key);
  }

  nudge(): string | null {
    const c = this.peekNudge();
    if (c === null) return null;
    this.ackNudge(c.key);
    return c.message;
  }
}

/** Python f"{filters}" 的 dict repr（插入序，单引号；py-repr.ts 单源） */
function pyReprDict(v: Record<string, unknown>): string {
  return pyReprDeep(v);
}
