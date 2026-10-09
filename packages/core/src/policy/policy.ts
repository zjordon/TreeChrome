// PolicyGate（p4/04 §1.2/§3；架构 §5.1/§5.3）：组合 decide 决策表 + PolicyInteraction
// 确认卡 + GrantStore 授权。判定顺序：once grant → always grant → 决策表 →
// PolicyInteraction；边界纪律：交互异常/超时一律按 deny。TreeChrome 净新增（设计取
// webbrain，代码重写）。submitGate（M5 段 C）：submit 特征 click 的二道门——
// confirmSubmit 逐次确认、无 grant 记账（submit 卡按动作粒度，always 语义不适用）。

import type { ElementBbox } from "../events/events.js";
import { CAPABILITY_LABEL, type GatedCapability } from "./capability.js";
import { decide } from "./gate.js";
import type { Grant, GrantStore } from "./grants.js";

/** 确认卡请求（架构 §5.3：带元素 bbox/xpath 高亮） */
export interface PermissionRequest {
  capability: GatedCapability;
  host: string;
  actionName: string;
  params: Record<string, unknown>;
  tabId: string | null;
  elementIndex: number | null;
  elementBbox: ElementBbox | null;
  elementXpath: string | null;
}

export type PermissionVerdict = "allow-once" | "allow-always" | "deny";

/** submit 预确认卡的字段摘要（架构 §5.3：变更字段 ≤8，password 值打码） */
export interface SubmitFieldSummary {
  /** name 属性 → id → aria-label/placeholder 兜底的字段标识 */
  name: string;
  /** 当前值（≤40 字符；password 字段恒 "***"） */
  value: string;
}

/** 宿主交互面（架构 §4 五接口之一；扩展侧确认卡 UI——M5 落地） */
export interface PolicyInteraction {
  requestPermission(req: PermissionRequest): Promise<PermissionVerdict>;
  /** submit 预确认（M5 段 C 挂点）：req + 变更字段摘要；true=放行提交 */
  confirmSubmit(req: PermissionRequest, summary: SubmitFieldSummary[]): Promise<boolean>;
}

export interface GateCheckRequest {
  capability: GatedCapability;
  host: string;
  actionName: string;
  params: Record<string, unknown>;
  tabId: string | null;
  elementIndex: number | null;
  elementBbox: ElementBbox | null;
  elementXpath: string | null;
}

export interface GateCheckResult {
  allowed: boolean;
  /** 拒绝回流文案（allowed=false 时非空；denied ActionResult.error 直用） */
  reason: string | null;
}

export interface PolicyGateOptions {
  /** 确认等待上限 ms（超时按 deny；M5 扩展侧确认卡自身 UX 超时之外的兜底） */
  promptTimeoutMs?: number;
}

export const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;

/** 用户拒绝文案（架构 §5.1 逐字模板；交互异常/超时同文案——模型不区分拒绝来源） */
function deniedReason(host: string, capability: GatedCapability): string {
  return `用户拒绝在 ${host} 上 ${CAPABILITY_LABEL[capability]}，不要重试，可改道或询问`;
}

/** submit 预确认拒绝文案（M5 段 C，架构 §5.3 变体——不复用 CLICK 文案，避免模型
 *  误解为点击本身被拒；交互异常/超时同文案） */
function deniedSubmitReason(host: string): string {
  return `用户拒绝在 ${host} 上提交表单，不要重试，可改道或询问`;
}

/** fail-closed（host 识别不出）文案 */
function failClosedReason(capability: GatedCapability): string {
  return `无法识别目标站点 host，权限门已按拒绝处理（${CAPABILITY_LABEL[capability]}），不要重试，可改道或询问`;
}

export class PolicyGate {
  private readonly interaction: PolicyInteraction;
  private readonly store: GrantStore | null;
  private readonly promptTimeoutMs: number;
  private onceGrants: Grant[] = [];
  private alwaysGrants: Grant[] | null = null;

  constructor(
    interaction: PolicyInteraction,
    store: GrantStore | null = null,
    options: PolicyGateOptions = {},
  ) {
    this.interaction = interaction;
    this.store = store;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  }

  /**
   * 单动作过门（挂点：act.ts 串行循环内逐动作，ToolCallEvent 之后）。纯检查不抛——
   * 存储读写失败按「空授权/尽力持久化」降级，交互异常/超时按 deny（边界纪律）。
   */
  async check(req: GateCheckRequest): Promise<GateCheckResult> {
    if (req.host === "") {
      return { allowed: false, reason: failClosedReason(req.capability) };
    }
    const grants = [...this.visibleOnceGrants(req.tabId), ...(await this.loadAlways())];
    const decision = decide(req.capability, req.host, grants);
    if (decision === "allow") return { allowed: true, reason: null };
    if (decision === "deny")
      return { allowed: false, reason: deniedReason(req.host, req.capability) };

    // prompt → 宿主确认卡（超时/异常一律 deny；race 后到结果不记账）
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const verdict = await Promise.race([
        this.interaction.requestPermission(req),
        new Promise<"__timeout__">((resolve) => {
          timer = setTimeout(() => resolve("__timeout__"), this.promptTimeoutMs);
        }),
      ]);
      if (verdict === "deny" || verdict === "__timeout__") {
        return { allowed: false, reason: deniedReason(req.host, req.capability) };
      }
      if (verdict === "allow-once") {
        this.recordOnce(req);
      } else {
        await this.recordAlways(req);
      }
      return { allowed: true, reason: null };
    } catch {
      return { allowed: false, reason: deniedReason(req.host, req.capability) };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * submit 预确认二道门（M5 段 C，架构 §5.3）：CLICK 已放行后的独立确认——
   * confirmSubmit 一步问（无 grant 记账：submit 卡按动作粒度逐次确认，always 语义
   * 不适用）。边界纪律同 check：交互异常/超时一律 deny；host 空 fail-closed。
   */
  async submitGate(req: GateCheckRequest, summary: SubmitFieldSummary[]): Promise<GateCheckResult> {
    if (req.host === "") {
      return { allowed: false, reason: failClosedReason(req.capability) };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const verdict = await Promise.race([
        this.interaction.confirmSubmit(req, summary),
        new Promise<"__timeout__">((resolve) => {
          timer = setTimeout(() => resolve("__timeout__"), this.promptTimeoutMs);
        }),
      ]);
      if (verdict === true) return { allowed: true, reason: null };
      return { allowed: false, reason: deniedSubmitReason(req.host) };
    } catch {
      return { allowed: false, reason: deniedSubmitReason(req.host) };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** 回合结束清 once（p4/04 §3；tabId 省略清全部——单 Agent 单回合口径） */
  clearOnce(tabId?: string | null): void {
    if (tabId === undefined || tabId === null) {
      this.onceGrants = [];
      return;
    }
    this.onceGrants = this.onceGrants.filter((g) => g.tabId !== tabId);
  }

  /** 当前生效的 always 授权（设置页撤销可见面；只读拷贝） */
  async listAlwaysGrants(): Promise<Grant[]> {
    return [...(await this.loadAlways())];
  }

  private visibleOnceGrants(tabId: string | null): Grant[] {
    // once 绑 tab：本 tab 的 once 才可见（webbrain「一 tab 的 Allow-once 不得授权
    // 另一 tab」同款）；tabId null 的宿主形态只匹配 null 授权
    return this.onceGrants.filter((g) => g.tabId === tabId);
  }

  private async loadAlways(): Promise<Grant[]> {
    if (this.alwaysGrants !== null) return this.alwaysGrants;
    let loaded: Grant[] = [];
    if (this.store !== null) {
      try {
        loaded = (await this.store.loadAlways()).filter(
          (g) => g.duration === "always" && g.host !== "" && g.tabId === null,
        );
      } catch {
        // 存储不可用 → 按空授权起步（webbrain hydrate 同款）
      }
    }
    this.alwaysGrants = loaded;
    return loaded;
  }

  private recordOnce(req: GateCheckRequest): void {
    // 同键旧 once 授权被覆盖（同 tab）
    this.onceGrants = this.onceGrants.filter(
      (g) => !(g.tabId === req.tabId && g.capability === req.capability && g.host === req.host),
    );
    this.onceGrants.push({
      capability: req.capability,
      host: req.host,
      decision: "allow",
      duration: "once",
      tabId: req.tabId,
      createdAt: Date.now(),
    });
  }

  private async recordAlways(req: GateCheckRequest): Promise<void> {
    const current = await this.loadAlways();
    // 全局覆盖：任何 tab 的同键旧授权被替换（webbrain record 同款）
    const next = current.filter((g) => !(g.capability === req.capability && g.host === req.host));
    next.push({
      capability: req.capability,
      host: req.host,
      decision: "allow",
      duration: "always",
      tabId: null,
      createdAt: Date.now(),
    });
    this.alwaysGrants = next;
    if (this.store !== null) {
      try {
        await this.store.saveAlways(next);
      } catch {
        // 持久化失败不影响本回合授权（尽力而为）
      }
    }
  }
}
