// 上传族 session 侧（session.py :5015-5101 + :1798-1851）：setFileInput
// （DOM.setFileInputFiles——不点击 input）/ shadow DOM file input 搜索 /
// file-chooser 拦截消费（discoverFileInputViaClick）。探针与验证在动作层
// （upload-file.ts，对齐 Python 的 Tools._probe_upload_signals 位置）。
// 偏离（p4b/02 §6）：非 ASCII 文件名的 ASCII 临时副本（tempfile+shutil.copy2）
// 不落核心——tmp 目录与全量二进制复制属宿主面，宿主可在 fs 层前置重命名。

import { clickElement } from "./element-pointer.js";
import type { FileChooserRecord, SessionInternals } from "./transport.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 赋值收窄还原透传（discover 轮询读 lastFileChooser 用） */
const identityFileChooser = (v: FileChooserRecord | null): FileChooserRecord | null => v;

/**
 * :691-721 递归走 CDP DOM Node 树找 file input backendNodeId（children /
 * shadowRoots / contentDocument 三向）。纯函数——测试直接锚定。
 */
export function walkForFileInputs(node: Record<string, unknown>): number[] {
  const results: number[] = [];
  const nodeName = String(node.nodeName ?? "").toUpperCase();
  if (nodeName === "INPUT") {
    const attrsList = Array.isArray(node.attributes) ? (node.attributes as unknown[]) : [];
    const attrs: Record<string, unknown> = {};
    for (let i = 0; i + 1 < attrsList.length; i += 2) {
      attrs[String(attrsList[i])] = attrsList[i + 1];
    }
    if (String(attrs.type ?? "").toLowerCase() === "file") {
      const bid = node.backendNodeId;
      if (typeof bid === "number") results.push(bid);
    }
  }
  for (const child of Array.isArray(node.children)
    ? (node.children as Record<string, unknown>[])
    : []) {
    results.push(...walkForFileInputs(child));
  }
  for (const sr of Array.isArray(node.shadowRoots)
    ? (node.shadowRoots as Record<string, unknown>[])
    : []) {
    results.push(...walkForFileInputs(sr));
  }
  const contentDoc = node.contentDocument;
  if (isRecord(contentDoc)) results.push(...walkForFileInputs(contentDoc));
  return results;
}

/** :5015-5029 DOM.getDocument(pierce) 穿透 shadow root 找全部 file input；失败 [] */
export async function findFileInputsInShadowDom(s: SessionInternals): Promise<number[]> {
  try {
    const result = await s.send<Record<string, unknown>>("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const root = isRecord(result.root) ? result.root : {};
    return walkForFileInputs(root);
  } catch (e) {
    s.log(`DOM.getDocument(pierce) failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * :5036-5101 经 CDP 直设 file input 文件（不点击、不开 OS 选择器）。fallback 链：
 * 显式 backendNodeId → fileInputBackendIds[0] → shadow DOM 搜索；全空抛 Error
 * （Python RuntimeError 文案逐字节）。
 */
export async function setFileInput(
  s: SessionInternals,
  backendNodeId: number | null,
  filePath: string,
  fileInputBackendIds: number[] | null = null,
): Promise<void> {
  let targetId = backendNodeId;
  s.log(
    `set_file_input: backend_node_id=${backendNodeId}, ` +
      `file_input_backend_ids=${fileInputBackendIds === null ? "None" : JSON.stringify(fileInputBackendIds)}, ` +
      `file=${filePath}`,
  );
  if (targetId === null && fileInputBackendIds !== null && fileInputBackendIds.length > 0) {
    targetId = fileInputBackendIds[0];
  }
  if (targetId === null) {
    const shadowIds = await findFileInputsInShadowDom(s);
    if (shadowIds.length > 0) {
      targetId = shadowIds[0];
      s.log(`Found file input in shadow DOM: backendNodeId=${targetId}`);
    }
  }
  if (targetId === null) {
    throw new Error(
      "No file input element found. " + "Ensure the page has an <input type='file'> element.",
    );
  }
  await s.send("DOM.setFileInputFiles", {
    backendNodeId: targetId,
    files: [filePath],
  });
}

/**
 * :1798-1851 点击元素并捕获其打开的 file input（file-chooser 拦截消费端）。
 * 拦截未启用 → 拒点（会弹阻塞的 OS 原生对话框）；超时无 chooser → null
 * （自定义上传对话框场景，action 层上翻可操作 error）。
 */
export async function discoverFileInputViaClick(
  s: SessionInternals,
  backendNodeId: number,
  timeoutMs = 2500,
): Promise<number | null> {
  if (!s.fileChooserInterceptEnabled) {
    s.log(
      "discover_file_input_via_click: interception not enabled, " +
        "refusing to click (would pop native dialog)",
    );
    return null;
  }
  s.lastFileChooser = null;
  try {
    await clickElement(s, backendNodeId);
  } catch (e) {
    s.log(
      `discover_file_input_via_click: click failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  const deadline = s.now() + timeoutMs / 1000;
  while (s.now() < deadline) {
    // 经注解透传读取：上方 `s.lastFileChooser = null` 的赋值收窄会把后续裸读取
    // 判成 null（never 分支），函数边界按声明类型还原
    const chooser: FileChooserRecord | null = identityFileChooser(s.lastFileChooser);
    if (chooser !== null) {
      const bid = chooser.backendNodeId;
      s.log(
        `discover_file_input_via_click: click on backendNodeId=${backendNodeId} ` +
          `opened file input backendNodeId=${bid}`,
      );
      return typeof bid === "number" ? bid : null;
    }
    await s.sleep(50);
  }
  s.log(
    `discover_file_input_via_click: click on backendNodeId=${backendNodeId} opened no ` +
      `file chooser within ${(timeoutMs / 1000).toFixed(1)}s (custom dialog?)`,
  );
  return null;
}
