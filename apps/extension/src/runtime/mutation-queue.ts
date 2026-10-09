// 互斥变更队列（m5/05 评审轮 1 [12]）：SW 单线程但 await 点交错——无锁
// load→filter→save 的读-改-写会被并发消息交错覆盖（后写者复活前者已删条目）。
// promise 链串行化：所有变更排队执行，前序失败不阻塞后续。

export function createMutationQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
}
