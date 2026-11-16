// drive-gateway 单测（issue #32 M2 P2）：动词校验/run 互斥/在场门/epoch 三态/
// core 派发与投影/审计留痕（upload 记路径）/session_stop 幂等/audit writer 环形
// 缓冲——fake session（ensure/epoch/touch/stop）+ fake core + fake journal。

import type { ActionResult, BrowserStateSummary } from "@tw/core";
import type { BridgeDriveResult, RunJournalSnapshot } from "@tw/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createDriveAuditWriter,
  createDriveGateway,
  DRIVE_AUDIT_CAP,
  DRIVE_AUDIT_KEY,
  type DriveAuditEntry,
  driveUploadFs,
  looksLikeOsAbsolutePath,
} from "../src/runtime/drive-gateway.js";

const req = (
  method: string,
  params: Record<string, unknown>,
): {
  method: string;
  params: Record<string, unknown>;
} => ({ method, params });

const signal = (): AbortSignal => new AbortController().signal;

const asResult = (value: unknown): BridgeDriveResult => value as BridgeDriveResult;

function actionResult(over: Partial<ActionResult> = {}): ActionResult {
  return {
    isDone: false,
    success: null,
    error: null,
    extractedContent: null,
    longTermMemory: null,
    judgement: null,
    metadata: { page: "ok" },
    attachments: null,
    denied: false,
    ...over,
  } as ActionResult;
}

const stateSummary = {
  url: "https://example.com/",
  title: "示例",
  tabs: [],
  domState: { elementTreeText: "[0] button" },
  gridMeta: null,
} as unknown as BrowserStateSummary;

interface Harness {
  dispatch: ReturnType<typeof createDriveGateway>;
  ensure: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  audit: DriveAuditEntry[];
  setHasSidepanel(value: boolean): void;
  journalCurrent: RunJournalSnapshot | null;
}

function harness(
  over: { current?: RunJournalSnapshot | null; hasSidepanel?: boolean } = {},
): Harness {
  const audit: DriveAuditEntry[] = [];
  let hasSidepanel = over.hasSidepanel ?? true;
  let epoch = 0;
  let active = false;
  const getState = vi.fn(async () => stateSummary);
  const getTabs = vi.fn(async () => [
    { targetId: "T1", url: "https://example.com/", title: "示例" },
  ]);
  const execute = vi.fn(async () => actionResult());
  const core = {
    browser: { getState, getTabs, currentTargetId: "T1", isConnected: true },
    tools: { execute },
  };
  const stop = vi.fn(async () => {
    active = false;
  });
  const touch = vi.fn(() => {});
  const ensure = vi.fn(async () => {
    // 对齐真实 DriveSession：仅「创建」时 epoch+1（会话在位则复用不加代次）
    if (!active) {
      epoch += 1;
      active = true;
    }
    return core;
  });
  const holder: Harness = {
    ensure,
    touch,
    stop,
    execute,
    getState,
    audit,
    setHasSidepanel: (value) => {
      hasSidepanel = value;
    },
    journalCurrent: over.current ?? null,
    dispatch: createDriveGateway({
      session: {
        get active() {
          return active;
        },
        get busy() {
          return active;
        },
        get epoch() {
          return epoch;
        },
        ensure,
        touch,
        stop,
      },
      journal: { current: () => holder.journalCurrent },
      hasSidepanel: () => hasSidepanel,
      audit: (entry) => audit.push(entry),
      now: () => 123,
      log: () => {},
    }),
  };
  return holder;
}

describe("drive-gateway 派发全链", () => {
  it("get_state：ensure → getState → 投影（elementTreeText/currentTargetId）→ 恒携 epoch；只读无需在场", async () => {
    const h = harness({ hasSidepanel: false });
    const result = asResult(
      await h.dispatch(req("drive", { verb: "get_state", args: {} }), signal()),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        url: "https://example.com/",
        currentTargetId: "T1",
        elementTreeText: "[0] button",
      });
      expect(result.epoch).toBe(1);
    }
    expect(h.getState).toHaveBeenCalledTimes(1);
    expect(h.touch).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ verb: "get_state", ok: true });
  });

  it("tabs：getTabs 投影；click 在场 → tools.execute(action, params, browser, lastState)", async () => {
    const h = harness();
    const tabs = asResult(await h.dispatch(req("drive", { verb: "tabs", args: {} }), signal()));
    expect(tabs.ok && tabs.data).toMatchObject({ currentTargetId: "T1" });
    const click = asResult(
      await h.dispatch(req("drive", { verb: "click", args: { index: 1 }, epoch: 1 }), signal()),
    );
    expect(click.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledWith(
      "click",
      { index: 1 },
      expect.objectContaining({ currentTargetId: "T1" }),
      null,
    );
  });

  it("get_state 后 lastState 线程透传给后续工具动词（daemon 同款）", async () => {
    const h = harness();
    await h.dispatch(req("drive", { verb: "get_state", args: {} }), signal());
    await h.dispatch(req("drive", { verb: "evaluate", args: { code: "1+1" } }), signal());
    expect(h.execute).toHaveBeenCalledWith(
      "evaluate",
      { code: "1+1" },
      expect.anything(),
      stateSummary,
    );
  });

  it("动作回执投影（ActionResult → camelCase out）", async () => {
    const h = harness();
    h.execute.mockResolvedValue(
      actionResult({ isDone: true, success: true, extractedContent: "答：42" }),
    );
    const result = asResult(
      await h.dispatch(req("drive", { verb: "evaluate", args: { code: "x" } }), signal()),
    );
    expect(result.ok && result.data).toMatchObject({
      isDone: true,
      success: true,
      extractedContent: "答：42",
      denied: false,
    });
  });
});

describe("gate 链序", () => {
  it("run 进行中 → BUSY（ensure 不被调——不白附 debugger）", async () => {
    const h = harness({ current: { status: "running" } as RunJournalSnapshot });
    const result = asResult(
      await h.dispatch(req("drive", { verb: "get_state", args: {} }), signal()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BUSY");
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.audit[0]).toMatchObject({ code: "BUSY" });
  });

  it("写类无在场 → SIDEPANEL_REQUIRED（ensure 不被调）；只读放行", async () => {
    const h = harness({ hasSidepanel: false });
    const denied = asResult(
      await h.dispatch(req("drive", { verb: "navigate", args: { url: "https://x/" } }), signal()),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("SIDEPANEL_REQUIRED");
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.audit[0]).toMatchObject({ code: "SIDEPANEL_REQUIRED" });
    const read = asResult(
      await h.dispatch(req("drive", { verb: "screenshot", args: {} }), signal()),
    );
    expect(read.ok).toBe(true);
  });

  it("locator 无 epoch → INDEX_REQUIRES_STATE；epoch 不符 → EPOCH_STALE（均携当前 epoch）", async () => {
    const h = harness();
    const missing = asResult(
      await h.dispatch(req("drive", { verb: "click", args: { index: 1 } }), signal()),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("INDEX_REQUIRES_STATE");
      expect(missing.epoch).toBe(1);
    }
    const stale = asResult(
      await h.dispatch(req("drive", { verb: "click", args: { index: 1 }, epoch: 99 }), signal()),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("EPOCH_STALE");
      expect(stale.epoch).toBe(1);
      expect(stale.error.message).toContain("99");
    }
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("未知动词/坏参数 → INVALID_ARGUMENTS（信封无 epoch）", async () => {
    const h = harness();
    const unknown = asResult(await h.dispatch(req("drive", { verb: "frob", args: {} }), signal()));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("INVALID_ARGUMENTS");
      expect(unknown.epoch).toBeUndefined();
    }
    const bad = asResult(await h.dispatch(req("drive", { verb: "navigate", args: {} }), signal()));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("url");
  });

  it("ensure 失败透传 code（NO_ACTIVE_TAB）；执行抛错 → DRIVE_EXECUTION_FAILED + epoch", async () => {
    const h = harness();
    h.ensure.mockRejectedValue(
      Object.assign(new Error("找不到活动标签页"), { code: "NO_ACTIVE_TAB" }),
    );
    const noTab = asResult(
      await h.dispatch(req("drive", { verb: "get_state", args: {} }), signal()),
    );
    expect(noTab.ok).toBe(false);
    if (!noTab.ok) expect(noTab.error.code).toBe("NO_ACTIVE_TAB");
    expect(h.audit[0]).toMatchObject({ code: "NO_ACTIVE_TAB" });

    const h2 = harness();
    h2.execute.mockRejectedValue(new Error("node not found"));
    const failed = asResult(
      await h2.dispatch(req("drive", { verb: "evaluate", args: { code: "x" } }), signal()),
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("DRIVE_EXECUTION_FAILED");
      expect(failed.epoch).toBe(1);
    }
  });
});

describe("session_stop 与审计", () => {
  it("session_stop：stopped 携停前态，幂等；审计留痕", async () => {
    const h = harness();
    await h.dispatch(req("drive", { verb: "get_state", args: {} }), signal());
    const first = (await h.dispatch(req("session_stop", {}), signal())) as {
      stopped: boolean;
      epoch: number;
    };
    expect(first).toEqual({ stopped: true, epoch: 1 });
    expect(h.stop).toHaveBeenCalledTimes(1);
    const second = (await h.dispatch(req("session_stop", {}), signal())) as {
      stopped: boolean;
    };
    expect(second.stopped).toBe(false);
    expect(h.audit.at(-1)).toMatchObject({ verb: "session_stop", ok: true });
  });

  it("session_stop 撞在途 create（busy=true, active=false）→ stopped:true（评审轮 1 [2]）", async () => {
    let busy = true;
    let stopCalls = 0;
    const gateway = createDriveGateway({
      session: {
        get active() {
          return false;
        },
        get busy() {
          return busy;
        },
        epoch: 3,
        ensure: async () => {
          throw new Error("ensure must not be called by session_stop");
        },
        touch: () => {},
        stop: async () => {
          busy = false;
          stopCalls += 1;
        },
      },
      journal: { current: () => null },
      hasSidepanel: () => true,
      audit: () => {},
      now: () => 0,
    });
    const result = (await gateway(req("session_stop", {}), signal())) as {
      stopped: boolean;
      epoch: number;
    };
    expect(result).toEqual({ stopped: true, epoch: 3 });
    expect(stopCalls).toBe(1);
  });

  it("upload_file：在场 + epoch → 执行且审计 detail 记完整路径（决策点 ④）", async () => {
    const h = harness();
    const result = asResult(
      await h.dispatch(
        req("drive", { verb: "upload_file", args: { index: 2, path: "C:/tmp/a.png" }, epoch: 1 }),
        signal(),
      ),
    );
    expect(result.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledWith(
      "upload_file",
      { index: 2, path: "C:/tmp/a.png" },
      expect.anything(),
      null,
    );
    expect(h.audit[0]).toMatchObject({
      verb: "upload_file",
      ok: true,
      detail: { path: "C:/tmp/a.png" },
    });
  });
});

describe("driveUploadFs（决策点 ④ 路径模式）", () => {
  const innerCalls: string[] = [];
  const inner = {
    resolve: (p: string) => {
      innerCalls.push(`resolve:${p}`);
      return `/opfs/${p}`;
    },
    isFile: async (p: string) => {
      innerCalls.push(`isFile:${p}`);
      return false;
    },
    stat: async (p: string) => {
      innerCalls.push(`stat:${p}`);
      return null;
    },
    readTextFile: async (p: string) => {
      innerCalls.push(`readTextFile:${p}`);
      return "";
    },
    ensureDir: async (p: string) => {
      innerCalls.push(`ensureDir:${p}`);
    },
    writeTextFile: async (p: string, c: string) => {
      innerCalls.push(`writeTextFile:${p}:${c}`);
    },
    appendTextFile: async (p: string, c: string) => {
      innerCalls.push(`appendTextFile:${p}:${c}`);
    },
    writeBytes: async (p: string, d: Uint8Array) => {
      innerCalls.push(`writeBytes:${p}:${d.length}`);
    },
    readHead: async (p: string, n: number) => {
      innerCalls.push(`readHead:${p}:${n}`);
      return null;
    },
  };
  const wrapped = driveUploadFs(inner);

  it("looksLikeOsAbsolutePath：盘符/UNC 命中；相对路径与 /opfs 形不命中", () => {
    expect(looksLikeOsAbsolutePath("C:/tmp/a.png")).toBe(true);
    expect(looksLikeOsAbsolutePath("D:\\x\\y.txt")).toBe(true);
    expect(looksLikeOsAbsolutePath("\\\\server\\share\\a")).toBe(true);
    expect(looksLikeOsAbsolutePath("shots/step_001.png")).toBe(false);
    expect(looksLikeOsAbsolutePath("/opfs/foo")).toBe(false);
  });

  it("OS 绝对路径：resolve 恒等、isFile 放行、stat 非空——不触 inner（校验权交 Chrome）", async () => {
    expect(wrapped.resolve("C:/tmp/a.png")).toBe("C:/tmp/a.png");
    await expect(wrapped.isFile("C:/tmp/a.png")).resolves.toBe(true);
    await expect(wrapped.stat("C:/tmp/a.png")).resolves.toEqual({ size: 1 });
    expect(innerCalls).toEqual([]);
  });

  it("非 OS 路径全量委托 inner（OPFS 虚拟工作区照常——如 screenshot save_path）", async () => {
    expect(wrapped.resolve("shots/a.png")).toBe("/opfs/shots/a.png");
    await wrapped.writeTextFile("a.txt", "hi");
    await wrapped.writeBytes("b.png", new Uint8Array(3));
    expect(innerCalls).toEqual([
      "resolve:shots/a.png",
      "writeTextFile:a.txt:hi",
      "writeBytes:b.png:3",
    ]);
  });
});

describe("createDriveAuditWriter", () => {
  it("串行落盘 + 环形封顶（FIFO 淘汰）+ 坏形态回空环", async () => {
    const store = new Map<string, unknown>();
    const storage = {
      get: async (keys: string | string[]) => {
        const key = typeof keys === "string" ? keys : (keys[0] ?? "");
        const value = store.get(key);
        return value === undefined ? {} : { [key]: value };
      },
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
    };
    const write = createDriveAuditWriter(storage as never);
    const preloaded: DriveAuditEntry[] = Array.from({ length: DRIVE_AUDIT_CAP }, (_, i) => ({
      at: i,
      verb: "get_state",
      ok: true,
    }));
    store.set(DRIVE_AUDIT_KEY, [...preloaded, { junk: true } as unknown as DriveAuditEntry]);
    write({ at: 999, verb: "click", ok: true });
    write({ at: 1000, verb: "navigate", ok: false, code: "BUSY" });
    await vi.waitFor(() => {
      const ring = store.get(DRIVE_AUDIT_KEY) as DriveAuditEntry[];
      expect(ring).toHaveLength(DRIVE_AUDIT_CAP);
      expect(ring.at(-1)).toMatchObject({ verb: "navigate", ok: false, code: "BUSY" });
      expect(ring.at(-2)).toMatchObject({ verb: "click", at: 999 });
      expect(ring[0]?.at).toBe(2); // 最老两条被淘汰（at 0/1 出局）
    });
  });
});
