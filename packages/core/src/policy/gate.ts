// 决策表纯函数（p4/04 §1.2）：(capability, host, 可见授权) → allow/deny/prompt。
// 不读页面内容、不问 LLM、语言无关、注入免疫（架构 §5.1——人是信任锚）。

import type { GatedCapability } from "./capability.js";
import type { Grant } from "./grants.js";

export type GateDecision = "allow" | "deny" | "prompt";

/**
 * host 为空 = 目标识别不出 → fail-closed 拒绝（架构 §5.1）。
 * (capability, host) 精确匹配授权（once/always 由调用方先行过滤合并）；
 * 无命中 → prompt（默认保守面：无授权即问人）。
 */
export function decide(
  capability: GatedCapability,
  host: string,
  grants: readonly Grant[],
): GateDecision {
  if (host === "") return "deny";
  const hit = grants.find((g) => g.capability === capability && g.host === host);
  if (hit !== undefined) return hit.decision;
  return "prompt";
}
