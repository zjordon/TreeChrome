// evaluate 动作（actions.py :2730-2815）：参数守卫（registry 不校验 execute 路径）
// → browser.evaluateEnhanced → backendNodeId 回显 / data:image 抽取 / 大结果分级
// 落盘 / 长短期记忆拆分。_eval_long_term_memory :269-283 / _extract_data_images
// :285-302 逐字节锚定 batch2c.json。
// 微偏离：Python json.dumps 预检对 set/map 抛 TypeError——TS 以 assertJsonable 等价
// 拦截（Set/Map/BigInt/function/symbol/undefined）；elements 的 bool（Python int 子类
// 可过）在 TS 按严格 number 拒——LLM 参数面的安全收紧。

import { ActionResult } from "../../agent/views.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import { saveOversizedResult } from "./shared/format.js";

/** :266 回显上限（短结果原样入记忆，长结果折叠为长度摘要） */
const EVAL_MEMORY_ECHO_MAX = 200;

/** :269-283 短期逐字回显 / 长度折叠 */
export function evalLongTermMemory(text: string): string {
  if (text.length <= EVAL_MEMORY_ECHO_MAX) return text;
  return `JavaScript executed successfully, result length: ${text.length} characters.`;
}

const DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

/** :285-302 data:image base64 URI → [image N] 占位，列表随 metadata 出（不撑上下文） */
export function extractDataImages(text: string): [string, string[]] {
  const images: string[] = [];
  const replaced = text.replace(DATA_IMAGE_RE, (m) => {
    images.push(m);
    return `[image ${images.length}]`;
  });
  return [replaced, images];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Python json.dumps 可序列化预检的等价拦截（Set/Map/BigInt/function/symbol/undefined） */
function assertJsonable(v: unknown, depth = 0): void {
  if (depth > 64) throw new Error("Object of type set is not JSON serializable");
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return;
  if (typeof v === "bigint") {
    throw new Error("Object of type set is not JSON serializable");
  }
  if (typeof v === "function" || typeof v === "symbol" || typeof v === "undefined") {
    throw new Error("Object of type set is not JSON serializable");
  }
  if (v instanceof Set) throw new Error("Object of type set is not JSON serializable");
  if (v instanceof Map) throw new Error("Object of type map is not JSON serializable");
  if (Array.isArray(v)) {
    for (const item of v) assertJsonable(item, depth + 1);
    return;
  }
  if (isRecord(v)) {
    for (const item of Object.values(v)) assertJsonable(item, depth + 1);
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createEvaluateHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    const code = params.code;
    if (code === undefined || code === null) {
      return new ActionResult({ error: "Evaluate failed: missing required param `code`." });
    }
    const awaitPromise = params.await_promise ?? true;
    const timeoutMs = params.timeout_ms ?? null;
    const userGesture = params.user_gesture ?? false;
    const args = params.args ?? null;
    const elements = params.elements ?? null;
    const returnElementIds = params.return_element_ids ?? false;
    const frame = params.frame ?? null;
    const extractImages = params.extract_images === true;
    if (
      timeoutMs !== null &&
      !(typeof timeoutMs === "number" && 1 <= timeoutMs && timeoutMs <= 300000)
    ) {
      return new ActionResult({
        error: `Evaluate failed: timeout_ms must be in [1, 300000], got ${timeoutMs}`,
      });
    }
    if (args !== null) {
      // 进 CDP 前先验可序列化（Python json.dumps TypeError 的等价拦截）
      try {
        assertJsonable(args);
      } catch (e) {
        return new ActionResult({
          error: `Evaluate failed: args not JSON-serializable: ${errText(e)}`,
        });
      }
    }
    if (
      elements !== null &&
      (!Array.isArray(elements) ||
        !elements.every((i) => typeof i === "number" && Number.isInteger(i)))
    ) {
      return new ActionResult({
        error: "Evaluate failed: elements must be a list of ints (backend node ids)",
      });
    }
    let text: string;
    try {
      text = await browser.evaluateEnhanced({
        code: code as string,
        args: args as unknown[] | null,
        elements: elements as number[] | null,
        awaitPromise: awaitPromise === true,
        timeoutMs: timeoutMs as number | null,
        userGesture: userGesture === true,
        returnElementIds: returnElementIds === true,
        frame: frame as number | null,
      });
    } catch (e) {
      ctx.log(`evaluate(${JSON.stringify(String(code).slice(0, 120))}) failed: ${errText(e)}`);
      return new ActionResult({ error: `Evaluate failed: ${errText(e)}` });
    }
    // 二.D OUT: 节点回投 → 可操作 index 回显
    if (text.startsWith("backendNodeId:")) {
      const bid = text.split(":", 2)[1];
      const visible =
        `Returned element backend node id: ${bid} ` +
        "(usable as index/element_id for click/input_text; " +
        "if not in current selector_map, call get_state to refresh)";
      return new ActionResult({
        extractedContent: visible,
        longTermMemory: `evaluate returned element index ${bid}`,
      });
    }
    // 二.F: 抽出 base64 图片（metadata 携带，extracted 留占位）
    let metadata: Record<string, unknown> | null = null;
    if (extractImages) {
      const [replaced, images] = extractDataImages(text);
      text = replaced;
      if (images.length > 0) metadata = { images };
    }
    // 二.A: 大结果分级落盘
    const tr = ctx.truncation;
    const savedTo = await saveOversizedResult(text, {
      prefix: "evaluate",
      outputDir: tr.evalOutputDir,
      ext: "txt",
      threshold: tr.evalSaveThreshold,
      fs: ctx.fs,
      log: ctx.log,
    });
    let visible: string;
    let memory: string;
    if (savedTo !== null) {
      visible =
        `Evaluate result (${text.length} chars) saved to ${savedTo}. Preview: ${text.slice(0, 200)}...`.trim();
      memory = `JavaScript executed successfully, result saved: ${savedTo}`;
    } else {
      visible = text.slice(0, tr.evalResultMaxChars);
      memory = evalLongTermMemory(text);
    }
    return new ActionResult({
      extractedContent: visible,
      longTermMemory: memory,
      ...(metadata !== null ? { metadata } : {}),
    });
  };
}
