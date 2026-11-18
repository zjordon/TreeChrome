// 导出 HTML（issue #39 U3 批 D，验收④）：转录条目 → 自包含静态单文件（内联
// cssText + 零脚本）。结构复用转录类名体系（tc-transcript-user/tc-card 等——
// 与面板同源保证结构一致）；文案与 RunTimeline/EventLine 同口径的简化事件行
//（工具卡/等待态 live 块/多轮边界均覆盖）。markdown 不在导出面重渲染（无 JS），
// finalResult 以 pre-wrap 文本呈现——登记偏离（D8）。

import type { JournalEvent } from "@tw/protocol";
import type { TranscriptItem } from "./transcript.js";

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** HTML 文本转义（属性/文本双用） */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESC[c] ?? c);
}

const RUN_STATUS_LABEL: Record<string, string> = {
  live: "运行中",
  done: "完成",
  error: "出错",
  interrupted: "已中断",
};

const TURN_STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  done: "完成",
  error: "出错",
  interrupted: "已中断",
  cancelled: "已取消",
};

/** 事件行（RunTimeline EventLine 的导出同口径——防御收窄 data） */
function eventLineHtml(e: JournalEvent): string {
  const d: Record<string, unknown> =
    typeof e.data === "object" && e.data !== null && !Array.isArray(e.data)
      ? (e.data as Record<string, unknown>)
      : {};
  const str = (k: string): string | null => (typeof d[k] === "string" ? (d[k] as string) : null);
  const num = (k: string): number | null => (typeof d[k] === "number" ? (d[k] as number) : null);
  switch (e.type) {
    case "step_start":
      return `<div class="tc-ev-muted">第 ${escapeHtml(String(num("step") ?? "?"))} 步开始</div>`;
    case "step_end": {
      const secs = num("durationSeconds");
      return `<div class="tc-ev-muted">第 ${escapeHtml(String(num("step") ?? "?"))} 步完成${
        secs !== null ? `（${secs}s）` : ""
      }</div>`;
    }
    case "tool_call": {
      const action = str("actionName") ?? e.type;
      const idx = num("elementIndex");
      return `<div>▸ ${escapeHtml(action)}${idx !== null ? ` #${idx}` : ""}</div>`;
    }
    case "tool_result": {
      const error = str("error");
      const ok = error === null && d.success !== false;
      const secs = num("durationSeconds");
      return ok
        ? `<div class="tc-ev-ok">✓ 动作成功${secs !== null ? `（${secs}s）` : ""}</div>`
        : `<div class="tc-ev-err">✗ ${escapeHtml((error ?? "动作失败").slice(0, 1000))}</div>`;
    }
    case "model_result": {
      const action = str("actionName");
      const goal = str("nextGoal");
      return `<div>✦ ${escapeHtml(action ?? "模型")}${
        goal !== null ? `：${escapeHtml(goal.slice(0, 500))}` : ""
      }</div>`;
    }
    default:
      return `<div class="tc-ev-muted">${escapeHtml(e.type)}</div>`;
  }
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export interface ExportHtmlOptions {
  /** 内联 CSS 文本（宿主注入——console-ui 不 import CSS 副作用进导出） */
  cssText: string;
  title: string;
}

/** 转录条目序列 → 自包含静态 HTML（零脚本——验收④离线打开） */
export function serializeTranscriptHtml(
  items: TranscriptItem[],
  options: ExportHtmlOptions,
): string {
  const body = items
    .map((item) => {
      if (item.kind === "user-turn") {
        const badge =
          item.status !== "done"
            ? `<span class="tc-badge">${escapeHtml(TURN_STATUS_LABEL[item.status] ?? item.status)}</span>`
            : "";
        const files =
          item.attachments.length > 0
            ? `<div class="tc-ev-muted">${item.attachments
                .map((a) => escapeHtml(a.name))
                .join(" · ")}</div>`
            : "";
        return `<div class="tc-transcript-user"><div>${escapeHtml(item.task)}${badge}</div>${files}</div>`;
      }
      const status = RUN_STATUS_LABEL[item.status] ?? item.status;
      const events = item.events.map(eventLineHtml).join("\n");
      const result =
        item.finalResult !== null
          ? `<p style="white-space:pre-wrap">${escapeHtml(item.finalResult)}</p>`
          : "";
      const err =
        item.lastError !== null ? `<p class="tc-ev-err">${escapeHtml(item.lastError)}</p>` : "";
      return `<section class="tc-card"><div class="tc-badge">${escapeHtml(status)}</div>${events}${err}${result}</section>`;
    })
    .join("\n");
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>${options.cssText}</style>`,
    "</head>",
    '<body><div class="tc-root"><main class="tc-shell-main">',
    `<h2>${escapeHtml(options.title)}</h2>`,
    '<div class="tc-transcript">',
    body || '<p class="tc-ev-muted">（空转录）</p>',
    "</div>",
    `<p class="tc-ev-muted">导出于 ${escapeHtml(timeOf(Date.now()))} · TreeChrome</p>`,
    "</main></div></body>",
    "</html>",
  ].join("\n");
}
