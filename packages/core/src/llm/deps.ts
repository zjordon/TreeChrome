// LlmDeps：I/O 三件套注入（测试零真网络、退避单测冻结时钟）。纯类型文件；缺省实现在 client.ts。

export interface LlmDeps {
  /** 缺省全局 fetch。MV3 SW 与 Node 18+ 均原生；测试注入 mock */
  fetch?: typeof fetch;
  /** 单调时钟，缺省 performance.now()——退避预算单测冻结用（Python _mono 同动机） */
  now?: () => number;
  /** 可中止睡眠，缺省 AbortSignal-aware setTimeout 包装 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
