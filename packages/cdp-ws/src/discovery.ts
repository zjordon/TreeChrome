/**
 * ws_url 发现：GET /json/version → webSocketDebuggerUrl（对齐 TreeWalker
 * config._fetch_ws_url 与 gen_fixtures.wait_version 的公共化，01 §6 偏离 7）。
 */
import { describeError } from "./errors.js";
import { isRecord } from "./types.js";

export interface DiscoveryDeps {
  fetch?: typeof fetch;
}

export async function discoverWebSocketUrl(
  host: string,
  port: number,
  deps: DiscoveryDeps = {},
): Promise<string> {
  const endpoint = `http://${host}:${port}/json/version`;
  const doFetch = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(endpoint);
  } catch (e) {
    throw new Error(
      `发现 ws_url 失败：GET ${endpoint} 网络错误` +
        `（Chrome 是否以 --remote-debugging-port=${port} 运行？）：${describeError(e)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`发现 ws_url 失败：GET ${endpoint} 返回 HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (e) {
    throw new Error(`发现 ws_url 失败：${endpoint} 响应体非 JSON：${describeError(e)}`);
  }
  const wsUrl = isRecord(body) ? body.webSocketDebuggerUrl : undefined;
  if (typeof wsUrl !== "string" || wsUrl === "") {
    throw new Error(`发现 ws_url 失败：${endpoint} 响应缺 webSocketDebuggerUrl 字段`);
  }
  return wsUrl;
}
