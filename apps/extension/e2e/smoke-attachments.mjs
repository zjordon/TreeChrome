// 附件分块传输 e2e smoke（issue #2 C 档）：真扩展 + 真侧边栏页 + 真 Port——
// 页内按 sidepanel 同款协议驱动（begin→begun→chunk×N→commit，块载荷 base64），
// 断言：① 微型文件单块入表；② 8MB 文件两块传输 commit 后 attachments 广播含条目
// + budget 投影；③ 声明超单件上限的 begin → attachment-rejected(too-large) 明细
// 回传；④ 第二个文件 → 清单多件并存。
// 通道事实（本 smoke 的 diag echo 探针实证，2026-10-21）：chrome.runtime 消息为
// JSON 序列化，ArrayBuffer 克隆不可用（回显 object{}）——块编码因此是 base64；
// echo 形态仅记录不断言（Chrome 未来若支持克隆，协议无需回退）。
// 用例：先 npx wxt build，然后 node apps/extension/e2e/smoke-attachments.mjs。
import { connectOurServiceWorker, ensureSidepanelPage, launchChrome } from "./lib-harness.mjs";

const CDP_PORT = 9789;

/** 页内协议驱动（返回结构化结果——断言全部在 node 侧做） */
const DRIVER = `(async () => {
  const results = { errors: [], trace: [] };
  const port = chrome.runtime.connect({ name: "e2e-attachments" });
  const waiters = [];
  const waitFor = (pred, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting sw message")), timeoutMs);
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  port.onMessage.addListener((m) => {
    results.trace.push(
      m.kind === "attachments" ? { kind: m.kind, items: m.items.map((i) => i.name) } :
      m.kind === "attachment-rejected" ? { kind: m.kind, r: m.rejection.reason, tid: m.rejection.transferId } :
      { kind: m.kind, tid: m.transferId ?? null },
    );
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  try {
    // ⓪' 通道序列化探针：diag echo 回显 ArrayBuffer/Uint8Array 过通道后的形态
    const probeBytes = new Uint8Array([1, 2, 3, 4]);
    const echoed = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { kind: "diag", command: "echo", payload: { ab: probeBytes.buffer, u8: probeBytes } },
        (resp) => resolve(resp),
      );
    });
    const shapeOf = (v) =>
      v === null || v === undefined ? String(v) :
      v instanceof ArrayBuffer ? "ArrayBuffer(" + v.byteLength + ")" :
      ArrayBuffer.isView(v) ? v.constructor.name + "(" + v.byteLength + ")" :
      Array.isArray(v) ? "array(" + v.length + ")" :
      typeof v === "object" ? "object{" + Object.keys(v).slice(0, 6).join(",") + "}" : typeof v;
    results.echo = { ab: shapeOf(echoed?.payload?.ab), u8: shapeOf(echoed?.payload?.u8) };

    // ⓪ 微型文件（8B 单块）——与大块路径二分定位
    const tiny = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const t0 = "e2e-t0";
    port.postMessage({ kind: "attachment-begin", transferId: t0, name: "tiny.bin",
      mimeType: "application/octet-stream", size: tiny.length });
    await waitFor((m) => m.kind === "attachment-begun" && m.transferId === t0);
    port.postMessage({ kind: "attachment-chunk", transferId: t0, offset: 0, data: btoa(String.fromCharCode.apply(null, tiny)) });
    port.postMessage({ kind: "attachment-commit", transferId: t0 });
    const att0 = await waitFor(
      (m) => m.kind === "attachments" && m.items.some((it) => it.name === "tiny.bin"));
    results.att0 = { count: att0.items.length, size: att0.items[0].size };

    // ① 8MB 两块传输（4MB 块——与 sidepanel ATTACHMENT_CHUNK_BYTES 同款；块载荷
    //    base64——通道 JSON 序列化实证后的协议形态）
    const CHUNK = 4 * 1024 * 1024;
    const SIZE = 8 * 1024 * 1024;
    const bytes = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i += 1) bytes[i] = i % 251;
    const toB64 = (u8) => {
      let binary = "";
      for (let i = 0; i < u8.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    };
    const t1 = "e2e-t1";
    port.postMessage({ kind: "attachment-begin", transferId: t1, name: "big8.bin",
      mimeType: "application/octet-stream", size: SIZE });
    const begun = await waitFor((m) => m.kind === "attachment-begun" && m.transferId === t1);
    results.begun = begun.transferId === t1;
    port.postMessage({ kind: "attachment-chunk", transferId: t1, offset: 0,
      data: toB64(bytes.subarray(0, CHUNK)) });
    port.postMessage({ kind: "attachment-chunk", transferId: t1, offset: CHUNK,
      data: toB64(bytes.subarray(CHUNK, SIZE)) });
    port.postMessage({ kind: "attachment-commit", transferId: t1 });
    const att1 = await waitFor(
      (m) => m.kind === "attachments" && m.items.some((it) => it.name === "big8.bin"));
    results.att1 = {
      count: att1.items.length,
      size: att1.items.find((it) => it.name === "big8.bin").size,
      budgetUsed: att1.budget.usedBytes,
      budgetPending: att1.budget.pendingBytes,
    };

    // ② 超单件上限 begin（声明即拒——不分配百兆）
    const t2 = "e2e-t2";
    port.postMessage({ kind: "attachment-begin", transferId: t2, name: "huge.bin",
      mimeType: "video/mp4", size: 100 * 1024 * 1024 + 1 });
    const rej = await waitFor(
      (m) => m.kind === "attachment-rejected" && m.rejection.transferId === t2);
    results.reject = { reason: rej.rejection.reason, size: rej.rejection.size, limit: rej.rejection.limit };

    // ③ 第二个文件 → 清单两件
    const small = new Uint8Array(1024 * 1024);
    const t3 = "e2e-t3";
    port.postMessage({ kind: "attachment-begin", transferId: t3, name: "small.bin",
      mimeType: "application/octet-stream", size: small.length });
    await waitFor((m) => m.kind === "attachment-begun" && m.transferId === t3);
    port.postMessage({ kind: "attachment-chunk", transferId: t3, offset: 0,
      data: toB64(small) });
    port.postMessage({ kind: "attachment-commit", transferId: t3 });
    const att2 = await waitFor(
      (m) => m.kind === "attachments" && m.items.some((it) => it.name === "small.bin"));
    results.att2 = { count: att2.items.length, budgetUsed: att2.budget.usedBytes };
  } catch (e) {
    results.errors.push(String(e && e.message ? e.message : e));
  } finally {
    port.disconnect();
  }
  return JSON.stringify(results);
})()`;

let proc = null;
const failures = [];
let raw = null;
try {
  const { proc: chromeProc, profileDir } = await launchChrome({ port: CDP_PORT });
  proc = chromeProc;
  const { sw } = await connectOurServiceWorker(CDP_PORT, profileDir);
  const page = await ensureSidepanelPage(CDP_PORT, await sw.evaluate("chrome.runtime.id"));
  raw = await page.evaluate(DRIVER);
  const r = JSON.parse(raw);

  if (r.errors.length > 0)
    failures.push(`页内驱动异常: ${r.errors.join("; ")} trace=${JSON.stringify(r.trace)}`);
  if (r.att0?.count !== 1 || r.att0?.size !== 8)
    failures.push(`① 微型 att0=${JSON.stringify(r.att0)}`);
  if (r.begun !== true) failures.push("② begun 回执未达");
  if (r.att1?.size !== 8 * 1024 * 1024) failures.push(`② att1.size=${r.att1?.size}`);
  if (r.att1?.count !== 2) failures.push(`② att1.count=${r.att1?.count}`);
  if (r.att1?.budgetUsed !== 8 * 1024 * 1024 + 8)
    failures.push(`② budgetUsed=${r.att1?.budgetUsed}`);
  if (r.att1?.budgetPending !== 0) failures.push(`② budgetPending=${r.att1?.budgetPending}`);
  if (r.reject?.reason !== "too-large") failures.push(`③ reason=${r.reject?.reason}`);
  if (r.reject?.limit !== 100 * 1024 * 1024) failures.push(`③ limit=${r.reject?.limit}`);
  if (r.reject?.size !== 100 * 1024 * 1024 + 1) failures.push(`③ size=${r.reject?.size}`);
  if (r.att2?.count !== 3) failures.push(`④ att2.count=${r.att2?.count}`);
  if (r.att2?.budgetUsed !== 9 * 1024 * 1024 + 8)
    failures.push(`④ budgetUsed=${r.att2?.budgetUsed}`);
} catch (e) {
  failures.push(`harness: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  proc?.kill();
}

if (failures.length > 0) {
  console.error("smoke-attachments FAIL:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`  [results] ${raw ?? "(no page result)"}`);
  process.exit(1);
}
console.log("smoke-attachments PASS: 分块传输/超限拒绝明细/多件并存 全部通过");
