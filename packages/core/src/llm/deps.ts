// LLMDeps：I/O 注入（测试零真网络、退避单测冻结时钟、观测日志可路由）。
// 纯类型文件；缺省实现在 client.ts。
// 运行时基线：fetch/AbortSignal.timeout 在 Node 18+/MV3 SW 原生；AbortSignal.any 需
// Node 20.3+/Chrome 116+——包 engines 已声明 node >=22，以包声明为准。

export interface LLMDeps {
  /** 缺省全局 fetch。MV3 SW 与 Node 18+ 均原生；测试注入 mock */
  fetch?: typeof fetch;
  /** 单调时钟，缺省 performance.now()——退避预算单测冻结用（Python _mono 同动机） */
  now?: () => number;
  /** 可中止睡眠，缺省 AbortSignal-aware setTimeout 包装 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * 观测日志通道（退避每轮/fallback 切换/丢弃 toolCall 等.WARNING 级证据链，03 §3.6），
   * 缺省 console.warn。库不该写死宿主控制台：P4 接通 EventBus 后由宿主注入事件路由。
   * 取舍记录（轮 42 #7）：当前为单通道——信息级消息（backoff 进度/切换通知/
   * 已占位通知）与 WARNING 级证据混载，缺省统一 console.warn 呈现；P4 分级
   * 路由时扩展 level 参数，勿在宿主侧按消息前缀猜级别。
   */
  log?: (message: string) => void;
}
