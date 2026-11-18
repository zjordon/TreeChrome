// SearchOverlay（issue #41 U4 批 B，验收①）：聊天搜索浮层——输入 / ↑↓ 导航 /
// 命中计数（aria-live 播报）/ Esc 关。浮层定位（sticky 挂 main 顶部右侧）由
// layout.css 的 .tc-search-pop 承载；状态与命中计算在宿主（组件零依赖转录面）。

import { useEffect, useRef } from "react";

export interface SearchOverlayProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** 当前命中（0-based）；count=0 时展示层忽略 */
  matchIndex: number;
  matchCount: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function SearchOverlay({
  query,
  onQueryChange,
  matchIndex,
  matchCount,
  onPrev,
  onNext,
  onClose,
}: SearchOverlayProps) {
  // 挂载即聚焦（打开搜索的目的就是输入）——effect 而非 autoFocus（a11y 规则面）
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    // <search> 是 HTML5 语义地标元素（useSemanticElements 的原生对应）
    <search className="tc-search-pop" data-testid="search-overlay">
      <input
        type="search"
        ref={inputRef}
        data-testid="search-input"
        aria-label="搜索本会话"
        placeholder="搜索本会话…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
      />
      {/* 验收①：命中计数 aria-live 播报 */}
      <span className="tc-ev-muted" data-testid="search-count" aria-live="polite">
        {matchCount === 0 ? "无命中" : `${matchIndex + 1}/${matchCount} 处`}
      </span>
      <button type="button" aria-label="上一处命中" data-testid="search-prev" onClick={onPrev}>
        ↑
      </button>
      <button type="button" aria-label="下一处命中" data-testid="search-next" onClick={onNext}>
        ↓
      </button>
      <button type="button" aria-label="关闭搜索" data-testid="search-close" onClick={onClose}>
        ×
      </button>
    </search>
  );
}
