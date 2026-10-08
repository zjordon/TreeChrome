// 侧边栏冒烟组件（m5/01 §A4）：段 A 只验证 chrome 引用合法区（粘合层在
// entrypoints/）+ echo 消息往返；段 E 换成 console-ui 全量组态（TaskBar/RunTimeline/
// 权限卡）。chrome 交互（browser.runtime.sendMessage）留在本粘合层——console-ui 组件
// 只收 props/回调。

import { ThemedRoot } from "@tw/console-ui";
import { useState } from "react";
import { browser } from "wxt/browser";

export function App() {
  const [echoResult, setEchoResult] = useState<string>("（未测试）");

  const runEcho = async () => {
    try {
      const res = (await browser.runtime.sendMessage({
        kind: "diag",
        command: "echo",
        payload: { from: "sidepanel", ts: Date.now() },
      })) as { ok?: boolean; payload?: unknown } | undefined;
      setEchoResult(
        res !== undefined && res.ok === true
          ? `✅ ${JSON.stringify(res.payload)}`
          : `❌ ${JSON.stringify(res)}`,
      );
    } catch (e) {
      setEchoResult(`❌ ${String(e)}`);
    }
  };

  return (
    <ThemedRoot>
      <main style={{ padding: 12, display: "grid", gap: 8 }}>
        <h1 style={{ fontSize: 15, margin: 0 }}>TreeChrome</h1>
        <p style={{ margin: 0, color: "var(--tc-muted)" }}>
          M5 段 A 骨架——SW echo 通道冒烟（段 E 换全量 UI）。
        </p>
        <button type="button" onClick={runEcho} style={{ justifySelf: "start" }}>
          测试 SW echo
        </button>
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            color: "var(--tc-muted)",
            fontSize: 11,
          }}
        >
          {echoResult}
        </pre>
      </main>
    </ThemedRoot>
  );
}
