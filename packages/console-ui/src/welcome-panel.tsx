// 欢迎屏（issue #20 M3）：空闲态（无 run 且无事件）的品牌区 + 输入引导。

export interface WelcomePanelProps {
  title: string;
  tagline: string;
  hint?: string;
}

export function WelcomePanel({ title, tagline, hint = "在下方输入任务开始 ↓" }: WelcomePanelProps) {
  return (
    <div className="tc-welcome">
      <div className="tc-welcome-title">{title}</div>
      <div>{tagline}</div>
      <div>{hint}</div>
    </div>
  );
}
