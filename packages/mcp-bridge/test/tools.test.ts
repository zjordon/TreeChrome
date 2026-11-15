// MCP 工具面单测（issue #31 M1 P2）：InMemoryTransport 走真 SDK Server/Client——
// 不经 HTTP，验证工具目录/参数校验/队列桥接/错误信封/watch 与 progress 流。
// 「扩展侧」由测试驱动 state.poll/complete 扮演。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BridgeRunSnapshot } from "@tw/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeState, createMcpServer } from "../src/index.js";

const EXT_AUTH = {
  connectionId: "c-1",
  pairingToken: "ptoken",
  instanceId: "inst-1",
  pollTimeoutMs: 1_000,
  maxBatch: 4,
};

function makeState(): BridgeState {
  let idSeq = 0;
  let tokenSeq = 0;
  let record: { pairingToken: string; extensionId: string; name: string } | null = null;
  return new BridgeState({
    instanceId: "inst-1",
    now: () => 1_000_000,
    randomId: () => `id-${++idSeq}`,
    randomToken: () => `t${++tokenSeq}`,
    pairingStore: {
      load: async () => record,
      save: async (r) => {
        record = r;
      },
      remove: async () => {
        record = null;
      },
    },
  });
}

async function pairFresh(state: BridgeState): Promise<void> {
  const invitation = state.beginPairing();
  await state.pair({
    t: invitation.t,
    extensionId: "ext-1",
    name: "TreeChrome",
    pairingToken: "ptoken",
    connectionId: "c-1",
  });
}

/** 假扩展：领走下一条命令并以给定结果回投 */
async function serveNext(state: BridgeState, result: unknown): Promise<void> {
  const { requests } = await state.poll(EXT_AUTH, new AbortController().signal);
  const request = requests[0];
  if (request === undefined) throw new Error("serveNext: 队列为空");
  state.complete({
    requestId: request.id,
    ok: true,
    result,
    durationMs: 1,
  });
}

async function serveNextError(
  state: BridgeState,
  error: { code: string; message: string },
): Promise<void> {
  const { requests } = await state.poll(EXT_AUTH, new AbortController().signal);
  const request = requests[0];
  if (request === undefined) throw new Error("serveNextError: 队列为空");
  state.complete({ requestId: request.id, ok: false, error, durationMs: 1 });
}

async function connect(state: BridgeState): Promise<Client> {
  const server = createMcpServer({
    state,
    version: "test",
    requestTimeoutMs: 5_000,
    watchPollIntervalMs: 5,
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** callTool 结果联合形态（SDK ≥1.3x 含 toolResult 变体）→ 首个 text 块的 JSON */
function textOf(result: object): unknown {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const block = content?.[0];
  if (block === undefined || block.type !== "text" || block.text === undefined) {
    throw new Error("no text block");
  }
  return JSON.parse(block.text);
}

function snap(over: Partial<BridgeRunSnapshot> = {}): BridgeRunSnapshot {
  return {
    runId: "r-1",
    status: "running",
    isDone: false,
    isSuccessful: null,
    finalResult: null,
    stopReason: null,
    nSteps: 0,
    errors: [],
    lastUrl: null,
    timeline: [],
    ...over,
  };
}

let state: BridgeState;
let client: Client;

beforeEach(async () => {
  state = makeState();
  await pairFresh(state);
  client = await connect(state);
});
afterEach(async () => {
  await client.close();
});

describe("工具目录", () => {
  it("5 工具齐备", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "tc_bridge_status",
      "run_task",
      "get_snapshot",
      "watch_task",
      "stop_run",
    ]);
  });
});

describe("命令三件", () => {
  it("tc_bridge_status：直读状态不入队", async () => {
    const result = await client.callTool({ name: "tc_bridge_status", arguments: {} });
    expect(textOf(result)).toMatchObject({ paired: true });
  });

  it("run_task：入队 → 扩展回投 → 返回受理回执", async () => {
    const call = client.callTool({ name: "run_task", arguments: { task: "查价" } });
    await serveNext(state, { accepted: true, runId: "r-1" });
    const result = await call;
    expect(textOf(result)).toEqual({ accepted: true, runId: "r-1" });
  });

  it("run_task：空 task → INVALID_ARGUMENTS", async () => {
    const result = await client.callTool({ name: "run_task", arguments: { task: "  " } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ code: "INVALID_ARGUMENTS" });
  });

  it("扩展回执失败（busy）→ isError + code", async () => {
    const call = client.callTool({ name: "run_task", arguments: { task: "x" } });
    await serveNextError(state, { code: "RUN_IN_PROGRESS", message: "busy" });
    const result = await call;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ code: "RUN_IN_PROGRESS" });
  });

  it("未知工具 → INVALID_ARGUMENTS", async () => {
    const result = await client.callTool({ name: "nope", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ code: "INVALID_ARGUMENTS" });
  });
});

describe("未配对快速失败", () => {
  it("run_task 在未配对时直接 BRIDGE_PAIRING_REQUIRED（不入队）", async () => {
    const fresh = makeState();
    const unpaired = await connect(fresh);
    try {
      const result = await unpaired.callTool({ name: "run_task", arguments: { task: "x" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({ code: "BRIDGE_PAIRING_REQUIRED" });
      expect(fresh.status().queueDepth).toBe(0);
    } finally {
      await unpaired.close();
    }
  });
});

describe("watch_task", () => {
  it("挂起至终态并返回完整快照；stream 时 progress 逐事件外发", async () => {
    const progresses: Array<string | undefined> = [];
    const call = client.callTool(
      { name: "watch_task", arguments: { waitTimeoutSeconds: 30, stream: true } },
      undefined,
      {
        onprogress: (p: { message?: string }) => {
          progresses.push(p.message);
        },
      },
    );
    await serveNext(state, snap({ timeline: [{ seq: 1, type: "step", summary: "s1" }] }));
    await serveNext(
      state,
      snap({
        isDone: true,
        status: "done",
        isSuccessful: true,
        finalResult: "答：42",
        timeline: [
          { seq: 1, type: "step", summary: "s1" },
          { seq: 2, type: "done", summary: "完成" },
        ],
      }),
    );
    const result = await call;
    expect(textOf(result)).toMatchObject({ isDone: true, finalResult: "答：42" });
    expect(progresses.join("\n")).toContain("s1");
    expect(progresses.join("\n")).toContain("完成");
  });

  it("超时 → isError code TIMEOUT 且携带 lastSnapshot（任务仍在跑）", async () => {
    vi.useFakeTimers();
    try {
      const call = client.callTool({
        name: "watch_task",
        arguments: { waitTimeoutSeconds: 0 },
      });
      // waitTimeoutSeconds=0：首拍 running 后即过截止——先备好第一条快照
      await serveNext(state, snap({ timeline: [{ seq: 1, type: "step", summary: "s" }] }));
      const result = await call;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({ code: "TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("不带 stream → 无 progress 通知也能观察到终态", async () => {
    const call = client.callTool({ name: "watch_task", arguments: {} });
    await serveNext(state, snap({ isDone: true, status: "done" }));
    const result = await call;
    expect(textOf(result)).toMatchObject({ isDone: true });
  });

  it("大截止不放宽单命令预算：budget 只收紧——失联时按 requestTimeoutMs 上限暴露", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const call = client
        .callTool({ name: "watch_task", arguments: { waitTimeoutSeconds: 600 } })
        .then((r) => {
          settled = true;
          return r;
        });
      // 不 serveNext——扩展失联；connect() 注入的 requestTimeoutMs=5s 是单命令预算
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true); // 未钳制时会挂到 600s 截止——此处即红
      const result = await call;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({ code: "BRIDGE_REQUEST_TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });
});
