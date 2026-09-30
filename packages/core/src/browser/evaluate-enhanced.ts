// evaluate 增强（session.py :3735-3940）：args/elements 走 Runtime.callFunctionOn
// （this=document，CDP 编组参数——无字符串拼接无注入面）；frame 跨源 iframe 会话
// 切换；return_element_ids 节点回投 backendNodeId；语法自愈重试（evaluate-basic
// 的 syntaxRepairCandidates/delimiterScan/formatEvalException 在此接线——P4 移植
// 时「留 P4b」的欠账）。evaluateScript 单发子集不回归（settle/grid 消费面不变）。

import {
  delimiterScan,
  formatEvalException,
  normalizeEvalResult,
  syntaxRepairCandidates,
  validateAndFixJavascript,
} from "./evaluate-basic.js";
import type { SessionInternals } from "./transport.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface EvaluateRequest {
  code: string;
  args?: unknown[] | null;
  elements?: number[] | null;
  awaitPromise?: boolean;
  timeoutMs?: number | null;
  userGesture?: boolean;
  returnElementIds?: boolean;
  frame?: number | null;
}

/** Python %g 形态（totals-check 等回显）：6 位有效数字去尾零；指数 < -4 或 ≥ 6 时
 *  科学计数（指数两位零填充——"%g" % 1234567 == "1.23457e+06"、%g 尾零剥除） */
export function pyFormatG(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  // 指数在 6 位有效数字舍入之后判定（%g 语义：999999.5 → 舍入进位 1e6 → 科学计数）
  const rounded = Number(n.toPrecision(6));
  const exp = Math.floor(Math.log10(Math.abs(rounded)));
  if (exp < -4 || exp >= 6) {
    const [rawMant, rawExp] = rounded.toExponential(5).split("e");
    const mant = rawMant.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    const sign = rawExp.startsWith("-") ? "-" : "+";
    const digits = rawExp.replace(/^[+-]/, "").padStart(2, "0");
    return `${mant}e${sign}${digits}`;
  }
  const p = n.toPrecision(6);
  return String(Number.parseFloat(p));
}

/**
 * 在（通常跨源）iframe 上下文内执行的前置解析（:3778-3797）：frame backendNodeId
 * → frameId → Target.getTargets iframe 表（parentFrameId 匹配）→ attachToTarget
 * （flatten）。返回目标 sessionId；解析/附加失败抛 Error（Python RuntimeError 文案）。
 */
async function resolveFrameSessionId(s: SessionInternals, frame: number): Promise<string> {
  if (s.transport === null) throw new Error("Evaluate failed: no transport");
  const resolveIfr = await s.send<Record<string, unknown>>("DOM.resolveNode", {
    backendNodeId: frame,
  });
  const object = isRecord(resolveIfr.object) ? resolveIfr.object : {};
  const descIfr = await s.send<Record<string, unknown>>("DOM.describeNode", {
    objectId: object.objectId,
  });
  const node = isRecord(descIfr.node) ? descIfr.node : {};
  const frameId = node.frameId;
  const targets = await s.transport.send<Record<string, unknown>>("Target.getTargets", {});
  const infos = Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
  let targetId: string | null = null;
  for (const t of infos) {
    if (isRecord(t) && t.type === "iframe" && t.parentFrameId === frameId) {
      targetId = typeof t.targetId === "string" ? t.targetId : null;
      break;
    }
  }
  if (targetId === null) {
    throw new Error(
      `Evaluate failed: could not resolve iframe target for frame ${JSON.stringify(frameId ?? null)}`,
    );
  }
  try {
    const attached = await s.transport.send<Record<string, unknown>>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sid = attached.sessionId;
    if (typeof sid === "string" && sid !== "") return sid;
  } catch (e) {
    s.log(
      `Failed to attach to iframe target ${targetId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  throw new Error("Evaluate failed: could not attach to iframe target");
}

/** 增强版 evaluate（session.evaluate 全参数面——cdp_evaluator 的 CDPPageAdapter
 *  消费签名，架构 §10 对照）。异常 Error 上抛（handler 层包 "Evaluate failed:"）。 */
export async function evaluateEnhanced(s: SessionInternals, req: EvaluateRequest): Promise<string> {
  const validatedCode = validateAndFixJavascript(req.code);
  const awaitPromise = req.awaitPromise ?? true;
  const returnElementIds = req.returnElementIds ?? false;
  const userGesture = req.userGesture ?? false;
  const args = req.args ?? null;
  const elements = req.elements ?? null;
  let sid = s.currentSessionId;
  const sendTo = <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (s.transport === null) return Promise.reject(new Error("Evaluate failed: no transport"));
    return s.transport.send<T>(method, params, sid === null ? undefined : sid);
  };

  // 二.E: frame → 目标会话内执行
  if (req.frame !== undefined && req.frame !== null) {
    sid = await resolveFrameSessionId(s, req.frame);
  }

  // 二.D IN: 元素句柄解析（DOM.resolveNode）
  const elementOids: string[] = [];
  for (const bid of elements ?? []) {
    const r = await sendTo<Record<string, unknown>>("DOM.resolveNode", { backendNodeId: bid });
    const object = isRecord(r.object) ? r.object : {};
    const oid = object.objectId;
    if (typeof oid === "string") elementOids.push(oid);
  }
  const useCallFn = (args !== null && args.length > 0) || elementOids.length > 0;

  let result: Record<string, unknown>;
  if (useCallFn) {
    // call host = document（this=document）：DOM.getDocument + DOM.resolveNode，
    // 无需 executionContextId / 事件订阅
    const doc = await sendTo<Record<string, unknown>>("DOM.getDocument", { depth: 0 });
    const root = isRecord(doc.root) ? doc.root : {};
    const host = await sendTo<Record<string, unknown>>("DOM.resolveNode", {
      nodeId: root.nodeId,
    });
    const hostObject = isRecord(host.object) ? host.object : {};
    // JSON args 在前、元素句柄在后，故签名 function(...a, ...e)
    const argumentsList: Array<Record<string, unknown>> = [
      ...(args ?? []).map((a) => ({ value: a })),
      ...elementOids.map((o) => ({ objectId: o })),
    ];
    const paramsStr = elementOids.length > 0 ? "...a, ...e" : "...a";
    const funcDecl = `function(${paramsStr}){\n${validatedCode}\n}`;
    result = await sendTo<Record<string, unknown>>("Runtime.callFunctionOn", {
      objectId: hostObject.objectId,
      functionDeclaration: funcDecl,
      arguments: argumentsList,
      returnByValue: !returnElementIds,
      awaitPromise,
      userGesture,
    });
  } else {
    result = await sendTo<Record<string, unknown>>("Runtime.evaluate", {
      expression: validatedCode,
      returnByValue: !returnElementIds,
      awaitPromise,
      userGesture,
      timeout: req.timeoutMs ?? 30000,
    });
  }

  if (result.exceptionDetails !== undefined) {
    const exc = isRecord(result.exceptionDetails)
      ? (result.exceptionDetails as Record<string, unknown>)
      : {};
    // 编译期 SyntaxError 判定（issue #185 根因A）：text 恒 "Uncaught" 且 description
    // 以 "SyntaxError:" 开头；运行期异常（含内部 eval 抛的 SyntaxError——带 Uncaught
    // 前缀与堆栈）混入会误触发自愈，把可能有副作用的代码包 IIFE 重跑
    const excObj = isRecord(exc.exception) ? (exc.exception as Record<string, unknown>) : {};
    const text = String(exc.text ?? "");
    const desc = String(excObj.description ?? "");
    const compileTime = text === "Uncaught" && desc.startsWith("SyntaxError:");
    const errText = compileTime ? `${text} ${desc}` : "";
    // 单行 ASCII 载荷时 CDP 列偏移即 0-based 字符偏移（review5 #1 实证）；载荷含
    // astral 字符时按 UTF-16 码元系统性错位——非 ASCII 一律视为无位置证据
    const ln = exc.lineNumber;
    const col = exc.columnNumber;
    const isAscii = (str: string): boolean => {
      for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) > 0x7f) return false;
      }
      return true;
    };
    const errOffset =
      typeof ln === "number" &&
      ln === 0 &&
      typeof col === "number" &&
      col >= 0 &&
      col <= validatedCode.length &&
      isAscii(validatedCode)
        ? col
        : null;

    // 语法自愈（仅无输入路径——args/elements 模式代码在函数体内，裸 return 合法）
    if (!useCallFn) {
      for (const candidate of syntaxRepairCandidates(validatedCode, errText, errOffset)) {
        const retry = await sendTo<Record<string, unknown>>("Runtime.evaluate", {
          expression: candidate,
          returnByValue: !returnElementIds,
          awaitPromise,
          userGesture,
          timeout: req.timeoutMs ?? 30000,
        });
        const retryResult = isRecord(retry.result) ? retry.result : {};
        if (retry.exceptionDetails === undefined && retryResult.wasThrown !== true) {
          if (errText.includes("Unexpected token")) {
            s.log(
              `evaluate deletion-candidate self-heal applied (${errText.split("\n")[0].slice(0, 80)}; ` +
                `candidate head=${JSON.stringify(candidate.slice(0, 120))}) — verify semantics`,
            );
          } else {
            s.log(
              `evaluate syntax self-heal applied (${errText.split("\n")[0].slice(0, 80)} → retry succeeded)`,
            );
          }
          result = retry;
          break;
        }
      }
    }
    if (result.exceptionDetails !== undefined) {
      let msg = formatEvalException(result.exceptionDetails, validatedCode);
      const [hintStack, hintExtra] = delimiterScan(validatedCode);
      const trigger =
        (errText.includes("Unexpected end of input") || errText.includes("Unexpected token")) &&
        (hintStack.length > 0 || hintExtra >= 0);
      if (trigger) {
        msg +=
          "\n⚠️ The code likely has unbalanced braces/parens " +
          "(in measured history this V8 error almost always " +
          "means delimiters never matched rather than transport " +
          "truncation — but note regex literals can also trip " +
          "this check). Verify an IIFE prefix `((function(){...` " +
          "has its matching `))` / `)())` suffix; keep code under " +
          "~300 chars or split into several evaluate calls.";
      }
      throw new Error(msg);
    }
  }

  const resultData = isRecord(result.result) ? result.result : {};
  if (resultData.wasThrown === true) {
    throw new Error("JavaScript execution failed (wasThrown=true)");
  }
  // 二.D OUT: 返回的 DOM 节点 → backendNodeId（== 可操作的 index/element_id）
  if (
    returnElementIds &&
    resultData.type === "object" &&
    resultData.subtype === "node" &&
    typeof resultData.objectId === "string"
  ) {
    const desc = await sendTo<Record<string, unknown>>("DOM.describeNode", {
      objectId: resultData.objectId,
    });
    const node = isRecord(desc.node) ? desc.node : {};
    if (typeof node.backendNodeId === "number") {
      return `backendNodeId:${node.backendNodeId}`;
    }
  }
  return normalizeEvalResult(resultData);
}
