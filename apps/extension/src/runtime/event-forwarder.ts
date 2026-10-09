// 事件转发（m5/04 §4.2）：EventBus 订阅（core 10 类全转——"*"）→ journal.record
// （seq 编号+压缩）→ Port 广播 `{kind:"event", seq, event}`。消息体护栏：单事件
// 超 1MB → 截断标记形态（保 eventType/step，丢大体字段——model_result 长文本）。
// 断连不中断 run（sink 是 port-server 的广播函数，无 port 时静默）。
// 订阅不可退（EventBus 无 unsubscribe——bus 是 run 级生命周期，run 结束随 run 丢弃）。

import type { EventBus, TwEvent } from "@tw/core";
import type { SwToUiMessage } from "@tw/protocol";
import { JOURNAL_EVENT_JSON_LIMIT, type RunJournal } from "./journal.js";

export type EventSink = (message: SwToUiMessage) => void;

/** 超限事件的截断标记形态（保最小定位面；大体字段整体丢弃） */
function truncatedMarker(event: TwEvent): TwEvent {
  return {
    eventType: event.eventType,
    step: event.step,
    sessionId: event.sessionId,
    truncated: true,
  } as unknown as TwEvent;
}

export class EventForwarder {
  private readonly bus: EventBus;
  private readonly journal: RunJournal;
  private readonly sink: EventSink;

  constructor(bus: EventBus, journal: RunJournal, sink: EventSink) {
    this.bus = bus;
    this.journal = journal;
    this.sink = sink;
  }

  /** run 启动时接一次（bus 随 run 生命周期丢弃——无需退订） */
  start(): void {
    this.bus.subscribe("*", (event) => {
      const entry = this.journal.record(event);
      if (entry === null) return;
      const payload =
        JSON.stringify(event).length > JOURNAL_EVENT_JSON_LIMIT ? truncatedMarker(event) : event;
      this.sink({ kind: "event", seq: entry.seq, event: payload });
    });
  }
}
