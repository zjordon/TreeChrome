// run-manager 状态机单测（m5/04 §9）：start（卡片缺失/无 tab/空任务/成功链）→
// journal running → agent.run 完 → done + cleanup（keepalive/attachments/监听器）；
// stop → interrupted（用户中断文案）；tab onRemoved → interrupted；单飞互斥拒绝；
// pause/resume 直通；recoverInterrupted（非终态 → interrupted；终态不动）；
// handleUiMessage 分发——assemble 覆盖缝注入 stub agent（不跑真 Agent）。

import { AgentHistoryList } from "@tw/core";
import type { RunJournalSnapshot, SessionRecord, SwToUiMessage } from "@tw/protocol";
import { describe, expect, it, vi } from "vitest";
import { AttachmentRegistry } from "../src/host/attachment-registry.js";
import type { StorageAreaWithRemove } from "../src/host/chrome-apis.js";
import type { KeepaliveController } from "../src/host/keepalive.js";
import type { DirHandleLike } from "../src/host/opfs-fs.js";
import { OpfsFs } from "../src/host/opfs-fs.js";
import { parseExtensionSettings, type SettingsStore } from "../src/host/settings-store.js";
import { RunJournal } from "../src/runtime/journal.js";
import { RunManager, type RunManagerDeps } from "../src/runtime/run-manager.js";
import { SessionRepository } from "../src/runtime/session-repo.js";

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
    /** 蒸馏入队面注入（issue #5 S4 门控测试） */
    distill?: RunManagerDeps["distill"];
    /** assemble 覆盖（抛错/连接断类场景注入特殊 stub） */
    agent?: ReturnType<typeof stubAgent> | { run: () => Promise<AgentHistoryList> };
    /** tabsQuery 闸门（starting 互斥竞态测试：挂住首查直到放行） */
    queryGate?: Promise<void>;
    /** 装配时捕获 policyInteraction（桥 pending 收口测试） */
    captureInteraction?: (i: unknown) => void;
    /** 注入小上限 registry（拒绝面测试——不造百兆载荷） */
    attachments?: AttachmentRegistry;
    /** 会话存储面（issue #35 U1a：缺省不注入 = 降级路径） */
    sessions?: RunManagerDeps["sessions"];
    /** 装配时捕获任务文本入参（#35 验收①：前情块注入断言） */
    captureTask?: (task: string) => void;
  } = {},
) {
  const journal = new RunJournal({ now: () => 1234 });
  const attachments = options.attachments ?? new AttachmentRegistry();
  const broadcasts: SwToUiMessage[] = [];
  const keepalive = {
    onStartRun: () => void 0,
    onEndRun: () => void 0,
  } as unknown as KeepaliveController;
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const stub = stubAgent();
  const browserStops: number[] = [];
  const logs: string[] = [];
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
    return ((_input: { task: string }, deps: { policyInteraction: unknown }) => {
      options.captureInteraction?.(deps.policyInteraction);
      options.captureTask?.(_input.task);
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
    ...(options.distill !== undefined ? { distill: options.distill } : {}),
    ...(options.sessions !== undefined ? { sessions: options.sessions } : {}),
    newRunId: () => "run_test",
    now: () => 1234,
    log: (m: string) => void logs.push(m),
  };
  const manager = new RunManager(deps);
  return {
    manager,
    journal,
    attachments,
    broadcasts,
    logs,
    tabRemovedListeners,
    stub,
    browserStops,
  };
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

  it("附件起跑守卫（issue #11 D3）：任务指涉附件但列表空 → 拒绝并给可行动提示；有附件/无指涉 → 放行", async () => {
    const m = makeDeps();
    // 空表：中/英两种指涉都拒（SW 被杀丢内存态 / 上一轮 clearForRun 清表的场景）
    expect(await m.manager.control("start", "用附件里的视频发布到抖音")).toMatchObject({
      ok: false,
      error: "任务提到附件但附件列表为空——请先在下方附加文件（浏览器重启或上一轮结束会清空附件）",
    });
    expect(await m.manager.control("start", "attachment: video.mp4 上传")).toMatchObject({
      ok: false,
      error: expect.stringContaining("附件列表为空"),
    });
    // 无附件指涉 → 放行（既有行为不变）
    const m2 = makeDeps();
    expect(await m2.manager.control("start", "打开首页")).toEqual({ ok: true });
    m2.stub.finish(doneHistory());
    // 有附件 → 放行
    const m3 = makeDeps();
    m3.manager.handleUiMessage({
      kind: "attachment-begin",
      transferId: "t1",
      name: "a.mp4",
      mimeType: "video/mp4",
      size: 1,
    });
    m3.manager.handleUiMessage({
      kind: "attachment-chunk",
      transferId: "t1",
      offset: 0,
      data: btoa("x"),
    });
    m3.manager.handleUiMessage({ kind: "attachment-commit", transferId: "t1" });
    expect(await m3.manager.control("start", "用附件里的视频发布到抖音")).toEqual({ ok: true });
    m3.stub.finish(doneHistory());
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
    // 起始快照广播（评审轮 1 [6]）：begin 重置 seq 后必须广播——否则 UI 的
    // seq 去重把新 run 事件判为旧 run 重复而丢弃
    const startSnap = m.broadcasts.find((b) => b.kind === "journal-snapshot");
    expect(startSnap).toMatchObject({ snapshot: { runId: "run_test", status: "running" } });
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
    // 清表广播（评审轮 1 [16]）：add/remove 均广播，clear 不得静默（budget 随清表归零）
    expect(m.broadcasts.filter((b) => b.kind === "attachments")).toEqual([
      {
        kind: "attachments",
        items: [],
        budget: { usedBytes: 0, pendingBytes: 0, maxBytes: 104857600, maxTotalBytes: 209715200 },
      },
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
    // 无效附件（空名）→ attachment-rejected 明细广播（issue #2：拒绝不再静默）
    m.manager.handleUiMessage({
      kind: "attachment-begin",
      transferId: "t1",
      name: "",
      mimeType: "m",
      size: 1,
    });
    expect(m.broadcasts.filter((b) => b.kind === "attachment-rejected")).toEqual([
      {
        kind: "attachment-rejected",
        rejection: {
          transferId: "t1",
          name: "",
          mimeType: "m",
          size: 1,
          reason: "invalid",
          limit: 0,
        },
      },
    ]);
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

  it("handleUiMessage：attachment begin/chunk/commit/remove 全链广播；ack 进 journal", async () => {
    const m = makeDeps();
    m.journal.begin({ runId: "r", tabId: 1, task: "t", attachments: [] });
    m.journal.record({ eventType: "step_start", step: 1, sessionId: "s" });
    m.manager.handleUiMessage({ kind: "journal-ack", seq: 1 });
    expect(m.journal.current()?.ackedSeq).toBe(1);
    const data = btoa("x");
    // begin → begun 回执（UI 收到才开始发块）
    m.manager.handleUiMessage({
      kind: "attachment-begin",
      transferId: "t1",
      name: "a",
      mimeType: "text/plain",
      size: 1,
    });
    expect(m.broadcasts.at(-1)).toEqual({ kind: "attachment-begun", transferId: "t1" });
    // chunk 静默（中间态不广播——广播数停在 begun 那 1 条）
    m.manager.handleUiMessage({ kind: "attachment-chunk", transferId: "t1", offset: 0, data });
    expect(m.broadcasts).toHaveLength(1);
    // commit → attachments + budget 投影
    m.manager.handleUiMessage({ kind: "attachment-commit", transferId: "t1" });
    expect(m.broadcasts.at(-1)).toMatchObject({
      kind: "attachments",
      items: [{ attachmentId: "att_1", name: "a", size: 1 }],
      budget: { usedBytes: 1, pendingBytes: 0, maxBytes: 104857600, maxTotalBytes: 209715200 },
    });
    // remove → 空清单 + 预算归零
    m.manager.handleUiMessage({ kind: "attachment-remove", attachmentId: "att_1" });
    expect(m.broadcasts.at(-1)).toMatchObject({
      kind: "attachments",
      items: [],
      budget: { usedBytes: 0, pendingBytes: 0 },
    });
  });

  it("handleUiMessage：begin 超限拒绝明细广播（too-large / total-exceeded；小上限注入）", () => {
    const m = makeDeps({
      attachments: new AttachmentRegistry({ maxBytes: 10, maxTotalBytes: 15 }),
    });
    m.manager.handleUiMessage({
      kind: "attachment-begin",
      transferId: "t1",
      name: "big.mp4",
      mimeType: "video/mp4",
      size: 11,
    });
    expect(m.broadcasts.at(-1)).toEqual({
      kind: "attachment-rejected",
      rejection: {
        transferId: "t1",
        name: "big.mp4",
        mimeType: "video/mp4",
        size: 11,
        reason: "too-large",
        limit: 10,
      },
    });
    m.manager.handleUiMessage({
      kind: "attachment-begin",
      transferId: "t2",
      name: "a",
      mimeType: "m",
      size: 8,
    });
    m.manager.handleUiMessage({
      kind: "attachment-begin",
      transferId: "t3",
      name: "b",
      mimeType: "m",
      size: 8,
    });
    expect(m.broadcasts.at(-1)).toMatchObject({
      kind: "attachment-rejected",
      rejection: { transferId: "t3", name: "b", size: 8, reason: "total-exceeded", limit: 15 },
    });
  });

  it("handleUiMessage：commit 半传 → lost 拒绝（带 pending meta）；彻底未知 → 占位名；abort 静默", () => {
    const m = makeDeps();
    m.manager.handleUiMessage({
      kind: "attachment-begin",
      transferId: "t1",
      name: "a",
      mimeType: "m",
      size: 4,
    });
    m.manager.handleUiMessage({
      kind: "attachment-chunk",
      transferId: "t1",
      offset: 0,
      data: btoa("01"),
    });
    m.manager.handleUiMessage({ kind: "attachment-commit", transferId: "t1" });
    expect(m.broadcasts.filter((b) => b.kind === "attachment-rejected")).toEqual([
      {
        kind: "attachment-rejected",
        rejection: {
          transferId: "t1",
          name: "a",
          mimeType: "m",
          size: 4,
          reason: "lost",
          limit: 0,
        },
      },
    ]);
    // 彻底未知（pending 已不存在）→ 占位名
    m.manager.handleUiMessage({ kind: "attachment-commit", transferId: "tX" });
    expect(m.broadcasts.at(-1)).toMatchObject({
      kind: "attachment-rejected",
      rejection: { name: "（未知附件）", reason: "lost" },
    });
    // abort 静默清理（无广播）
    m.manager.handleUiMessage({
      kind: "attachment-begin",
      transferId: "t2",
      name: "b",
      mimeType: "m",
      size: 2,
    });
    m.manager.handleUiMessage({ kind: "attachment-abort", transferId: "t2" });
    expect(m.broadcasts.filter((b) => b.kind === "attachments")).toEqual([]);
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

describe("start 绑定可驱动页（段 F 验收：chrome:// 附着被拒）", () => {
  it("currentWindow 活动页是 chrome:// → 跳过取同查询中的 http 页；url 缺失不判形态（旧行为）", async () => {
    const m1 = makeDeps();
    (m1.manager as unknown as { deps: { tabsQuery: unknown } }).deps.tabsQuery = {
      query: async () => [
        { id: 11, url: "chrome://extensions" },
        { id: 22, url: "https://www.google.com" },
      ],
    };
    expect(await m1.manager.control("start", "t")).toEqual({ ok: true });
    expect(m1.journal.current()).toMatchObject({ tabId: 22 });
    m1.stub.finish(new AgentHistoryList());

    const m2 = makeDeps(); // url 不可读（无 tabs 权限/注入形态）→ 首个即可
    (m2.manager as unknown as { deps: { tabsQuery: unknown } }).deps.tabsQuery = {
      query: async () => [{ id: 33 }],
    };
    expect(await m2.manager.control("start", "t")).toEqual({ ok: true });
    expect(m2.journal.current()).toMatchObject({ tabId: 33 });
    m2.stub.finish(new AgentHistoryList());
  });

  it("全受限 → 用户可行动文案；无任何标签页 → 原文案", async () => {
    const m1 = makeDeps();
    (m1.manager as unknown as { deps: { tabsQuery: unknown } }).deps.tabsQuery = {
      query: async () => [{ id: 5, url: "chrome://newtab" }],
    };
    expect(await m1.manager.control("start", "t")).toMatchObject({
      ok: false,
      error: expect.stringContaining("浏览器内部页面"),
    });

    const m2 = makeDeps({ tabId: undefined });
    expect(await m2.manager.control("start", "t")).toMatchObject({
      ok: false,
      error: "找不到活动标签页",
    });
  });

  it("drive 附着失败（Chrome 原生 chrome:// 拒绝）→ lastError 换用户可行动文案", async () => {
    const attach = makeDeps({
      agent: {
        run: () => Promise.reject(new Error("Cannot access a chrome:// URL")),
        stop: () => void 0,
        pause: () => void 0,
        resume: () => void 0,
      },
    });
    await attach.manager.control("start", "t");
    await new Promise((r) => setTimeout(r, 10));
    expect(attach.journal.current()).toMatchObject({
      status: "error",
      lastError: "无法驱动浏览器内部页面（chrome://）——请切换到普通网页标签页后重试",
    });
  });
});

// ── 蒸馏门控入队（issue #5 S4：D1 门控 / D3 脱敏 / D9 异步收口后）────────

describe("RunManager 蒸馏门控入队", () => {
  const distillHistory = (verdict: boolean | null) =>
    new AgentHistoryList({
      history: [
        {
          stepNumber: 1,
          modelOutput: { next_goal: "查报表", action: { name: "done", params: {} } },
          stateSummary: { url: "https://a.example/reports", title: "报表" },
          result: [
            {
              isDone: true,
              success: true,
              extractedContent: "全部完成",
              ...(verdict === null ? {} : { judgement: { verdict } }),
            },
          ],
        } as never,
      ],
    });

  it("门控过（success + verdict true）→ enqueue + kick；task/host/stepCount/traceText 正确", async () => {
    const jobs: import("../src/runtime/distill-queue.js").DistillJobInput[] = [];
    const kicks: number[] = [];
    const m = makeDeps({
      distill: {
        enqueue: async (job) => void jobs.push(job),
        kick: () => void kicks.push(1),
      },
    });
    await m.manager.control("start", "查报表");
    m.stub.finish(distillHistory(true));
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      runId: "run_test",
      task: "查报表",
      host: "a.example",
      stepCount: 1,
    });
    expect(jobs[0]?.traceText).toContain("https://a.example/reports");
    expect(kicks).toHaveLength(1);
    // issue #9 D3：入队成功 → distill-status queued 广播（空窗可见性的第一拍）
    expect(m.broadcasts).toContainEqual({ kind: "distill-status", phase: "queued" });
    // issue #5 可观测性：judge 结论进 journal 快照（收尾后可查「为什么没蒸馏」）
    expect(m.journal.current()).toMatchObject({
      judgement: { verdict: true, reasoning: null, failureReason: null },
    });
  });

  it("快照持久化 judge 拒绝结论（verdict=false + reasoning 收窄）", async () => {
    const m = makeDeps();
    await m.manager.control("start", "查报表");
    m.stub.finish(
      new AgentHistoryList({
        history: [
          {
            stepNumber: 1,
            modelOutput: { next_goal: "查", action: { name: "done", params: {} } },
            stateSummary: { url: "https://a.example/r" },
            result: [
              {
                isDone: true,
                success: true,
                extractedContent: "x",
                judgement: { verdict: false, reasoning: "无页面证据", failureReason: "证据不足" },
              },
            ],
          } as never,
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(m.journal.current()).toMatchObject({
      judgement: { verdict: false, reasoning: "无页面证据", failureReason: "证据不足" },
      lastError: null, // issue #10 D6：正常 done 收口不携带停跑原因
    });
  });

  it("非 done 收口 → lastError 带停跑原因（issue #10 D6：E5 可见性）", async () => {
    const m = makeDeps();
    await m.manager.control("start", "查报表");
    m.stub.finish(
      new AgentHistoryList({
        history: [
          {
            stepNumber: 1,
            modelOutput: { next_goal: "查", action: { name: "wait", params: {} } },
            stateSummary: { url: "https://a.example/r" },
            result: [{ extractedContent: "x" }],
          } as never,
        ],
        stopReason: "max_infra_failures",
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    // 2026-10-25 HTTP 401 实测：此前仅「✗ 未成功」无任何解释
    expect(m.journal.current()).toMatchObject({
      status: "done",
      isDone: false,
      lastError: "LLM 基建失败达到上限——常见原因：API key 失效/网络不通/端点不可达",
    });
  });

  it("verdict false / judgement 缺失（judge 关闭）→ 不入队", async () => {
    for (const verdict of [false, null]) {
      const jobs: unknown[] = [];
      const m = makeDeps({
        distill: { enqueue: async (job) => void jobs.push(job), kick: () => {} },
      });
      await m.manager.control("start", "查报表");
      m.stub.finish(distillHistory(verdict));
      await new Promise((r) => setTimeout(r, 10));
      expect(jobs).toHaveLength(0); // D1 严格读法：judgement 缺失 = 不蒸馏
      // 门控不过 → 也不发 queued 拍（没入队就没过程可跟踪——issue #9）
      expect(m.broadcasts.filter((b) => b.kind === "distill-status")).toEqual([]);
      // issue #10 D4：门控日志三态归因——null 与 false 不再混为一句
      //（some 匹配：门控行之后还有 run ended 等收尾日志）
      expect(
        m.logs.some((l) =>
          l.includes(verdict === false ? "judge 复核拒绝" : "judge 未执行或调用失败"),
        ),
      ).toBe(true);
    }
  });

  it("interrupted → 不入队", async () => {
    const jobs: unknown[] = [];
    const m = makeDeps({
      distill: { enqueue: async (job) => void jobs.push(job), kick: () => {} },
    });
    await m.manager.control("start", "查报表");
    await m.manager.control("stop");
    m.stub.finish(distillHistory(true));
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs).toHaveLength(0);
  });

  it("selfEvolution.enabled=false → 短路不入队", async () => {
    const jobs: unknown[] = [];
    const m = makeDeps({
      settings: {
        ...SETTINGS,
        selfEvolution: { enabled: false, distillCard: "" },
      },
      distill: { enqueue: async (job) => void jobs.push(job), kick: () => {} },
    });
    await m.manager.control("start", "查报表");
    m.stub.finish(distillHistory(true));
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs).toHaveLength(0);
  });

  it("脱敏（D3）：敏感真值不出现在入队的 task/traceText（占位替换）", async () => {
    const jobs: import("../src/runtime/distill-queue.js").DistillJobInput[] = [];
    const m = makeDeps({
      settings: {
        ...SETTINGS,
        sensitiveData: { ADMIN_TOKEN: { value: "hunter2secret", urls: null } },
      },
      distill: { enqueue: async (job) => void jobs.push(job), kick: () => {} },
    });
    await m.manager.control("start", "用 hunter2secret 登录后查报表");
    const hist = new AgentHistoryList({
      history: [
        {
          stepNumber: 1,
          modelOutput: {
            next_goal: "登录",
            action: { name: "input_text", params: { text: "hunter2secret" } },
          },
          stateSummary: { url: "https://a.example/login", title: "登录" },
          result: [
            {
              isDone: true,
              success: true,
              extractedContent: "全部完成 hunter2secret",
              judgement: { verdict: true },
            },
          ],
        } as never,
      ],
    });
    m.stub.finish(hist);
    await new Promise((r) => setTimeout(r, 10));
    expect(jobs).toHaveLength(1); // 门控过——入队
    expect(jobs[0]?.task).not.toContain("hunter2secret"); // task 脱敏
    expect(jobs[0]?.traceText).not.toContain("hunter2secret"); // Action/Result 行脱敏
  });
});

// —— 会话模型集成（issue #35 U1a W8）——

function fakeSessionStorage(): StorageAreaWithRemove {
  const map = new Map<string, unknown>();
  return {
    get: async (keys) => {
      if (keys === null) return Object.fromEntries(map);
      const list = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of list) if (map.has(k)) out[k] = map.get(k);
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

function makeRepo(): SessionRepository {
  let n = 0;
  let clock = 1000;
  return new SessionRepository(fakeSessionStorage(), {
    newSessionId: () => {
      n += 1;
      return `s${n}`;
    },
    newTurnId: () => {
      n += 1;
      return `t${n}`;
    },
    now: () => {
      clock += 1;
      return clock;
    },
  });
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("RunManager 会话集成（#35 U1a）", () => {
  it("验收①：同 tab 二连发——第二次装配任务含前情块（首任务 + [当前任务] 分隔）", async () => {
    const repo = makeRepo();
    const tasks: string[] = [];
    const m = makeDeps({ tabId: 7, sessions: repo, captureTask: (t) => void tasks.push(t) });
    expect(await m.manager.control("start", "查价")).toMatchObject({ ok: true });
    m.stub.finish(doneHistory());
    await settle();
    expect(tasks[0]).toBe("查价"); // 首 run 零行为面（无前情块）
    expect(await m.manager.control("start", "再查一次")).toMatchObject({ ok: true });
    expect(tasks[1]).toContain("[会话前情·自动注入]");
    expect(tasks[1]).toContain("此前任务：查价");
    expect(tasks[1]).toContain("[当前任务]\n再查一次");
    // 会话复用：两次 run 同 session（不另建）
    expect(await repo.listIndex()).toHaveLength(1);
    m.stub.finish(doneHistory());
    await settle();
  });

  it("终态收口：turn 置终态 + 归档事件全量 + meta 计数 + session-updated 广播", async () => {
    const repo = makeRepo();
    const m = makeDeps({ tabId: 7, sessions: repo });
    expect(await m.manager.control("start", "查价")).toMatchObject({ ok: true });
    m.journal.record({ eventType: "step_start", step: 1, sessionId: "s" });
    m.journal.record({
      eventType: "model_result",
      step: 1,
      sessionId: "s",
      actionName: "click",
      inputTokens: 100,
      outputTokens: 20,
    });
    m.stub.finish(doneHistory());
    await settle();
    const record = (await repo.open("s1")) as SessionRecord;
    expect(record.turns).toHaveLength(1);
    expect(record.turns[0]).toMatchObject({ status: "done", task: "查价" });
    expect(record.runs).toHaveLength(1);
    expect(record.runs[0]?.events).toHaveLength(2); // 归档缓冲全量（journal 直录也进档）
    expect(record.meta).toMatchObject({ runCount: 1, lastStatus: "done", usageTokens: 120 });
    const reasons = m.broadcasts
      .filter((b) => b.kind === "session-updated")
      .map((b) => (b as { reason: string }).reason);
    expect(reasons).toContain("turn");
    expect(reasons).toContain("archive");
  });

  it("bridge origin：startRun 走 bridge 标记进快照与会话", async () => {
    const repo = makeRepo();
    const m = makeDeps({ tabId: 7, sessions: repo });
    expect(await m.manager.startRun("外部任务", "bridge")).toMatchObject({ ok: true });
    expect(m.journal.current()).toMatchObject({ origin: "bridge", sessionId: "s1" });
    expect((await repo.open("s1"))?.meta.origin).toBe("bridge");
    m.stub.finish(doneHistory());
    await settle();
  });

  it("steer 预留：明确回 not-supported（U2/L2 前防 breaking）", async () => {
    const m = makeDeps();
    const r = await m.manager.control("steer", "插话");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain("尚未支持");
  });

  it("恢复对账：非终态快照 → journal interrupted + turn 置终态 + 环幸存事件归档", async () => {
    const repo = makeRepo();
    // 预置：SW 死前该 run 已记 turn（running）——模拟上一生命周期的 beginRun
    const meta = await repo.createSession({ tabId: 7, origin: "user", title: "对账" });
    await repo.beginRun(meta.sessionId, {
      runId: "run_dead",
      task: "被打断的任务",
      attachments: [],
    });
    const m = makeDeps({ tabId: 7, sessions: repo });
    const snapshot: RunJournalSnapshot = {
      runId: "run_dead",
      tabId: 7,
      status: "running",
      seq: 2,
      ackedSeq: 0,
      discardedBeforeSeq: 1,
      events: [{ seq: 2, type: "model_result", ts: 1, data: { inputTokens: 5 } }],
      task: "被打断的任务",
      startedAt: 1,
      endedAt: null,
      finalResult: null,
      isDone: false,
      isSuccessful: null,
      stepCount: 1,
      lastError: null,
      attachments: [],
      sessionId: meta.sessionId,
      origin: "user",
    };
    m.manager.recoverInterrupted(snapshot);
    await settle();
    expect(m.journal.status).toBe("interrupted");
    const record = (await repo.open(meta.sessionId)) as SessionRecord;
    expect(record.turns[0]).toMatchObject({ status: "interrupted", runId: "run_dead" });
    expect(record.runs[0]).toMatchObject({
      status: "interrupted",
      runId: "run_dead",
      discardedBeforeSeq: 1, // 环淘汰如实记账
    });
    expect(record.runs[0]?.events).toHaveLength(1);
  });

  it("旧快照无 sessionId：恢复照旧、会话面零写不炸（向后兼容）", async () => {
    const repo = makeRepo();
    const meta = await repo.createSession({ tabId: 7, origin: "user", title: "无关会话" });
    await repo.beginRun(meta.sessionId, { runId: "run_live", task: "在跑", attachments: [] });
    const m = makeDeps({ tabId: 7, sessions: repo });
    m.manager.recoverInterrupted({
      runId: "run_dead",
      tabId: 7,
      status: "running",
      seq: 0,
      ackedSeq: 0,
      discardedBeforeSeq: 0,
      events: [],
      task: "旧任务",
      startedAt: 1,
      endedAt: null,
      finalResult: null,
      isDone: false,
      isSuccessful: null,
      stepCount: 0,
      lastError: null,
      attachments: [],
    });
    await settle();
    expect(m.journal.status).toBe("interrupted");
    const record = await repo.open(meta.sessionId);
    expect(record?.turns[0]?.status).toBe("running"); // 未被误置终态
    expect(record?.runs).toHaveLength(0);
  });

  it("beginRun 抛错 fail-soft：run 生命周期不受影响（D3）", async () => {
    const broken = makeRepo();
    // 实例属性直接遮蔽原型方法（保住 own 字段——spread/prototype 复制都会丢状态）
    (
      broken as unknown as {
        beginRun: SessionRepository["beginRun"];
      }
    ).beginRun = async () => {
      throw new Error("session write boom");
    };
    const m = makeDeps({ tabId: 7, sessions: broken });
    expect(await m.manager.control("start", "任务")).toMatchObject({ ok: true });
    m.stub.finish(doneHistory());
    await settle();
    expect(m.journal.status).toBe("done"); // run 照常终态
    expect(m.logs.some((l) => l.includes("beginRun failed"))).toBe(true);
  });

  it("会话面缺省（sessions 未注入）：start/run 照旧零会话语义（降级路径）", async () => {
    const m = makeDeps();
    expect(await m.manager.control("start", "任务")).toMatchObject({ ok: true });
    const snap = m.journal.current();
    expect(snap?.sessionId).toBeUndefined();
    expect(snap?.origin).toBeUndefined();
    m.stub.finish(doneHistory());
    await settle();
    expect(m.journal.status).toBe("done");
  });

  it("显式 sessionId 续跑：跨 tab 跟随重绑（rebindTab）+ 前情块来自该会话", async () => {
    const repo = makeRepo();
    // 先在 tab 7 建会话跑一 run（直接经 repo 预置——隔离 start 链）
    const meta = await repo.createSession({ tabId: 7, origin: "user", title: "旧 tab 会话" });
    const turn = await repo.beginRun(meta.sessionId, {
      runId: "r_old",
      task: "旧任务",
      attachments: [],
    });
    await repo.completeRun(meta.sessionId, {
      turnId: turn?.turnId ?? "",
      archive: {
        runId: "r_old",
        startedAt: 1,
        endedAt: 2,
        status: "done",
        finalResult: "旧结果",
        lastError: null,
        events: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        discardedBeforeSeq: 0,
      },
    });
    // 在 tab 9 显式续跑该会话
    const tasks: string[] = [];
    const m9 = makeDeps({ tabId: 9, sessions: repo, captureTask: (t) => void tasks.push(t) });
    expect(await m9.manager.control("start", "新任务", meta.sessionId)).toMatchObject({ ok: true });
    expect(tasks[0]).toContain("此前任务：旧任务");
    expect(tasks[0]).toContain("结果：旧结果");
    const list = await repo.listIndex();
    expect(list).toHaveLength(1); // 未另建
    expect(list[0]?.tabId).toBe(9); // 已重绑
    m9.stub.finish(doneHistory());
    await settle();
  });
});
