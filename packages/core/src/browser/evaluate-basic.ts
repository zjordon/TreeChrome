// JS 通道基础版：executeJs/evalFunctionOnNode + evaluateScript（单发路径）+ LLM JS
// 修复/结果归一化/定界符扫描/语法修复候选/异常富化工具族。移植自 TreeWalker
// session.py:3674-3688（execute_js）、:4505-4529（eval_function_on_node）、
// :437-689（模块级 JS 通道工具）@640d52a。增强版 evaluate（frame 切换/args/elements/
// 语法自愈重试）整体 P4b（p4/02 §7）——本文件的 syntaxRepairCandidates 届时接入。

import type { SessionInternals } from "./transport.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 执行 JS 并返回值（Python execute_js：returnByValue + awaitPromise + 30s 超时） */
export async function executeJs(s: SessionInternals, code: string): Promise<unknown> {
  const result = await s.send<Record<string, unknown>>("Runtime.evaluate", {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
    timeout: 30000,
  });
  if ("exceptionDetails" in result) {
    const err = result.exceptionDetails;
    const text = isRecord(err) && typeof err.text === "string" ? err.text : String(err);
    throw new Error(`JS error: ${text}`);
  }
  const inner = isRecord(result.result) ? result.result : {};
  return inner.value;
}

/**
 * 在 backendNodeId 绑定元素上跑函数（this = 该元素，returnByValue）。CDP/JS 异常
 * 上抛（caller 兜底）。upload_identity（P4b）与 setter 族共用。
 */
export async function evalFunctionOnNode(
  s: SessionInternals,
  backendNodeId: number,
  functionDeclaration: string,
): Promise<unknown> {
  const resolve = await s.send<Record<string, unknown>>("DOM.resolveNode", { backendNodeId });
  const object = isRecord(resolve.object) ? resolve.object : {};
  const objectId = object.objectId;
  if (typeof objectId !== "string") {
    throw new Error("evalFunctionOnNode: resolveNode 未返回 objectId");
  }
  const result = await s.send<Record<string, unknown>>("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    returnByValue: true,
  });
  const inner = isRecord(result.result) ? result.result : {};
  return inner.value;
}

/**
 * evaluateScript：增强 evaluate 的单发子集（无 args/elements/frame 的裸代码路径，
 * settle/grid-kick/grid-meta 消费）：validateAndFix → Runtime.evaluate →
 * 异常富化上抛 / 结果归一化为字符串。P4b 接入语法自愈重试时在此扩展。
 */
export async function evaluateScript(
  s: SessionInternals,
  code: string,
  options: { awaitPromise?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const params: Record<string, unknown> = {
    expression: validateAndFixJavascript(code),
    returnByValue: true,
    awaitPromise: options.awaitPromise ?? true,
  };
  if (options.timeoutMs !== undefined) params.timeout = options.timeoutMs;
  const result = await s.send<Record<string, unknown>>("Runtime.evaluate", params);
  if ("exceptionDetails" in result) {
    throw new Error(formatEvalException(result.exceptionDetails, String(params.expression)));
  }
  return normalizeEvalResult(isRecord(result.result) ? result.result : {});
}

// ── 模块级 JS 通道工具（:437-689 全量）────────────────────────────────

/**
 * 修复 LLM 常见 JS 引号/转义错误（browser-use _validate_and_fix_javascript 同源）。
 * 纯正则清理；绝不把用户值插值进 JS。
 */
export function validateAndFixJavascript(code: string): string {
  // 1: 双重转义引号还原（\" -> "）
  let fixed = code.replace(/\\"/g, '"');
  // 2: 过度转义正则类还原（\\d -> \d、\\[ -> \[）
  fixed = fixed.replace(/\\\\([dDsSwWbBnrtfv])/g, "\\$1");
  fixed = fixed.replace(/\\\\([.*+?^${}()|[\]])/g, "\\$1");
  // 3-6: 混引号选择器 → 模板字面量（evaluate / querySelector / closest / matches）
  fixed = fixed.replace(/document\.evaluate\s*\(\s*"([^"]*)"\s*,/, "document.evaluate(`$1`,");
  fixed = fixed.replace(/(querySelector(?:All)?)\s*\(\s*"([^"]*)"\s*\)/g, "$1(`$2`)");
  fixed = fixed.replace(/\.closest\s*\(\s*"([^"]*)"\s*\)/g, ".closest(`$1`)");
  fixed = fixed.replace(/\.matches\s*\(\s*"([^"]*)"\s*\)/g, ".matches(`$1`)");
  // 7: JSON 少写一层反斜杠时 \n 被解析成真实换行进正则字面量——把单字符正则类里
  // 的裸控制字符转义回字面量形式（保守：只处理 /\n/ /\t/ /\r/（含 flags），不动其他结构）
  fixed = fixed.replace(/\/([\n\t\r])\/([a-z]*)/g, (_m, ch: string, flags: string) => {
    const esc = ch === "\n" ? "\\n" : ch === "\t" ? "\\t" : "\\r";
    return `/${esc}/${flags}`;
  });
  return fixed;
}

/**
 * Runtime.evaluate 结果值 → LLM 友好字符串（browser-use 同源 + bool/null 用 JS
 * 字面量 true/false/null，不带 Python repr 语义）。undefined → "undefined"。
 */
export function normalizeEvalResult(resultData: Record<string, unknown>): string {
  if (!("value" in resultData)) return "undefined"; // CDP 对 undefined 省略 value
  const value = resultData.value;
  if (isRecord(value) || Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "null";
  return String(value);
}

const CLOSE_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * 字符串/模板字面量与 // 注释感知的定界符扫描（issue #185-c2）。返回
 * [未闭合栈（按开序）, 首个错位闭合符下标（无则 -1）]。已知局限：regex 字面量内
 * 的括号会被误计（候选由编译试跑把关）；块注释不识别；模板 ${} 插值整体按字符串跳过。
 */
export function delimiterScan(code: string): [string[], number] {
  const stack: string[] = [];
  let inStr: string | null = null;
  let k = 0;
  const n = code.length;
  while (k < n) {
    const c = code[k];
    if (inStr !== null) {
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === "`") {
      inStr = c;
    } else if (c === "\\") {
      // regex 字面量转义（\/ \] \)）：非字符串区成对跳过
      k += 2;
      continue;
    } else if (c === "/" && k + 1 < n && code[k + 1] === "/") {
      // 行注释：跳到行尾（多行 evaluate 的注释后行仍有定界符）
      const nl = code.indexOf("\n", k);
      if (nl < 0) break;
      k = nl + 1;
      continue;
    } else if (c in CLOSE_OF) {
      stack.push(c);
    } else if (c === ")" || c === "]" || c === "}") {
      if (stack.length > 0 && CLOSE_OF[stack[stack.length - 1]] === c) {
        stack.pop();
      } else {
        return [stack, k]; // 首个错位闭合（多余/错序）
      }
    }
    k += 1;
  }
  return [stack, -1];
}

/** 按栈序逆置生成补全闭合串（(( → ))） */
export function closeOpenDelims(stack: string[]): string {
  return [...stack]
    .reverse()
    .map((c) => CLOSE_OF[c])
    .join("");
}

/**
 * 按已知 SyntaxError 生成确定性修复候选（按序试跑）。删除类候选与 CDP 出错位置
 * 交叉验证：无错位、位置分叉、或无位置证据一律 fail-safe 放弃（regex 幻影防护）。
 * 其余错误返回空列表（不自愈，原样抛出）。
 */
export function syntaxRepairCandidates(
  code: string,
  errText: string,
  errOffset?: number | null,
): string[] {
  if (errText.includes("Illegal return statement")) {
    const candidates = [`(()=>{\n${code}\n})()`];
    // 裸 return 叠加失衡——内层先补全闭合再包裹（仅 EOF 缺闭合形态）
    const [stack, firstExtra] = delimiterScan(code);
    if (stack.length > 0 && firstExtra < 0) {
      candidates.push(`(()=>{\n${code}${closeOpenDelims(stack)}\n})()`);
    }
    return candidates;
  }
  if (errText.includes("Missing catch or finally after try")) {
    const catchClause = "catch(e){return 'Error: '+e.message}";
    const candidates: string[] = [];
    // 形态①：括号均衡、仅缺 catch——插在最后一个 } 之前
    const idx = code.lastIndexOf("}");
    if (idx > 0) candidates.push(code.slice(0, idx) + catchClause + code.slice(idx));
    // 形态②：连函数闭合括号也缺——去掉尾部 })() 重建闭合
    if (code.endsWith("})()")) {
      candidates.push(`${code.slice(0, -4)}}${catchClause}})()`);
    }
    // 缺 catch 叠加失衡——内层补全闭合后再插 catch（仅 EOF 缺闭合形态）
    const [stack, firstExtra] = delimiterScan(code);
    if (stack.length > 0 && firstExtra < 0) {
      const balanced = code + closeOpenDelims(stack);
      const j = balanced.lastIndexOf("}");
      if (j > 0) candidates.push(balanced.slice(0, j) + catchClause + balanced.slice(j));
    }
    return candidates;
  }
  if (errText.includes("Unexpected end of input")) {
    const [stack] = delimiterScan(code);
    if (stack.length === 0) return [];
    const completion = closeOpenDelims(stack);
    const candidates = [code + completion];
    if (completion !== ")") candidates.push(`${code})`); // 最小修补：仅外层包裹括号漏配
    return candidates;
  }
  if (errText.includes("Unexpected token")) {
    // 多余闭合：删首个错位闭合符；候选②再删下一个错位。删除类必须与 CDP 出错
    // 位置（单行载荷 0-based 列偏移）交叉验证——分叉即 regex 幻影，fail-safe 放弃。
    const [, firstExtra] = delimiterScan(code);
    if (firstExtra < 0 || errOffset === undefined || errOffset === null) return [];
    if (errOffset !== firstExtra) return [];
    const candidates: string[] = [];
    let work = code;
    for (let round = 0; round < 2; round++) {
      const [, extra] = delimiterScan(work);
      if (extra < 0) break;
      if (candidates.length > 0) {
        // 候选②无 CDP 位置证据——仅限与首个已验证错位连排的同字符（}}/))/]] 笔误形态）
        if (extra !== firstExtra || work[extra] !== code[firstExtra]) break;
      }
      work = work.slice(0, extra) + work.slice(extra + 1);
      candidates.push(work);
    }
    return candidates;
  }
  return [];
}

/** CDP exceptionDetails → 调试富化错误消息（description 全量 + 代码片段截断） */
export function formatEvalException(exception: unknown, validatedCode: string): string {
  const exc = isRecord(exception) ? exception : {};
  const text = typeof exc.text === "string" ? exc.text : "Unknown error";
  const parts = [`JavaScript execution error: ${text}`];
  const inner = isRecord(exc.exception) ? exc.exception : {};
  const description = inner.description;
  if (typeof description === "string" && description && description !== text) {
    parts.push(description.slice(0, 500));
  }
  const snippet = validatedCode.slice(0, 500) + (validatedCode.length > 500 ? "..." : "");
  parts.push(`Validated code (after quote fixing):\n${snippet}`);
  return parts.join("\n");
}
