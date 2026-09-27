// 元素指针：坐标三级回退、遮挡判定、真实/JS 点击。移植自 TreeWalker session.py
// :2440-2747 @640d52a。人工时序（勿优化）：click 三段 50/80/300ms；scrollIntoView
// 后 0.05s。

import { DOMRect } from "@tw/dom-snapshot";
import type { SessionInternals } from "./transport.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 视口坐标点击（:2444-2484）：mouseMoved→50ms→mousePressed→80ms→mouseReleased→300ms */
export async function clickAt(s: SessionInternals, x: number, y: number): Promise<void> {
  // 1) mouseMoved——hover 状态 / mousemove 监听器 / 反爬检测需要显式移动事件
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await s.sleep(50);
  // 2) mousePressed
  await s.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await s.sleep(80);
  // 3) mouseReleased
  await s.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await s.sleep(300); // 点击反馈动画 / SPA 局部更新窗口
  if (s.highlightSettings.enabled && s.highlightSettings.clickFeedbackEnabled) {
    await s.highlight.highlightClickPoint(x, y);
  }
}

/** 视口 (clientWidth, clientHeight)（:2602-2617）；失败 null（调用方优雅降级） */
export async function getViewportSize(s: SessionInternals): Promise<[number, number] | null> {
  try {
    const result = await s.send<Record<string, unknown>>("Page.getLayoutMetrics", {});
    const lv = isRecord(result.layoutViewport) ? result.layoutViewport : {};
    const w = Math.trunc(numberOr(lv.clientWidth, 0));
    const h = Math.trunc(numberOr(lv.clientHeight, 0));
    return w > 0 && h > 0 ? [w, h] : null;
  } catch {
    return null;
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

/**
 * 元素实时坐标（:2486-2566）三级回退：getContentQuads（取与视口交集最大 quad）
 * → getBoxModel → JS getBoundingClientRect。viewport 已取过的调用方传入避免重复。
 */
export async function getElementCoordinates(
  s: SessionInternals,
  backendNodeId: number,
  viewport?: [number, number] | null,
): Promise<DOMRect | null> {
  const vp = viewport === undefined ? await getViewportSize(s) : viewport;
  // Method 1: DOM.getContentQuads
  try {
    const result = await s.send<Record<string, unknown>>("DOM.getContentQuads", {
      backendNodeId,
    });
    const best = bestQuadRect(Array.isArray(result.quads) ? result.quads : [], vp);
    if (best) return best;
  } catch {
    // 与 Python 同款：吞掉进下一级
  }
  // Method 2: DOM.getBoxModel
  try {
    const result = await s.send<Record<string, unknown>>("DOM.getBoxModel", {
      backendNodeId,
    });
    const model = isRecord(result.model) ? result.model : {};
    const content = Array.isArray(model.content) ? model.content : [];
    if (content.length >= 8) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < 8; i += 2) {
        xs.push(Number(content[i]));
        ys.push(Number(content[i + 1]));
      }
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return new DOMRect(minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY);
    }
  } catch {
    // 吞掉
  }
  // Method 3: JS getBoundingClientRect()
  try {
    const resolve = await s.send<Record<string, unknown>>("DOM.resolveNode", {
      backendNodeId,
    });
    const object = isRecord(resolve.object) ? resolve.object : {};
    const objectId = object.objectId;
    if (typeof objectId !== "string") return null;
    const jsResult = await s.send<Record<string, unknown>>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        "function() {\n" +
        "    const rect = this.getBoundingClientRect();\n" +
        "    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };\n" +
        "}",
      returnByValue: true,
    });
    const inner = isRecord(jsResult.result) ? jsResult.result : {};
    const rect = isRecord(inner.value) ? inner.value : {};
    if (numberOr(rect.width, 0) > 0 && numberOr(rect.height, 0) > 0) {
      return new DOMRect(
        numberOr(rect.x, 0),
        numberOr(rect.y, 0),
        numberOr(rect.width, 0),
        numberOr(rect.height, 0),
      );
    }
  } catch {
    // 吞掉
  }
  return null;
}

/**
 * 取与视口交集最大的 quad 的外接矩形（:2568-2600）；视口未知/为空回退首个 quad。
 */
export function bestQuadRect(
  quads: unknown[],
  viewport: [number, number] | null | undefined,
): DOMRect | null {
  const rects: DOMRect[] = [];
  for (const quad of quads) {
    if (!Array.isArray(quad) || quad.length < 8) continue;
    const xs = [0, 2, 4, 6].map((i) => Number(quad[i]));
    const ys = [1, 3, 5, 7].map((i) => Number(quad[i]));
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    rects.push(new DOMRect(minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY));
  }
  if (rects.length === 0) return null;
  if (!viewport || viewport[0] <= 0 || viewport[1] <= 0) return rects[0];
  const [vw, vh] = viewport;
  const area = (r: DOMRect): number => {
    const iw = Math.max(0.0, Math.min(r.x + r.width, vw) - Math.max(r.x, 0.0));
    const ih = Math.max(0.0, Math.min(r.y + r.height, vh) - Math.max(r.y, 0.0));
    return iw * ih;
  };
  return rects.reduce((best, r) => (area(r) > area(best) ? r : best));
}

/**
 * 点击元素（:2619-2671）：scrollIntoView → 坐标中心（裁剪到视口）→ 未遮挡则
 * click_at；坐标缺失或被遮挡走 JS 回退。返回是否真的派发了点击。
 */
export async function clickElement(s: SessionInternals, backendNodeId: number): Promise<boolean> {
  // 1. 先滚入视野（best-effort）
  try {
    await s.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    await s.sleep(50);
  } catch {
    // 吞掉
  }
  const viewport = await getViewportSize(s);
  const rect = await getElementCoordinates(s, backendNodeId, viewport);
  if (rect) {
    let x = Math.trunc(rect.x + rect.width / 2);
    let y = Math.trunc(rect.y + rect.height / 2);
    if (viewport) {
      x = Math.max(0, Math.min(viewport[0] - 1, x));
      y = Math.max(0, Math.min(viewport[1] - 1, y));
    }
    if (!(await isElementOccluded(s, backendNodeId, x, y))) {
      await clickAt(s, x, y);
      return true;
    }
    s.log(
      `Element backendNodeId=${backendNodeId} is occluded at (${x},${y}), using JS click fallback`,
    );
  }
  // 2. 坐标拿不到 OR 被遮挡 → JS click 回退
  if (await jsClick(s, backendNodeId)) return true;
  s.log(`Could not click backendNodeId=${backendNodeId} (no coordinates and JS fallback failed)`);
  return false;
}

/**
 * 遮挡判定（:2673-2718）：elementFromPoint 命中目标或其祖先 → 未遮挡。best-effort：
 * 任何错误返回 false（视为未遮挡，几何点击照发）。x/y 走 arguments 不走插值（防注入）。
 */
export async function isElementOccluded(
  s: SessionInternals,
  backendNodeId: number,
  x: number,
  y: number,
): Promise<boolean> {
  try {
    const resolve = await s.send<Record<string, unknown>>("DOM.resolveNode", {
      backendNodeId,
    });
    const object = isRecord(resolve.object) ? resolve.object : {};
    const objectId = object.objectId;
    if (typeof objectId !== "string") return false;
    const result = await s.send<Record<string, unknown>>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        "function(x, y) {\n" +
        "    var hit = document.elementFromPoint(x, y);\n" +
        "    if (!hit) return true;  // 视口外或被遮挡\n" +
        "    var cur = hit;\n" +
        "    while (cur) {\n" +
        "        if (cur === this) return false;  // 命中目标或其祖先 -> 未遮挡\n" +
        "        cur = cur.parentElement;\n" +
        "    }\n" +
        "    return true;  // 命中无关元素 -> 被遮挡\n" +
        "}",
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    });
    const inner = isRecord(result.result) ? result.result : {};
    return Boolean(inner.value);
  } catch (e) {
    s.log(`_is_element_occluded failed (treating as not occluded): ${String(e)}`);
    return false;
  }
}

/** JS 回退点击（:2720-2747）：resolveNode + callFunctionOn this.click() */
export async function jsClick(s: SessionInternals, backendNodeId: number): Promise<boolean> {
  try {
    const resolve = await s.send<Record<string, unknown>>("DOM.resolveNode", {
      backendNodeId,
    });
    const object = isRecord(resolve.object) ? resolve.object : {};
    const objectId = object.objectId;
    if (typeof objectId !== "string") return false;
    await s.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function() { this.click(); }",
      returnByValue: true,
    });
    return true;
  } catch (e) {
    s.log(`_js_click failed: ${String(e)}`);
    return false;
  }
}
