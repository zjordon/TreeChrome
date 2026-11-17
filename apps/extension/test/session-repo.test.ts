// session-repo 单测（issue #35 U1a W8）：键结构/turn 与归档往返/LRU 50 连带删除/
// 1MB 预算降级链（丢 tool 明细保标题）/变更链串行（并发不覆盖）/坏形态回退/
// rebindTab/compressArchiveEvents/sumUsage——fake StorageAreaWithRemove（Map 化）。

import type { JournalEvent, SessionRecord } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import type { StorageAreaWithRemove } from "../src/host/chrome-apis.js";
import {
  compressArchiveEvents,
  enforceSessionBudget,
  SESSION_INDEX_LIMIT,
  SESSIONS_INDEX_KEY,
  SessionRepository,
  sessionKey,
  sumUsage,
  TURN_TASK_CLIP,
} from "../src/runtime/session-repo.js";

function fakeStorage(initial: Record<string, unknown> = {}): StorageAreaWithRemove & {
  map: Map<string, unknown>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (keys) => {
      if (keys === null) return Object.fromEntries(map);
      const list = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of list) {
        if (map.has(k)) out[k] = map.get(k);
      }
      return out;
    },
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    remove: async (keys) => {
      for (const k of typeof keys === "string" ? [keys] : keys) map.delete(k);
    },
  };
}

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): JournalEvent => ({
  seq,
  type: type as JournalEvent["type"],
  ts: seq,
  data,
});

/** 顺序 id 工厂（块体赋值——表达式内赋值过不了 noAssignInExpressions） */
function seqIds(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${n}`;
  };
}

/** 步进时钟（同上） */
function stepClock(step: number): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}

describe("session-repo CRUD 往返", () => {
  it("createSession → listIndex/open 往返；listIndex 按 updatedAt 新→旧", async () => {
    const repo = new SessionRepository(fakeStorage(), {
      newSessionId: seqIds("s"),
      now: stepClock(10),
    });
    const a = await repo.createSession({ tabId: 1, origin: "user", title: "会话 A" });
    await repo.createSession({ tabId: 2, origin: "bridge", title: "外部" });
    expect(a.sessionId).toBe("s1");
    const list = await repo.listIndex();
    expect(list.map((m) => m.sessionId)).toEqual(["s2", "s1"]);
    const record = await repo.open("s1");
    expect(record?.meta).toMatchObject({ tabId: 1, origin: "user", title: "会话 A" });
    expect(record?.turns).toEqual([]);
    expect(await repo.open("不存在")).toBeNull();
  });

  it("beginRun → turn（task 超 8000 裁剪）；completeRun → turn 终态 + 归档 + meta 计数", async () => {
    const storage = fakeStorage();
    const repo = new SessionRepository(storage, {
      newSessionId: () => "s1",
      newTurnId: () => "t1",
      now: () => 100,
    });
    const meta = await repo.createSession({ tabId: 7, origin: "user", title: "查价" });
    const turn = await repo.beginRun(meta.sessionId, {
      runId: "r1",
      task: "x".repeat(TURN_TASK_CLIP + 10),
      attachments: [],
    });
    expect(turn).not.toBeNull();
    expect(turn?.task.length).toBe(TURN_TASK_CLIP + 1); // 8000 + … = 8001
    const ok = await repo.completeRun(meta.sessionId, {
      turnId: "t1",
      archive: {
        runId: "r1",
        startedAt: 100,
        endedAt: 300,
        status: "done",
        finalResult: "答：42",
        lastError: null,
        events: [ev(1, "step_start"), ev(2, "model_result", { inputTokens: 30, outputTokens: 5 })],
        usage: { inputTokens: 30, outputTokens: 5 },
        discardedBeforeSeq: 0,
      },
    });
    expect(ok).toBe(true);
    const record = (await repo.open(meta.sessionId)) as SessionRecord;
    expect(record.turns[0]).toMatchObject({ status: "done", endedAt: 300 });
    expect(record.runs[0]).toMatchObject({ runId: "r1", turnId: "t1", finalResult: "答：42" });
    expect(record.meta).toMatchObject({ runCount: 1, lastStatus: "done", usageTokens: 35 });
  });

  it("beginRun/completeRun 对不存在会话回 null/false", async () => {
    const repo = new SessionRepository(fakeStorage(), { newSessionId: () => "s1" });
    expect(await repo.beginRun("ghost", { runId: "r", task: "t", attachments: [] })).toBeNull();
    expect(await repo.completeRun("ghost", { turnId: "t", archive: null as never })).toBe(false);
  });

  it("rename/delete/rebindTab：生效且 index 同步；不存在回 false", async () => {
    const storage = fakeStorage();
    const repo = new SessionRepository(storage, { newSessionId: () => "s1" });
    await repo.createSession({ tabId: 1, origin: "user", title: "旧名" });
    expect(await repo.rename("s1", "新名")).toBe(true);
    expect((await repo.listIndex())[0]?.title).toBe("新名");
    expect(await repo.rebindTab("s1", 9)).toBe(true);
    expect((await repo.listIndex())[0]?.tabId).toBe(9);
    expect(await repo.delete("s1")).toBe(true);
    expect(await repo.listIndex()).toEqual([]);
    expect(storage.map.has(sessionKey("s1"))).toBe(false);
    expect(await repo.rename("s1", "x")).toBe(false);
    expect(await repo.delete("s1")).toBe(false);
    // 同 tab 重绑幂等（不重复写）
    expect(await repo.rebindTab("ghost", 1)).toBe(false);
  });

  it("resolveSessionForTab：同 tab 多会话取 updatedAt 最新", async () => {
    const repo = new SessionRepository(fakeStorage(), {
      newSessionId: seqIds("s"),
      now: stepClock(10),
    });
    await repo.createSession({ tabId: 5, origin: "user", title: "a" });
    await repo.createSession({ tabId: 5, origin: "user", title: "b" });
    await repo.createSession({ tabId: 6, origin: "user", title: "other" });
    expect((await repo.resolveSessionForTab(5))?.title).toBe("b");
    expect(await repo.resolveSessionForTab(99)).toBeNull();
  });
});

describe("session-repo LRU 与预算", () => {
  it(`索引超 ${SESSION_INDEX_LIMIT} 条 LRU：淘汰最老且连带删除会话键`, async () => {
    const storage = fakeStorage();
    const repo = new SessionRepository(storage, {
      newSessionId: seqIds("s"),
      now: stepClock(10),
    });
    for (let i = 0; i < SESSION_INDEX_LIMIT + 3; i += 1) {
      await repo.createSession({ tabId: i, origin: "user", title: `t${i}` });
    }
    const list = await repo.listIndex();
    expect(list).toHaveLength(SESSION_INDEX_LIMIT);
    expect(list.map((m) => m.title)).not.toContain("t0"); // 最老三个被淘汰
    expect(storage.map.has(sessionKey("s1"))).toBe(false);
    expect(list[0]?.title).toBe(`t${SESSION_INDEX_LIMIT + 2}`); // 最新在前
  });

  it("预算降级链：tool error 裁 200 → 丢 tool_result → 丢 model_call → 丢最老 run", async () => {
    const bigError = "E".repeat(400);
    const events: JournalEvent[] = [
      ev(1, "tool_call", { actionName: "click" }),
      ev(2, "tool_result", { error: bigError }),
      ev(3, "model_call", { messageCount: 4 }),
      ev(4, "model_result", { nextGoal: "G".repeat(300) }),
    ];
    const record = (): SessionRecord => ({
      meta: {
        sessionId: "s",
        tabId: 1,
        title: "t",
        origin: "user",
        runCount: 2,
        lastStatus: "done",
        createdAt: 1,
        updatedAt: 2,
        usageTokens: 0,
      },
      turns: [
        {
          turnId: "t1",
          sessionId: "s",
          runId: "r1",
          task: "任务",
          status: "done",
          attachments: [],
          createdAt: 1,
          endedAt: 2,
        },
      ],
      runs: [
        {
          runId: "r0",
          turnId: "t0",
          startedAt: 1,
          endedAt: 2,
          status: "done",
          finalResult: "旧",
          lastError: null,
          events: [...events],
          usage: { inputTokens: 0, outputTokens: 0 },
          discardedBeforeSeq: 0,
        },
        {
          runId: "r1",
          turnId: "t1",
          startedAt: 1,
          endedAt: 2,
          status: "done",
          finalResult: "新",
          lastError: null,
          events: [...events],
          usage: { inputTokens: 0, outputTokens: 0 },
          discardedBeforeSeq: 0,
        },
      ],
    });
    const size = JSON.stringify(record()).length;
    // ① 全量放行（budget 充足）
    expect(enforceSessionBudget(record(), size + 1).runs).toHaveLength(2);
    // ② 丢 tool_result error 之外不再动（预算 = 全量 -（400-201）*2 以上）
    const step1 = enforceSessionBudget(record(), size - 300);
    const toolErrors = step1.runs.flatMap((r) =>
      r.events
        .filter((e) => e.type === "tool_result")
        .map((e) => (e.data as { error?: string }).error ?? ""),
    );
    for (const e of toolErrors) expect(e.length).toBeLessThanOrEqual(201);
    // ③ 极小预算：逐级降到底——tool_result 全丢、model_call 全丢、最老 run 被丢（保最新）
    const squeezed = enforceSessionBudget(record(), 700);
    expect(squeezed.runs.map((r) => r.runId)).toEqual(["r1"]);
    expect(squeezed.runs[0]?.events.some((e) => e.type === "tool_result")).toBe(false);
    expect(squeezed.runs[0]?.events.some((e) => e.type === "model_call")).toBe(false);
    expect(squeezed.runs[0]?.events.some((e) => e.type === "model_result")).toBe(true); // 标题保住
    expect(squeezed.turns).toHaveLength(1); // turns 恒保
  });
});

describe("session-repo 串行与坏形态", () => {
  it("并发 beginRun 不丢：变更链串行（后写不覆盖先写）", async () => {
    const repo = new SessionRepository(fakeStorage(), {
      newSessionId: () => "s1",
      newTurnId: seqIds("t"),
    });
    const meta = await repo.createSession({ tabId: 1, origin: "user", title: "x" });
    await Promise.all([
      repo.beginRun(meta.sessionId, { runId: "r1", task: "a", attachments: [] }),
      repo.beginRun(meta.sessionId, { runId: "r2", task: "b", attachments: [] }),
    ]);
    const record = await repo.open(meta.sessionId);
    expect(record?.turns.map((t) => t.runId).sort()).toEqual(["r1", "r2"]);
  });

  it("坏形态回退：索引非数组→空；记录坏 meta→open null；归档条目逐条过滤", async () => {
    const storage = fakeStorage({
      [SESSIONS_INDEX_KEY]: [{ sessionId: 1 }, { garbage: true }, null],
      "tc_session:bad": "not an object",
      "tc_session:half": {
        meta: {
          sessionId: "half",
          tabId: 1,
          title: "t",
          origin: "user",
          createdAt: 1,
          updatedAt: 2,
        },
        turns: [
          {
            turnId: "ok",
            sessionId: "half",
            runId: "r",
            task: "t",
            status: "done",
            attachments: [],
            createdAt: 1,
          },
          { bad: 1 },
        ],
        runs: [
          {
            runId: "r",
            turnId: "ok",
            startedAt: 1,
            endedAt: 2,
            status: "done",
            events: [],
            usage: {},
          },
          42,
        ],
      },
    });
    const repo = new SessionRepository(storage);
    expect(await repo.listIndex()).toEqual([]); // 索引坏条目全滤
    expect(await repo.open("bad")).toBeNull();
    const half = await repo.open("half");
    expect(half?.turns).toHaveLength(1);
    expect(half?.runs).toHaveLength(1);
    expect(half?.runs[0]?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("compressArchiveEvents / sumUsage", () => {
  it("tool_result error 裁 200；无 error 与非 tool_result 原样", () => {
    const events = [
      ev(1, "tool_result", { error: "E".repeat(500) }),
      ev(2, "tool_result", { success: null }),
      ev(3, "model_result", { nextGoal: "G".repeat(2000) }),
    ];
    const out = compressArchiveEvents(events);
    const first = out[0]?.data as { error?: string } | undefined;
    expect((first?.error ?? "").length).toBe(201);
    expect(out[1]).toBe(events[1]);
    expect(out[2]).toBe(events[2]);
  });

  it("sumUsage：model_result 逐次累加；坏 data 防御跳过", () => {
    const usage = sumUsage([
      ev(1, "model_result", { inputTokens: 10, outputTokens: 2 }),
      ev(2, "model_result", { inputTokens: 5 }),
      ev(3, "model_result", "not a record"),
      ev(4, "tool_result", { inputTokens: 999 }),
    ]);
    expect(usage).toEqual({ inputTokens: 15, outputTokens: 2 });
  });
});

describe("session-repo 排队面（#37 批 A）", () => {
  function repoOf() {
    let n = 0;
    return new SessionRepository(fakeStorage(), {
      newSessionId: () => "s1",
      newTurnId: () => {
        n += 1;
        return `t${n}`;
      },
      now: () => 100 + n,
    });
  }

  it("appendQueuedTurn：FIFO 追加（runId null）；上限 5 拒绝；会话不存在 not-found", async () => {
    const repo = repoOf();
    const meta = await repo.createSession({ tabId: 1, origin: "user", title: "x" });
    for (let i = 1; i <= 5; i += 1) {
      const r = await repo.appendQueuedTurn(meta.sessionId, { task: `任务${i}`, attachments: [] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.turn).toMatchObject({ status: "queued", runId: null, task: `任务${i}` });
    }
    const full = await repo.appendQueuedTurn(meta.sessionId, { task: "第6条", attachments: [] });
    expect(full).toEqual({ ok: false, error: "queue-full" });
    const missing = await repo.appendQueuedTurn("ghost", { task: "x", attachments: [] });
    expect(missing).toEqual({ ok: false, error: "not-found" });
    const first = await repo.firstQueuedTurn(meta.sessionId);
    expect(first?.task).toBe("任务1"); // FIFO
  });

  it("activateQueuedTurn：queued→running 回填 runId；非 queued/不存在回 false", async () => {
    const repo = repoOf();
    const meta = await repo.createSession({ tabId: 1, origin: "user", title: "x" });
    const q = await repo.appendQueuedTurn(meta.sessionId, { task: "t", attachments: [] });
    if (!q.ok) throw new Error("queue failed");
    expect(await repo.activateQueuedTurn(meta.sessionId, q.turn.turnId, "run_1")).toBe(true);
    const record = await repo.open(meta.sessionId);
    expect(record?.turns[0]).toMatchObject({ status: "running", runId: "run_1" });
    // 再激活（已 running）→ false
    expect(await repo.activateQueuedTurn(meta.sessionId, q.turn.turnId, "run_2")).toBe(false);
    expect(await repo.activateQueuedTurn(meta.sessionId, "ghost", "run_3")).toBe(false);
  });

  it("cancelQueuedTurn/cancelQueued：仅 queued 转 cancelled（running 不动）；计数正确", async () => {
    const repo = repoOf();
    const meta = await repo.createSession({ tabId: 1, origin: "user", title: "x" });
    const a = await repo.appendQueuedTurn(meta.sessionId, { task: "a", attachments: [] });
    await repo.appendQueuedTurn(meta.sessionId, { task: "b", attachments: [] });
    if (!a.ok) throw new Error("queue failed");
    expect(await repo.cancelQueuedTurn(meta.sessionId, a.turn.turnId)).toBe(true);
    // 已 cancelled 再撤 → false
    expect(await repo.cancelQueuedTurn(meta.sessionId, a.turn.turnId)).toBe(false);
    let record = await repo.open(meta.sessionId);
    expect(record?.turns[0]?.status).toBe("cancelled");
    expect(record?.turns[1]?.status).toBe("queued");
    expect(await repo.cancelQueued(meta.sessionId)).toBe(1);
    record = await repo.open(meta.sessionId);
    expect(record?.turns[1]?.status).toBe("cancelled");
    expect(await repo.cancelQueued("ghost")).toBe(0);
  });

  it("cancelAllQueued：跨会话清空 queued；无排队零写", async () => {
    const repo = repoOf();
    const m1 = await repo.createSession({ tabId: 1, origin: "user", title: "a" });
    const m2 = await repo.createSession({ tabId: 2, origin: "user", title: "b" });
    await repo.appendQueuedTurn(m1.sessionId, { task: "x", attachments: [] });
    await repo.appendQueuedTurn(m1.sessionId, { task: "y", attachments: [] });
    await repo.appendQueuedTurn(m2.sessionId, { task: "z", attachments: [] });
    expect(await repo.cancelAllQueued()).toBe(3);
    for (const m of [m1, m2]) {
      const record = await repo.open(m.sessionId);
      expect(record?.turns.every((t) => t.status === "cancelled")).toBe(true);
    }
    expect(await repo.cancelAllQueued()).toBe(0);
  });
});
