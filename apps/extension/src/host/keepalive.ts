// SW 存活策略（m5/04 §8）：run 进行中 chrome.debugger 事件流持续重置 idle timer
// （transport onEvent 在 SW 进程内活跃——主通道）；兜底 alarms 周期唤醒（run 启动
// 创建 / 结束清除）。真机长任务（抖音 ~10min）在段 F 验证。

import type { AlarmsApi } from "./chrome-apis.js";

export const KEEPALIVE_ALARM = "tc-keepalive";
/** Chrome 120+ 最小周期 30s（0.5 分钟） */
export const KEEPALIVE_PERIOD_MINUTES = 0.5;

export class KeepaliveController {
  private readonly alarms: AlarmsApi;
  private active = false;

  constructor(alarms: AlarmsApi) {
    this.alarms = alarms;
  }

  /** run 启动：创建兜底闹钟（幂等——同名 create 覆盖） */
  onStartRun(): void {
    this.active = true;
    this.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
  }

  /** run 结束/中止：清除（失败不抛——清理路径） */
  onEndRun(): void {
    if (!this.active) return;
    this.active = false;
    void this.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
  }
}
