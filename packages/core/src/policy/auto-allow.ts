// 评测策略（p4/04 §1.2；架构 §5 注）：无人值守无条件放行 + 记账（评测口径标注——
// 请求全量留痕，保证「评测对权限层零阻塞」与权限逻辑/UI 解耦可审计）。

import type { PermissionRequest, PermissionVerdict, PolicyInteraction } from "./policy.js";

export class AutoAllowPolicy implements PolicyInteraction {
  /** 记账：每次过门请求原样留痕（评测报告消费） */
  readonly requests: PermissionRequest[] = [];

  async requestPermission(req: PermissionRequest): Promise<PermissionVerdict> {
    this.requests.push(req);
    return "allow-once";
  }

  async confirmSubmit(_req: PermissionRequest): Promise<boolean> {
    return true;
  }
}
