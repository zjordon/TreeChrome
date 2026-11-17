// GoalStrip（#37 批 C）：会话目标条——composer 顶部条件行，显示当前会话目标
// tab 的 host+路径截断，点击聚焦该 tab（session-focus op）。TC 会话本质是「围绕
// 一个页面目标的任务序列」——目标比 qz 的 Goal 模式更必要。零 chrome。

export interface GoalStripProps {
  url: string;
  onFocus: () => void;
}

/** URL → host + 路径截断（显示形态；坏 URL 原样返回截断） */
export function goalLabelOf(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    const label = `${u.host}${path}${u.search}`;
    return label.length > 48 ? `${label.slice(0, 47)}…` : label;
  } catch {
    return url.length > 48 ? `${url.slice(0, 47)}…` : url;
  }
}

export function GoalStrip({ url, onFocus }: GoalStripProps) {
  return (
    <button
      type="button"
      className="tc-goal-strip"
      data-testid="goal-strip"
      onClick={onFocus}
      title="聚焦会话目标标签页"
    >
      <span aria-hidden="true">◎</span> {goalLabelOf(url)}
    </button>
  );
}
