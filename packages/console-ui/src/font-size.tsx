// 字号档位（issue #39 U3 批 C，验收⑤）：纯视图偏好不入 SW 设置面（D4——SW 单一
// 写者纪律），localStorage 持久化 + documentElement 挂档位类（.tc-font-sm/lg，
// md=缺省无类）。三档 12/13/15px 经 base.css 的 html 档位规则缩放 .tc-root，
// 双主题 token 继承天然可读。

import { useEffect, useState } from "react";

export type FontSize = "sm" | "md" | "lg";
export const FONT_SIZE_KEY = "tc:font-size";
export const FONT_SIZES: FontSize[] = ["sm", "md", "lg"];

const FONT_SIZE_LABEL: Record<FontSize, string> = {
  sm: "小",
  md: "标准",
  lg: "大",
};

/** 读档位（坏值/缺失回退 md）；storage 不可用时 md（try/catch——隐私模式等） */
export function readFontSize(): FontSize {
  try {
    const v = window.localStorage.getItem(FONT_SIZE_KEY);
    return v === "sm" || v === "lg" ? v : "md";
  } catch {
    return "md";
  }
}

function writeFontSize(size: FontSize): void {
  try {
    window.localStorage.setItem(FONT_SIZE_KEY, size);
  } catch {
    // 写失败静默——本会话档位仍生效
  }
}

/** 档位类挂 documentElement（html 级——.tc-root 全树继承缩放） */
function applyFontSizeClass(size: FontSize): void {
  const root = document.documentElement;
  for (const s of FONT_SIZES) root.classList.toggle(`tc-font-${s}`, s === size && s !== "md");
}

export interface FontSizePopoverProps {
  /** 受控初值缺省读 localStorage（宿主不持态——纯偏好自管理） */
  initial?: FontSize;
}

/** Aa 钮 + 弹出三档（aria-expanded；Esc/再点关闭；选择即生效并持久化） */
export function FontSizePopover({ initial }: FontSizePopoverProps) {
  const [size, setSize] = useState<FontSize>(initial ?? readFontSize());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    applyFontSizeClass(size);
  }, [size]);
  const choose = (next: FontSize): void => {
    setSize(next);
    writeFontSize(next);
  };
  return (
    <span style={{ position: "relative", display: "inline-flex" }} data-testid="font-size">
      <button
        type="button"
        className="tc-page-tab"
        aria-expanded={open}
        aria-label="字号"
        data-testid="font-size-toggle"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        Aa
      </button>
      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: 弹卡是按钮容器非表单语义组——fieldset 不适用
        <span className="tc-font-popover" role="group" aria-label="字号档位">
          {FONT_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              className={s === size ? "tc-page-tab tc-page-tab--active" : "tc-page-tab"}
              aria-pressed={s === size}
              data-testid={`font-size-${s}`}
              onClick={() => {
                choose(s);
                setOpen(false);
              }}
            >
              {FONT_SIZE_LABEL[s]}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
