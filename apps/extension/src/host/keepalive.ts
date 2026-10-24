// SW 存活策略（m5/04 §8）：run 进行中 chrome.debugger 事件流持续重置 idle timer
// （transport onEvent 在 SW 进程内活跃——主通道）；兜底 alarms 周期唤醒（run 启动
// 创建 / 结束清除）。真机长任务（抖音 ~10min）在段 F 验证。
// issue #5 S4：hold()/release() 引用计数——蒸馏等 run 外长调用（LLM 60s 级）期间
// 保活；run 语义不变（run 与 hold 任一在位即保活，全部退场才清）。

import type { AlarmsApi } from "./chrome-apis.js";

export const KEEPALIVE_ALARM = "tc-keepalive";
/** Chrome 120+ 最小周期 30s（0.5 分钟） */
export const KEEPALIVE_PERIOD_MINUTES = 0.5;

export class KeepaliveController {
  private readonly alarms: AlarmsApi;
  private runActive = false;
  private holds = 0;

  constructor(alarms: AlarmsApi) {
    this.alarms = alarms;
  }

  /** run 启动：创建兜底闹钟（幂等——同名 create 覆盖） */
  onStartRun(): void {
    this.runActive = true;
    this.sync();
  }

  /** run 结束/中止：清除（失败不抛——清理路径）；蒸馏 hold 在位时不清 */
  onEndRun(): void {
    if (!this.runActive) return;
    this.runActive = false;
    this.sync();
  }

  /** run 外长调用保活（issue #5：蒸馏 LLM 60s 级——SW 30s idle 会被杀） */
  hold(): void {
    this.holds += 1;
    this.sync();
  }

  /** 与 hold 配对释放；归零且无 run 时清闹钟（失败不抛） */
  release(): void {
    if (this.holds === 0) return;
    this.holds -= 1;
    this.sync();
  }

  private sync(): void {
    if (this.runActive || this.holds > 0) {
      this.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
    } else {
      void this.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
    }
  }
}
