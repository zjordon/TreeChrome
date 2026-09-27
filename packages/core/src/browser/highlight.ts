// 视觉高亮管理：CDP Overlay.highlightNode + JS 注入点击反馈/调试序号标签。
// 全量移植自 TreeWalker browser/highlight.py @640d52a。Python 的
// call_later(ensure_future(_safe_hide)) 在 TS 单线程下为 setTimeout + 浮动 Promise
// （失败静默）；executeJs 与 Overlay 发送经构造注入（连线延迟到 _connect，p4/01 §2）。

import type { DOMSelectorMap } from "@tw/dom-snapshot";
import type { Logger } from "../agent/action-shape.js";
import type { BoundSend } from "./transport.js";
import type { HighlightSettings } from "./views.js";

export interface HighlightManagerDeps {
  /** JS 注入通道（click 反馈/移除/调试标签——session 的 executeJs） */
  executeJs: (code: string) => Promise<unknown>;
  /** Overlay 域发送（_connect 后接线；null = 未连接期调用安全跳过） */
  send?: BoundSend | null;
  log?: Logger;
}

const DEFAULT_INTERACTION_COLOR = { r: 255, g: 165, b: 0, a: 0.8 };

export class HighlightManager {
  private readonly settings: HighlightSettings;
  private readonly executeJs: (code: string) => Promise<unknown>;
  private readonly log: Logger;
  private send: BoundSend | null;
  private scheduledHide: ReturnType<typeof setTimeout> | null = null;

  constructor(settings: HighlightSettings, deps: HighlightManagerDeps) {
    this.settings = settings;
    this.executeJs = deps.executeJs;
    this.send = deps.send ?? null;
    this.log = deps.log ?? (() => {});
  }

  /** _connect 后接线（对应 Python 的 _highlight._client/_session_id 赋值） */
  attach(send: BoundSend | null): void {
    this.send = send;
  }

  detach(): void {
    if (this.scheduledHide !== null) clearTimeout(this.scheduledHide);
    this.scheduledHide = null;
    this.send = null;
  }

  async highlightElement(backendNodeId: number): Promise<void> {
    if (!this.settings.enabled || !this.settings.interactionEnabled) return;
    try {
      const send = this.send;
      if (!send) return;
      const color = this.settings.interactionColor ?? DEFAULT_INTERACTION_COLOR;
      await send("Overlay.highlightNode", {
        highlightConfig: {
          borderColor: color,
          contentColor: {
            r: color.r,
            g: color.g,
            b: color.b,
            a: Math.round(color.a * 0.125 * 1000) / 1000,
          },
        },
        backendNodeId,
      });
      this.scheduledHide = setTimeout(() => {
        this.scheduledHide = null;
        void this.safeHideHighlight();
      }, this.settings.interactionDuration * 1000);
    } catch (e) {
      this.log(`Highlight failed (non-critical): ${String(e)}`);
    }
  }

  async highlightClickPoint(x: number, y: number): Promise<void> {
    if (!this.settings.enabled || !this.settings.clickFeedbackEnabled) return;
    const durationMs = Math.round(this.settings.clickFeedbackDuration * 1000);
    const jsCode = `
(function() {
	const x = ${x} + window.pageXOffset;
	const y = ${y} + window.pageYOffset;
	const ring = document.createElement('div');
	ring.setAttribute('data-sba-highlight', 'click');
	ring.style.cssText =
		'position:absolute; left:' + x + 'px; top:' + y + 'px; ' +
		'width:30px; height:30px; border:3px solid rgba(255,165,0,0.8); ' +
		'border-radius:50%; pointer-events:none; z-index:2147483647; ' +
		'transform:translate(-50%,-50%) scale(0.3); ' +
		'transition:all 0.2s ease-out;';
	document.body.appendChild(ring);
	requestAnimationFrame(function() {
		ring.style.transform = 'translate(-50%,-50%) scale(1)';
		ring.style.opacity = '0.8';
	});
	setTimeout(function() {
		ring.style.opacity = '0';
		ring.style.transform = 'translate(-50%,-50%) scale(1.5)';
		setTimeout(function() { ring.remove(); }, 300);
	}, ${durationMs});
})();
`;
    try {
      await this.executeJs(jsCode);
    } catch (e) {
      this.log(`Click highlight failed (non-critical): ${String(e)}`);
    }
  }

  async removeHighlights(): Promise<void> {
    const jsCode = `
(function() {
	document.querySelectorAll('[data-sba-highlight]').forEach(function(el) {
		el.remove();
	});
})();
`;
    try {
      await this.executeJs(jsCode);
    } catch (e) {
      this.log(`Remove highlights failed (non-critical): ${String(e)}`);
    }
  }

  /** selector_map 的可交互元素注入序号标签（调试模式；只给人看不进 LLM 图） */
  async addDebugHighlights(selectorMap: DOMSelectorMap): Promise<void> {
    if (!selectorMap || selectorMap.size === 0) return;
    const elementsJs: string[] = [];
    for (const [index, node] of selectorMap) {
      const pos = node.absolutePosition;
      if (!pos) continue;
      if (pos.width <= 0 || pos.height <= 0) continue;
      elementsJs.push(
        `{idx:${index}, x:${pos.x.toFixed(1)}, y:${pos.y.toFixed(1)}, ` +
          `w:${pos.width.toFixed(1)}, h:${pos.height.toFixed(1)}}`,
      );
    }
    if (elementsJs.length === 0) return;
    const color = this.settings.debugHighlightColor;
    const jsCode = `
(function() {
	const items = [${elementsJs.join(",")}];
	const container = document.createElement('div');
	container.id = 'sba-debug-highlights';
	container.setAttribute('data-sba-highlight', 'debug');
	items.forEach(function(item) {
		const box = document.createElement('div');
		box.setAttribute('data-sba-highlight', 'debug');
		box.style.cssText =
			'position:absolute; left:' + item.x + 'px; top:' + item.y + 'px; ' +
			'width:' + item.w + 'px; height:' + item.h + 'px; ' +
			'border:2px dashed ${color}; box-sizing:border-box; ' +
			'pointer-events:none; z-index:2147483647;';
		container.appendChild(box);
		const label = document.createElement('span');
		label.setAttribute('data-sba-highlight', 'debug');
		label.style.cssText =
			'position:absolute; left:' + item.x + 'px; top:' + (item.y - 18) + 'px; ' +
			'background:${color}; color:white; font-size:10px; ' +
			'padding:1px 4px; border-radius:2px; font-family:monospace; ' +
			'pointer-events:none; z-index:2147483647;';
		label.textContent = '[' + item.idx + ']';
		container.appendChild(label);
	});
	document.body.appendChild(container);
})();
`;
    try {
      await this.executeJs(jsCode);
    } catch (e) {
      this.log(`Debug highlights failed (non-critical): ${String(e)}`);
    }
  }

  private async safeHideHighlight(): Promise<void> {
    try {
      await this.send?.("Overlay.hideHighlight", {});
    } catch {
      // 与 Python 同款：吞掉
    }
  }
}
