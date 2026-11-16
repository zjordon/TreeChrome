// 互斥命令的串行派发链（issue #32 评审轮 1 [1]）：run_task 与 drive/session_stop
// 共享同一台 Chrome 的 debugger 附着，双向互斥靠各自 dispatch 内部的门控检查
// （m1Gateway 查 isDriveActive+journal / driveGateway 查 journal 状态）——但
// bridge-runtime 对同批命令并发派发（startRequest void async），两类检查都存在
// 「检查 → 置态」的 await 间隙（run 的 starting 同步占位而 journal.begin 晚两个
// await；drive 的 ensure 在途数百 ms 期 core 仍空），并发下双向互检穿透 → 两路
// 先后 chrome.debugger attach 同一 tab，cdp-chrome 的强制 detach 重挂互踢。
// 这里把互斥对经同一条 promise 链串行派发：前者 dispatch resolve 时其状态已对
// 后者可见（run_task 经 control("start") 在 journal.begin 之后才返回；drive 动词
// 经 ensure 后 core 已就位）。get_snapshot 等只读命令保持并发，不加延迟。

import type { BridgeCommandRequest } from "@tw/protocol";

/** 需要互斥串行的命令面（stop_run 不 attach 无冲突，保持并发不拖慢用户停止） */
const MUTATING_METHODS = new Set<string>(["run_task", "drive", "session_stop"]);

export function createMutatingDispatchChain(
  dispatch: (request: BridgeCommandRequest, signal: AbortSignal) => Promise<unknown>,
): (request: BridgeCommandRequest, signal: AbortSignal) => Promise<unknown> {
  let chain: Promise<unknown> = Promise.resolve();
  return (request, signal) => {
    if (!MUTATING_METHODS.has(request.method)) return dispatch(request, signal);
    const run = chain.then(() => dispatch(request, signal));
    // 链尾吞错——单个命令失败不得断链（后续命令照常派发，错误由各自响应面回报）
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
