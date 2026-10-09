// run-manager 状态机单测（m5/04 §9）：start（卡片缺失/无 tab/空任务/成功链）→
// journal running → agent.run 完 → done + cleanup（keepalive/attachments/监听器）；
// stop → interrupted（用户中断文案）；tab onRemoved → interrupted；单飞互斥拒绝；
// pause/resume 直通；recoverInterrupted（非终态 → interrupted；终态不动）；
// handleUiMessage 分发——assemble 覆盖缝注入 stub agent（不跑真 Agent）。

import { AgentHistoryList } from "@tw/core";
import type { RunJournalSnapshot, SwToUiMessage } from "@tw/protocol";
import { describe, expect, it } from "vitest";
import { AttachmentRegistry } from "../src/host/attachment-registry.js";
import type { KeepaliveController } from "../src/host/keepalive.js";
import type { DirHandleLike } from "../src/host/opfs-fs.js";
import { OpfsFs } from "../src/host/opfs-fs.js";
import { parseExtensionSettings, type SettingsStore } from "../src/host/settings-store.js";
import { RunJournal } from "../src/runtime/journal.js";
import { RunManager, type RunManagerDeps } from "../src/runtime/run-manager.js";

const SETTINGS = parseExtensionSettings({
  providerCards: [
    {
      name: "main",
      protocol: "anthropic-messages",
      baseUrl: "https://api",
      apiKey: "k",
      model: "m",
      maxTokens: 8,
    },
  ],
  activeCard: "main",
});

/** 受控 stub agent（run 挂起直到测试放行） */
function stubAgent() {
  let resolveRun: (h: AgentHistoryList) => void = () => {};
  const calls: string[] = [];
  const runPromise = new Promise<AgentHistoryList>((resolve) => {
    resolveRun = resolve;
  });
  return {
    calls,
    finish: (h: AgentHistoryList) => resolveRun(h),
    agent: {
      run: () => {
        calls.push("run");
        return runPromise;
      },
      stop: () => void calls.push("stop"),
      pause: () => void calls.push("pause"),
      resume: () => void calls.push("resume"),
    },
  };
}

function makeDeps(
  options: {
    settings?: ReturnType<typeof parseExtensionSettings>;
    tabId?: number;
    /** assemble 覆盖（抛错/连接断类场景注入特殊 stub） */
    agent?: ReturnType<typeof stubAgent> | { run: () => Promise<AgentHistoryList> };
    /** tabsQuery 闸门（starting 互斥竞态测试：挂住首查直到放行） */
    queryGate?: Promise<void>;
    /** 装配时捕获 policyInteraction（桥 pending 收口测试） */
    captureInteraction?: (i: unknown) => void;
  } = {},
) {
  const journal = new RunJournal({ now: () => 1234 });
  const attachments = new AttachmentRegistry();
  const broadcasts: SwToUiMessage[] = [];
  const keepalive = {
    onStartRun: () => void 0,
    onEndRun: () => void 0,
  } as unknown as KeepaliveController;
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const stub = stubAgent();
  const browserStops: number[] = [];
  const noRoot: DirHandleLike = {
    async getDirectoryHandle() {
      throw new Error("unused");
    },
    async getFileHandle() {
      throw new Error("unused");
    },
  };
  // stub 装配：真 assembleRun 的无卡拒绝路径在 runtime-assemble.test 覆盖——此处
  // 复刻抛错（settings 无卡时），其余返回受控 stub
  const assembleOverride = (() => {
    if (options.settings !== undefined && options.settings.providerCards.length === 0) {
      return (() => {
        throw new Error("No active provider card — 请先在设置页配置 LLM 卡片");
      }) as never;
    }
    const agent = options.agent ?? stub.agent;
    return ((_input: unknown, deps: { policyInteraction: unknown }) => {
      options.captureInteraction?.(deps.policyInteraction);
      return {
        agent,
        browser: { stop: async () => void browserStops.push(1) },
        bus: { subscribe: () => {}, close: () => void 0 } as never,
        taskText: "task text",
      };
    }) as never;
  })();
  const deps: RunManagerDeps = {
    settingsStore: {
      load: async () => options.settings ?? SETTINGS,
    } as unknown as SettingsStore,
    attachments,
    journal,
    fs: new OpfsFs(async () => noRoot),
    keepalive,
    tabsQuery: {
      query: async () => {
        if (options.queryGate !== undefined) await options.queryGate;
        return [{ id: "tabId" in options ? options.tabId : 77 }];
      },
    },
    tabsOnRemoved: {
      addListener: (cb) => void tabRemovedListeners.push(cb),
      removeListener: (cb) => {
        const i = tabRemovedListeners.indexOf(cb);
        if (i >= 0) tabRemovedListeners.splice(i, 1);
      },
    },
    transportFactoryFor: () => async () => ({}) as never,
    makeSkillSource: () => ({
      loadHostSkill: async () => null,
      taskCatalog: async () => [],
      taskCardText: async () => "",
    }),
    grantStore: null,
    broadcast: (m) => void broadcasts.push(m),
    hasPorts: () => true,
    assemble: assembleOverride,
    newRunId: () => "run_test",
    now: () => 1234,
    log: () => {},
  };
  const manager = new RunManager(deps);
  return { manager, journal, attachments, broadcasts, tabRemovedListeners, stub, browserStops };
}

const doneHistory = () =>
  new AgentHistoryList({
    history: [
      {
        step: 1,
        result: [{ isDone: true, success: true, extractedContent: "全部完成" } as never],
      } as never,
    ],
  });

describe("RunManager 状态机", () => {
  it("start 拒绝面：空任务 / 无活动 tab / 无卡片 / 单飞互斥", async () => {
    const m1 = makeDeps();
    expect(await m1.manager.control("start", "  ")).toMatchObject({
      ok: false,
      error: "任务不能为空",
    });
    const noTab = makeDeps({ tabId: undefined });
    expect(await noTab.manager.control("start", "t")).toMatchObject({
      ok: false,
      error: "找不到活动标签页",
    });
    const noCard = makeDeps({ settings: parseExtensionSettings({}) });
    expect(await noCard.manager.control("start", "t")).toMatchObject({
      ok: false,
      error: "No active provider card — 请先在设置页配置 LLM 卡片",
    });
    const busy = makeDeps();
    expect(await busy.manager.control("start", "t")).toMatchObject({ ok: true });
    expect(await busy.manager.control("start", "t2")).toMatchObject({
      ok: false,
      error: "请先停止当前任务",
    });
    busy.stub.finish(new AgentHistoryList());
    await busy.manager.control("start", "再次起跑"); // 收口后可再跑
  });

  it("成功链：journal running（runId/tabId/task）→ agent.run 完成 → done + 收口广播", async () => {
    const m = makeDeps();
    expect(await m.manager.control("start", "做")).toEqual({ ok: true });
    expect(m.journal.current()).toMatchObject({
      runId: "run_test",
      tabId: 77,
      status: "running",
      task: "task text",
    });
    m.stub.finish(doneHistory());
    await new Promise((r) => setTimeout(r, 10)); // drive() 微任务收口
    expect(m.journal.current()).toMatchObject({
      status: "done",
      finalResult: "全部完成",
      isDone: true,
      isSuccessful: true,
      endedAt: 1234,
    });
    // 收口面：browser stop、tab 监听器移除、attachments 清表、终态快照广播
    expect(m.browserStops).toHaveLength(1);
    expect(m.tabRemovedListeners).toHaveLength(0);
    const last = m.broadcasts.at(-1);
    expect(last).toMatchObject({ kind: "journal-snapshot" });
    // 清表广播（评审轮 1 [16]）：add/remove 均广播，clear 不得静默
    expect(m.broadcasts.filter((b) => b.kind === "attachments")).toEqual([
      { kind: "attachments", items: [] },
    ]);
    expect(m.manager.busy).toBe(false);
  });

  it("starting 互斥：tabsQuery 挂起期间的并发 start 被拒（判空与置 active 的 await 间隙）", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const m = makeDeps({ queryGate: gate });
    const first = m.manager.control("start", "第一个");
    // 首查仍挂起（this.active 未置）——第二条 start 必须被 starting 标志挡下
    expect(await m.manager.control("start", "第二个")).toMatchObject({
      ok: false,
      error: "请先停止当前任务",
    });
    release();
    expect(await first).toEqual({ ok: true });
    m.stub.finish(new AgentHistoryList());
    await new Promise((r) => setTimeout(r, 10));
    expect(m.journal.current()).toMatchObject({ status: "done" });
    // 互斥释放后可再跑
    expect(await m.manager.control("start", "第三个")).toEqual({ ok: true });
    m.stub.finish(new AgentHistoryList());
  });

  it("stop 收口挂起确认：agent 挂在桥 pending 上 → stop 同步 deny → run 解除挂起", async () => {
    let interaction: {
      requestPermission: (req: {
        capability: "CLICK";
        host: string;
        actionName: string;
        params: Record<string, unknown>;
        tabId: string;
        elementIndex: number;
        elementBbox: { left: number; top: number; width: number; height: number };
        elementXpath: string;
      }) => Promise<string>;
    } | null = null;
    const verdicts: string[] = [];
    const agent = {
      // run 挂在权限卡上（真 PolicyGate 同款路径）——stop 不收口则永久悬挂
      run: async () => {
        if (interaction === null) throw new Error("interaction not captured");
        verdicts.push(
          await interaction.requestPermission({
            capability: "CLICK",
            host: "a.example",
            actionName: "click",
            params: { index: 1 },
            tabId: "T1",
            elementIndex: 1,
            elementBbox: { left: 0, top: 0, width: 8, height: 8 },
            elementXpath: "//button[1]",
          }),
        );
        return new AgentHistoryList();
      },
      stop: () => void 0,
      pause: () => void 0,
      resume: () => void 0,
    };
    const m = makeDeps({ agent, captureInteraction: (i) => (interaction = i as never) });
    expect(await m.manager.control("start", "t")).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 10)); // agent.run 进入 pending
    expect(m.journal.status).toBe("awaiting-permission");
    // 挂起卡可枚举（port-server 重连补发面）
    expect(m.manager.pendingCards()).toMatchObject([{ kind: "permission-request" }]);
    expect(await m.manager.control("stop")).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(m.manager.pendingCards()).toEqual([]); // stop 收口后无挂起卡
    expect(verdicts).toEqual(["deny"]); // pending 被 stop 同步收口（非 300s 兜底）
    expect(m.journal.current()).toMatchObject({ status: "interrupted", lastError: "用户中断" });
  });

  it("stop → agent.stop() + interrupted（用户中断文案，非 error）", async () => {
    const m = makeDeps();
    await m.manager.control("start", "t");
    await m.manager.control("stop");
    expect(m.stub.calls).toContain("stop");
    m.stub.finish(new AgentHistoryList());
    await new Promise((r) => setTimeout(r, 10));
    expect(m.journal.current()).toMatchObject({
      status: "interrupted",
      lastError: "用户中断",
    });
  });

  it("绑定 tab onRemoved → interrupted（绑定标签页被关闭）+ 监听器收口", async () => {
    const m = makeDeps();
    await m.manager.control("start", "t");
    expect(m.tabRemovedListeners).toHaveLength(1);
    for (const cb of [...m.tabRemovedListeners]) cb(77); // 关的是绑定 tab
    for (const cb of [...m.tabRemovedListeners]) cb(99); // 他 tab 不触发
    m.stub.finish(new AgentHistoryList());
    await new Promise((r) => setTimeout(r, 10));
    expect(m.journal.current()).toMatchObject({
      status: "interrupted",
      lastError: "绑定标签页被关闭",
    });
  });

  it("agent.run 抛错 → error 态；连接断类错误 → interrupted", async () => {
    const boom = makeDeps({
      agent: {
        run: () => Promise.reject(new Error("boom")),
        stop: () => void 0,
        pause: () => void 0,
        resume: () => void 0,
      },
    });
    await boom.manager.control("start", "t");
    await new Promise((r) => setTimeout(r, 10));
    expect(boom.journal.current()).toMatchObject({ status: "error", lastError: "boom" });

    const connLost = makeDeps({
      agent: {
        run: () => Promise.reject(new Error("WebSocket connection closed")),
        stop: () => void 0,
        pause: () => void 0,
        resume: () => void 0,
      },
    });
    await connLost.manager.control("start", "t");
    await new Promise((r) => setTimeout(r, 10));
    expect(connLost.journal.current()).toMatchObject({
      status: "interrupted",
      lastError: "WebSocket connection closed",
    });
  });

  it("pause/resume 直通 agent；无活 run 的 control 拒绝", async () => {
    const m = makeDeps();
    expect(await m.manager.control("stop")).toMatchObject({
      ok: false,
      error: "当前没有运行中的任务",
    });
    await m.manager.control("start", "t");
    await m.manager.control("pause");
    await m.manager.control("resume");
    expect(m.stub.calls).toEqual(["run", "pause", "resume"]);
    m.stub.finish(new AgentHistoryList());
  });

  it("handleUiMessage：diag/settings-changed/options no-op；无效附件拒绝；无活 run 的 resolve 忽略；tabsQuery 抛错兜底", async () => {
    const m = makeDeps();
    m.manager.handleUiMessage({ kind: "diag", command: "echo" });
    m.manager.handleUiMessage({ kind: "settings-changed" });
    // options 是 sendMessage 单发应答面——Port 携带时静默忽略
    m.manager.handleUiMessage({ kind: "options", op: "get-settings" });
    // 无效附件（空名）→ 拒绝不广播
    m.manager.handleUiMessage({ kind: "attachment-add", name: "", mimeType: "m", base64: "eA==" });
    expect(m.broadcasts.filter((b) => b.kind === "attachments")).toEqual([]);
    // 无活 run 的确认 resolve——静默
    m.manager.handleUiMessage({ kind: "permission-resolve", token: "t", verdict: "deny" });
    m.manager.handleUiMessage({ kind: "submit-resolve", token: "t", approved: false });
    m.manager.onAllPortsDisconnected();
    // tabsQuery 抛错 → 找不到活动标签页（不炸）
    const broken = makeDeps();
    (broken.manager as unknown as { deps: { tabsQuery: unknown } }).deps.tabsQuery = {
      query: async () => {
        throw new Error("tabs api down");
      },
    };
    expect(await broken.manager.control("start", "t")).toMatchObject({
      ok: false,
      error: "找不到活动标签页",
    });
  });

  it("handleUiMessage：attachment-add/remove 广播回 attachments；ack 进 journal", async () => {
    const m = makeDeps();
    m.journal.begin({ runId: "r", tabId: 1, task: "t", attachments: [] });
    m.journal.record({ eventType: "step_start", step: 1, sessionId: "s" });
    m.manager.handleUiMessage({ kind: "journal-ack", seq: 1 });
    expect(m.journal.current()?.ackedSeq).toBe(1);
    m.manager.handleUiMessage({
      kind: "attachment-add",
      name: "a",
      mimeType: "text/plain",
      base64: btoa("x"),
    });
    const last = m.broadcasts.at(-1);
    expect(last).toMatchObject({
      kind: "attachments",
      items: [{ attachmentId: "att_1", name: "a", size: 1 }],
    });
    m.manager.handleUiMessage({ kind: "attachment-remove", attachmentId: "att_1" });
    expect(m.broadcasts.at(-1)).toMatchObject({ kind: "attachments", items: [] });
  });

  it("recoverInterrupted：非终态 → interrupted（SW 被杀文案）+ 广播；终态/活 run 不动", async () => {
    const m = makeDeps();
    const running: RunJournalSnapshot = {
      runId: "run_old",
      tabId: 5,
      status: "running",
      seq: 3,
      ackedSeq: 0,
      discardedBeforeSeq: 0,
      events: [],
      task: "t",
      startedAt: 1,
      endedAt: null,
      finalResult: null,
      isDone: false,
      isSuccessful: null,
      stepCount: 1,
      lastError: null,
      attachments: [],
    };
    m.manager.recoverInterrupted(running);
    expect(m.journal.current()).toMatchObject({
      status: "interrupted",
      lastError: "Service worker was killed during the run",
      endedAt: 1234,
    });
    expect(m.broadcasts.at(-1)).toMatchObject({ kind: "journal-snapshot" });
    // 终态不动
    m.manager.recoverInterrupted({ ...running, status: "done" });
    expect(m.journal.current()?.status).toBe("interrupted"); // 保持上次恢复态
    // 活 run 不动
    await m.manager.control("start", "t");
    m.manager.recoverInterrupted({ ...running, runId: "another", status: "running" });
    expect(m.journal.current()?.runId).toBe("run_test");
    m.stub.finish(new AgentHistoryList());
  });
});
