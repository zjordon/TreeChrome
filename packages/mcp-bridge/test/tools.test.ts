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
  it("21 工具齐备（M1 任务级 5 + M2 直驱 15 + session_stop）", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "tc_bridge_status",
      "run_task",
      "get_snapshot",
      "watch_task",
      "stop_run",
      "get_state",
      "navigate",
      "click",
      "input_text",
      "select_dropdown",
      "scroll",
      "find_text",
      "read_grid",
      "evaluate",
      "screenshot",
      "upload_file",
      "go_back",
      "tabs",
      "switch_tab",
      "close_tab",
      "session_stop",
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

describe("会话级直驱（#32 M2 P3）", () => {
  interface EpochRef {
    value: number | undefined;
  }

  async function connectDrive(state2: BridgeState): Promise<{ client: Client; epoch: EpochRef }> {
    const epoch: EpochRef = { value: undefined };
    const server = createMcpServer({
      state: state2,
      version: "test",
      requestTimeoutMs: 5_000,
      watchPollIntervalMs: 5,
      driveEpoch: () => epoch.value,
      onDriveEpoch: (value) => {
        epoch.value = value;
      },
    });
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { client, epoch };
  }

  it("get_state → 信封解包返回 data 且簿记 epoch；后续 click 自动附 epoch", async () => {
    const { client, epoch } = await connectDrive(state);
    const first = client.callTool({ name: "get_state", arguments: {} });
    const seen1 = await serveNext(state, {
      ok: true,
      data: { elementTreeText: "[0] btn", currentTargetId: "T1" },
      epoch: 7,
    });
    void seen1;
    const result = await first;
    expect(textOf(result)).toEqual({ elementTreeText: "[0] btn", currentTargetId: "T1" });
    expect(epoch.value).toBe(7);

    const second = client.callTool({ name: "click", arguments: { index: 3 } });
    // 领取 drive 命令：locator 动词已自动附 epoch=7（调用方未传）
    const pollResult = await state.poll(EXT_AUTH, new AbortController().signal);
    const drive = pollResult.requests[0];
    expect(drive.method).toBe("drive");
    expect(drive.params).toMatchObject({ verb: "click", args: { index: 3 }, epoch: 7 });
    state.complete({
      requestId: drive.id,
      ok: true,
      result: { ok: true, data: { isDone: false, denied: false }, epoch: 7 },
      durationMs: 1,
    });
    const clicked = await second;
    expect(textOf(clicked)).toMatchObject({ isDone: false });
  });

  it("locator 无簿记 → 本地快速失败 INDEX_REQUIRES_STATE（不入队）", async () => {
    const fresh = makeState();
    await pairFresh(fresh);
    const { client } = await connectDrive(fresh);
    const result = await client.callTool({ name: "click", arguments: { index: 1 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ code: "INDEX_REQUIRES_STATE" });
    expect(fresh.status().queueDepth).toBe(0);
  });

  it("扩展侧领域错信封 → isError + code 透传，epoch 仍簿记（自动愈合面）", async () => {
    const { client, epoch } = await connectDrive(state);
    epoch.value = 1;
    const call = client.callTool({ name: "click", arguments: { index: 1 } });
    await serveNext(state, {
      ok: false,
      error: { code: "EPOCH_STALE", message: "Session rebuilt (epoch 2 now...)" },
      epoch: 2,
    });
    const result = await call;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ code: "EPOCH_STALE" });
    expect(epoch.value).toBe(2);
  });

  it("camel 入参 → snake 派发；未知参数拒绝且不入队", async () => {
    const { client } = await connectDrive(state);
    // evaluate 非 locator——不带 epoch 键，完整断言 params 形状；顺带覆盖三个 camel 参数
    const call = client.callTool({
      name: "evaluate",
      arguments: { code: "1+1", awaitPromise: false, timeoutMs: 500 },
    });
    const pollResult = await state.poll(EXT_AUTH, new AbortController().signal);
    const drive = pollResult.requests[0];
    if (drive === undefined) throw new Error("drive command not enqueued");
    expect(drive.params).toEqual({
      verb: "evaluate",
      args: { code: "1+1", await_promise: false, timeout_ms: 500 },
    });
    state.complete({
      requestId: drive.id,
      ok: true,
      result: { ok: true, data: { isDone: false }, epoch: 3 },
      durationMs: 1,
    });
    expect(textOf(await call)).toEqual({ isDone: false });

    const bad = await client.callTool({ name: "click", arguments: { who: 1, index: 1 } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatchObject({ code: "INVALID_ARGUMENTS" });
  });

  it("session_stop：命令往返 + epoch 簿记", async () => {
    const { client, epoch } = await connectDrive(state);
    const call = client.callTool({ name: "session_stop", arguments: {} });
    await serveNext(state, { stopped: true, epoch: 9 });
    const result = await call;
    expect(textOf(result)).toEqual({ stopped: true, epoch: 9 });
    expect(epoch.value).toBe(9);
  });
});
