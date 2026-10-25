// 蒸馏 worker（issue #5 S4，D9/D14/D17）：drain 队列一条 → 装配蒸馏 LLM
// （selfEvolution.distillCard 缺省复用主卡）→ core distillTaskCard 编排
// （matcher 预匹配/增量/新卡/收敛判停全在 core）→ 草稿落库（saveDraft）/
// unchanged 累计 streak / skip 记日志 → notify 广播面（S5 接 protocol）。全程
// keepalive hold 保活；selfEvolution.enabled=false 时整轮不 drain。

import type { DistillLLM, ProviderConfig, SkillSource, TaskCardMeta } from "@tw/core";
import { distillTaskCard } from "@tw/core";
import type { DistillPhase } from "@tw/protocol";
import type { KeepaliveController } from "../host/keepalive.js";
import type { SettingsStore } from "../host/settings-store.js";
import { findCard, selfEvolutionOf } from "../host/settings-store.js";
import type { SkillStore } from "../host/skill-store.js";
import type { DistillJob, DistillQueue } from "./distill-queue.js";

export interface DistillWorkerDeps {
  queue: DistillQueue;
  settingsStore: SettingsStore;
  /** LLM 构造面（assemble.llmFactory 同签名——LLMClient 结构满足 DistillLLM） */
  llmFactory: (card: ProviderConfig) => DistillLLM;
  /** 每轮新实例（与 RunManager.makeSkillSource 同款——缓存不跨轮） */
  makeSkillSource: () => SkillSource;
  skillStore: SkillStore;
  keepalive: KeepaliveController;
  /** 草稿数通知面（S5 接 protocol 广播；S4 注入可测/日志） */
  notify: (draftCount: number) => void;
  /** 过程状态拍（issue #9 D3）：running=每条 job 处理前；done/failed=终拍
   *  （skip/unchanged 也走 done 带 detail——「跑完了为何没产出」可见；boot 接线
   *  为 distill-status 广播。queued 拍在 run-manager 入队侧，不经 worker） */
  onPhase: (phase: DistillPhase, detail?: string) => void;
  /** 主卡解析（assemble.activeProviderCard——注入可测） */
  activeCard: (settings: Awaited<ReturnType<SettingsStore["load"]>>) => ProviderConfig | null;
  log?: (message: string) => void;
}

export class DistillWorker {
  private draining = false;

  constructor(private readonly deps: DistillWorkerDeps) {}

  /** 是否正在 drain（防重入——enqueue kick 与 alarm 唤醒并发） */
  get isDraining(): boolean {
    return this.draining;
  }

  async drainAll(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.deps.keepalive.hold();
    const log = this.deps.log ?? (() => {});
    try {
      for (;;) {
        const settings = await this.deps.settingsStore.load();
        if (!selfEvolutionOf(settings).enabled) {
          log("distill: selfEvolution 关闭——不 drain");
          return;
        }
        const job = await this.deps.queue.peek();
        if (job === null) return;
        this.deps.onPhase("running");
        const again = await this.distillOne(job, settings, log);
        if (again === "retry") return; // 失败不热转——等下一次 kick/alarm
      }
    } finally {
      this.deps.keepalive.release();
      this.draining = false;
    }
  }

  /** 单条蒸馏。返回 "ack"（移除）/"retry"（保留重试）——caller 据此决定是否继续。
   *  全路径（目录读/编排/落库）异常统一走 queue.fail 记账（评审轮 1 [7]：落库
   *  段逃逸会让 job 既不 ack 也不 fail——alarm 每分钟无限重跑完整 LLM 蒸馏） */
  private async distillOne(
    job: DistillJob,
    settings: Awaited<ReturnType<SettingsStore["load"]>>,
    log: (message: string) => void,
  ): Promise<"ack" | "retry"> {
    const self = selfEvolutionOf(settings);
    const card =
      findCard(settings, self.distillCard === "" ? undefined : self.distillCard) ??
      this.deps.activeCard(settings);
    if (card === null) {
      log("distill: 无可用 LLM 卡——跳过该 job");
      await this.deps.queue.ack(job.runId);
      this.deps.onPhase("done", "跳过：无可用 LLM 卡");
      return "ack";
    }
    try {
      const source = this.deps.makeSkillSource();
      const catalog = await source.taskCatalog(job.host);
      const cardText = async (slug: string): Promise<string | null> => {
        const meta = catalog.find((c) => c.slug === slug);
        return meta === undefined ? null : source.taskCardText(meta);
      };
      // D14：只增量 distilled 卡——built-in（上游打包物，覆盖会遮蔽刷新）与 import 不碰
      const isUpdatable = async (slug: string): Promise<boolean> => {
        const c = await this.deps.skillStore.getCard(job.host, slug);
        return c?.provenance.sourceType === "distilled";
      };
      // D17：streak 判停数据源（core 在蒸馏调用前判停）
      const cardDistillState = async (slug: string): Promise<{ streak: number } | null> => {
        const c = await this.deps.skillStore.getCard(job.host, slug);
        return c === null ? null : { streak: c.distillStreak ?? 0 };
      };
      const outcome = await distillTaskCard({
        task: job.task,
        host: job.host,
        runId: job.runId,
        traceText: job.traceText,
        stepCount: job.stepCount,
        // 长轨迹 + thinking 模型生成整卡 8k tokens：60s 实测不够（2026-10-24 抖音
        // 真机超时）——放宽到 180s；SW 生命周期由 keepalive hold 兜底
        callTimeoutMs: 180_000,
        catalog: catalog as TaskCardMeta[],
        cardText,
        isUpdatable,
        cardDistillState,
        llm: this.deps.llmFactory(card),
        sensitiveData: null, // 入队时已整串脱敏（run-manager 侧）
        log,
      });
      if (outcome.kind === "skip") {
        log(`distill: ${outcome.reason}——跳过`);
        await this.deps.queue.ack(job.runId);
        this.deps.onPhase("done", `跳过：${outcome.reason}`);
        return "ack";
      }
      if (outcome.kind === "error") {
        log(`distill: 失败（attempts 记账）——${outcome.error}`);
        const again = (await this.deps.queue.fail(job.runId)) === "retry" ? "retry" : "ack";
        this.deps.onPhase(
          "failed",
          again === "retry"
            ? `蒸馏失败（将重试）——${outcome.error}`
            : `蒸馏失败（重试额度耗尽）——${outcome.error}`,
        );
        return again;
      }
      if (outcome.kind === "unchanged") {
        log(`distill: 无新观察——streak+1（${outcome.slug}）`);
        await this.deps.skillStore.bumpDistillStreak(job.host, outcome.slug);
        await this.deps.queue.ack(job.runId);
        this.deps.onPhase("done", `无新观察——卡内容不动（收敛计数+1：${outcome.slug}）`);
        return "ack";
      }
      await this.deps.skillStore.saveDraft(outcome.card);
      const drafts = await this.deps.skillStore.listDrafts();
      this.deps.notify(drafts.length);
      await this.deps.queue.ack(job.runId);
      this.deps.onPhase("done", "新草稿待审——options 审阅采纳");
      return "ack";
    } catch (e) {
      log(`distill: 编排/落库异常（attempts 记账）——${e instanceof Error ? e.message : String(e)}`);
      await this.deps.queue.fail(job.runId);
      this.deps.onPhase("failed", `蒸馏异常——${e instanceof Error ? e.message : String(e)}`);
      return "retry";
    }
  }
}
