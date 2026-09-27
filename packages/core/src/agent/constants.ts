// step 层常量与纯文本辅助（偏离 8：Python 散落 step.py 顶部/尾部的常量收拢于此，
// 数值与文案逐一对照 @640d52a）。字节锚定 fixtures/python-anchors/agent.json。

import type { ModelOutput } from "./action-shape.js";
import { describeActionEntry, honestDoneAction, isRecord } from "./action-shape.js";

/** #176 P0-B / #197：参数校验内梯重试次数（视觉模型形状退化二连脆死 2→3） */
export const PARAM_VALIDATION_MAX_RETRIES = 3;
/** #197：外梯形状澄清重试次数（原硬编码 1），第二次降级去图 */
export const INVALID_ACTION_MAX_RETRIES = 2;
/** #194 Branch 2.5：LLM infra 指数退避 5,10,20,40,60 封顶（秒） */
export const INFRA_BACKOFF_BASE_S = 5.0;
export const INFRA_BACKOFF_CAP_S = 60.0;
/** #186 现象②：done 门禁每 run 封顶 + 重试内层小超时（秒） */
export const DONE_GATE_MAX_PER_RUN = 2;
export const DONE_GATE_RETRY_TIMEOUT_S = 60.0;
/** 视觉默认降采样目标（AgentSettings.llmScreenshotSize 缺省回落） */
export const DEFAULT_LLM_SCREENSHOT_SIZE: readonly [number, number] = [1400, 850];
/** 消息裁剪：默认尾部 20 条；compactor 启用放宽 3×（安全上限） */
export const TRIM_MESSAGES_DEFAULT = 20;

/** 连接类错误判定模式表（Branch 2；大小写不敏感子串） */
export const CONNECTION_ERROR_PATTERNS = [
  "websocket connection closed",
  "connection closed",
  "connection reset",
  "connection refused",
  "browser has been closed",
  "browser closed",
  "no browser",
] as const;

/** Branch 3：解析类错误标记（附模型名诊断行） */
export const LLM_PARSE_ERROR_MARKERS = [
  "no parseable response",
  "Could not parse",
  "tool_use_failed",
  "invalid output structure",
] as const;

/** 循环检测豁免动作（恒同哈希或终止性） */
export const LOOP_EXEMPT_ACTIONS: ReadonlySet<string> = new Set(["wait", "done", "go_back"]);

/** #197：无效动作的形状定向澄清（内外梯共用——泛化文案对缺 name 形态零纠错信息） */
export function invalidActionFeedback(response: unknown): string {
  const action = isRecord(response) ? response.action : null;
  let problem: string;
  if (!isRecord(response)) {
    problem = "your response was not a JSON object";
  } else if (!isRecord(action)) {
    problem = "your response contained no action object";
  } else if (!("name" in action)) {
    problem = "your action object is missing the required 'name' key";
  } else if (typeof action.name !== "string" || String(action.name).trim() === "") {
    problem = "your action's 'name' must be a non-empty string";
  } else {
    problem = "your action object was not usable";
  }
  return (
    `Your previous response could not be used: ${problem}. Every action ` +
    'MUST be an object like {"name": "click", "params": {"index": 5}}, ' +
    "where 'name' is one of the action names in the tool schema and " +
    "'params' is an object. Respond again with the agent_response tool, " +
    "including your evaluation, memory, next goal, and action."
  );
}

/** review7 #5：合成 done 挂 honestDone 带外标记（校验放行；variant B 不烧重试） */
export function fallbackDoneOutput(): ModelOutput {
  const action = honestDoneAction();
  action.params = {
    ...(action.params as Record<string, unknown>),
    text: "No action returned by LLM",
  };
  return {
    evaluation_previous_goal: "No action returned",
    memory: "",
    next_goal: "Ending task",
    action,
    actions: [action],
  };
}

/** 中断信号（Branch 1 不计失败；Act 阶段 stop/pause 检查 raise） */
export class InterruptedError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "InterruptedError";
  }
}

export function isConnectionError(e: unknown): boolean {
  if (e instanceof Error && e.name === "ConnectionError") return true;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return CONNECTION_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/** Branch 3 错误格式化（browser-use AgentError.format_error 的 TreeWalker 适配） */
export function formatStepError(error: unknown): string {
  const errorStr = error instanceof Error ? error.message : String(error);
  if (LLM_PARSE_ERROR_MARKERS.some((marker) => errorStr.includes(marker))) {
    const main = errorStr.split("\n", 1)[0];
    return (
      `${main}\n\nThe previous response had an invalid output structure. ` +
      "Please stick to the required output format."
    );
  }
  return errorStr;
}

// ── #186 现象②：done(success=True) 不确定标记扫描 ──────────────────────

// 词尾 ?：贴数字/标识符的悬而未决值（"Emma Davis=1?"）。(?<![\w?]) 排除 "???" 连问
// 与 token 中段；排除式前瞻 (?![\w?]) 覆盖括号/引号/句读包裹形态。
const TOKEN_Q_RE = /(?<![\w?])[\w.\-=]{1,64}\?(?![\w?])/g;
const URL_RE = /https?:\/\/\S+/g;
const UNCERTAIN_KEYWORDS = [
  "unknown",
  "unverified",
  "unread",
  "gap",
  "missing",
  "pending",
  "partial",
  "uncertain",
  "unclear",
  "not sure",
  "not verified",
  "not confirmed",
  "needs verification",
  "to verify",
  "to check",
] as const;
// 否定语境（"nothing missing"/"no gap"）——命中词前 25 字符窗口内出现否定词则不计；
// n't 缩写单列一枝不带前置 \b（isn't 的 n 前是字母）
const NEGATION_RE = /\b(?:no|nothing|not|none|without)\b|n't\b/g;
const NEGATION_WINDOW = 25;

/** 关键词-only 扫描（done.text 等对外交付物专用——词尾 ? 无引语豁免不扫） */
export function scanUncertaintyKeywords(text: string): string[] {
  if (!text) return [];
  const hits: string[] = [];
  const low = text.replace(URL_RE, "").toLowerCase();
  for (const kw of UNCERTAIN_KEYWORDS) {
    const kwRe = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    let m: RegExpExecArray | null = kwRe.exec(low);
    while (m !== null) {
      const windowStart = Math.max(0, m.index - NEGATION_WINDOW);
      const neg = lastMatch(NEGATION_RE, low.slice(windowStart, m.index));
      // "not sure/not verified/not confirmed" 自带否定词，不受窗口抑制
      if (neg === null || kw.startsWith("not ")) {
        if (!hits.includes(kw)) hits.push(kw);
        break;
      }
      m = kwRe.exec(low);
    }
  }
  return hits;
}

/** 正则是否有任一匹配（不消费全局 lastIndex） */
function lastMatch(re: RegExp, s: string): RegExpExecArray | null {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`).exec(s);
}

/** evaluation/memory 等自评文本的不确定标记扫描（去重保序、封顶 3 个样本） */
export function scanUncertaintyMarkers(...texts: string[]): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const add = (sample: string) => {
    if (hits.length >= 3 || seen.has(sample)) return;
    seen.add(sample);
    hits.push(sample);
  };
  for (const t of texts) {
    if (!t) continue;
    const stripped = t.replace(URL_RE, "");
    for (const m of stripped.matchAll(TOKEN_Q_RE)) add(m[0]);
    for (const kw of scanUncertaintyKeywords(stripped)) add(kw);
  }
  return hits;
}

/** 决策日志用：畸形响应的一句话诊断（外梯/内梯 warning 消息） */
export function describeResponseAction(response: unknown): string {
  if (isRecord(response)) return describeActionEntry(response.action);
  return "<non-dict>";
}
