// 会话存储层（issue #35 U1a W2）：tc_sessions:index（SessionMeta[]，上限 50 条
// LRU——超限连带删除最老会话键）+ tc_session:<id>（SessionRecord，单会话 1MB 预算
// 降级链）。全部读-改-写经变更链串行（并发 beginRun/completeRun 不以后写覆盖先写
// ——mutation-queue/driveAuditWriter 同款）；坏形态回空不抛（宽松收窄，
// settings-store 风格）。零 chrome 依赖（StorageAreaWithRemove 注入）。

import type {
  AttachmentInfo,
  JournalEvent,
  RunArchive,
  RunArchiveUsage,
  RunStatus,
  SessionMeta,
  SessionOrigin,
  SessionRecord,
  SessionTurn,
} from "@tw/protocol";
import type { StorageAreaWithRemove } from "../host/chrome-apis.js";

export const SESSIONS_INDEX_KEY = "tc_sessions:index";
export const sessionKey = (sessionId: string): string => `tc_session:${sessionId}`;
export const SESSION_INDEX_LIMIT = 50;
export const SESSION_BUDGET_BYTES = 1024 * 1024;
/** 单会话排队上限（U2 批 A：入队拒绝面） */
export const SESSION_QUEUE_LIMIT = 5;
/** turn 任务原文留存上限（超长输入先于事件降级裁剪——转录用户气泡够用） */
export const TURN_TASK_CLIP = 8000;

/** completeRun 的归档入参（turnId 由 repo 关联填充——调用方只知自己的 turn） */
export type RunArchiveInput = Omit<RunArchive, "turnId">;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseMeta(v: unknown): SessionMeta | null {
  if (!isRecord(v)) return null;
  const sessionId = str(v.sessionId);
  const tabId = num(v.tabId);
  const title = str(v.title);
  const origin = v.origin === "user" || v.origin === "bridge" ? v.origin : null;
  const createdAt = num(v.createdAt);
  const updatedAt = num(v.updatedAt);
  if (
    sessionId === null ||
    sessionId === "" ||
    tabId === null ||
    title === null ||
    origin === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    sessionId,
    tabId,
    title,
    origin,
    runCount: num(v.runCount) ?? 0,
    lastStatus: str(v.lastStatus) as RunStatus | null,
    createdAt,
    updatedAt,
    usageTokens: num(v.usageTokens) ?? 0,
  };
}

function parseTurn(v: unknown): SessionTurn | null {
  if (!isRecord(v)) return null;
  const turnId = str(v.turnId);
  const sessionId = str(v.sessionId);
  const task = str(v.task);
  const status = str(v.status);
  const createdAt = num(v.createdAt);
  if (
    turnId === null ||
    sessionId === null ||
    task === null ||
    createdAt === null ||
    !["queued", "running", "done", "error", "interrupted", "cancelled"].includes(status ?? "")
  ) {
    return null;
  }
  return {
    turnId,
    sessionId,
    runId: str(v.runId),
    task,
    status: status as SessionTurn["status"],
    attachments: (Array.isArray(v.attachments) ? v.attachments : []).filter(
      (a): a is AttachmentInfo =>
        isRecord(a) && typeof a.attachmentId === "string" && typeof a.name === "string",
    ),
    createdAt,
    endedAt: num(v.endedAt),
  };
}

function parseArchive(v: unknown): RunArchive | null {
  if (!isRecord(v)) return null;
  const runId = str(v.runId);
  const turnId = str(v.turnId);
  const status = str(v.status);
  const startedAt = num(v.startedAt);
  const endedAt = num(v.endedAt);
  if (
    runId === null ||
    turnId === null ||
    startedAt === null ||
    endedAt === null ||
    !["done", "error", "interrupted"].includes(status ?? "")
  ) {
    return null;
  }
  const usage = isRecord(v.usage) ? v.usage : {};
  return {
    runId,
    turnId,
    startedAt,
    endedAt,
    status: status as RunArchive["status"],
    finalResult: str(v.finalResult),
    lastError: str(v.lastError),
    events: (Array.isArray(v.events) ? v.events : []).filter(
      (e): e is JournalEvent =>
        isRecord(e) && typeof e.seq === "number" && typeof e.type === "string",
    ),
    usage: {
      inputTokens: num(usage.inputTokens) ?? 0,
      outputTokens: num(usage.outputTokens) ?? 0,
    },
    discardedBeforeSeq: num(v.discardedBeforeSeq) ?? 0,
  };
}

function parseRecord(v: unknown): SessionRecord | null {
  if (!isRecord(v)) return null;
  const meta = parseMeta(v.meta);
  if (meta === null) return null;
  return {
    meta,
    turns: (Array.isArray(v.turns) ? v.turns : []).map(parseTurn).filter((t) => t !== null),
    runs: (Array.isArray(v.runs) ? v.runs : []).map(parseArchive).filter((r) => r !== null),
  };
}

const byteSize = (v: unknown): number => JSON.stringify(v)?.length ?? 0;

const isToolResult = (e: JournalEvent): boolean => e.type === "tool_result";
const isModelCall = (e: JournalEvent): boolean => e.type === "model_call";

/**
 * 单会话预算降级链（验收④）：全量超预算时逐级牺牲保转录骨架——
 * ① tool_result 的 error 裁到 200 字符 → ② 丢 tool_result 明细（tool_call 标题行
 * 仍在，转录工具行不缺）→ ③ 丢 model_call（model_result 语义更重）→ ④ 整 run
 * 从最老起丢（meta/turns 恒保）。降级只动 runs.events，不改环记账字段语义。
 */
export function enforceSessionBudget(record: SessionRecord, budget: number): SessionRecord {
  const clipToolError = (events: JournalEvent[], limit: number): JournalEvent[] =>
    events.map((e) => {
      if (!isToolResult(e) || !isRecord(e.data)) return e;
      const error = typeof e.data.error === "string" ? e.data.error : null;
      if (error === null || error.length <= limit) return e;
      return { ...e, data: { ...e.data, error: `${error.slice(0, limit)}…` } };
    });
  const dropEvents = (
    events: JournalEvent[],
    match: (e: JournalEvent) => boolean,
  ): JournalEvent[] => events.filter((e) => !match(e));

  let out = record;
  const passes: Array<(r: SessionRecord) => SessionRecord> = [
    (r) => ({
      ...r,
      runs: r.runs.map((run) => ({ ...run, events: clipToolError(run.events, 200) })),
    }),
    (r) => ({
      ...r,
      runs: r.runs.map((run) => ({ ...run, events: dropEvents(run.events, isToolResult) })),
    }),
    (r) => ({
      ...r,
      runs: r.runs.map((run) => ({ ...run, events: dropEvents(run.events, isModelCall) })),
    }),
  ];
  for (const pass of passes) {
    if (byteSize(out) <= budget) return out;
    out = pass(out);
  }
  while (byteSize(out) > budget && out.runs.length > 1) {
    out = { ...out, runs: out.runs.slice(1) };
  }
  return out;
}

export interface SessionRepoOptions {
  newSessionId?: () => string;
  newTurnId?: () => string;
  now?: () => number;
  /** 单会话预算（缺省 1MB——测试注入小值） */
  budget?: number;
  log?: (message: string) => void;
}

export class SessionRepository {
  private readonly area: StorageAreaWithRemove;
  private readonly newSessionId: () => string;
  private readonly newTurnId: () => string;
  private readonly now: () => number;
  private readonly budget: number;
  private readonly log: (message: string) => void;
  /** 变更链：全部读-改-写串行（链尾吞错——单 op 失败不毒化后续） */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(area: StorageAreaWithRemove, options: SessionRepoOptions = {}) {
    this.area = area;
    this.newSessionId = options.newSessionId ?? (() => `sess_${Date.now().toString(16)}`);
    this.newTurnId = options.newTurnId ?? (() => `turn_${Date.now().toString(16)}`);
    this.now = options.now ?? (() => Date.now());
    this.budget = options.budget ?? SESSION_BUDGET_BYTES;
    this.log = options.log ?? (() => {});
  }

  /** 变更链执行器：op 串行；失败上抛给调用方（fail-soft 由调用方决定），链自身吞错续跑 */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async readIndex(): Promise<SessionMeta[]> {
    const stored = await this.area.get(SESSIONS_INDEX_KEY);
    const raw = stored[SESSIONS_INDEX_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.map(parseMeta).filter((m): m is SessionMeta => m !== null);
  }

  private async writeIndex(index: SessionMeta[]): Promise<void> {
    // LRU：按 updatedAt 新→旧截断到上限，淘汰者连带删除会话键（索引与记录不分离残留）
    const sorted = [...index].sort((a, b) => b.updatedAt - a.updatedAt);
    const kept = sorted.slice(0, SESSION_INDEX_LIMIT);
    const evicted = sorted.slice(SESSION_INDEX_LIMIT);
    for (const meta of evicted) {
      await this.area.remove(sessionKey(meta.sessionId));
      this.log(`session evicted (LRU): ${meta.sessionId}`);
    }
    await this.area.set({ [SESSIONS_INDEX_KEY]: kept });
  }

  private async readRecord(sessionId: string): Promise<SessionRecord | null> {
    const key = sessionKey(sessionId);
    const stored = await this.area.get(key);
    return parseRecord(stored[key]);
  }

  private async writeRecord(record: SessionRecord): Promise<void> {
    await this.area.set({
      [sessionKey(record.meta.sessionId)]: enforceSessionBudget(record, this.budget),
    });
  }

  createSession(input: {
    tabId: number;
    origin: SessionOrigin;
    title: string;
  }): Promise<SessionMeta> {
    return this.enqueue(async () => {
      const meta: SessionMeta = {
        sessionId: this.newSessionId(),
        tabId: input.tabId,
        title: input.title,
        origin: input.origin,
        runCount: 0,
        lastStatus: null,
        createdAt: this.now(),
        updatedAt: this.now(),
        usageTokens: 0,
      };
      await this.writeRecord({ meta, turns: [], runs: [] });
      const index = await this.readIndex();
      await this.writeIndex([...index, meta]);
      return meta;
    });
  }

  /** tab → 最新会话（follow-up 语义：省略 sessionId 的 start 续接它） */
  resolveSessionForTab(tabId: number): Promise<SessionMeta | null> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      const ofTab = index.filter((m) => m.tabId === tabId);
      if (ofTab.length === 0) return null;
      return ofTab.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a));
    });
  }

  /** run 起跑记 turn（status=running）；会话不存在回 null（调用方决定重建或放弃） */
  beginRun(
    sessionId: string,
    input: { runId: string; task: string; attachments: AttachmentInfo[] },
  ): Promise<SessionTurn | null> {
    return this.enqueue(async () => {
      const record = await this.readRecord(sessionId);
      if (record === null) return null;
      const turn: SessionTurn = {
        turnId: this.newTurnId(),
        sessionId,
        runId: input.runId,
        task:
          input.task.length > TURN_TASK_CLIP
            ? `${input.task.slice(0, TURN_TASK_CLIP)}…`
            : input.task,
        status: "running",
        attachments: input.attachments,
        createdAt: this.now(),
        endedAt: null,
      };
      const next: SessionRecord = {
        meta: { ...record.meta, updatedAt: this.now() },
        turns: [...record.turns, turn],
        runs: record.runs,
      };
      await this.writeRecord(next);
      await this.writeIndex(replaceMeta(await this.readIndex(), next.meta));
      return turn;
    });
  }

  /** run 终态收口：turn 置终态 + 归档入档 + meta 计数/用量累计 */
  completeRun(
    sessionId: string,
    input: { turnId: string; archive: RunArchiveInput },
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const record = await this.readRecord(sessionId);
      if (record === null) return false;
      const archive: RunArchive = { ...input.archive, turnId: input.turnId };
      const turns = record.turns.map((t) =>
        t.turnId === input.turnId ? { ...t, status: archive.status, endedAt: archive.endedAt } : t,
      );
      const next: SessionRecord = {
        meta: {
          ...record.meta,
          runCount: record.meta.runCount + 1,
          lastStatus: archive.status,
          usageTokens:
            record.meta.usageTokens + archive.usage.inputTokens + archive.usage.outputTokens,
          updatedAt: this.now(),
        },
        turns,
        runs: [...record.runs, archive],
      };
      await this.writeRecord(next);
      await this.writeIndex(replaceMeta(await this.readIndex(), next.meta));
      return true;
    });
  }

  listIndex(): Promise<SessionMeta[]> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      return [...index].sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }

  open(sessionId: string): Promise<SessionRecord | null> {
    return this.enqueue(() => this.readRecord(sessionId));
  }

  rename(sessionId: string, title: string): Promise<boolean> {
    return this.enqueue(async () => {
      const record = await this.readRecord(sessionId);
      if (record === null) return false;
      const next: SessionRecord = { ...record, meta: { ...record.meta, title } };
      await this.writeRecord(next);
      await this.writeIndex(replaceMeta(await this.readIndex(), next.meta));
      return true;
    });
  }

  /** 会话目标 tab 重绑（issue #35：显式 sessionId 续跑时跟随当前 tab——tab 绑定
   *  是 follow-up 解析的缺省依据，跟随用户实际所在 tab 才不脱节） */
  rebindTab(sessionId: string, tabId: number): Promise<boolean> {
    return this.enqueue(async () => {
      const record = await this.readRecord(sessionId);
      if (record === null) return false;
      if (record.meta.tabId === tabId) return true;
      const next: SessionRecord = { ...record, meta: { ...record.meta, tabId } };
      await this.writeRecord(next);
      await this.writeIndex(replaceMeta(await this.readIndex(), next.meta));
      return true;
    });
  }

  delete(sessionId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      if (!index.some((m) => m.sessionId === sessionId)) return false;
      await this.area.remove(sessionKey(sessionId));
      await this.writeIndex(index.filter((m) => m.sessionId !== sessionId));
      return true;
    });
  }

  // —— 排队面（issue #37 U2 批 A）：queued turn 的入队/激活/撤销/清空 ——

  /** 入队（上限 5）：追加 queued turn（runId null——出队激活时回填） */
  appendQueuedTurn(
    sessionId: string,
    input: { task: string; attachments: AttachmentInfo[] },
  ): Promise<{ ok: true; turn: SessionTurn } | { ok: false; error: "not-found" | "queue-full" }> {
    return this.enqueue(async () => {
      const record = await this.readRecord(sessionId);
      if (record === null) return { ok: false as const, error: "not-found" as const };
      if (record.turns.filter((t) => t.status === "queued").length >= SESSION_QUEUE_LIMIT) {
        return { ok: false as const, error: "queue-full" as const };
      }
      const turn: SessionTurn = {
        turnId: this.newTurnId(),
        sessionId,
        runId: null,
        task:
          input.task.length > TURN_TASK_CLIP
            ? `${input.task.slice(0, TURN_TASK_CLIP)}…`
            : input.task,
        status: "queued",
        attachments: input.attachments,
        createdAt: this.now(),
        endedAt: null,
      };
      const next: SessionRecord = {
        meta: { ...record.meta, updatedAt: this.now() },
        turns: [...record.turns, turn],
        runs: record.runs,
      };
      await this.writeRecord(next);
      await this.writeIndex(replaceMeta(await this.readIndex(), next.meta));
      return { ok: true as const, turn };
    });
  }

  /** 出队取首：最早的 queued turn（FIFO） */
  firstQueuedTurn(sessionId: string): Promise<SessionTurn | null> {
    return this.enqueue(async () => {
      const record = await this.readRecord(sessionId);
      if (record === null) return null;
      return record.turns.find((t) => t.status === "queued") ?? null;
    });
  }

  /** 激活：queued→running 并回填 runId（startInner 消费——排队的 turn 复用为
   *  本 run 的正式 turn，不另 beginRun） */
  activateQueuedTurn(sessionId: string, turnId: string, runId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const record = await this.readRecord(sessionId);
      if (record === null) return false;
      let hit = false;
      const turns = record.turns.map((t) => {
        if (t.turnId !== turnId || t.status !== "queued") return t;
        hit = true;
        return { ...t, status: "running" as const, runId };
      });
      if (!hit) return false;
      const next: SessionRecord = {
        meta: { ...record.meta, updatedAt: this.now() },
        turns,
        runs: record.runs,
      };
      await this.writeRecord(next);
      await this.writeIndex(replaceMeta(await this.readIndex(), next.meta));
      return true;
    });
  }

  /** 撤销单条排队（转 cancelled 留转录痕——不从记录中删除） */
  cancelQueuedTurn(sessionId: string, turnId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const record = await this.readRecord(sessionId);
      if (record === null) return false;
      let hit = false;
      const turns = record.turns.map((t) => {
        if (t.turnId !== turnId || t.status !== "queued") return t;
        hit = true;
        return { ...t, status: "cancelled" as const, endedAt: this.now() };
      });
      if (!hit) return false;
      const next: SessionRecord = { ...record, turns };
      await this.writeRecord(next);
      return true;
    });
  }

  /** 清空一会话的全部排队（stop 连播语义 D2：用户叫停的是这个会话的后续任务） */
  cancelQueued(sessionId: string): Promise<number> {
    return this.enqueue(async () => {
      const record = await this.readRecord(sessionId);
      if (record === null) return 0;
      let count = 0;
      const turns = record.turns.map((t) => {
        if (t.status !== "queued") return t;
        count += 1;
        return { ...t, status: "cancelled" as const, endedAt: this.now() };
      });
      if (count === 0) return 0;
      await this.writeRecord({ ...record, turns });
      return count;
    });
  }

  /** SW 重启兜底（D3）：全部会话的 queued→cancelled（与「run 不续跑」同构——
   *  无人值守自动起跑撞权限卡模型不可接受）；返回清除数供 boot 日志 */
  cancelAllQueued(): Promise<number> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      let count = 0;
      for (const meta of index) {
        const record = await this.readRecord(meta.sessionId);
        if (record === null) continue;
        let hit = false;
        const turns = record.turns.map((t) => {
          if (t.status !== "queued") return t;
          hit = true;
          count += 1;
          return { ...t, status: "cancelled" as const, endedAt: this.now() };
        });
        if (hit) await this.writeRecord({ ...record, turns });
      }
      return count;
    });
  }
}

function replaceMeta(index: SessionMeta[], meta: SessionMeta): SessionMeta[] {
  const without = index.filter((m) => m.sessionId !== meta.sessionId);
  return [...without, meta];
}

/** 归档事件用量汇总（run-manager 终态收口用——model_result 逐次累加） */
export function sumUsage(events: JournalEvent[]): RunArchiveUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const e of events) {
    if (e.type !== "model_result" || !isRecord(e.data)) continue;
    const i = num(e.data.inputTokens);
    const o = num(e.data.outputTokens);
    if (i !== null) inputTokens += i;
    if (o !== null) outputTokens += o;
  }
  return { inputTokens, outputTokens };
}

/** 归档入库前压缩（W5 规则）：model_call/model_result/session_end 等全量保留；
 *  tool_result 的 error 裁到 200 字符（标题行语义——成败与步骤号在，长栈不进档）。
 *  进一步降级由 enforceSessionBudget 按预算接管 */
export function compressArchiveEvents(events: JournalEvent[]): JournalEvent[] {
  return events.map((e) => {
    if (e.type !== "tool_result" || !isRecord(e.data)) return e;
    const error = typeof e.data.error === "string" ? e.data.error : null;
    if (error === null || error.length <= 200) return e;
    return { ...e, data: { ...e.data, error: `${error.slice(0, 200)}…` } };
  });
}
