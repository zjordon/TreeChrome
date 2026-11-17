// 欢迎屏（issue #20 M3 + #35 U1b 二态）：空闲态品牌区 + 输入引导；有历史会话时
// 附「查看历史」链接（落地页 ↔ 历史入口——外部直驱欢迎卡 U2 再加第三态）。

export interface WelcomePanelProps {
  title: string;
  tagline: string;
  hint?: string;
  /** 历史会话数（>0 时渲染历史入口——二态依据） */
  historyCount?: number;
  onOpenHistory?: () => void;
}

export function WelcomePanel({
  title,
  tagline,
  hint = "在下方输入任务开始 ↓",
  historyCount = 0,
  onOpenHistory,
}: WelcomePanelProps) {
  return (
    <div className="tc-welcome" data-testid="welcome-panel">
      <div className="tc-welcome-title">{title}</div>
      <div>{tagline}</div>
      <div>{hint}</div>
      {historyCount > 0 && onOpenHistory !== undefined ? (
        <div>
          <button
            type="button"
            className="tc-welcome-history"
            onClick={onOpenHistory}
            data-testid="welcome-history"
          >
            查看历史会话（{historyCount}）
          </button>
        </div>
      ) : null}
    </div>
  );
}
