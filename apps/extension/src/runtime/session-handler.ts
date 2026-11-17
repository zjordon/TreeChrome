// 会话单发处理器（issue #35 U1a W6）：镜像 options-handler 形态——session-new/
// list/open/rename/delete 请求-应答（sendMessage 单发，Port 只承载推送广播）；
// queue-add/remove 协议预留回 not-supported（U2 实现——D6 防先型 breaking）。
// 全路径 fail-soft：异常/坏载荷回 {ok:false,error} 不炸通道。notifyUpdated 广播
// session-updated（实现侧必须自吞异常——通知失败不改变 op 结果，notifyDrafts 先例）。

import type { SessionOp } from "@tw/protocol";
import type { SessionRepository } from "./session-repo.js";

/** session 面：宿主 boot 装配注入 */
export interface SessionFace {
  repo: SessionRepository;
  /** 会话面变更广播（boot 闭包接 portServer；reason 见 SwSessionUpdatedMessage） */
  notifyUpdated: (
    sessionId: string | undefined,
    reason: "turn" | "archive" | "index" | "queue",
  ) => void;
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
        return { ok: true, record };
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
      case "queue-add":
      case "queue-remove":
        // 协议先型预留（D6）：U2 落地排队面——本期明确回 not-supported
        return { ok: false, error: "排队功能尚未提供（U2）——请等本轮结束或停止后重发" };
      default:
        return { ok: false, error: `未知操作：${op}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
