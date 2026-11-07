// cli 纯函数 + main 壳契约（issue #25 M1）：stdin 优先解析序 / --json 输出纪律
// （stdout 恰一个 JSON、过程日志走 stderr）/ 退出码 0-1-2。run 注入 fake（离线）；
// 投影用真 AgentHistoryList 构造。

import { ActionResult, AgentHistory, AgentHistoryList } from "@tw/core";
import { describe, expect, test, vi } from "vitest";
import {
  exitCodeOf,
  type MainDeps,
  main,
  parseCliArgs,
  projectRunJson,
  type RunAgentOptions,
  type RunJson,
  renderHumanResult,
  resolveTaskText,
  USAGE,
} from "../src/index.js";

const step = (
  stepNumber: number,
  result: ActionResult[],
  stateSummary: Record<string, unknown> | null = null,
): AgentHistory =>
  new AgentHistory({
    stepNumber,
    modelOutput: { nextGoal: "g", evaluation: "e", memory: "m" },
    result,
    stateSummary,
  });

/** done 且成功（带附件与 url） */
const historyDone = (): AgentHistoryList =>
  new AgentHistoryList({
    history: [
      step(1, [new ActionResult({ error: "中间一步失败" })], { url: "https://a.example" }),
      step(
        2,
        [
          new ActionResult({
            isDone: true,
            success: true,
            extractedContent: "查到了",
            attachments: ["out.csv"],
          }),
        ],
        { url: "https://b.example", title: "结果页" },
      ),
    ],
  });

/** done 但失败（末步 success=false 带错误） */
const historyFailed = (): AgentHistoryList =>
  new AgentHistoryList({
    history: [step(1, [new ActionResult({ isDone: true, success: false, error: "没找到" })])],
  });

/** 未 done（stopReason 非空形态） */
const historyNotDone = (): AgentHistoryList =>
  new AgentHistoryList({
    history: [step(1, [new ActionResult({ error: "boom" })], { url: "https://x" })],
    stopReason: "max_steps",
  });

describe("parseCliArgs", () => {
  test("run + 位置参数拼接 + 全旗标", () => {
    const r = parseCliArgs(["run", "打开", "example.com", "--json", "--max-steps", "5"]);
    expect(r).toEqual({
      ok: true,
      args: {
        task: "打开 example.com",
        json: true,
        taskFile: null,
        maxSteps: 5,
        allowedWrite: null,
        allowedRead: null,
        allowedUpload: null,
        help: false,
        version: false,
      },
    });
  });

  test("白名单旗标可重复收集；空串条目剔除；未设为 null", () => {
    const r = parseCliArgs([
      "run",
      "--allow-write",
      "D:/out",
      "--allow-write",
      "D:/tmp",
      "--allow-upload",
      "",
      "--allow-upload",
      "D:/video.mp4",
    ]);
    expect(r.ok && r.args.allowedWrite).toEqual(["D:/out", "D:/tmp"]);
    expect(r.ok && r.args.allowedUpload).toEqual(["D:/video.mp4"]); // 空串条目被剔除
    expect(r.ok && r.args.allowedRead).toBeNull();
  });

  test("help/version 无需子命令即生效", () => {
    const h = parseCliArgs(["--help"]);
    expect(h.ok && h.args.help).toBe(true);
    const v = parseCliArgs(["-v"]);
    expect(v.ok && v.args.version).toBe(true);
  });

  test("缺子命令 / 未知子命令 → 用法错", () => {
    expect(parseCliArgs([])).toMatchObject({ ok: false });
    expect(parseCliArgs(["--json"])).toMatchObject({ ok: false });
    const fly = parseCliArgs(["fly", "x"]);
    expect(fly.ok).toBe(false);
    expect(!fly.ok && fly.message).toContain("未知子命令");
  });

  test("未知旗标 → 参数错误；--max-steps 非正整数 → 参数错误", () => {
    expect(parseCliArgs(["run", "--nope"]).ok).toBe(false);
    const zero = parseCliArgs(["run", "--max-steps", "0"]);
    expect(!zero.ok && zero.message).toContain("非法");
    expect(parseCliArgs(["run", "--max-steps", "abc"]).ok).toBe(false);
    expect(parseCliArgs(["run", "--max-steps", "1.5"]).ok).toBe(false);
  });

  test("空 --task-file 等价未提供；缺位置参数 task=null", () => {
    const r = parseCliArgs(["run", "--task-file", ""]);
    expect(r.ok && r.args.taskFile).toBeNull();
    expect(r.ok && r.args.task).toBeNull();
  });
});

describe("resolveTaskText（stdin 优先序，已拍板）", () => {
  test("task-file > stdin > argv", () => {
    expect(resolveTaskText({ taskFileContent: "f", stdinText: "s", argvTask: "a" })).toEqual({
      ok: true,
      task: "f",
      source: "task-file",
    });
    expect(resolveTaskText({ taskFileContent: null, stdinText: "s", argvTask: "a" })).toEqual({
      ok: true,
      task: "s",
      source: "stdin",
    });
    expect(resolveTaskText({ taskFileContent: null, stdinText: null, argvTask: "a" })).toEqual({
      ok: true,
      task: "a",
      source: "argv",
    });
  });

  test("stdin 尾换行 trim；空白 stdin 回落到 argv", () => {
    expect(resolveTaskText({ taskFileContent: null, stdinText: "任务\n", argvTask: null })).toEqual(
      {
        ok: true,
        task: "任务",
        source: "stdin",
      },
    );
    expect(
      resolveTaskText({ taskFileContent: null, stdinText: "  \n", argvTask: "argv 任务" }),
    ).toEqual({
      ok: true,
      task: "argv 任务",
      source: "argv",
    });
  });

  test("全空/全空白 → ok:false", () => {
    expect(resolveTaskText({ taskFileContent: null, stdinText: null, argvTask: null }).ok).toBe(
      false,
    );
    expect(resolveTaskText({ taskFileContent: "  ", stdinText: " ", argvTask: " " }).ok).toBe(
      false,
    );
  });
});

describe("projectRunJson（camelCase 投影）", () => {
  test("done 成功：全字段（errors 收集 / attachments 去重 / lastUrl 取末个非空 url）", () => {
    const json = projectRunJson(historyDone());
    expect(json).toEqual({
      isDone: true,
      isSuccessful: true,
      finalResult: "查到了",
      stopReason: null,
      nSteps: 2,
      finalizeDegradedSteps: 0,
      attachments: ["out.csv"],
      errors: ["中间一步失败"],
      lastUrl: "https://b.example",
    } satisfies RunJson);
  });

  test("attachments 去重保序；done 失败与未 done 形态", () => {
    const dup = new AgentHistoryList({
      history: [
        step(1, [
          new ActionResult({
            isDone: true,
            success: true,
            extractedContent: "r",
            attachments: ["a", "b", "a"],
          }),
        ]),
      ],
    });
    expect(projectRunJson(dup).attachments).toEqual(["a", "b"]);
    const failed = projectRunJson(historyFailed());
    expect(failed.isDone && failed.isSuccessful).toBe(false);
    expect(failed.errors).toEqual(["没找到"]);
    const notDone = projectRunJson(historyNotDone());
    expect(notDone.stopReason).toBe("max_steps");
    expect(notDone.finalResult).toBeNull();
  });
});

describe("exitCodeOf / renderHumanResult", () => {
  test("0=done 且成功；1=其余", () => {
    expect(exitCodeOf(historyDone())).toBe(0);
    expect(exitCodeOf(historyFailed())).toBe(1);
    expect(exitCodeOf(historyNotDone())).toBe(1);
  });

  test("人类模式终态行（对齐 examples 文案）", () => {
    expect(renderHumanResult(historyDone())).toBe("Task completed: 查到了");
    expect(renderHumanResult(historyFailed())).toBe("Task failed: 没找到");
    expect(renderHumanResult(historyNotDone())).toBe("Task did not complete (max_steps)");
  });
});

describe("main（壳契约）", () => {
  const ttyStdin = { isTTY: true, text: () => Promise.resolve("") };
  const pipedStdin = (text: string) => ({ isTTY: false, text: () => Promise.resolve(text) });

  interface Channels {
    out: string[];
    err: string[];
  }

  const channels = (): Channels => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err };
  };

  const runCapturing =
    (history: () => AgentHistoryList, calls: RunAgentOptions[]) =>
    async (opts: RunAgentOptions) => {
      calls.push(opts);
      return history();
    };

  const depsOf = (ch: Channels, argv: string[], over: Partial<MainDeps> = {}): MainDeps => ({
    argv,
    out: (l) => ch.out.push(l),
    err: (l) => ch.err.push(l),
    version: "9.9.9",
    ...over,
  });

  test("--json：stdout 恰一个可解析 JSON；过程日志经注入的 log 走 stderr；exit 0", async () => {
    const ch = channels();
    const calls: RunAgentOptions[] = [];
    const code = await main(
      depsOf(ch, ["run", "--json"], {
        stdin: pipedStdin("帮我查东西\n"),
        run: runCapturing(historyDone, calls),
      }),
    );
    expect(code).toBe(0);
    expect(ch.out).toHaveLength(1);
    const json = JSON.parse(ch.out[0]) as RunJson;
    expect(json.finalResult).toBe("查到了");
    expect(json.lastUrl).toBe("https://b.example");
    // 注入的 log 是 stderr 通道——runAgent 的过程日志全落 stderr
    expect(typeof calls[0].log).toBe("function");
    calls[0].log?.("[browser] 页面就绪");
    expect(ch.err).toContain("[browser] 页面就绪");
    expect(calls[0].task).toBe("帮我查东西"); // trim 后
  });

  test("人类模式：log 不注入（runAgent 缺省 stdout）；终态行 + exit 0", async () => {
    const ch = channels();
    const calls: RunAgentOptions[] = [];
    const code = await main(
      depsOf(ch, ["run"], {
        stdin: pipedStdin("任务"),
        run: runCapturing(historyDone, calls),
      }),
    );
    expect(code).toBe(0);
    expect(ch.out).toContain("Task completed: 查到了");
    expect(calls[0].log).toBeUndefined();
  });

  test("stdin 优先于 argv（已拍板）；--max-steps 透传 overrides", async () => {
    const ch = channels();
    const calls: RunAgentOptions[] = [];
    await main(
      depsOf(ch, ["run", "from argv", "--max-steps", "5"], {
        stdin: pipedStdin("from stdin"),
        run: runCapturing(historyDone, calls),
      }),
    );
    expect(calls[0].task).toBe("from stdin");
    expect(calls[0].overrides).toEqual({ agent: { maxSteps: 5 } });
    // 白名单旗标 → overrides.agent.*Paths（护栏透传）
    const chW = channels();
    const callsW: RunAgentOptions[] = [];
    await main(
      depsOf(chW, ["run", "--allow-write", "D:/out", "--allow-upload", "D:/v.mp4"], {
        stdin: pipedStdin("t"),
        run: runCapturing(historyDone, callsW),
      }),
    );
    expect(callsW[0].overrides).toEqual({
      agent: { allowedWritePaths: ["D:/out"], allowedUploadPaths: ["D:/v.mp4"] },
    });
    // 无旗标时 overrides 缺省不传
    const calls2: RunAgentOptions[] = [];
    await main(
      depsOf(ch, ["run"], { stdin: pipedStdin("t"), run: runCapturing(historyDone, calls2) }),
    );
    expect(calls2[0].overrides).toBeUndefined();
  });

  test("--task-file 覆盖 stdin；读取失败 exit 2", async () => {
    const ch = channels();
    const calls: RunAgentOptions[] = [];
    const readFile = vi.fn(async () => " from file \n");
    await main(
      depsOf(ch, ["run", "--task-file", "task.txt"], {
        stdin: pipedStdin("stdin 任务"),
        readFile,
        run: runCapturing(historyDone, calls),
      }),
    );
    expect(readFile).toHaveBeenCalledWith("task.txt");
    expect(calls[0].task).toBe("from file");

    const ch2 = channels();
    const code = await main(
      depsOf(ch2, ["run", "--task-file", "missing.txt"], {
        stdin: ttyStdin,
        readFile: async () => {
          throw new Error("ENOENT");
        },
        run: runCapturing(historyDone, []),
      }),
    );
    expect(code).toBe(2);
    expect(ch2.err[0]).toContain("--task-file 读取失败");
  });

  test("无任务文本（TTY 且无位置参数）→ exit 2 + 用法；run 不被调用", async () => {
    const ch = channels();
    const run = vi.fn(runCapturing(historyDone, []));
    const code = await main(depsOf(ch, ["run"], { stdin: ttyStdin, run }));
    expect(code).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(ch.err.some((l) => l.includes("未提供任务文本"))).toBe(true);
    expect(ch.err).toContain(USAGE);
    // 空白管道输入 + 无 argv 同为 exit 2
    const ch2 = channels();
    expect(await main(depsOf(ch2, ["run"], { stdin: pipedStdin("   "), run }))).toBe(2);
  });

  test("--task-file 就绪时不读 stdin（spawn 永不关闭的 stdin 管道不得挂起）；stdin 读失败 → exit 2", async () => {
    // 挂起防护（评审轮 1 [1]）：text() 若被调用即计一次——task-file 通道就绪时必须为 0
    let stdinReads = 0;
    const ch = channels();
    await main(
      depsOf(ch, ["run", "--task-file", "t.txt"], {
        stdin: {
          isTTY: false,
          text: () => {
            stdinReads += 1;
            return Promise.resolve("s");
          },
        },
        readFile: async () => "任务",
        run: runCapturing(historyDone, []),
      }),
    );
    expect(stdinReads).toBe(0);
    // 无 task-file 时 stdin 正常读取（对照组，防修过头）
    const chCtl = channels();
    await main(
      depsOf(chCtl, ["run"], {
        stdin: {
          isTTY: false,
          text: () => {
            stdinReads += 1;
            return Promise.resolve("s");
          },
        },
        run: runCapturing(historyDone, []),
      }),
    );
    expect(stdinReads).toBe(1);

    // stdin error 事件 → 前置失败收口 exit 2（评审轮 1 [2]），run 不被调用
    const ch2 = channels();
    const run = vi.fn(runCapturing(historyDone, []));
    const code = await main(
      depsOf(ch2, ["run"], {
        stdin: {
          isTTY: false,
          text: () => Promise.reject(new Error("EPIPE")),
        },
        run,
      }),
    );
    expect(code).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(ch2.err[0]).toContain("stdin 读取失败");
  });

  test("run 抛错（缺 key / 连不上 Chrome 文案）→ stderr + exit 2；--json 下 stdout 保持纯净", async () => {
    const ch = channels();
    const run = async () => {
      throw new Error("Error: Set ZHIPU_API_KEY environment variable");
    };
    const code = await main(depsOf(ch, ["run", "--json"], { stdin: pipedStdin("t"), run }));
    expect(code).toBe(2);
    expect(ch.out).toHaveLength(0);
    expect(ch.err[0]).toContain("ZHIPU_API_KEY");
  });

  test("done 失败 / 未 done → exit 1（json 与人类模式各证一路）", async () => {
    const ch = channels();
    expect(
      await main(
        depsOf(ch, ["run", "--json"], {
          stdin: pipedStdin("t"),
          run: runCapturing(historyFailed, []),
        }),
      ),
    ).toBe(1);
    expect(JSON.parse(ch.out[0]).isSuccessful).toBe(false);
    const ch2 = channels();
    expect(
      await main(
        depsOf(ch2, ["run"], { stdin: pipedStdin("t"), run: runCapturing(historyNotDone, []) }),
      ),
    ).toBe(1);
    expect(ch2.out[0]).toBe("Task did not complete (max_steps)");
  });

  test("--help / --version：stdout 输出、exit 0、run 不被调用", async () => {
    const ch = channels();
    const run = vi.fn(runCapturing(historyDone, []));
    expect(await main(depsOf(ch, ["--help"], { stdin: ttyStdin, run }))).toBe(0);
    expect(ch.out[0]).toBe(USAGE);
    const ch2 = channels();
    expect(await main(depsOf(ch2, ["--version"], { stdin: ttyStdin, run }))).toBe(0);
    expect(ch2.out).toEqual(["9.9.9"]);
    expect(run).not.toHaveBeenCalled();
  });

  test("参数错（未知旗标）→ exit 2 + 用法", async () => {
    const ch = channels();
    const code = await main(
      depsOf(ch, ["run", "--nope"], { stdin: pipedStdin("t"), run: runCapturing(historyDone, []) }),
    );
    expect(code).toBe(2);
    expect(ch.err[0]).toContain("参数错误");
    expect(ch.out).toHaveLength(0);
  });
});
