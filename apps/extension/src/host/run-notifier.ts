// RunNotifier（issue #41 U4 批 C，验收②）：run 终态桌面通知 + 点击回流。
// 发送门（D3）：run-manager 侧「无端口连接」+ 本类 enabled() 设置门（hot-read
// ——save-settings 立即生效）；点击回流（D4）：激活绑定 tab + sidePanel.open
// （通知点击是用户手势——Chrome 116+ 可用）；tab 已关/打开失败 fail-soft 记日志。
// 全注入可测（notifications/tabs/sidePanel 均 fake 替换）；onClicked 在构造时
// 注册（MV3 纪律——监听器须在首个 await 前同步注册）。

import type { NotificationsApi, SidePanelApi, TabsUpdateApi } from "./chrome-apis.js";

/** 通知图标（public/icon 打包后在扩展根——128 尺寸在通知里清晰） */
export const NOTIFICATION_ICON_URL = "/icon/128.png";

export type TerminalNotifyStatus = "done" | "error" | "interrupted";

export interface TerminalNotifyInput {
  status: TerminalNotifyStatus;
  /** 任务原文（通知主标识——截断展示） */
  task: string;
  finalResult: string | null;
  lastError: string | null;
  /** run 绑定 tab（点击回流目标） */
  tabId: number;
}

export interface RunNotifierDeps {
  notifications: NotificationsApi;
  /** 原生 tabs API 对象（receiver 敏感——update 须以方法形态调用，裸传必炸） */
  tabsUpdate: TabsUpdateApi;
  sidePanelOpen: SidePanelApi["open"];
  /** 设置门：返回 false 不发（可异步——设置是 storage 热读；缺省恒 true）。
   *  读取失败按开（fail-open：通知是观测面，设置读不到不该静默吞） */
  enabled?: () => boolean | Promise<boolean>;
  log?: (message: string) => void;
  /** 通知 id 生成（缺省 run 终态唯一前缀 + 随机；测试注入序列） */
  generateId?: () => string;
}

const STATUS_TITLE: Record<TerminalNotifyStatus, string> = {
  done: "任务完成",
  error: "任务失败",
  interrupted: "任务已中断",
};

function excerpt(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 通知文案（导出供测试锚定：任务截 40 + 结果/原因截 80） */
export function renderTerminalNotification(input: TerminalNotifyInput): {
  title: string;
  message: string;
} {
  const detail =
    input.status === "done" && input.finalResult !== null
      ? input.finalResult
      : (input.lastError ?? "");
  const message =
    detail === "" ? excerpt(input.task, 40) : `${excerpt(input.task, 40)}\n${excerpt(detail, 80)}`;
  return { title: STATUS_TITLE[input.status], message };
}

export class RunNotifier {
  private readonly deps: RunNotifierDeps;
  /** notificationId → 回流上下文（点击即取即清——通知是瞬态面） */
  private readonly contexts = new Map<string, { tabId: number }>();

  constructor(deps: RunNotifierDeps) {
    this.deps = deps;
    deps.notifications.onClicked.addListener((notificationId) => this.onClicked(notificationId));
  }

  /** run 终态通知（run-manager drive() 收口调用——面板不可见时）。fire-and-forget：
   *  设置门可异步（storage 热读），失败面全兜（通知不炸 run 收口） */
  notifyTerminal(input: TerminalNotifyInput): void {
    void this.resolveEnabled()
      .then((on) => {
        if (!on) return;
        const id = this.deps.generateId?.() ?? `run-terminal-${crypto.randomUUID()}`;
        this.contexts.set(id, { tabId: input.tabId });
        if (this.contexts.size > 16) {
          // 上下文兜底淘汰（正常路径点击即清；理论堆积时丢最老防泄漏）
          const oldest = this.contexts.keys().next().value;
          if (oldest !== undefined) this.contexts.delete(oldest);
        }
        const { title, message } = renderTerminalNotification(input);
        this.deps.notifications.create(id, {
          type: "basic",
          iconUrl: NOTIFICATION_ICON_URL,
          title,
          message,
        });
      })
      .catch((e: unknown) => {
        this.deps.log?.(`notify: 通知失败——${e instanceof Error ? e.message : String(e)}`);
      });
  }

  private async resolveEnabled(): Promise<boolean> {
    try {
      return await (this.deps.enabled?.() ?? true);
    } catch {
      return true;
    }
  }

  /** 通知点击回流（构造时注册）：激活绑定 tab + 打开面板；失败 fail-soft */
  private onClicked(notificationId: string): void {
    const ctx = this.contexts.get(notificationId);
    this.contexts.delete(notificationId);
    if (ctx === undefined) return;
    void this.deps.tabsUpdate
      .update(ctx.tabId, { active: true })
      .then(() => this.deps.sidePanelOpen({ tabId: ctx.tabId }))
      .catch((e: unknown) => {
        // tab 已关（update reject）或面板打开失败——面板仍可 Ctrl+Shift+K 打开
        this.deps.log?.(
          `notification click: 回流失败（tab ${ctx.tabId}）——${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }
}
