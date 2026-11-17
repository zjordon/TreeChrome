// sidepanel 状态机（m5/05 §2）：SwToUiMessage → UI 态的纯 reducer（信封→props
// 适配的核心）。hello 全量重建（重连恢复）；live event 经 compactEventData 投影
// 进 JournalEvent 形态（与 journal 快照同一渲染面）；seq 去重（重连补发窗口重叠）；
// ack 回发序号随 ingest 返回（调用方发 journal-ack 释放环）。

import type {
  AttachmentBudget,
  AttachmentInfo,
  AttachmentRejection,
  DistillPhase,
  JournalEvent,
  RunJournalSnapshot,
  SessionMeta,
  SessionRecord,
  SwPermissionRequestMessage,
  SwSubmitRequestMessage,
  SwToUiMessage,
  TwEvent,
} from "@tw/protocol";
import { compactEventData } from "../runtime/journal.js";

/** 拒绝明细展示上限（防多文件连续被拒刷屏；最早的先被挤掉） */
export const ATTACHMENT_REJECTIONS_LIMIT = 5;

export interface SidepanelState {
  snapshot: RunJournalSnapshot | null;
  events: JournalEvent[];
  attachments: AttachmentInfo[];
  /** attachments 广播携带的预算投影（无广播前为 null——UI 不自行假定上限） */
  attachmentBudget: AttachmentBudget | null;
  /** 被拒附件明细（SW 拒绝广播 + 本地读文件失败汇入同一展示位） */
  attachmentRejections: AttachmentRejection[];
  permission: SwPermissionRequestMessage | null;
  submit: SwSubmitRequestMessage | null;
  /** skill-drafts 广播的待审草稿数（issue #5 D11 轻提示；null = 未收到过） */
  draftCount: number | null;
  /** 蒸馏过程状态拍（issue #9 D5：null = 无过程在跟踪。failed 常驻到下一 run——
   *  journal-snapshot runChanged / hello 换 run 时清空，新 run 不背旧失败） */
  distill: { phase: DistillPhase; detail: string | null } | null;
  /** 会话索引（issue #35 U1b：session-list 应答；空 = 未拉到/无会话） */
  sessions: SessionMeta[];
  /** 当前会话归档（session-open 应答；null = 未打开） */
  sessionRecord: SessionRecord | null;
  currentSessionId: string | null;
  /** session-updated 计数（变更是 fetch 触发器——载荷只带定位摘要，D8 单源） */
  sessionRev: number;
}

export const initialSidepanelState: SidepanelState = {
  snapshot: null,
  events: [],
  attachments: [],
  attachmentBudget: null,
  attachmentRejections: [],
  permission: null,
  submit: null,
  draftCount: null,
  distill: null,
  sessions: [],
  sessionRecord: null,
  currentSessionId: null,
  sessionRev: 0,
};

/** 本地动作（确认卡 resolve 后乐观清除——SW 不广播 resolve 回执；拒绝明细的
 *  清除同理：× 逐条Dismiss、起跑时整表清——SW 不回执 UI 本地动作） */
export type SidepanelAction =
  | SwToUiMessage
  | { kind: "permission-resolved" }
  | { kind: "submit-resolved" }
  | { kind: "attachment-rejection-dismissed"; index: number }
  | { kind: "attachment-rejections-cleared" }
  /** 本地组装的拒绝（读文件失败等无 SW 广播的失败面——与 SW 拒绝同形同位展示） */
  | { kind: "attachment-rejected-local"; rejection: AttachmentRejection }
  /** session-list 应答（issue #35 U1b） */
  | { kind: "session-index"; sessions: SessionMeta[] }
  /** session-open 应答（null = 会话已不存在——清空当前视图） */
  | {
      kind: "session-record";
      record: SessionRecord | null;
      /** 发起 session-open 时的会话（迟到应答防串台——评审轮 2 [8]；record null
       *  = 确认不存在（notFound），清当前指向回落地页） */
      forSessionId: string;
    }
  /** 当前会话切换（null = 无当前——落地页态） */
  | { kind: "session-current"; sessionId: string | null };

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
    case "hello": {
      // SW 空闲被杀后重连：hello 无活 run（null）——保留上一 run 的终态视图
      //（段 F 验收：整表重建为空 = 「任务成功后一段时间消息自动清空」；新 run
      // 的重置点是 begin 后的 journal-snapshot 起始快照，不是 SW 唤醒）
      const snap = action.snapshot;
      if (snap === null) {
        return { state, ack: null };
      }
      // journal.ack 已把渲染过的事件从 SW 快照释放——hello 只带未 ack 尾巴，
      // 不得整表替换本地时间线（重连会销毁唯一副本，评审轮 1 [13]）；仅换 run
      // 才全量重建
      const sameRun = state.snapshot?.runId === snap.runId;
      const tail = snap.events;
      return {
        state: {
          ...state,
          snapshot: snap,
          events: sameRun
            ? [...state.events, ...tail.filter((t) => !state.events.some((e) => e.seq === t.seq))]
            : tail,
          attachments: snap.attachments,
          // 换 run（如 SW 休眠期间新 run 已起）——旧 run 的蒸馏状态一并作废
          ...(sameRun ? {} : { distill: null }),
          // 会话归属同步（#35：SW 侧受理时已写——面板跟随；换会话连归档一起清
          // 防串台，与 journal-snapshot 分支对齐——评审轮 2 [4]）
          ...(snap.sessionId !== undefined && snap.sessionId !== state.currentSessionId
            ? { currentSessionId: snap.sessionId, sessionRecord: null }
            : snap.sessionId !== undefined
              ? { currentSessionId: snap.sessionId }
              : {}),
        },
        ack: null,
      };
    }
    case "session-updated": {
      // 变更合并推送只做触发器（载荷是定位摘要非全量——UI 按需补查，D8）
      return { state: { ...state, sessionRev: state.sessionRev + 1 }, ack: null };
    }
    case "session-index":
      return { state: { ...state, sessions: action.sessions }, ack: null };
    case "session-record": {
      // 迟到应答防串台（评审轮 2 [8]）：effect 的 cancelled 旗要到 cleanup 才置位，
      // 应答宏任务可先到——切会话/自动跟随后旧会话的应答（record 或 notFound 清空）
      // 一律按 forSessionId 归属丢弃
      if (action.forSessionId !== state.currentSessionId) return { state, ack: null };
      if (action.record === null) {
        return {
          state: { ...state, sessionRecord: null, currentSessionId: null },
          ack: null,
        };
      }
      return { state: { ...state, sessionRecord: action.record }, ack: null };
    }
    case "session-current": {
      // 切会话：归档视图即时清（fetch 在途不闪旧会话内容）
      if (action.sessionId === state.currentSessionId) return { state, ack: null };
      return {
        state: {
          ...state,
          currentSessionId: action.sessionId,
          sessionRecord: null,
        },
        ack: null,
      };
    }
    case "skill-drafts": {
      // D11 轻提示：sidepanel 只显示待审数——审阅面在 options 页
      return { state: { ...state, draftCount: action.count }, ack: null };
    }
    case "distill-status": {
      // issue #9 D5：过程拍只置位不清——终态语义由 phase 自带（done/failed），
      // 清空时机在下一 run 起跑（journal-snapshot runChanged）
      return {
        state: { ...state, distill: { phase: action.phase, detail: action.detail ?? null } },
        ack: null,
      };
    }
    case "journal-snapshot": {
      // run 切换（SW 在 begin 后广播起始快照——seq 已重置）→ 全量重建；同 run
      // 终态快照只更新视图字段（评审轮 1 [6]：不重建则新 run 事件被 seq 去重
      // 全部丢弃、时间线显示旧 run）
      const runChanged = state.snapshot?.runId !== action.snapshot.runId;
      const nextSessionId =
        action.snapshot.sessionId !== undefined ? action.snapshot.sessionId : null;
      return {
        state: {
          ...(runChanged
            ? { ...state, snapshot: action.snapshot, events: action.snapshot.events, distill: null }
            : { ...state, snapshot: action.snapshot }),
          // 会话归属跟随（#35：bridge/远端发起的 run 面板自动切换视图）
          ...(nextSessionId !== null && nextSessionId !== state.currentSessionId
            ? { currentSessionId: nextSessionId, sessionRecord: null }
            : {}),
        },
        ack: null,
      };
    }
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
      return {
        state: { ...state, attachments: action.items, attachmentBudget: action.budget },
        ack: null,
      };
    case "attachment-rejected":
      return {
        state: {
          ...state,
          attachmentRejections: [...state.attachmentRejections, action.rejection].slice(
            -ATTACHMENT_REJECTIONS_LIMIT,
          ),
        },
        ack: null,
      };
    case "attachment-rejected-local":
      return {
        state: {
          ...state,
          attachmentRejections: [...state.attachmentRejections, action.rejection].slice(
            -ATTACHMENT_REJECTIONS_LIMIT,
          ),
        },
        ack: null,
      };
    case "attachment-rejection-dismissed":
      return {
        state: {
          ...state,
          attachmentRejections: state.attachmentRejections.filter((_, i) => i !== action.index),
        },
        ack: null,
      };
    case "attachment-rejections-cleared":
      return {
        state:
          state.attachmentRejections.length === 0 ? state : { ...state, attachmentRejections: [] },
        ack: null,
      };
    case "permission-resolved":
      return { state: { ...state, permission: null }, ack: null };
    case "submit-resolved":
      return { state: { ...state, submit: null }, ack: null };
    default:
      return { state, ack: null };
  }
}
