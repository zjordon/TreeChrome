// 页签注册与切换（issue #39 U3 批 B，方案 §5 页签注册静态化）：宿主组态处静态
// 数组声明页面（id/title/order/isEnabled/Component），PageTabs 只承切换面——
// 聊天不是页签（缺省主视图），页签仅次级导航入口。roving 键盘焦点（tablist 规范）。

import type { ReactElement } from "react";

/** 静态页签注册项（宿主组态层声明；isEnabled=false 不出现——验收③） */
export interface PageRegistration {
  id: string;
  title: string;
  /** 排序键（方案 §5：任务 10/技能 40/调试日志 50） */
  order: number;
  isEnabled: boolean;
  /** 零 props 视图工厂（宿主闭包组装数据流；渲染处函数调用——评审轮 1 [2]
   *  组件体内声明的工厂作 JSX 类型会换引用致整页 remount） */
  Component: () => ReactElement;
}

export interface PageTabsProps {
  pages: Array<Pick<PageRegistration, "id" | "title">>;
  /** null = 聊天主视图（无页签活动） */
  activeId: string | null;
  /** 点页签（点活动中的页签由父层裁决——toggle 回聊天） */
  onSelect: (id: string) => void;
}

export function PageTabs({ pages, activeId, onSelect }: PageTabsProps) {
  if (pages.length === 0) return null;
  return (
    <div
      className="tc-page-tabs"
      role="tablist"
      aria-label="页面"
      data-testid="page-tabs"
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const buttons = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        );
        const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (idx === -1 || buttons.length === 0) return;
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const next = buttons[(idx + dir + buttons.length) % buttons.length];
        next?.focus();
      }}
    >
      {pages.map((p) => {
        const active = p.id === activeId;
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`page-tab-${p.id}`}
            className={active ? "tc-page-tab tc-page-tab--active" : "tc-page-tab"}
            onClick={() => onSelect(p.id)}
          >
            {p.title}
          </button>
        );
      })}
    </div>
  );
}
