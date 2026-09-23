// 请求/响应侧变换：URL 缩写/还原、敏感值占位/还原、JSON 兜底解析、滤图、work 副本。
// 移植自 tree_walker/llm/client.py 同名私有方法（03 §3.2-3.4）；期望值锚定 Python 实跑，
// 见 test/llm/transforms.test.ts 头部命令与输出。

import { LLMProtocolViolationError } from "./errors.js";
import type { ChatMessage } from "./types.js";

/** URL 缩写阈值（Python _URL_MIN_LENGTH=100） */
export const URL_MIN_LENGTH = 100;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * URL 缩写：长度 ≥100 的 URL 换 [uN] 短标记，同 URL 同 tag（省 token），
 * tag 分配顺序 = 首次出现顺序（契约，锚定测试锁定）。只碰 user/assistant 的
 * TextBlock（Python 只处理 type=text block；toolResult 的 text 不动——对齐原实现）。
 * 就地改写传入的 work 消息（调用方保证是副本），返回 tag→原 URL 映射供还原。
 */
export function shortenUrlsInMessages(messages: ChatMessage[]): Map<string, string> {
  const urlMap = new Map<string, string>(); // tag → 原 URL
  const urlToTag = new Map<string, string>(); // 原 URL → tag
  let counter = 0;
  const shorten = (text: string): string =>
    text.replace(/https?:\/\/\S+/g, (url) => {
      if (url.length < URL_MIN_LENGTH) {
        return url;
      }
      const existing = urlToTag.get(url);
      if (existing !== undefined) {
        return existing;
      }
      const tag = `[u${counter}]`;
      counter += 1;
      urlMap.set(tag, url);
      urlToTag.set(url, tag);
      return tag;
    });

  for (const msg of messages) {
    if (msg.role === "toolResult") {
      continue;
    }
    for (const block of msg.blocks) {
      if (block.kind === "text") {
        block.text = shorten(block.text);
      }
    }
  }
  return urlMap;
}

/**
 * 敏感值占位：TextBlock 文本内 real→placeholder（多键按对象插入序替换——
 * 键有包含关系时顺序影响结果，Python dict 序等价，锚定测试覆盖）。
 * 就地改写 work 消息；map 为空/undefined 时不动。
 *
 * 已知取舍（对齐 Python `_filter_sensitive_in_messages` 只处理 type=text block）：
 * toolResult.text **不占位**——工具输出中的敏感值会明文发往端点。Python 原实现
 * 如此（P5 parity），修约属上游契约变更；P4 接 SecretProvider 时一并裁决。
 */
export function applySensitiveInMessages(
  messages: ChatMessage[],
  sensitiveMap: Record<string, string> | undefined,
): void {
  if (!sensitiveMap) {
    return;
  }
  // 空字符串键会让 replaceAll 逐字符插入占位符（无声损坏全文）——宿主侧失误防御
  const entries = Object.entries(sensitiveMap).filter(([real]) => real !== "");
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      continue;
    }
    for (const block of msg.blocks) {
      if (block.kind !== "text") {
        continue;
      }
      for (const [real, placeholder] of entries) {
        block.text = block.text.replaceAll(real, placeholder);
      }
    }
  }
}

function restoreInStrings(
  obj: unknown,
  replacements: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof obj === "string") {
    let out = obj;
    for (const [from, to] of replacements) {
      out = out.replaceAll(from, to);
    }
    return out;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => restoreInStrings(item, replacements));
  }
  if (isRecord(obj)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = restoreInStrings(v, replacements);
    }
    return out;
  }
  return obj;
}

/** 响应侧 URL 还原：toolInput 递归把 [uN] 换回原 URL（对象/数组/嵌套全走） */
export function restoreUrlsInOutput<T>(output: T, urlMap: Map<string, string>): T {
  if (urlMap.size === 0) {
    return output;
  }
  return restoreInStrings(output, [...urlMap.entries()]) as T;
}

/** 响应侧敏感值还原：placeholder→real，结构与 restoreUrlsInOutput 同 */
export function restoreSensitiveInOutput<T>(
  output: T,
  sensitiveMap: Record<string, string> | undefined,
): T {
  if (!sensitiveMap) {
    return output;
  }
  // entries 是 real→placeholder，还原方向取反（顺序仍按插入序，与 Python dict 一致）；
  // 滤空键（空占位符同样会让 replaceAll 逐字符插入，损坏全文）
  const reversed = Object.entries(sensitiveMap)
    .filter(([, placeholder]) => placeholder !== "")
    .map(([real, placeholder]) => [placeholder, real] as const);
  return restoreInStrings(output, reversed) as T;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * JSON 兜底解析（Python _try_parse_json 三级，逐级回退）：
 * 1. trim 后以 { 开头 → 直接 parse；
 * 2. ```(json)? 围栏内的 {…}（非贪婪）；
 * 3. 首个 { … 末个 } 的子串。
 * 全部失败返回 undefined。注意 "{}" 会解析成功返回空对象——调用方按
 * Python `if parsed:` 语义把空对象视为失败（client.ts 处理）。
 */
export function tryParseJson(text: string): Record<string, unknown> | undefined {
  const stripped = text.trim();
  if (stripped.startsWith("{")) {
    const direct = parseJsonObject(stripped);
    if (direct !== undefined) {
      return direct;
    }
  }
  const fence = /```(?:json)?\s*(\{.*?\})\s*```/s.exec(stripped);
  if (fence !== null) {
    const parsed = parseJsonObject(fence[1]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const parsed = parseJsonObject(stripped.slice(start, end + 1));
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * 滤图（fallback 切到无视觉模型后调用，Python _strip_image_blocks）：
 * 从 work 消息移除全部 ImageBlock。智谱端点对「文本模型+图」静默致盲不报错
 * （P0 实测），不滤只会得到困惑回答。块移空 = canonical 违例，抛
 * LLMProtocolViolationError 暴露（Python 退化为空串；TS canonical 无空块语义）。
 */
export function stripImageBlocks(messages: ChatMessage[], providerName: string): void {
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      continue;
    }
    const kept = msg.blocks.filter((b) => b.kind !== "image");
    if (kept.length !== msg.blocks.length) {
      if (kept.length === 0) {
        throw new LLMProtocolViolationError(
          "滤图后消息块为空（canonical 要求 user/assistant 消息恒有非 image 块）",
          { provider: providerName },
        );
      }
      msg.blocks = kept;
    }
  }
}

/**
 * work 副本：请求侧变换只落在副本上，不改动调用方消息（03 偏离 1）。
 * 复制会被改写的对象（消息对象、blocks 数组、TextBlock）；ImageBlock 与
 * toolResult 的字符串字段不可变，共享/浅拷贝即可。
 */
export function cloneWorkMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === "toolResult") {
      return { ...msg };
    }
    return {
      ...msg,
      blocks: msg.blocks.map((b) => (b.kind === "text" ? { ...b } : b)),
    };
  });
}
