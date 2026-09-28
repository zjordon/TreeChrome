// upload file input 的站点无关身份（agent/upload_identity.py :105-285 全量）：
// candidates 收集 / 全页 contexts 扫描 / clue 构建与 rect 谓词。纯 DOM 树 +
// 注入 browser 面（executeJs/evalFunctionOnNode），不直连 CDP。JS 常量 batch2b.json
// 逐字节锚定。重放精筛（rerun _match_file_upload_by_clue）是 P5 消费方。

import type { EnhancedDOMTreeNode } from "../../browser/views.js";

/** upload_identity.py :33-75 全页扫描版（document 序，单次 execute_js）——batch2b.json 逐字节 */
export const UPLOAD_INPUT_CONTEXTS_JS =
  "(()=>{const norm=s=>(s||'').replace(/\\s+/g,' ').trim();const out=[];document.querySelectorAll('input[type=file]').forEach(inp=>{const labelText=norm(Array.from(inp.labels||[]).map(l=>l.textContent||'').join(' '));const ariaText=norm((inp.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean).map(id=>document.getElementById(id)).filter(Boolean).map(el=>el.textContent||'').join(' '));let region='',p=inp.parentElement,depth=0;while(p&&depth<5&&!region){const t=norm(p.textContent||'');if(t&&t.length<200)region=t;p=p.parentElement;depth++;}const inDialog=!!(inp.closest('[role=dialog]')||inp.closest('[aria-modal=true]'));let a=inp.parentElement,affText='',affRole='',affTag='',affRect=null,d2=0;while(a&&d2<6&&!affText){const role=a.getAttribute('role');const click=a.tagName==='BUTTON'||role==='button'||a.tagName==='A'||a.tagName==='LABEL'||role==='link'||(window.getComputedStyle(a).cursor==='pointer');if(click){affText=norm(a.textContent||'');affRole=role||a.tagName.toLowerCase();affTag=a.tagName.toLowerCase();const ar=a.getBoundingClientRect();if(ar.width>0&&ar.height>0)affRect={x:ar.x,y:ar.y,width:ar.width,height:ar.height};}a=a.parentElement;d2++;}let cRect=null,c=inp.parentElement,d3=0;while(c&&d3<6){const r=c.getBoundingClientRect();if(r.width>0&&r.height>0){cRect={x:r.x,y:r.y,width:r.width,height:r.height};break;}c=c.parentElement;d3++;}out.push({accept:(inp.getAttribute('accept')||'').toLowerCase(),label_text:labelText,aria_text:ariaText,region_text:region,in_dialog:inDialog,affordance_text:affText,affordance_role:affRole,affordance_tag:affTag,affordance_rect:affRect,container_rect:cRect});});return out;})()";

/** upload_identity.py :77-104 单元素版（this=input，callFunctionOn）——坑③：不走计数对齐 */
export const UPLOAD_INPUT_CONTEXT_ON_ELEMENT_JS =
  "function(){const inp=this;if(!inp||inp.tagName!=='INPUT'||(inp.type||'').toLowerCase()!=='file')return null;const norm=s=>(s||'').replace(/\\s+/g,' ').trim();const labelText=norm(Array.from(inp.labels||[]).map(l=>l.textContent||'').join(' '));const ariaText=norm((inp.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean).map(id=>document.getElementById(id)).filter(Boolean).map(el=>el.textContent||'').join(' '));let region='',p=inp.parentElement,depth=0;while(p&&depth<5&&!region){const t=norm(p.textContent||'');if(t&&t.length<200)region=t;p=p.parentElement;depth++;}const inDialog=!!(inp.closest('[role=dialog]')||inp.closest('[aria-modal=true]'));let a=inp.parentElement,affText='',affRole='',affTag='',affRect=null,d2=0;while(a&&d2<6&&!affText){const role=a.getAttribute('role');const click=a.tagName==='BUTTON'||role==='button'||a.tagName==='A'||a.tagName==='LABEL'||role==='link'||(window.getComputedStyle(a).cursor==='pointer');if(click){affText=norm(a.textContent||'');affRole=role||a.tagName.toLowerCase();affTag=a.tagName.toLowerCase();const ar=a.getBoundingClientRect();if(ar.width>0&&ar.height>0)affRect={x:ar.x,y:ar.y,width:ar.width,height:ar.height};}a=a.parentElement;d2++;}let cRect=null,c=inp.parentElement,d3=0;while(c&&d3<6){const r=c.getBoundingClientRect();if(r.width>0&&r.height>0){cRect={x:r.x,y:r.y,width:r.width,height:r.height};break;}c=c.parentElement;d3++;}return {accept:(inp.getAttribute('accept')||'').toLowerCase(),label_text:labelText,aria_text:ariaText,region_text:region,in_dialog:inDialog,affordance_text:affText,affordance_role:affRole,affordance_tag:affTag,affordance_rect:affRect,container_rect:cRect};}";

/** 身份上下文（两条 JS 探针的共同产物形态） */
export interface UploadInputContext {
  accept?: string;
  label_text?: string;
  aria_text?: string;
  region_text?: string;
  in_dialog?: boolean;
  affordance_text?: string;
  affordance_role?: string;
  affordance_tag?: string;
  affordance_rect?: Record<string, unknown> | null;
  container_rect?: Record<string, unknown> | null;
}

const UPLOAD_VIDEO_EXTS = new Set([
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "flv",
  "wmv",
  "m4v",
  "ts",
  "3gp",
  "mpeg",
  "mpg",
]);
const UPLOAD_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "tif",
  "tiff",
  "svg",
  "heic",
]);

/** captureUploadClue 消费的最小 browser 面（BrowserSession 结构满足） */
export interface UploadClueBrowserFace {
  evalFunctionOnNode(backendNodeId: number, functionDeclaration: string): Promise<unknown>;
}

/** uploadInputContexts 消费的最小 browser 面 */
export interface UploadContextsBrowserFace {
  executeJs(code: string): Promise<unknown>;
}

const extOf = (path: string): string => {
  const base = path.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
};

/**
 * :105-130 收集 accept（kind）匹配的 file input 候选（selector_map 迭代顺序）。
 * kind 优先取自 acceptHint（change 瞬间真实 accept），否则按 path 扩展名推断。
 */
export function fileInputCandidates(
  selectorMap: Map<number, EnhancedDOMTreeNode>,
  opts: { acceptHint?: string; path?: string } = {},
): Array<[number, EnhancedDOMTreeNode]> {
  let kind: "video" | "image" | null = null;
  if (opts.acceptHint !== undefined && opts.acceptHint !== "") {
    const ah = opts.acceptHint.toLowerCase();
    kind = ah.includes("video") ? "video" : ah.includes("image") ? "image" : null;
  } else {
    const ext = extOf(opts.path ?? "");
    kind = UPLOAD_VIDEO_EXTS.has(ext) ? "video" : UPLOAD_IMAGE_EXTS.has(ext) ? "image" : null;
  }
  const candidates: Array<[number, EnhancedDOMTreeNode]> = [];
  for (const [idx, node] of selectorMap) {
    const attrs = node.attributes ?? {};
    if (node.tagName.toUpperCase() !== "INPUT" || (attrs.type ?? "").toLowerCase() !== "file") {
      continue;
    }
    if (kind === null || (attrs.accept ?? "").toLowerCase().includes(kind)) {
      candidates.push([idx, node]);
    }
  }
  return candidates;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * :131-167 单次 execute_js 返回每个 file input 的身份上下文，按 DOM 序下标与
 * candidates 对齐。失败/非 list/kind 过滤后数量不符（坑③）→ 空 Map 降级。
 */
export async function uploadInputContexts(
  browser: UploadContextsBrowserFace,
  candidates: Array<[number, EnhancedDOMTreeNode]>,
  kind = "",
): Promise<Map<number, UploadInputContext>> {
  const out = new Map<number, UploadInputContext>();
  if (candidates.length === 0) return out;
  let arr: unknown;
  try {
    arr = await browser.executeJs(UPLOAD_INPUT_CONTEXTS_JS);
  } catch {
    return new Map();
  }
  if (!Array.isArray(arr)) return new Map();
  const entries = arr.filter(
    (en) => isRecord(en) && (kind === "" || String(en.accept ?? "").includes(kind)),
  );
  if (entries.length !== candidates.length) return new Map();
  candidates.forEach(([idx], i) => {
    out.set(idx, entries[i] as UploadInputContext);
  });
  return out;
}

/** :170-181 rect 是否 width/height 之一 > 0；None/非法 false */
export function nonzeroRect(r: unknown): boolean {
  if (!isRecord(r)) return false;
  let w: number;
  let h: number;
  try {
    w = Number(r.width ?? 0) || 0;
    h = Number(r.height ?? 0) || 0;
  } catch {
    return false;
  }
  return w > 0 || h > 0;
}

/** :183-205 线索里首个非零 rect（rect → container_rect → trigger_affordance.rect） */
export function effectiveClueRect(clue: Record<string, unknown>): unknown {
  const rect = clue.rect;
  if (nonzeroRect(rect)) return rect;
  const cr = clue.container_rect;
  if (nonzeroRect(cr)) return cr;
  const aff = clue.trigger_affordance;
  if (isRecord(aff) && nonzeroRect(aff.rect)) return aff.rect;
  return rect;
}

/** :207-225 DOMRect-like / dict → {x,y,width,height}；失败 null */
export function boundsToDict(bounds: unknown): Record<string, number> | null {
  if (bounds === null || bounds === undefined) return null;
  if (isRecord(bounds)) return bounds as Record<string, number>;
  return {
    x: Number((bounds as { x?: number }).x ?? 0) || 0,
    y: Number((bounds as { y?: number }).y ?? 0) || 0,
    width: Number((bounds as { width?: number }).width ?? 0) || 0,
    height: Number((bounds as { height?: number }).height ?? 0) || 0,
  };
}

/**
 * :227-260 从选中 input 的 node + 身份上下文构建线索（与手工录制 _store_upload_clue
 * 同形；不含 _semantic_clue/kind——由 4.4 finalize 投影时补）。
 */
export function buildUploadClue(
  node: EnhancedDOMTreeNode,
  ctxEntry: UploadInputContext,
): Record<string, unknown> {
  const accept = node.attributes.accept ?? "";
  const bounds = node.snapshotNode?.bounds ?? null;
  const clue: Record<string, unknown> = {
    xpath: node.xpath ?? null,
    tag: (node.tagName || "input").toLowerCase(),
    rect: boundsToDict(bounds),
    accept,
    label_text: ctxEntry.label_text ?? "",
    aria_text: ctxEntry.aria_text ?? "",
    region_text: ctxEntry.region_text ?? "",
    in_dialog: ctxEntry.in_dialog === true,
    container_rect: ctxEntry.container_rect ?? null,
  };
  const affText = (ctxEntry.affordance_text ?? "").trim();
  if (affText !== "") {
    clue.trigger_affordance = {
      text: affText,
      role: ctxEntry.affordance_role || "",
      tag: ctxEntry.affordance_tag || "",
      rect: ctxEntry.affordance_rect ?? ctxEntry.container_rect,
    };
  }
  return clue;
}

/**
 * :261-285 为【实际命中】的 input 采集语义线索（#151）。best-effort：节点不在
 * selector_map / 探针失败 / 任何异常 → null（绝不阻塞上传）。
 */
export async function captureUploadClue(
  browser: UploadClueBrowserFace,
  selectorMap: Map<number, EnhancedDOMTreeNode>,
  backendId: number,
): Promise<Record<string, unknown> | null> {
  try {
    let node: EnhancedDOMTreeNode | null = null;
    for (const n of selectorMap.values()) {
      if (n.backendNodeId === backendId) {
        node = n;
        break;
      }
    }
    if (node === null) return null;
    // 目标元素自身提取（resolveNode+callFunctionOn this=input），不走计数对齐
    const ctx = await browser.evalFunctionOnNode(backendId, UPLOAD_INPUT_CONTEXT_ON_ELEMENT_JS);
    if (!isRecord(ctx)) return null;
    return buildUploadClue(node, ctx as UploadInputContext);
  } catch {
    return null;
  }
}
