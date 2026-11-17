// markdown 渲染面单测（issue #39 U3 批 A，验收①安全样例集）：
// react-markdown 双闸——raw HTML 不渲染（无 script/iframe/on* 属性）+
// urlTransform 协议白名单（javascript: 中和为 #）；GFM 表格/代码块复制钮；
// clipboard 不可用静默降级。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardUtil } from "../src/clipboard.js";
import { CopyButton, MarkdownText, safeUrlTransform } from "../src/markdown.js";

// jsdom 无 clipboard——mock 到模块封装面（组件经 ClipboardUtil 收口）
const writeText = vi.fn<(text: string) => Promise<void>>();
vi.spyOn(ClipboardUtil, "writeText").mockImplementation(writeText);

const ORIGINAL_CLIPBOARD = navigator.clipboard;
beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    value: ORIGINAL_CLIPBOARD,
    configurable: true,
  });
  vi.spyOn(ClipboardUtil, "writeText").mockImplementation(writeText);
});

describe("safeUrlTransform（协议白名单）", () => {
  it("http/https/mailto/相对/#/锚点放行；javascript:/data:/vbscript: 中和为 #", () => {
    expect(safeUrlTransform("https://a.example/x")).toBe("https://a.example/x");
    expect(safeUrlTransform("http://a.example")).toBe("http://a.example");
    expect(safeUrlTransform("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeUrlTransform("/path")).toBe("/path");
    expect(safeUrlTransform("#anchor")).toBe("#anchor");
    expect(safeUrlTransform("javascript:alert(1)")).toBe("#");
    expect(safeUrlTransform("JAVASCRIPT:alert(1)")).toBe("#");
    expect(safeUrlTransform("data:text/html,<script>")).toBe("#");
    expect(safeUrlTransform("vbscript:msgbox")).toBe("#");
  });
});

describe("MarkdownText 安全样例集（验收①——无脚本执行）", () => {
  it("raw <script>/<img onerror>/<iframe> 一律不进 DOM（react-markdown 默认拒 raw HTML）", () => {
    const hostile = [
      "# 标题",
      "",
      "<script>window.pwned=1</script>",
      '<img src="x" onerror="window.pwned=2">',
      '<iframe src="javascript:alert(3)"></iframe>',
      '<a href="javascript:alert(4)">x</a>',
      "",
      "正文",
    ].join("\n");
    const { container } = render(<MarkdownText>{hostile}</MarkdownText>);
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    // 无任何 on* 内联属性
    const withOn = Array.from(container.querySelectorAll("*")).filter((el) =>
      Array.from(el.attributes).some((a) => a.name.toLowerCase().startsWith("on")),
    );
    expect(withOn).toHaveLength(0);
    // 敌意原文按纯文本呈现（可见但不执行）
    expect(container.textContent).toContain("正文");
  });

  it("markdown 链接的 javascript: href 被中和为 #", () => {
    const { container } = render(
      <MarkdownText>{"[点击](javascript:alert(1)) 与 [正常](https://a.example)"}</MarkdownText>,
    );
    const links = Array.from(container.querySelectorAll("a"));
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe("#");
    expect(links[1]?.getAttribute("href")).toBe("https://a.example");
  });

  it("GFM 表格与删除线渲染", () => {
    const { container } = render(
      <MarkdownText>{"| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~旧~~"}</MarkdownText>,
    );
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("del")).toHaveLength(1);
  });

  it("代码块：语言标签 + hljs 高亮 class + 复制钮取全文", async () => {
    const md = "```ts\nconst x: number = 1;\nconsole.log(x);\n```";
    const { container } = render(<MarkdownText>{md}</MarkdownText>);
    const block = container.querySelector('[data-testid="code-block"]');
    expect(block).not.toBeNull();
    expect(block?.querySelector("code")?.className).toContain("language-ts");
    expect(block?.querySelector("code")?.className).toContain("hljs");
    expect(screen.getByLabelText("复制代码")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("复制代码"));
    expect(writeText).toHaveBeenCalledWith("const x: number = 1;\nconsole.log(x);\n");
  });

  it("无语言代码块回退 text 标签", () => {
    const { container } = render(<MarkdownText>{"```\nplain\n```"}</MarkdownText>);
    expect(container.querySelector(".tc-md-codebar")?.textContent).toContain("text");
  });
});

describe("CopyButton", () => {
  it("复制成功 → ✓ 反馈；1.5s 后复位", async () => {
    vi.useFakeTimers();
    try {
      render(<CopyButton text="hello" label="复制" />);
      const btn = screen.getByLabelText("复制");
      await act(async () => {
        fireEvent.click(btn);
      }); // act 刷 .then 微任务 + React 18 批量更新
      expect(writeText).toHaveBeenCalledWith("hello");
      expect(btn.textContent).toBe("✓");
      act(() => {
        vi.advanceTimersByTime(1600);
      });
      expect(btn.textContent).toBe("⧉");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clipboard 不可用（reject）静默降级——不炸渲染不弹错", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    render(<CopyButton text="x" label="复制" />);
    fireEvent.click(screen.getByLabelText("复制"));
    expect(screen.getByLabelText("复制")).not.toBeNull();
  });

  it("ClipboardUtil.writeText 原生面：navigator.clipboard 缺失时 reject", async () => {
    vi.spyOn(ClipboardUtil, "writeText").mockRestore();
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    await expect(ClipboardUtil.writeText("x")).rejects.toThrow("clipboard unavailable");
  });
});
