// sidepanel 状态机（m5/05 §2）：SwToUiMessage → UI 态的纯 reducer（信封→props
// 适配的核心）。hello 全量重建（重连恢复）；live event 经 compactEventData 投影
// 进 JournalEvent 形态（与 journal 快照同一渲染面）；seq 去重（重连补发窗口重叠）；
// ack 回发序号随 ingest 返回（调用方发 journal-ack 释放环）。

import type {
  AttachmentInfo,
  JournalEvent,
  RunJournalSnapshot,
  SwPermissionRequestMessage,
  SwSubmitRequestMessage,
  SwToUiMessage,
  TwEvent,
} from "@tw/protocol";
import { compactEventData } from "../runtime/journal.js";

export interface SidepanelState {
  snapshot: RunJournalSnapshot | null;
  events: JournalEvent[];
  attachments: AttachmentInfo[];
  permission: SwPermissionRequestMessage | null;
  submit: SwSubmitRequestMessage | null;
}

export const initialSidepanelState: SidepanelState = {
  snapshot: null,
  events: [],
  attachments: [],
  permission: null,
  submit: null,
};

/** 本地动作（确认卡 resolve 后乐观清除——SW 不广播 resolve 回执） */
export type SidepanelAction =
  | SwToUiMessage
  | { kind: "permission-resolved" }
  | { kind: "submit-resolved" };

/** live TwEvent → journal 条目形态（ts 取接收时刻墙上钟——展示序不参与协议；
 *  step 已随 compactEventData 进 data——JournalEvent 顶层无 step 字段） */
export function liveEventToJournal(seq: number, event: TwEvent, ts: number): JournalEvent {
  return { seq, type: event.eventType, ts, data: compactEventData(event) };
}

/** 摄取一条 SW 消息：返回下一态 + 需回发的 journal-ack seq（仅 event 消息） */
export function ingestSidepanel(
  state: SidepanelState,
  action: SidepanelAction,
  now = (): number => Date.now(),
): { state: SidepanelState; ack: number | null } {
  switch (action.kind) {
    case "hello":
      return {
        state: {
          ...state,
          snapshot: action.snapshot,
          events: action.snapshot?.events ?? [],
          // hello 后紧跟挂起卡补发——权限/提交卡不在此重建，交由补发消息
          attachments: action.snapshot?.attachments ?? [],
        },
        ack: null,
      };
    case "journal-snapshot":
      return { state: { ...state, snapshot: action.snapshot }, ack: null };
    case "event": {
      if (state.events.some((e) => e.seq >= action.seq)) return { state, ack: null };
      return {
        state: {
          ...state,
          events: [...state.events, liveEventToJournal(action.seq, action.event, now())],
        },
        ack: action.seq,
      };
    }
    case "permission-request":
      return { state: { ...state, permission: action }, ack: null };
    case "permission-cancelled":
      return state.permission?.token === action.token
        ? { state: { ...state, permission: null }, ack: null }
        : { state, ack: null };
    case "submit-request":
      return { state: { ...state, submit: action }, ack: null };
    case "attachments":
      return { state: { ...state, attachments: action.items }, ack: null };
    case "permission-resolved":
      return { state: { ...state, permission: null }, ack: null };
    case "submit-resolved":
      return { state: { ...state, submit: null }, ack: null };
    default:
      return { state, ack: null };
  }
}
