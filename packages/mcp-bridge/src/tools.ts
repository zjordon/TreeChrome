// MCP 工具面（issue #31 M1 P2）：5 工具——tc_bridge_status / run_task / get_snapshot /
// watch_task / stop_run。命令三件经 state.enqueue 走私线到扩展（未配对快速失败）；
// watch 是 get_snapshot 的桥侧编排（watch.ts）。结果恒单 text JSON；错误信封带 code。
// 移植 qz tools.mjs 骨架（Apache-2.0），裁剪为单 run 形态（无 drive 目录/无资源工具）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeCommandMethod, BridgeRunSnapshot } from "@tw/protocol";
import { type BridgeState, BridgeStateError } from "./state.js";
import { WatchTimeoutError, type WatchUpdate, watchTask } from "./watch.js";

export interface BridgeToolDeps {
  state: BridgeState;
  version: string;
  /** 单命令（受理/快照/停跑）的私线往返预算（缺省 state 层 180s） */
  requestTimeoutMs?: number;
  /** watch 轮询间隔（测试注小值） */
  watchPollIntervalMs?: number;
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
      // 截止剩余量（watch.ts 逐拍传入），未给则用单命令缺省预算
      getSnapshot: (_signal, budgetMs) =>
        enqueue("get_snapshot", {}, budgetMs) as Promise<BridgeRunSnapshot>,
      onUpdate: args.stream === true ? onUpdate : undefined,
      pollIntervalMs: deps.watchPollIntervalMs,
    });
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
        "观察只读——超时/取消不影响浏览器内任务。",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BRIDGE_TOOLS.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } })),
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
