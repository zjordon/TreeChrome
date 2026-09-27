// 页面 HTML 获取（extract 前置）。移植自 TreeWalker session.py:3690-3712 @640d52a：
// DOM.getDocument(depth=-1, pierce) 天然含 shadow DOM 与同源 iframe 的 contentDocument，
// 经 html-source 重建干净 HTML；失败返回 ""（动作层降级 execute_js outerHTML）。

import { documentBodyToHtml } from "./html-source.js";
import type { SessionInternals } from "./transport.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export interface GetPageHtmlOptions {
  extractLinks?: boolean;
  extractImages?: boolean;
}

export async function getPageHtml(
  s: SessionInternals,
  options: GetPageHtmlOptions = {},
): Promise<string> {
  try {
    const doc = await s.send<Record<string, unknown>>("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const root = isRecord(doc) ? doc.root : {};
    return documentBodyToHtml(root, options);
  } catch (e) {
    s.log(`get_page_html: DOM.getDocument failed: ${String(e)}`);
    return "";
  }
}
