// Tab 管理：getTabs/switchTab/closeTab/createTab。移植自 TreeWalker session.py
// :3617-3670 @640d52a。switchTab 清缓存 + 重挂 file-chooser 拦截（per-session，
// Bug-1 回归源）+ settle；不重发域 enable（Python 现状，p4/01 §3.2 登记复核项）——
// 例外：Overlay.enable 随拦截一并重发（偏离修复，见 connection.ts 头注释）。
// Target.* 浏览器级命令一律不绑 sessionId 发送（Python 同款；评审轮 1 #8——关闭当前
// tab 后旧 session 已销毁，绑定发送会命中 "Session with given id not found"）。

import { enableFileChooserIntercept, enableOverlay } from "./connection.js";
import { waitForReadyStateSettle } from "./navigation.js";
import type { SessionInternals } from "./transport.js";
import type { TabInfo } from "./views.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 浏览器级命令发送（无 sessionId——Target.* 域与页面会话无关） */
function browserSend<T>(method: string, s: SessionInternals, params?: object): Promise<T> {
  if (!s.transport) throw new Error(`tabs: not connected (${method})`);
  return s.transport.send<T>(method, params);
}

/** 列出 page 类型 target（单次 Target.getTargets；异常吞掉返空） */
export async function getTabs(s: SessionInternals): Promise<TabInfo[]> {
  const tabs: TabInfo[] = [];
  try {
    const targets = await browserSend<Record<string, unknown>>("Target.getTargets", s, {});
    for (const t of Array.isArray(targets.targetInfos) ? targets.targetInfos : []) {
      if (isRecord(t) && t.type === "page" && typeof t.targetId === "string") {
        tabs.push({
          targetId: t.targetId,
          url: typeof t.url === "string" ? t.url : "",
          title: typeof t.title === "string" ? t.title : "",
        });
      }
    }
  } catch {
    // 与 Python 同款：吞掉
  }
  return tabs;
}

/** 切换 tab（:3637-3651）：清两层缓存 → activate + attach → 重挂拦截 → settle */
export async function switchTab(s: SessionInternals, targetId: string): Promise<void> {
  s.clearSelectorMapCaches();
  await browserSend("Target.activateTarget", s, { targetId });
  const result = await browserSend<Record<string, unknown>>("Target.attachToTarget", s, {
    targetId,
    flatten: true,
  });
  s.currentTargetId = targetId;
  s.currentSessionId = String(result.sessionId);
  // file-chooser 拦截是 per-session 的：新 tab 必须重发，否则原生对话框回归；
  // Overlay.enable 同理（偏离修复——否则新 tab 上交互高亮回到未启用态）
  await enableFileChooserIntercept(s);
  await enableOverlay(s);
  s.log(`Switched to tab: ${targetId}`);
  await waitForReadyStateSettle(s);
}

/** 关 tab（:3653-3663）：关的是当前 tab 时切到剩余页，全无则开 about:blank */
export async function closeTab(s: SessionInternals, targetId: string): Promise<void> {
  const wasCurrent = targetId === s.currentTargetId;
  await browserSend("Target.closeTarget", s, { targetId });
  if (!wasCurrent) return;
  const targets = await browserSend<Record<string, unknown>>("Target.getTargets", s, {});
  for (const t of Array.isArray(targets.targetInfos) ? targets.targetInfos : []) {
    if (
      isRecord(t) &&
      t.type === "page" &&
      t.targetId !== targetId &&
      typeof t.targetId === "string"
    ) {
      await switchTab(s, t.targetId);
      return;
    }
  }
  await createTab(s, "about:blank"); // 无其他 page，避免 current_* 悬挂
}

/** 开新 tab（:3665-3670）：createTarget + switch，返回 targetId */
export async function createTab(s: SessionInternals, url = "about:blank"): Promise<string> {
  const result = await browserSend<Record<string, unknown>>("Target.createTarget", s, { url });
  const targetId = String(result.targetId);
  await switchTab(s, targetId);
  return targetId;
}
