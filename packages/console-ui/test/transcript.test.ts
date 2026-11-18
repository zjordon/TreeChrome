// transcript 投影纯函数单测（issue #35 U1b B8）：归档-only / 活动 run 合流 /
// 残留 running 无归档只出气泡 / 空态——B8 验收锚点。

import type { JournalEvent, RunJournalSnapshot, SessionRecord } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import { projectTranscript } from "../src/transcript.js";

const ev = (seq: number, type: string): JournalEvent => ({
  seq,
  type: type as JournalEvent["type"],
  ts: seq,
  data: { step: 1 },
});

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  meta: {
    sessionId: "s1",
    tabId: 7,
    title: "查价",
    origin: "user",
    runCount: 1,
    lastStatus: "done",
    createdAt: 1,
    updatedAt: 2,
    usageTokens: 10,
    attachmentCount: 0,
  },
  turns: [
    {
      turnId: "t1",
      sessionId: "s1",
      runId: "r1",
      task: "查价",
      status: "done",
      attachments: [],
      createdAt: 1,
      endedAt: 2,
    },
  ],
  runs: [
    {
      runId: "r1",
      turnId: "t1",
      startedAt: 1,
      endedAt: 2,
      status: "done",
      finalResult: "答：42",
      lastError: null,
      events: [ev(1, "step_start"), ev(2, "session_end")],
      usage: { inputTokens: 8, outputTokens: 2 },
      discardedBeforeSeq: 0,
    },
  ],
  ...over,
});

const snapshot = (over: Partial<RunJournalSnapshot> = {}): RunJournalSnapshot =>
  ({
    runId: "r2",
    tabId: 7,
    status: "running",
    seq: 5,
    ackedSeq: 0,
    discardedBeforeSeq: 0,
    events: [],
    task: "T2",
    startedAt: 3,
    endedAt: null,
    finalResult: null,
    isDone: false,
    isSuccessful: null,
    stepCount: 2,
    lastError: null,
    attachments: [],
    sessionId: "s1",
    origin: "user",
    ...over,
  }) as RunJournalSnapshot;

describe("projectTranscript", () => {
  it("空态：record null → []；无 turns → []", () => {
    expect(projectTranscript(null, null, [])).toEqual([]);
    expect(projectTranscript(record({ turns: [], runs: [] }), null, [])).toEqual([]);
  });

  it("归档-only：turn 气泡 + 终态 run 块（事件/结果取 RunArchive）", () => {
    const items = projectTranscript(record(), null, []);
    expect(items.map((i) => i.kind)).toEqual(["user-turn", "run-block"]);
    const bubble = items[0];
    expect(bubble).toMatchObject({ kind: "user-turn", task: "查价", status: "done" });
    const block = items[1];
    expect(block).toMatchObject({
      kind: "run-block",
      runId: "r1",
      status: "done",
      finalResult: "答：42",
      events: [ev(1, "step_start"), ev(2, "session_end")],
    });
  });

  it("活动 run 合流：running turn 配对快照 → live 块事件取 liveEvents（D8）", () => {
    const rec = record({
      turns: [
        ...record().turns,
        {
          turnId: "t2",
          sessionId: "s1",
          runId: "r2",
          task: "再查",
          status: "running",
          attachments: [],
          createdAt: 3,
          endedAt: null,
        },
      ],
    });
    const live = [ev(1, "step_start"), ev(2, "model_result")];
    const items = projectTranscript(rec, snapshot(), live);
    expect(items.map((i) => i.kind)).toEqual(["user-turn", "run-block", "user-turn", "run-block"]);
    const liveBlock = items[3];
    expect(liveBlock).toMatchObject({
      kind: "run-block",
      status: "live",
      events: live, // 归档里没有 r2——live 事件面直供
      stepCount: 2,
      finalResult: null,
    });
  });

  it("快照会话不匹配：turn 不按 live 配对（他会的活动 run 不进本会话转录）", () => {
    const rec = record({
      turns: [
        ...record().turns,
        {
          turnId: "t2",
          sessionId: "s1",
          runId: "r9",
          task: "他会的",
          status: "running",
          attachments: [],
          createdAt: 3,
          endedAt: null,
        },
      ],
    });
    const items = projectTranscript(rec, snapshot({ runId: "r9", sessionId: "s-other" }), []);
    expect(items).toHaveLength(3); // 无 r9 run 块——只出气泡
    expect(items[2]).toMatchObject({ kind: "user-turn", status: "running" });
  });

  it("残留 running 无归档且非活动：只出气泡（恢复对账后自然收口）", () => {
    const rec = record({
      turns: [
        ...record().turns,
        {
          turnId: "t2",
          sessionId: "s1",
          runId: "r_dead",
          task: "被打断",
          status: "running",
          attachments: [],
          createdAt: 3,
          endedAt: null,
        },
      ],
    });
    const items = projectTranscript(rec, null, []);
    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ kind: "user-turn", status: "running" });
  });

  it("终态快照不再配 live（评审轮 2 [1]）：turn done / 快照同 runId 已收口 → 走归档，终态结果可见", () => {
    // run 收口后：turn=done、归档就位、snapshot 仍是同 runId 的终态快照（reducer 无置空路径）
    const terminalSnapshot = snapshot({
      runId: "r1",
      status: "done",
      endedAt: 9,
      finalResult: "答：42",
    });
    const items = projectTranscript(record(), terminalSnapshot, []);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "run-block",
      status: "done", // 不是 live——归档分支
      finalResult: "答：42",
    });
  });

  it("turn 仍 running 但快照已终态（补查在途过渡窗）：同样走归档分支", () => {
    const rec = record({
      turns: [
        ...record().turns,
        {
          turnId: "t2",
          sessionId: "s1",
          runId: "r2",
          task: "刚收口",
          status: "running",
          attachments: [],
          createdAt: 3,
          endedAt: null,
        },
      ],
      runs: [
        ...record().runs,
        {
          runId: "r2",
          turnId: "t2",
          startedAt: 3,
          endedAt: 8,
          status: "done",
          finalResult: "R2",
          lastError: null,
          events: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          discardedBeforeSeq: 0,
        },
      ],
    });
    const items = projectTranscript(rec, snapshot({ status: "done", endedAt: 8 }), []);
    expect(items).toHaveLength(4);
    expect(items[3]).toMatchObject({ kind: "run-block", status: "done", finalResult: "R2" });
  });
});
