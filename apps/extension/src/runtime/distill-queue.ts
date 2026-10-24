// 蒸馏队列（issue #5 S4，D9）：chrome.storage.local `tc_distillQueue` 持久化——
// MV3 SW 在 LLM 调用中被杀不丢任务（job 未 ack，alarm/boot 兜底重 drain）。窄
// StorageArea 面注入可测（单测 fake，真实现 background 接 chrome.storage.local）。
// 单一写者纪律：队列只经 DistillQueue，草稿只经 SkillStore。

import type { StorageArea } from "../host/chrome-apis.js";

export const DISTILL_QUEUE_KEY = "tc_distillQueue";
/** 兜底唤醒 alarm（D9：队列非空时 1min 周期、清空即除——background 接线） */
export const DISTILL_ALARM_NAME = "tc_distill";
/** 队列上限（D9：溢出丢最老——蒸馏是可选增强，不挤爆 storage 配额） */
export const DISTILL_QUEUE_MAX = 10;
/** 单 job 总尝试上限（首次 + 1 重试；LLM 失败不无限重试） */
export const DISTILL_MAX_ATTEMPTS = 2;

/** 队列条目：轨迹为入队时已序列化+脱敏+截断的文本（重启后无需 AgentHistory） */
export interface DistillJob {
  runId: string;
  task: string;
  host: string;
  traceText: string;
  stepCount: number;
  enqueuedAt: number;
  attempts: number;
}

export type DistillJobInput = Pick<
  DistillJob,
  "runId" | "task" | "host" | "traceText" | "stepCount"
>;

function isJob(v: unknown): v is DistillJob {
  if (typeof v !== "object" || v === null) return false;
  const j = v as Record<string, unknown>;
  return (
    typeof j.runId === "string" &&
    typeof j.task === "string" &&
    typeof j.host === "string" &&
    typeof j.traceText === "string" &&
    typeof j.stepCount === "number" &&
    typeof j.enqueuedAt === "number" &&
    typeof j.attempts === "number"
  );
}

export class DistillQueue {
  /** 读改写串行面（评审轮 1 [8]）：enqueue（run 终态路径）与 ack/fail（worker
   *  drain 路径）是两组并发写者——LLM 180s 调用窗内交错时后写者以陈旧快照
   *  整串覆盖（ack 复活/新 job 丢失）。promise 链串行全部 RMW */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly area: StorageArea,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** 坏形态防御：非数组/条目缺字段静默丢弃（日志），不抛——读路径容错 */
  private async read(): Promise<DistillJob[]> {
    const items = await this.area.get(DISTILL_QUEUE_KEY);
    const raw = items[DISTILL_QUEUE_KEY];
    if (!Array.isArray(raw)) return [];
    const jobs = raw.filter(isJob);
    if (jobs.length !== raw.length) this.log("distill-queue: 丢弃坏形态条目");
    return jobs;
  }

  private async write(jobs: DistillJob[]): Promise<void> {
    await this.area.set({ [DISTILL_QUEUE_KEY]: jobs });
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => {});
    return next;
  }

  /** 入队（runId 幂等——同一 run 不重复蒸）；超上限丢最老（经串行面） */
  async enqueue(job: DistillJobInput, now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      const jobs = await this.read();
      if (jobs.some((j) => j.runId === job.runId)) {
        this.log(`distill-queue: runId=${job.runId} 已在队列——幂等跳过`);
        return;
      }
      jobs.push({ ...job, enqueuedAt: now, attempts: 0 });
      while (jobs.length > DISTILL_QUEUE_MAX) jobs.shift();
      await this.write(jobs);
    });
  }

  /** 最老一条（drain 起点；不弹出——ack/fail 才改队列） */
  async peek(): Promise<DistillJob | null> {
    const jobs = await this.read();
    return jobs[0] ?? null;
  }

  /** 处理完成移除（skip/unchanged/draft 都算完成；经串行面） */
  async ack(runId: string): Promise<void> {
    return this.serialize(async () => {
      await this.write((await this.read()).filter((j) => j.runId !== runId));
    });
  }

  /** 失败记账：attempts+1；达上限丢弃（dropped），否则保留待重试（retry）（经串行面） */
  async fail(runId: string): Promise<"retry" | "dropped"> {
    return this.serialize(async () => {
      const jobs = await this.read();
      const idx = jobs.findIndex((j) => j.runId === runId);
      if (idx === -1) return "dropped" as const;
      if (jobs[idx].attempts + 1 >= DISTILL_MAX_ATTEMPTS) {
        jobs.splice(idx, 1);
        await this.write(jobs);
        return "dropped" as const;
      }
      jobs[idx] = { ...jobs[idx], attempts: jobs[idx].attempts + 1 };
      await this.write(jobs);
      return "retry" as const;
    });
  }

  async size(): Promise<number> {
    return (await this.read()).length;
  }
}
