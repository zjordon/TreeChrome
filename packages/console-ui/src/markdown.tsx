// MarkdownText（issue #39 U3 批 A）：finalResult 的安全 markdown 渲染——
// react-markdown 默认不渲染 raw HTML（第一道闸）+ urlTransform 协议白名单
//（第二道闸）；rehype-highlight 代码高亮（CodeBlock 带语言标签与复制钮）。
// lastError 不走此面（D6：错误原文含尖括号/反引号概率高，重排失真）。

import { type HTMLAttributes, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { ClipboardUtil } from "./clipboard.js";

/** 允许出站的协议白名单（javascript:/data:/vbscript: 一律中和为 #）。
 *  单参签名（测试直调）；赋给 react-markdown 的 urlTransform（三参）合法——逆变 */
const SAFE_URL_RE = /^(https?:|mailto:|#|\/|\.\.?\/)/i;
export function safeUrlTransform(url: string): string {
  return SAFE_URL_RE.test(url) ? url : "#";
}

/**
 * 复制钮（气泡/finalResult/代码块共用）：剪贴板写入 + 「已复制」瞬时反馈。
 * clipboard 不可用（非安全上下文/旧 jsdom）时静默降级——不炸渲染。
 */
export function CopyButton({
  text,
  label,
}: {
  /** 静态文本或惰性取值（代码块经 DOM 读 textContent） */
  text: string | (() => string);
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    const value = typeof text === "function" ? text() : text;
    void ClipboardUtil.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <button
      type="button"
      className="tc-copy-btn"
      data-testid="copy-btn"
      aria-label={label}
      title={label}
      onClick={copy}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

/** pre 重包装：语言标签（code.language-* 提取）+ 复制钮 */
function CodeBlock({ children, ...rest }: HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [lang, setLang] = useState<string | null>(null);
  useEffect(() => {
    // children 是纯触发器（换块重查语言）——显式消费让依赖必要性成立
    void children;
    // react-markdown 不透传 code 的 className 到 pre——语言经 DOM 查询取
    const cls = ref.current?.querySelector("code")?.className ?? "";
    const hit = /language-([\w+-]+)/.exec(cls);
    setLang(hit?.[1] ?? null);
  }, [children]);
  return (
    <div className="tc-md-codeblock" data-testid="code-block">
      <div className="tc-md-codebar">
        <span className="tc-ev-muted">{lang ?? "text"}</span>
        <CopyButton text={() => ref.current?.textContent ?? ""} label="复制代码" />
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  );
}

export function MarkdownText({ children }: { children: string }) {
  return (
    <div className="tc-md" data-testid="markdown-text">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={safeUrlTransform}
        components={{ pre: CodeBlock }}
      >
        {children}
      </Markdown>
    </div>
  );
}
