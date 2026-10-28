// 段控原语（issue #20 M2）：受控单选组——button + aria-pressed（active 项 accent-subtle 底）；
// 首个消费方是 M4 设置分类 tab，本期交付原语与测试。

export interface SegmentItem {
  value: string;
  label: string;
}

export interface SegmentProps {
  items: SegmentItem[];
  value: string;
  onChange: (value: string) => void;
  /** role=group 的可访问名 */
  ariaLabel: string;
  className?: string;
}

export function Segment({ items, value, onChange, ariaLabel, className }: SegmentProps) {
  return (
    <fieldset
      className={["tc-segment", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className="tc-segment-item"
          aria-pressed={item.value === value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}
