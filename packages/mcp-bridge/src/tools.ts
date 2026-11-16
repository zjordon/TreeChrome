// MCP 工具面（issue #31 M1 P2 + #32 M2 P3）：任务级 5 工具（tc_bridge_status /
// run_task / get_snapshot / watch_task / stop_run）+ 会话级直驱 16 件（15 动词 +
// session_stop，DRIVE_TOOLS 由 core 规格生成）。命令走私线到扩展（未配对快速
// 失败）；watch 是 get_snapshot 的桥侧编排（watch.ts）；直驱的 locator 动词由
// 桥侧 epoch 簿记自动附代次（调用方零新参数）。结果恒单 text JSON；错误信封
// 带 code。移植 qz tools.mjs 骨架（Apache-2.0）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { findDriveVerb, validateDriveParams } from "@tw/core";
import type {
  BridgeCommandMethod,
  BridgeDriveResult,
  BridgeRunSnapshot,
  BridgeSessionStopResult,
} from "@tw/protocol";
import { type BridgeState, BridgeStateError, DEFAULT_COMMAND_TIMEOUT_MS } from "./state.js";
import { DRIVE_TOOLS } from "./verbs.js";
import { WatchTimeoutError, type WatchUpdate, watchTask } from "./watch.js";

export interface BridgeToolDeps {
  state: BridgeState;
  version: string;
  /** 单命令（受理/快照/停跑）的私线往返预算（缺省 state 层 180s） */
  requestTimeoutMs?: number;
  /** watch 轮询间隔（测试注小值） */
  watchPollIntervalMs?: number;
  /** 会话级直驱 epoch 簿记（#32 决策点 ①：server 按 MCP 会话接线；缺省无簿记） */
  driveEpoch?: () => number | undefined;
  onDriveEpoch?: (epoch: number) => void;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export const BRIDGE_TOOLS: ToolSpec[] = [
  {
    name: "tc_bridge_status",
    description: "桥自身状态：配对/连接/队列深度（不触浏览器）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_task",
    description:
      "委派一段自然语言任务给扩展内浏览器 agent（日常 Chrome，登录态可用）。异步受理：返回 {accepted, runId}；用 get_snapshot/watch_task 观察进度。已在跑 → busy 错误。",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "任务全文" } },
      required: ["task"],
    },
  },
  {
    name: "get_snapshot",
    description: "当前 run 的只读快照：状态/终态字段（camelCase）/时间线尾部摘要。从不重发任务。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "watch_task",
    description:
      "挂起观察至终态并返回完整快照。stream=true 时逐事件发 progress 通知。只读边界：超时/取消只结束本地观察，浏览器内任务继续。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        waitTimeoutSeconds: { type: "number", description: "缺省无截止" },
        stream: { type: "boolean" },
      },
    },
  },
  {
    name: "stop_run",
    description: "停止当前 run。",
    inputSchema: { type: "object", properties: {} },
  },
];

/** 工具错误信封（content text JSON 的形状） */
export function toolErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof WatchTimeoutError) {
    return { code: "TIMEOUT", message: error.message, lastSnapshot: error.lastSnapshot };
  }
  if (error instanceof BridgeStateError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "TOOL_EXECUTION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function executeTool(
  deps: BridgeToolDeps,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate?: (update: WatchUpdate) => void,
): Promise<unknown> {
  const enqueue = (
    method: BridgeCommandMethod,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> =>
    deps.state.enqueue(method, params, { timeoutMs: timeoutMs ?? deps.requestTimeoutMs, signal });
  const requirePaired = (): void => {
    if (!deps.state.paired) {
      throw new BridgeStateError(
        "BRIDGE_PAIRING_REQUIRED",
        "No extension paired. Run tc-bridge connect and open the printed URL in this browser.",
      );
    }
  };

  if (name === "tc_bridge_status") return deps.state.status();
  if (name === "stop_run") {
    requirePaired();
    return await enqueue("stop_run", {});
  }
  if (name === "run_task") {
    requirePaired();
    const task = args.task;
    if (typeof task !== "string" || task.trim() === "") {
      throw new BridgeStateError("INVALID_ARGUMENTS", "run_task requires a non-empty task string.");
    }
    return await enqueue("run_task", { task });
  }
  if (name === "get_snapshot") {
    requirePaired();
    return await enqueue("get_snapshot", {});
  }
  if (name === "watch_task") {
    requirePaired();
    return await watchTask({
      runId: typeof args.runId === "string" && args.runId !== "" ? args.runId : undefined,
      waitTimeoutSeconds:
        typeof args.waitTimeoutSeconds === "number" ? args.waitTimeoutSeconds : null,
      signal,
      // watch 的 signal 即工具调用 signal——快照请求与观察同生共死；budgetMs 是
      // 截止剩余量（watch.ts 逐拍传入）——只收紧不放宽：大于单命令预算时仍守
      // 上限，扩展失联时错误按预算暴露而非拖到截止全长（轮 2 实录）
      getSnapshot: (_signal, budgetMs) => {
        const cap = deps.requestTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
        const timeoutMs = budgetMs === undefined ? undefined : Math.min(budgetMs, cap);
        return enqueue("get_snapshot", {}, timeoutMs) as Promise<BridgeRunSnapshot>;
      },
      onUpdate: args.stream === true ? onUpdate : undefined,
      pollIntervalMs: deps.watchPollIntervalMs,
    });
  }
  if (DRIVE_TOOLS.some((tool) => tool.name === name)) {
    requirePaired();
    if (name === "session_stop") {
      const envelope = (await enqueue("session_stop", {})) as BridgeSessionStopResult;
      if (typeof envelope?.epoch === "number") deps.onDriveEpoch?.(envelope.epoch);
      return envelope;
    }
    const spec = findDriveVerb(name);
    if (spec === null) {
      throw new BridgeStateError("INVALID_ARGUMENTS", `Unknown tool: ${name}.`);
    }
    // camelCase 入参 → snake_case core 参数名；未知参数拒绝（typed 面不吞错）
    const snake: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      const snakeKey = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      if (!spec.params.some((param) => param.name === snakeKey)) {
        throw new BridgeStateError(
          "INVALID_ARGUMENTS",
          `drive verb ${name}: unknown argument ${key}.`,
        );
      }
      snake[snakeKey] = value;
    }
    const validated = validateDriveParams(spec, snake);
    if (!validated.ok) {
      throw new BridgeStateError("INVALID_ARGUMENTS", validated.message);
    }
    // locator 动词附桥侧簿记的代次（决策点 ①：无观察记录 → 本地快速失败）
    const epoch = spec.locator === true ? deps.driveEpoch?.() : undefined;
    if (spec.locator === true && epoch === undefined) {
      throw new BridgeStateError(
        "INDEX_REQUIRES_STATE",
        "Run get_state first — locator actions need fresh indexes (epoch bookkeeping).",
      );
    }
    const envelope = (await enqueue("drive", {
      verb: name,
      args: validated.params,
      ...(spec.locator === true ? { epoch } : {}),
    })) as BridgeDriveResult;
    if (isRecord(envelope) && typeof envelope.epoch === "number") {
      deps.onDriveEpoch?.(envelope.epoch);
    }
    if (!isRecord(envelope) || envelope.ok !== true) {
      // 扩展侧领域错信封（EPOCH_STALE/SIDEPANEL_REQUIRED/BUSY/…）转 MCP 错误信封
      const error = isRecord(envelope) && isRecord(envelope.error) ? envelope.error : {};
      throw new BridgeStateError(
        typeof error.code === "string" ? error.code : "DRIVE_FAILED",
        typeof error.message === "string" ? error.message : "Drive command failed.",
      );
    }
    return envelope.data ?? {};
  }
  throw new BridgeStateError("INVALID_ARGUMENTS", `Unknown tool: ${name}.`);
}

export function createMcpServer(deps: BridgeToolDeps): Server {
  const server = new Server(
    { name: "tc-bridge", version: deps.version },
    {
      capabilities: { tools: {} },
      instructions:
        "TreeChrome 扩展桥：run_task 委派任务到日常 Chrome（扩展内 agent 循环执行，异步受理返回 runId）；" +
        "get_snapshot 读进度；watch_task 挂起至终态（stream=true 逐事件 progress）；stop_run 停跑。" +
        "会话级直驱（#32）：get_state 取元素树后用 click/input_text 等逐步驱动（写类动作需侧边栏" +
        "在场；索引过期返回 EPOCH_STALE——重跑 get_state 即恢复）；session_stop 结束直驱会话。" +
        "观察只读——超时/取消不影响浏览器内任务。",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...BRIDGE_TOOLS, ...DRIVE_TOOLS].map((tool) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = (request.params._meta as { progressToken?: unknown } | undefined)
      ?.progressToken;
    let progress = 0;
    const onUpdate =
      progressToken === undefined
        ? undefined
        : (update: WatchUpdate): void => {
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken: progressToken as string | number,
                  progress: ++progress,
                  message: update.text,
                },
              })
              .catch(() => {});
          };
    try {
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      const result = await executeTool(deps, request.params.name, args, extra.signal, onUpdate);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(toolErrorPayload(error)) }],
      };
    }
  });
  return server;
}
