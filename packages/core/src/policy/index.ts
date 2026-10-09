// policy 门面（p4/04 §1.2 五模块）。

export { AutoAllowPolicy } from "./auto-allow.js";
export type { Capability, GatedCapability } from "./capability.js";
export {
  CAPABILITY_LABEL,
  hostForAction,
  normalizeHost,
  resolveCapability,
} from "./capability.js";
export type { GateDecision } from "./gate.js";
export { decide } from "./gate.js";
export type { Grant, GrantStore } from "./grants.js";
export { InMemoryGrantStore } from "./grants.js";
export type {
  GateCheckRequest,
  GateCheckResult,
  PermissionRequest,
  PermissionVerdict,
  PolicyGateOptions,
  PolicyInteraction,
  SubmitFieldSummary,
} from "./policy.js";
export {
  DEFAULT_PROMPT_TIMEOUT_MS,
  PolicyGate,
} from "./policy.js";
