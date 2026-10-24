// 信封类型面测试（m5/01 §1.1）：判别联合 exhaustive（satisfies never 编译期 + 运行期
// kind 全覆盖）+ 常量表与联合的一致性。纯类型包的运行面只有 kind 常量表——锚定它。

import { describe, expect, it } from "vitest";
import type { SwToUiKind, SwToUiMessage, UiToSwKind, UiToSwMessage } from "../src/index.js";
import { SW_TO_UI_KINDS, UI_TO_SW_KINDS } from "../src/index.js";

/** exhaustive switch 的默认分支守卫：新增 kind 未处理时赋值 never 编译失败 */
function swKindOf(msg: SwToUiMessage): SwToUiKind {
  switch (msg.kind) {
    case "hello":
    case "journal-snapshot":
    case "event":
    case "permission-request":
    case "permission-cancelled":
    case "submit-request":
    case "attachments":
    case "attachment-begun":
    case "attachment-rejected":
    case "skill-drafts":
      return msg.kind;
    default: {
      const unreachable: never = msg;
      return unreachable;
    }
  }
}

function uiKindOf(msg: UiToSwMessage): UiToSwKind {
  switch (msg.kind) {
    case "journal-ack":
    case "permission-resolve":
    case "submit-resolve":
    case "control":
    case "attachment-begin":
    case "attachment-chunk":
    case "attachment-commit":
    case "attachment-abort":
    case "attachment-remove":
    case "settings-changed":
    case "options":
    case "diag":
      return msg.kind;
    default: {
      const unreachable: never = msg;
      return unreachable;
    }
  }
}

describe("@tw/protocol 信封", () => {
  it("SW→UI kind 常量表与判别联合一致（逐 kind 构造样例可被路由）", () => {
    const samples: SwToUiMessage[] = [
      { kind: "hello", runId: null, snapshot: null },
      { kind: "journal-snapshot", snapshot: null as never },
      { kind: "event", seq: 1, event: null as never },
      { kind: "permission-request", token: "t", req: null as never },
      { kind: "permission-cancelled", token: "t" },
      { kind: "submit-request", token: "t", req: null as never, fields: [] },
      {
        kind: "attachments",
        items: [],
        budget: { usedBytes: 0, pendingBytes: 0, maxBytes: 1, maxTotalBytes: 2 },
      },
      { kind: "attachment-begun", transferId: "t1" },
      {
        kind: "attachment-rejected",
        rejection: { name: "a.mp4", mimeType: "video/mp4", size: 3, reason: "too-large", limit: 2 },
      },
      { kind: "skill-drafts", count: 1 },
    ];
    expect([...SW_TO_UI_KINDS]).toHaveLength(10);
    expect(samples.map(swKindOf)).toEqual([...SW_TO_UI_KINDS]);
  });

  it("UI→SW kind 常量表与判别联合一致", () => {
    expect([...UI_TO_SW_KINDS]).toHaveLength(12);
    const samples: UiToSwMessage[] = [
      { kind: "journal-ack", seq: 3 },
      { kind: "permission-resolve", token: "t", verdict: "deny" },
      { kind: "submit-resolve", token: "t", approved: true },
      { kind: "control", action: "stop" },
      { kind: "attachment-begin", transferId: "t1", name: "a.mp4", mimeType: "video/mp4", size: 8 },
      { kind: "attachment-chunk", transferId: "t1", offset: 0, data: "QUJD" },
      { kind: "attachment-commit", transferId: "t1" },
      { kind: "attachment-abort", transferId: "t1" },
      { kind: "attachment-remove", attachmentId: "att_1" },
      { kind: "settings-changed" },
      { kind: "options", op: "list-grants" },
      { kind: "diag", command: "echo" },
    ];
    expect(samples.map(uiKindOf)).toEqual([...UI_TO_SW_KINDS]);
  });

  it("control.action 收紧 start 的 task 可选性（类型面），运行期只验 kind 路由", () => {
    const start: UiToSwMessage = { kind: "control", action: "start", task: "任务" };
    const stop: UiToSwMessage = { kind: "control", action: "stop" };
    expect(uiKindOf(start)).toBe("control");
    expect(uiKindOf(stop)).toBe("control");
  });
});
