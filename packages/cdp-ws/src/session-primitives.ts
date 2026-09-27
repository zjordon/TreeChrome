/**
 * 会话原语最小集（docs/implement-plan/p3/02）：attach page target / navigate /
 * getTabs / switchTab / cookie 注入。Python 行号锚定与有意偏离见 02 文档；
 * BrowserSession 语义（域 enable/缓存清理/页面稳定等待/close_tab/create_tab）属 P4。
 */
import { CdpNavigationError, describeError } from "./errors.js";
import type { CdpWsClient } from "./transport.js";
import { isRecord, type TabInfo } from "./types.js";

export interface CdpPageSessionOptions {
  /** 单条 cookie 注入失败等观测日志，缺省 no-op */
  logger?: (message: string) => void;
}

export interface AttachedSession {
  targetId: string;
  sessionId: string;
}

const SAME_SITE_MAP: Record<string, string> = { Strict: "Strict", Lax: "Lax", None: "None" };

export class CdpPageSession {
  private readonly logger: (message: string) => void;

  constructor(
    readonly client: CdpWsClient,
    options: CdpPageSessionOptions = {},
  ) {
    this.logger = options.logger ?? (() => {});
  }

  /** 首个 page target 附着（session.py `_connect` 1669-1680 的抽取，flatten 协议） */
  async attachFirstPageTarget(): Promise<AttachedSession> {
    const targets = await this.client.send<unknown>("Target.getTargets");
    const targetInfos =
      isRecord(targets) && Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
    for (const info of targetInfos) {
      if (!isRecord(info) || info.type !== "page") {
        continue;
      }
      if (typeof info.targetId !== "string") {
        continue;
      }
      const attached = await this.client.send<unknown>("Target.attachToTarget", {
        targetId: info.targetId,
        flatten: true,
      });
      const sessionId = isRecord(attached) ? attached.sessionId : undefined;
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new Error(`attachToTarget 返回缺 sessionId（targetId=${info.targetId}）`);
      }
      return { targetId: info.targetId, sessionId };
    }
    // 文案对齐 Python（session.py:1680）
    throw new Error("No page target found. Is Chrome running with --remote-debugging-port?");
  }

  /**
   * 薄 Page.navigate 包装（session.py:2350-2376）：保留 transitionType 与
   * errorText 抛错；new_tab/缓存清理/settle 是 BrowserSession 语义（P4）。
   */
  async navigate(url: string, sessionId: string): Promise<void> {
    const result = await this.client.send<unknown>(
      "Page.navigate",
      { url, transitionType: "address_bar" },
      sessionId,
    );
    const errorText = isRecord(result) ? result.errorText : undefined;
    if (typeof errorText === "string" && errorText !== "") {
      throw new CdpNavigationError(errorText);
    }
  }

  /** page target 列表（session.py:3617-3635；错误透传是 02 偏离 1——容错归 P4） */
  async getTabs(): Promise<TabInfo[]> {
    const targets = await this.client.send<unknown>("Target.getTargets");
    const targetInfos =
      isRecord(targets) && Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
    const tabs: TabInfo[] = [];
    for (const info of targetInfos) {
      if (!isRecord(info) || info.type !== "page" || typeof info.targetId !== "string") {
        continue;
      }
      tabs.push({
        targetId: info.targetId,
        url: typeof info.url === "string" ? info.url : "",
        title: typeof info.title === "string" ? info.title : "",
      });
    }
    return tabs;
  }

  /** 激活并附着目标 tab，返回新会话句柄（session.py:3637-3651 的抽取） */
  async switchTab(targetId: string): Promise<AttachedSession> {
    await this.client.send("Target.activateTarget", { targetId });
    const attached = await this.client.send<unknown>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = isRecord(attached) ? attached.sessionId : undefined;
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error(`attachToTarget 返回缺 sessionId（targetId=${targetId}）`);
    }
    return { targetId, sessionId };
  }

  /**
   * Playwright storage_state → Network.setCookie（evals runner.py:76-156 移植）。
   * ⚠️ localhost 坑（runner.py:128-129 实测注释）：用 domain="localhost" 时 CDP
   * 返回 success:true 但 cookie 不进 jar——所以作用域恒用 url 参数绑定。
   * origins（localStorage）CDP 用不到，忽略（runner.py:93 同注释）。
   * 返回成功注入数；单条失败 log 不中断（对齐 runner.py:152-153）。
   */
  async injectCookies(storageState: unknown, sessionId: string): Promise<number> {
    if (!isRecord(storageState) || !Array.isArray(storageState.cookies)) {
      throw new Error("storageState 结构非法：应为 Playwright storage_state（含 cookies 数组）");
    }
    let injected = 0;
    for (const raw of storageState.cookies) {
      if (!isRecord(raw)) {
        this.logger(`[cdp-ws] cookie 条目非对象，跳过：${describeError(raw)}`);
        continue;
      }
      if (typeof raw.name !== "string" || typeof raw.value !== "string") {
        this.logger(`[cdp-ws] cookie 缺 name/value（string），跳过`);
        continue;
      }
      const secure = raw.secure === true;
      const path = typeof raw.path === "string" && raw.path !== "" ? raw.path : "/";
      const sameSite = SAME_SITE_MAP[typeof raw.sameSite === "string" ? raw.sameSite : ""] ?? "Lax";
      const params: Record<string, unknown> = {
        name: raw.name,
        value: raw.value,
        path,
        secure,
        httpOnly: raw.httpOnly === true,
        sameSite,
        url: scopeUrl(raw, path, secure),
      };
      if (typeof raw.expires === "number" && raw.expires > 0) {
        params.expires = raw.expires;
      }
      try {
        const result = await this.client.send<unknown>("Network.setCookie", params, sessionId);
        // runner.py:150 同口径：success 缺省视为接受
        if (!isRecord(result) || result.success !== false) {
          injected += 1;
        } else {
          this.logger(`[cdp-ws] setCookie 未接受（success:false，cookie=${raw.name}）`);
        }
      } catch (e) {
        this.logger(`[cdp-ws] setCookie 失败（cookie=${raw.name}）：${describeError(e)}`);
      }
    }
    return injected;
  }
}

/** 作用域 url 三来源（runner.py:130-141）：显式 url > domain 拼 > localhost 兜底 */
function scopeUrl(cookie: Record<string, unknown>, path: string, secure: boolean): string {
  const scheme = secure ? "https" : "http";
  if (typeof cookie.url === "string" && cookie.url !== "") {
    return cookie.url;
  }
  const domain = typeof cookie.domain === "string" && cookie.domain !== "" ? cookie.domain : "";
  if (domain !== "") {
    return `${scheme}://${domain}${path}`;
  }
  return `${scheme}://localhost${path}`;
}
