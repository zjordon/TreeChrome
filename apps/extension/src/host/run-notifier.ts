// RunNotifier（issue #41 U4 批 C，验收②）：run 终态桌面通知 + 点击回流。
// 发送门（D3）：run-manager 侧「无端口连接」+ 本类 enabled() 设置门（hot-read
// ——save-settings 立即生效）；点击回流（D4）：激活绑定 tab + sidePanel.open
// （通知点击是用户手势——Chrome 116+ 可用）；tab 已关/打开失败 fail-soft 记日志。
// 回流目标内嵌通知 id（评审轮 1 [2]）：通知常在 SW 空闲回收后数分钟才被点击
// ——冷启动重建的实例无内存上下文，解析 id 即恢复（Map 方案 30s 后必失效）。
// 全注入可测（notifications/tabs/sidePanel 均 fake 替换）；onClicked 在构造时
// 注册（MV3 纪律——监听器须在首个 await 前同步注册）。

import type { NotificationsApi, SidePanelApi, TabsUpdateApi } from "./chrome-apis.js";

/** 通知图标（public/icon 打包后在扩展根——128 尺寸在通知里清晰） */
export const NOTIFICATION_ICON_URL = "/icon/128.png";

/** 通知 id 前缀（onClicked 据此识别本器发出的通知并解析内嵌 tabId） */
export const TERMINAL_ID_PREFIX = "run-terminal-";

export type TerminalNotifyStatus = "done" | "error" | "interrupted";

/** 从通知 id 解析回流 tab（`run-terminal-<tabId>-<rand>`；非本器形态返回 null） */
export function tabIdOfNotificationId(notificationId: string): number | null {
  const m = /^run-terminal-(\d+)-/.exec(notificationId);
  return m === null ? null : Number(m[1]);
}

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
  /** 通知 id 生成（缺省 `run-terminal-<tabId>-<uuid>`——id 内嵌回流目标是冷启动
   *  恢复的前提，注入形态须保持 `run-terminal-<tabId>-` 前缀可解析） */
  makeId?: (tabId: number) => string;
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

  constructor(deps: RunNotifierDeps) {
    this.deps = deps;
    deps.notifications.onClicked.addListener((notificationId) => this.onClicked(notificationId));
  }

  /** run 终态通知（run-manager drive() 收口调用——面板不可见时）。fire-and-forget：
   *  设置门可异步（storage 热读），失败面全兜（通知不炸 run 收口）。id 内嵌
   *  tabId——回流不依赖内存态（SW 冷启动后仍可解析） */
  notifyTerminal(input: TerminalNotifyInput): void {
    void this.resolveEnabled()
      .then((on) => {
        if (!on) return;
        const id =
          this.deps.makeId?.(input.tabId) ??
          `${TERMINAL_ID_PREFIX}${input.tabId}-${crypto.randomUUID()}`;
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

  /** 通知点击回流（构造时注册）：解析 id 内嵌 tabId → 激活绑定 tab + 打开面板；
   *  失败 fail-soft。二次点击幂等无害（tab 激活/开面板均幂等操作） */
  private onClicked(notificationId: string): void {
    const tabId = tabIdOfNotificationId(notificationId);
    if (tabId === null) return; // 非本器形态（他处通知）
    void this.deps.tabsUpdate
      .update(tabId, { active: true })
      .then(() => this.deps.sidePanelOpen({ tabId }))
      .catch((e: unknown) => {
        // tab 已关（update reject）或面板打开失败——面板仍可 Ctrl+Shift+K 打开
        this.deps.log?.(
          `notification click: 回流失败（tab ${tabId}）——${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }
}
