// upload_file（actions.py :2147-2347，最大 handler）：白名单+存在性校验 → 多
// file input 纠偏（抖音 Semi 双 input Fix C #96）/ 唯一直用 / label 近邻 chooser
// 发现（issue #34）→ clue 采集（#151）→ 高亮+setFileInputFiles → accept 软校验 +
// 页面级验证探针（P1 四次修订轮询版）。全部 error 文案逐字节照搬。
// 偏离（p4b/02 §6）：非 ASCII 文件名 ASCII 临时副本不落核心（upload.ts 头注）；
// guessMime 用精简表（Python mimetypes 是平台注册表相关全表——锚定用例域内等价）。
// M5 段 C 净新增：附件 ref 二态（readAttachment 命中 → bytes 注入通道
// setFileInputData，跳路径校验；未命中原路径分支逐字节不动——Node 行为零变化）。

import { ActionResult } from "../../agent/views.js";
import type { EnhancedDOMTreeNode } from "../../browser/views.js";
import type { ActionHandler, ToolsBrowser } from "../types.js";
import type { ToolsContext } from "./context.js";
import {
  describeUpload,
  findNodeByBackendId,
  getElementByIndex,
  isFileInputNode,
} from "./shared/element-lookup.js";
import { captureUploadClue } from "./upload-identity.js";

/** actions.py :47-61 上传验证探针（canvas/blob-img/bg 预览计数，JSON 串）——batch2b.json 逐字节 */
export const UPLOAD_PROBE_JS =
  "(() => {  const canvases = document.querySelectorAll('canvas').length;  let imgPreviews = 0;  for (const img of document.querySelectorAll('img')) {    const s = img.getAttribute('src') || img.src || '';    if (s.indexOf('blob:') === 0 || s.indexOf('data:') === 0) imgPreviews++;  }  const bgPreviews = document.querySelectorAll(\"[style*='blob:'],[style*='data:']\").length;  return JSON.stringify({ canvases: canvases, imgPreviews: imgPreviews, bgPreviews: bgPreviews });})()";

/** actions.py :62-74 验证无定论引导文案——batch2b.json 逐字节 */
export const UPLOAD_INCONCLUSIVE_ADVISORY =
  "  ℹ️ File was set on the input successfully (DOM.setFileInputFiles returned OK). " +
  "No new <canvas>/<img> preview detected within the wait window — the page may still " +
  "be processing, or use a non-standard preview mechanism. Do NOT conclude the upload " +
  "failed just because the upload area still shows placeholder text like " +
  '"点击上传文件或拖拽文件到这里" — that text is static markup, not upload state. ' +
  '(This does NOT override explicit failure signals — an error toast / "rejected" / ' +
  "red border / size-limit notice still means failure.) To confirm, proceed one step " +
  "and re-read the DOM (look for a newly appeared preview) rather than taking a " +
  "screenshot (visual verification is currently disabled).\n";

/** 精简 mime 表（锚定用例域；Python mimetypes 平台注册表相关——登记偏离） */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

/** mimetypes.guess_type 等价（精简表；未知扩展名 → null） */
export function guessMimeType(path: string): string | null {
  const base = path.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return MIME_BY_EXT[base.slice(dot).toLowerCase()] ?? null;
}

/**
 * :79-113 accept 属性匹配（扩展名/通配 MIME/全 MIME 三态；空=不限制）。
 * 大小写不敏感；token 逐个尝试。软校验用——从不阻塞上传。
 */
export function fileMatchesAccept(filePath: string, accept: string | null): boolean {
  const acc = (accept ?? "").trim();
  if (acc === "") return true;
  const base = filePath.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const fileExt = dot < 0 ? "" : base.slice(dot).toLowerCase();
  const guessed = guessMimeType(filePath);
  for (const rawToken of acc.split(",")) {
    const token = rawToken.trim().toLowerCase();
    if (token === "") continue;
    if (token.startsWith(".")) {
      if (fileExt === token) return true;
    } else if (token.endsWith("/*")) {
      const prefix = token.slice(0, -1); // "image/"
      if (guessed?.startsWith(prefix)) return true;
    } else if (guessed === token) {
      return true;
    }
  }
  return false;
}

const isUploadLabel = (n: EnhancedDOMTreeNode | null): boolean => {
  if (n === null || n.tagName.toUpperCase() !== "LABEL") return false;
  const cls = (n.attributes.class ?? "").toLowerCase();
  const parts: string[] = [n.nodeValue ?? ""];
  for (const c of (n.childrenNodes ?? []).slice(0, 6)) {
    parts.push(c === null ? "" : (c.nodeValue ?? ""));
  }
  const txt = parts.filter((p) => p !== "").join(" ");
  return cls.includes("upload") || txt.includes("选择文件") || txt.includes("上传");
};

const searchSubtree = (root: EnhancedDOMTreeNode | null, depth: number): number | null => {
  if (root === null || depth < 0) return null;
  if (isUploadLabel(root) && root.backendNodeId !== null) return root.backendNodeId;
  for (const c of root.childrenNodes ?? []) {
    const found = searchSubtree(c, depth - 1);
    if (found !== null) return found;
  }
  for (const sr of root.shadowRoots ?? []) {
    const found = searchSubtree(sr, depth - 1);
    if (found !== null) return found;
  }
  return null;
};

/**
 * :302-361 近邻 <label> 上传触发器定位（原生 label 语义保留 user-activation，
 * JS input.click() 会丢 gesture 不触发 chooser——issue #34 关键）。向上爬
 * maxAncestor 层容器，每层子树搜 maxDepth 层。返回 backendNodeId 或 null。
 */
export function findUploadLabelNear(
  node: EnhancedDOMTreeNode,
  maxAncestor = 4,
  maxDepth = 3,
): number | null {
  let cur: EnhancedDOMTreeNode | null = node;
  let depth = 0;
  while (cur !== null && depth <= maxAncestor) {
    const found = searchSubtree(cur, maxDepth);
    if (found !== null) return found;
    cur = cur.parentNode;
    depth += 1;
  }
  return null;
}

/** :1326-1350 一次只读探针：(canvases, imgPreviews, bgPreviews)；异常 null */
export async function probeUploadSignals(
  browser: ToolsBrowser,
): Promise<[number, number, number] | null> {
  try {
    const raw = await browser.executeJs(UPLOAD_PROBE_JS);
    let data: Record<string, unknown>;
    if (typeof raw === "string") {
      data = JSON.parse(raw) as Record<string, unknown>;
    } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      data = raw as Record<string, unknown>;
    } else {
      return null;
    }
    return [
      Number(data.canvases ?? 0) | 0,
      Number(data.imgPreviews ?? 0) | 0,
      Number(data.bgPreviews ?? 0) | 0,
    ];
  } catch {
    return null;
  }
}

/**
 * :1351-1403 页面级验证轮询：每 interval 探一次，任一信号 delta>0 早退 ✅，
 * 预算耗尽/无基线/异常 → 无定论引导。绝不阻塞主流程。
 */
export async function verifyUpload(
  browser: ToolsBrowser,
  before: [number, number, number] | null,
  fileBasename: string,
  ctx: ToolsContext,
): Promise<string> {
  if (!ctx.uploadVerifyEnabled) return "";
  void fileBasename;
  try {
    if (before === null) return UPLOAD_INCONCLUSIVE_ADVISORY;
    const interval = Math.max(ctx.uploadVerifyIntervalMs, 50);
    const attempts = Math.max(1, Math.trunc(ctx.uploadVerifyWaitMs / interval));
    for (let i = 0; i < attempts; i++) {
      await ctx.sleep(interval);
      const after = await probeUploadSignals(browser);
      if (after === null) continue;
      const dCanvas = after[0] - before[0];
      const dImg = after[1] - before[1];
      const dBg = after[2] - before[2];
      if (dCanvas > 0 || dImg > 0 || dBg > 0) {
        const parts: string[] = [];
        if (dCanvas > 0) {
          parts.push(`new <canvas> preview appeared (count ${before[0]}→${after[0]})`);
        }
        if (dImg > 0) {
          parts.push(`new <img> preview appeared (count ${before[1]}→${after[1]})`);
        }
        if (dBg > 0) {
          parts.push(`new background-image preview appeared (count ${before[2]}→${after[2]})`);
        }
        return `  ✅ Upload verified on page: ${parts.join("; ")}.\n`;
      }
    }
    return UPLOAD_INCONCLUSIVE_ADVISORY;
  } catch {
    return UPLOAD_INCONCLUSIVE_ADVISORY;
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createUploadFileHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>, browser: ToolsBrowser) => {
    if (typeof params.path !== "string") {
      return new ActionResult({ error: "upload_file requires a string `path` parameter." });
    }
    if (typeof params.index !== "number") {
      return new ActionResult({ error: "upload_file requires a number `index` parameter." });
    }
    const filePath = params.path;
    const index = params.index;

    // 1. 附件句柄先问（M5 段 C，扩展形态）：命中 → 附件分支（跳过路径白名单与
    //    isFile/stat——附件由用户手势亲手选定，白名单防的是 agent 指定服务端路径，
    //    附件不在威胁面；size===0 沿用空文件校验文案）；未命中（null / fs 无可选
    //    方法）→ 原路径分支（逐字节不动，NodeFs 零开销短路）
    const attachment =
      ctx.fs !== null && ctx.fs.readAttachment !== undefined
        ? await ctx.fs.readAttachment(filePath)
        : null;
    let p = filePath;
    if (attachment !== null) {
      if (attachment.size === 0) {
        return new ActionResult({ error: `File is empty: ${filePath}` });
      }
      // bytes 通道体积上限（评审轮 1 [1]）：全量 base64 单条 CDP 消息的峰值内存与
      // 页面端同步解码随体积线性——超限快速失败回可操作 error（路径通道按 OS
      // 路径寻址无此退化；null = 宿主显式解除）
      if (ctx.maxAttachmentBytes !== null && attachment.size > ctx.maxAttachmentBytes) {
        return new ActionResult({
          error:
            `Attachment too large for data channel upload: ${filePath} ` +
            `(${attachment.size} bytes > ${ctx.maxAttachmentBytes} bytes limit)`,
        });
      }
    } else {
      // 白名单（resolve 归一化后比对——段 1 评审轮 1 [6] 同款收严）+ 存在/非空校验
      p = ctx.fs !== null ? ctx.fs.resolve(filePath) : filePath;
      if (
        ctx.allowedUploadPaths !== null &&
        !ctx.allowedUploadPaths.some((prefix) => p.startsWith(prefix))
      ) {
        return new ActionResult({ error: `File path not in allowed upload paths: ${p}` });
      }
      if (ctx.fs === null) {
        return new ActionResult({
          error: `File upload failed: no filesystem provider injected`,
        });
      }
      if (!(await ctx.fs.isFile(p))) {
        return new ActionResult({ error: `File not found: ${p}` });
      }
      const stat = await ctx.fs.stat(p);
      if (stat !== null && stat.size === 0) {
        return new ActionResult({ error: `File is empty: ${p}` });
      }
    }

    // 2. 元素查找
    const [entry, lookupError] = await getElementByIndex(index, browser, ctx);
    if (lookupError !== null) return lookupError;
    const node = entry as NonNullable<typeof entry>;

    // 3. 目标是否本身 file input；确定正确的 file input
    const isFileInput = isFileInputNode(node);
    const attrs = node.attributes ?? {};
    let backendId = node.backendNodeId;
    const fileInputIds = [...(ctx.cachedBrowserState?.domState?.fileInputBackendIds ?? [])];
    const fileInputsMeta = [...(ctx.cachedBrowserState?.domState?.fileInputsMeta ?? [])];
    let uploadNote = "";

    if (isFileInput && fileInputIds.length > 1) {
      // 多个 file input 共存（抖音式封面编辑器）。Fix C (#96)：Semi 双 input
      // （hidden-input 初次上传 + -replace 替换）软纠正，否则保持选择 + 软警告
      const chosenCls = (attrs.class ?? "").toLowerCase();
      const uploadAncestorCount = fileInputsMeta.filter((fi) => fi.upload_ancestor).length;
      let correctedBid: number | null = null;
      if (chosenCls.includes("replace") && uploadAncestorCount >= 2) {
        const primaryCandidates = fileInputsMeta
          .filter(
            (fi) =>
              fi.class_name.toLowerCase().includes("hidden-input") &&
              !fi.class_name.toLowerCase().includes("replace"),
          )
          .map((fi) => fi.backend_node_id);
        if (primaryCandidates.length > 0) {
          correctedBid = primaryCandidates[0];
          backendId = correctedBid;
          uploadNote =
            `  ⚠️ You picked [${index}] which is a replace(替换封面) ` +
            "file input; first-time upload should use the primary hidden-input. " +
            `Auto-switched to [${correctedBid}]. If the slot (横/竖) is wrong, ` +
            "get_state and retry upload_file on the correct upload area.";
        }
      }
      if (correctedBid === null) {
        const liveCandidates = fileInputsMeta
          .filter((fi) => fi.visible && fi.upload_ancestor)
          .map((fi) => fi.backend_node_id);
        // Python f-string 直接 repr int 列表（[61, 62]）——JSON.stringify 是 [61,62]
        // 无空格（评审轮 1 [1] 同族，venv 锚定 f"{[61, 62]}"）
        const candHint =
          liveCandidates.length > 0
            ? ` Likely-live candidates (visible + upload container): [${liveCandidates.join(", ")}].`
            : "";
        uploadNote =
          `  ⚠️ Page has ${fileInputIds.length} file inputs; uploaded to the one ` +
          `you specified (index ${index}).${candHint} If the site reacted ` +
          "wrongly (a 收藏封面/favorite-cover modal popped, or nothing changed = " +
          "you hit a hidden decoy input), retry upload_file on the correct visible " +
          "upload area.";
      }
    }

    if (!isFileInput) {
      if (fileInputIds.length === 0) {
        return new ActionResult({
          error: "Element is not a file input and no file input found on page",
        });
      }
      if (fileInputIds.length === 1) {
        backendId = fileInputIds[0];
        uploadNote =
          `  ℹ️ index ${index} is not a file input; uploaded to the ` +
          `only file input on the page (backendNodeId=${backendId}).`;
      } else {
        // 多 input 且目标是 dropzone/按钮：点近邻 <label> 触发器，chooser 命中即真身
        const labelBid = findUploadLabelNear(node) ?? node.backendNodeId;
        const discovered = await browser.discoverFileInputViaClick(labelBid);
        if (discovered !== null) {
          backendId = discovered;
          uploadNote =
            `  ℹ️ index ${index} is not a file input; clicked its ` +
            "upload button and uploaded to the file input the page opened " +
            `(backendNodeId=${backendId}).`;
        } else {
          return new ActionResult({
            error:
              `Element ${index} is not a file input, and clicking its ` +
              "upload button did not open a file chooser — it likely uses a " +
              "custom upload dialog. Open that dialog and click its 上传图片/" +
              "选择文件 button first, then call upload_file again on that button " +
              "so the correct file input is used.",
          });
        }
      }
    }

    ctx.log(
      `upload_file: index=${index}, tag=${node.tagName}, type=${attrs.type ?? ""}, ` +
        `backend_node_id=${node.backendNodeId}, is_file_input=${isFileInput}, ` +
        `resolved_backend_id=${backendId}, available_file_inputs=[${fileInputIds.join(", ")}]`,
    );

    // #151：为实际命中的 input 采集语义线索（best-effort，绝不阻塞）
    let uploadClue: Record<string, unknown> | null = null;
    try {
      const clueMap = ctx.cachedBrowserState?.domState?.selectorMap;
      if (clueMap !== undefined) {
        uploadClue = await captureUploadClue(browser, clueMap, backendId);
      }
    } catch {
      uploadClue = null;
    }

    // 上传前页面信号快照（验证关闭时跳过）
    const beforeSignals = ctx.uploadVerifyEnabled ? await probeUploadSignals(browser) : null;

    // 4. 高亮 + 上传（共用 try 统一映射；highlight best-effort；附件分支走 bytes 注入通道）
    try {
      await browser.highlightElement(backendId);
      if (attachment !== null) {
        await browser.setFileInputData(backendId, attachment);
      } else {
        await browser.setFileInput(backendId, p, isFileInput ? null : fileInputIds);
      }
    } catch (e) {
      return new ActionResult({
        error:
          attachment !== null
            ? `File upload failed (data channel): ${errText(e)}`
            : `File upload failed: ${errText(e)}`,
      });
    }

    // 5. 成功回显 + 目标来源说明 + accept 软校验 + 页面级验证（附件分支以
    //    filename 回填路径语义——set 后页面状态与注入方式无关，共用不动）
    const displayPath = attachment !== null ? attachment.filename : p;
    let memory = describeUpload(node, index, displayPath);
    if (uploadNote !== "") memory += uploadNote;

    const fileInputEntry = isFileInput
      ? node
      : findNodeByBackendId(backendId, ctx.cachedBrowserState?.domState ?? null);
    const acceptAttr = fileInputEntry?.attributes.accept ?? null;
    if (acceptAttr !== null && acceptAttr !== "" && !fileMatchesAccept(displayPath, acceptAttr)) {
      memory +=
        `  ℹ️ Note: file extension does not match this input's ` +
        `accept=${JSON.stringify(acceptAttr)}. The file was uploaded successfully regardless ` +
        "— browsers do not enforce accept (it is advisory only). No retry needed.";
    }

    memory += await verifyUpload(
      browser,
      beforeSignals,
      displayPath.replaceAll("\\", "/").split("/").pop() ?? "",
      ctx,
    );

    const metadata = uploadClue !== null ? { upload_clue: uploadClue } : null;
    return new ActionResult({
      extractedContent: memory,
      longTermMemory: memory,
      ...(metadata !== null ? { metadata } : {}),
    });
  };
}
