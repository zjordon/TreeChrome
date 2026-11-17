// 会话单发处理器（issue #35 U1a W6 + #37 U2 批 A）：镜像 options-handler 形态——
// session-new/list/open/rename/delete + queue-add/queue-remove 请求-应答（sendMessage
// 单发，Port 只承载推送广播）。排队受理走注入的 queue 面（run-manager 队列器——
// 入队即尝试出队/节流续播/撤销）。全路径 fail-soft：异常/坏载荷回 {ok:false,error}
// 不炸通道。notifyUpdated 广播 session-updated（实现侧必须自吞异常——通知失败不改
// 变 op 结果，notifyDrafts 先例）。

import type { SessionOp } from "@tw/protocol";
import type { SessionRepository } from "./session-repo.js";

/** queue 面（#37 批 A）：run-manager 的排队受理（boot 闭包接线） */
export interface SessionQueueFace {
  add: (
    sessionId: string,
    task: string,
  ) => Promise<{ ok: true; turnId: string } | { ok: false; error: string }>;
  remove: (sessionId: string, turnId: string) => Promise<boolean>;
}

/** session 面：宿主 boot 装配注入 */
export interface SessionFace {
  repo: SessionRepository;
  /** 会话面变更广播（boot 闭包接 portServer；reason 见 SwSessionUpdatedMessage） */
  notifyUpdated: (
    sessionId: string | undefined,
    reason: "turn" | "archive" | "index" | "queue",
  ) => void;
  /** 排队受理（缺省不注入 = 排队面禁用——旧装配/测试兼容） */
  queue?: SessionQueueFace;
  /** 目标 tab 现查 URL（#37 批 C 目标条：缺省 null——无 tabs 注入的测试面） */
  targetUrlOf?: (tabId: number) => Promise<string | null>;
  /** 激活会话目标 tab（session-focus 消费；缺省回 false） */
  focusTab?: (tabId: number) => Promise<boolean>;
}

export async function handleSessionRequest(
  op: SessionOp,
  payload: unknown,
  face: SessionFace,
): Promise<unknown> {
  try {
    switch (op) {
      case "session-new": {
        const p = payload as { tabId?: unknown; title?: unknown } | null;
        const tabId = p?.tabId;
        // tabId 可缺省（0 = 未绑定占位——首个 run 绑定时 rebind）；title 可缺省
        if (tabId !== undefined && (typeof tabId !== "number" || !Number.isFinite(tabId))) {
          return { ok: false, error: "session-new 的 tabId 须为数字（可缺省）" };
        }
        const title = typeof p?.title === "string" && p.title !== "" ? p.title : "新会话";
        const meta = await face.repo.createSession({
          tabId: typeof tabId === "number" ? tabId : 0,
          origin: "user",
          title,
        });
        face.notifyUpdated(meta.sessionId, "index");
        return { ok: true, session: meta };
      }
      case "session-list":
        return { ok: true, sessions: await face.repo.listIndex() };
      case "session-open": {
        const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
        if (typeof sessionId !== "string" || sessionId === "") {
          return { ok: false, error: "session-open 需要 {sessionId}" };
        }
        const record = await face.repo.open(sessionId);
        // notFound 与存储异常可区分（评审轮 2 [5]）：UI 只在确认不存在时清当前
        // 指向，瞬时错误走 fail-soft 保留旧值待补查
        if (record === null) {
          return { ok: false, error: `会话不存在：${sessionId}`, notFound: true };
        }
        // 目标条（#37 批 C）：现查目标 tab URL（tab 已关/查询失败 → null 不渲染）
        const targetUrl =
          face.targetUrlOf !== undefined ? await face.targetUrlOf(record.meta.tabId) : null;
        return { ok: true, record, targetUrl };
      }
      case "session-focus": {
        const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
        if (typeof sessionId !== "string" || sessionId === "") {
          return { ok: false, error: "session-focus 需要 {sessionId}" };
        }
        if (face.focusTab === undefined) return { ok: false, error: "聚焦面未启用" };
        const record = await face.repo.open(sessionId);
        if (record === null) return { ok: false, error: `会话不存在：${sessionId}` };
        const focused = await face.focusTab(record.meta.tabId);
        return focused ? { ok: true } : { ok: false, error: "目标标签页不可用（已关闭？）" };
      }
      case "session-rename": {
        const p = payload as { sessionId?: unknown; title?: unknown } | null;
        if (
          typeof p?.sessionId !== "string" ||
          p.sessionId === "" ||
          typeof p?.title !== "string" ||
          p.title.trim() === ""
        ) {
          return { ok: false, error: "session-rename 需要 {sessionId, title}" };
        }
        const renamed = await face.repo.rename(p.sessionId, p.title.trim().slice(0, 100));
        if (renamed) face.notifyUpdated(p.sessionId, "index");
        return { ok: renamed };
      }
      case "session-delete": {
        const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
        if (typeof sessionId !== "string" || sessionId === "") {
          return { ok: false, error: "session-delete 需要 {sessionId}" };
        }
        const deleted = await face.repo.delete(sessionId);
        if (deleted) face.notifyUpdated(sessionId, "index");
        return { ok: deleted };
      }
      case "queue-add": {
        if (face.queue === undefined) {
          return { ok: false, error: "排队面未启用" };
        }
        const p = payload as { sessionId?: unknown; task?: unknown } | null;
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return { ok: false, error: "queue-add 需要 {sessionId, task}" };
        }
        if (typeof p?.task !== "string" || p.task.trim() === "") {
          return { ok: false, error: "queue-add 需要 {sessionId, task}" };
        }
        // 变更广播在 queue.add 内（入队成功才推 reason:"queue"）
        return face.queue.add(p.sessionId, p.task);
      }
      case "queue-remove": {
        if (face.queue === undefined) {
          return { ok: false, error: "排队面未启用" };
        }
        const p = payload as { sessionId?: unknown; turnId?: unknown } | null;
        if (typeof p?.sessionId !== "string" || typeof p?.turnId !== "string") {
          return { ok: false, error: "queue-remove 需要 {sessionId, turnId}" };
        }
        const ok = await face.queue.remove(p.sessionId, p.turnId);
        return { ok };
      }
      default:
        return { ok: false, error: `未知操作：${op}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
