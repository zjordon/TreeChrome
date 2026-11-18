// 导出 HTML 纯函数单测（issue #39 U3 批 D，验收④）：自包含结构（doctype/内联
// style/零 script）、条目渲染（用户气泡/run 块事件行/finalResult/lastError/live
// 等待态）、多轮边界序、HTML 转义（敌意文本不逃逸）。

import { describe, expect, it } from "vitest";
import { escapeHtml, serializeTranscriptHtml } from "../src/export-html.js";
import type { TranscriptItem } from "../src/transcript.js";

function userTurn(
  over: Partial<Extract<TranscriptItem, { kind: "user-turn" }>> = {},
): TranscriptItem {
  return {
    kind: "user-turn",
    turnId: "t1",
    task: "任务一",
    status: "done",
    attachments: [],
    createdAt: 1,
    ...over,
  };
}

function runBlock(
  over: Partial<Extract<TranscriptItem, { kind: "run-block" }>> = {},
): TranscriptItem {
  return {
    kind: "run-block",
    runId: "r1",
    turnId: "t1",
    status: "done",
    events: [],
    stepCount: 1,
    startedAt: 1,
    endedAt: 2,
    finalResult: "完成结果",
    lastError: null,
    discardedBeforeSeq: 0,
    ...over,
  };
}

describe("escapeHtml", () => {
  it('& < > " 全转义', () => {
    expect(escapeHtml('<script a="x">&</script>')).toBe(
      "&lt;script a=&quot;x&quot;&gt;&amp;&lt;/script&gt;",
    );
  });
});

describe("serializeTranscriptHtml", () => {
  const opts = { cssText: ".tc-root{color:red}", title: "我的会话" };

  it("自包含骨架：doctype + 内联 style + 零 script 标签", () => {
    const html = serializeTranscriptHtml([userTurn()], opts);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<style>.tc-root{color:red}</style>");
    expect(html).toContain("<title>我的会话</title>");
    // 结构自身无脚本（内容里的敌意 script 被转义——见下例）
    expect(html.match(/<script/gi)?.length ?? 0).toBe(0);
  });

  it("多轮边界：turn 气泡与 run 块按序；事件行与终态结果在块内", () => {
    const html = serializeTranscriptHtml(
      [
        userTurn({ turnId: "t1", task: "第一问" }),
        runBlock({
          turnId: "t1",
          events: [
            { seq: 1, type: "step_start", ts: 1, data: { step: 1 } },
            { seq: 2, type: "tool_call", ts: 2, data: { actionName: "click", elementIndex: 5 } },
            { seq: 3, type: "model_result", ts: 3, data: { actionName: "done", nextGoal: "收尾" } },
          ],
        }),
        userTurn({ turnId: "t2", task: "第二问", status: "queued" }),
      ],
      opts,
    );
    const i1 = html.indexOf("第一问");
    const iRun = html.indexOf("tc-card");
    const i2 = html.indexOf("第二问");
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(iRun);
    expect(iRun).toBeLessThan(i2);
    expect(html).toContain("▸ click #5");
    expect(html).toContain("✦ done：收尾");
    expect(html).toContain("完成结果");
    // 非 done turn 出状态章（排队中）
    expect(html).toContain("排队中");
  });

  it("live 等待态：状态章「运行中」，finalResult 空缺不渲染段", () => {
    const html = serializeTranscriptHtml(
      [runBlock({ status: "live", finalResult: null, endedAt: null })],
      opts,
    );
    expect(html).toContain("运行中");
    expect(html).not.toContain("完成结果");
  });

  it("敌意 task/finalResult 被转义——无 script 逃逸", () => {
    const html = serializeTranscriptHtml(
      [
        userTurn({ task: "<script>alert(1)</script>" }),
        runBlock({ finalResult: "<img onerror=x>" }),
      ],
      opts,
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });

  it("空转录占位；lastError 红字段；附件名随气泡", () => {
    const empty = serializeTranscriptHtml([], opts);
    expect(empty).toContain("（空转录）");
    const html = serializeTranscriptHtml(
      [
        userTurn({
          attachments: [{ attachmentId: "a1", name: "f.mp4", mimeType: "video/mp4", size: 9 }],
        }),
        runBlock({ lastError: "连接断" }),
      ],
      opts,
    );
    expect(html).toContain("f.mp4");
    expect(html).toContain("连接断");
    expect(html).toContain("tc-ev-err");
  });
});
