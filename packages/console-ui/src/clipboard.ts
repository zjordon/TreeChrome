// 剪贴板薄封装（issue #39 U3 批 A）：navigator.clipboard 的可注入收口——
// jsdom/非安全上下文缺面时 reject 而不炸渲染（CopyButton 静默降级）。

export const ClipboardUtil = {
  writeText(text: string): Promise<void> {
    const clip = navigator.clipboard;
    if (clip === undefined || clip === null) {
      return Promise.reject(new Error("clipboard unavailable"));
    }
    return clip.writeText(text);
  },
};
