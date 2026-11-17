// session-handler 单测（issue #35 U1a W8）：五 op 请求-应答/queue 预留回
// not-supported/notifyUpdated 触发/坏载荷与 fail-soft——真 SessionRepository +
// fake storage（同 repo 单测件）。

import { describe, expect, it, vi } from "vitest";
import type { StorageAreaWithRemove } from "../src/host/chrome-apis.js";
import { handleSessionRequest, type SessionFace } from "../src/runtime/session-handler.js";
import { SessionRepository } from "../src/runtime/session-repo.js";

function fakeStorage(): StorageAreaWithRemove {
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

function face(): SessionFace & { notified: Array<{ sessionId?: string; reason: string }> } {
  const notified: Array<{ sessionId?: string; reason: string }> = [];
  return {
    repo: new SessionRepository(fakeStorage(), { newSessionId: () => "s1" }),
    notifyUpdated: (sessionId, reason) => void notified.push({ sessionId, reason }),
    notified,
  };
}

describe("handleSessionRequest", () => {
  it("session-new：tabId 缺省 0、title 缺省「新会话」→ meta + index 通知", async () => {
    const f = face();
    const res = (await handleSessionRequest("session-new", {}, f)) as {
      ok: boolean;
      session: { sessionId: string; tabId: number; title: string };
    };
    expect(res.ok).toBe(true);
    expect(res.session).toMatchObject({ sessionId: "s1", tabId: 0, title: "新会话" });
    expect(f.notified).toEqual([{ sessionId: "s1", reason: "index" }]);
  });

  it("session-new 坏 tabId → ok:false", async () => {
    const f = face();
    const res = (await handleSessionRequest("session-new", { tabId: "x" }, f)) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("tabId");
  });

  it("session-list / session-open / rename / delete 全链往返", async () => {
    const f = face();
    await handleSessionRequest("session-new", { tabId: 3, title: "查价" }, f);
    const list = (await handleSessionRequest("session-list", null, f)) as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(list.sessions).toHaveLength(1);
    const opened = (await handleSessionRequest("session-open", { sessionId: "s1" }, f)) as {
      ok: boolean;
      record: { meta: { title: string } };
    };
    expect(opened.ok).toBe(true);
    expect(opened.record.meta.title).toBe("查价");
    expect(
      await handleSessionRequest("session-rename", { sessionId: "s1", title: "改名" }, f),
    ).toEqual({ ok: true });
    expect(await handleSessionRequest("session-open", { sessionId: "s1" }, f)).toMatchObject({
      record: { meta: { title: "改名" } },
    });
    expect(await handleSessionRequest("session-delete", { sessionId: "s1" }, f)).toEqual({
      ok: true,
    });
    // 确认不存在带 notFound 标记（评审轮 2 [5]——UI 据此区分存储瞬时错误）
    expect(await handleSessionRequest("session-open", { sessionId: "s1" }, f)).toMatchObject({
      ok: false,
      notFound: true,
    });
  });

  it("open/rename/delete 缺参 → ok:false 带提示", async () => {
    const f = face();
    expect(await handleSessionRequest("session-open", {}, f)).toMatchObject({ ok: false });
    expect(await handleSessionRequest("session-rename", { sessionId: "s1" }, f)).toMatchObject({
      ok: false,
    });
    expect(await handleSessionRequest("session-delete", null, f)).toMatchObject({ ok: false });
  });

  it("queue-add/queue-remove：受理走注入 queue 面（#37 批 A）；缺注入/坏载荷回错", async () => {
    const noQueue = face();
    expect(
      await handleSessionRequest("queue-add", { sessionId: "s1", task: "t" }, noQueue),
    ).toMatchObject({ ok: false, error: "排队面未启用" });
    const added: Array<{ sessionId: string; task: string }> = [];
    const removed: Array<{ sessionId: string; turnId: string }> = [];
    const f = face();
    const withQueue = {
      ...f,
      queue: {
        add: async (sessionId: string, task: string) => {
          added.push({ sessionId, task });
          return { ok: true as const, turnId: "t9" };
        },
        remove: async (sessionId: string, turnId: string) => {
          removed.push({ sessionId, turnId });
          return true;
        },
      },
    };
    expect(
      await handleSessionRequest("queue-add", { sessionId: "s1", task: "跟进任务" }, withQueue),
    ).toEqual({ ok: true, turnId: "t9" });
    expect(
      await handleSessionRequest("queue-remove", { sessionId: "s1", turnId: "t9" }, withQueue),
    ).toEqual({
      ok: true,
    });
    expect(added).toEqual([{ sessionId: "s1", task: "跟进任务" }]);
    expect(removed).toEqual([{ sessionId: "s1", turnId: "t9" }]);
    // 坏载荷
    expect(await handleSessionRequest("queue-add", { sessionId: "s1" }, withQueue)).toMatchObject({
      ok: false,
    });
    expect(await handleSessionRequest("queue-remove", { turnId: "t9" }, withQueue)).toMatchObject({
      ok: false,
    });
  });

  it("未知 op 与 repo 抛错均 fail-soft 回 {ok:false}", async () => {
    const f = face();
    expect(await handleSessionRequest("frob" as never, null, f)).toMatchObject({ ok: false });
    const broken: SessionFace = {
      repo: {
        listIndex: async () => {
          throw new Error("storage 不可用");
        },
      } as never,
      notifyUpdated: vi.fn(),
    };
    const res = (await handleSessionRequest("session-list", null, broken)) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("storage 不可用");
  });
});

describe("session-open targetUrl / session-focus（#37 批 C）", () => {
  it("targetUrlOf 注入则 session-open 应答带现查 URL；缺省 null", async () => {
    const f = face();
    await handleSessionRequest("session-new", { tabId: 3, title: "查价" }, f);
    const withUrl = {
      ...f,
      targetUrlOf: async () => "https://www.example.com/pricing",
    };
    const res = (await handleSessionRequest("session-open", { sessionId: "s1" }, withUrl)) as {
      ok: boolean;
      targetUrl?: string | null;
    };
    expect(res.ok).toBe(true);
    expect(res.targetUrl).toBe("https://www.example.com/pricing");
    const bare = (await handleSessionRequest("session-open", { sessionId: "s1" }, f)) as {
      targetUrl?: string | null;
    };
    expect(bare.targetUrl).toBeNull();
  });

  it("session-focus：聚焦回调带 meta.tabId；tab 不可用回错；缺注入回未启用", async () => {
    const f = face();
    await handleSessionRequest("session-new", { tabId: 3, title: "x" }, f);
    expect(await handleSessionRequest("session-focus", { sessionId: "s1" }, f)).toMatchObject({
      ok: false,
      error: "聚焦面未启用",
    });
    const focused: number[] = [];
    const withFocus = {
      ...f,
      focusTab: async (tabId: number) => {
        focused.push(tabId);
        return true;
      },
    };
    expect(await handleSessionRequest("session-focus", { sessionId: "s1" }, withFocus)).toEqual({
      ok: true,
    });
    expect(focused).toEqual([3]);
    const failing = { ...f, focusTab: async () => false };
    expect(await handleSessionRequest("session-focus", { sessionId: "s1" }, failing)).toMatchObject(
      { ok: false, error: "目标标签页不可用（已关闭？）" },
    );
    expect(
      await handleSessionRequest("session-focus", { sessionId: "ghost" }, withFocus),
    ).toMatchObject({ ok: false });
  });
});
