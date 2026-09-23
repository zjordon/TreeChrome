// LlmDeps：I/O 注入（测试零真网络、退避单测冻结时钟、观测日志可路由）。
// 纯类型文件；缺省实现在 client.ts。
// 运行时基线：fetch/AbortSignal.timeout 在 Node 18+/MV3 SW 原生；AbortSignal.any 需
// Node 20.3+/Chrome 116+——包 engines 已声明 node >=22，以包声明为准。

export interface LlmDeps {
  /** 缺省全局 fetch。MV3 SW 与 Node 18+ 均原生；测试注入 mock */
  fetch?: typeof fetch;
  /** 单调时钟，缺省 performance.now()——退避预算单测冻结用（Python _mono 同动机） */
  now?: () => number;
  /** 可中止睡眠，缺省 AbortSignal-aware setTimeout 包装 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * 观测日志通道（退避每轮/fallback 切换/丢弃 toolCall 等.WARNING 级证据链，03 §3.6），
   * 缺省 console.warn。库不该写死宿主控制台：P4 接通 EventBus 后由宿主注入事件路由。
   */
  log?: (message: string) => void;
}
