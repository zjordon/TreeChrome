// 蒸馏钩子单测（issue #5 S2a）：门控判据（D1 严格读法：judgement 缺失 = 不蒸馏）、
// 主导 host 多数票（含端口形态）、编排 fail-soft（门控不过零 LLM 调用）、目录四文件
// 落盘（_task.json snake_case meta）、增量合并（source_traces 并集 + distilled_at
// 刷新）、蒸馏失败不落盘、assembleAgent 暴露主 llm。零真网络——LLM 注入 fake；
// 临时目录真盘 IO。

import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionResult, AgentHistory, AgentHistoryList, type DistillLLM } from "@tw/core";
import { afterAll, describe, expect, it } from "vitest";
import { assembleAgent } from "../src/agent-boot.js";
import {
  distillAfterRun,
  dominantHostOf,
  gateFailureReason,
  passesDistillGate,
  writeTaskCard,
} from "../src/distill-run.js";
import { deadLlm, settings } from "./agent-boot-helpers.js";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => fsp.rm(d, { recursive: true, force: true })));
});

const mkTmp = async (): Promise<string> => {
  const dir = await fsp.mkdtemp(join(tmpdir(), "tc-distill-"));
  tmpDirs.push(dir);
  return dir;
};

// —— 测试件 ——

/** 按 schema 分流的假 LLM（properties 含 "match" = matcher 调用） */
class FakeLlm implements DistillLLM {
  distillCalls = 0;
  /** 蒸馏调用的 opts 面（issue #10 B2：callTimeoutMs 透传断言） */
  distillOpts: Array<{ callTimeoutMs?: number | null }> = [];

  constructor(
    private readonly matcherResult: Record<string, unknown> | null,
    private readonly distillResult: Record<string, unknown> | null,
  ) {}

  async structuredCall(
    _systemPrompt: string,
    _userPrompt: string,
    outputSchema: Record<string, unknown>,
    opts?: { maxTokens?: number; callTimeoutMs?: number | null },
  ): Promise<Record<string, unknown> | null> {
    const props = (outputSchema.properties ?? {}) as Record<string, unknown>;
    if ("match" in props) return this.matcherResult;
    this.distillCalls += 1;
    this.distillOpts.push(opts ?? {});
    return this.distillResult;
  }
}

interface StepSpec {
  url: string;
  done?: { success: boolean; verdict?: boolean };
}

function history(steps: StepSpec[]): AgentHistoryList {
  return new AgentHistoryList({
    history: steps.map((s, i) => {
      const done = s.done;
      const result = new ActionResult(
        done === undefined
          ? { extractedContent: "ok" }
          : { isDone: true, success: done.success, extractedContent: "final" },
      );
      if (done?.verdict !== undefined) {
        result.judgement = { verdict: done.verdict, reasoning: "r" };
      }
      return new AgentHistory({
        stepNumber: i,
        modelOutput: { next_goal: "g", action: { name: "noop", params: {} } } as never,
        result: [result],
        stateSummary: { url: s.url, title: "T" },
      });
    }),
  });
}

const DISTILLED = {
  task_slug: "upload-video",
  task_description: "上传视频存草稿",
  task_keywords: ["上传", "视频"],
  sop_md: "# SOP\nstep 1",
  selectors_md: "| 元素用途 |",
  quirks_md: "upload_file 直注",
};

const NO_MATCH = { match: null, confidence: "high", reason: "no" };

const BASE = {
  task: "上传视频存草稿",
  now: () => new Date("2026-10-23T00:00:00Z"),
  log: () => {},
};

// —— 门控与 host 判定（纯函数面）——

describe("passesDistillGate", () => {
  it("成功 + Judge verdict true 才过", () => {
    expect(
      passesDistillGate(
        history([{ url: "https://a.com", done: { success: true, verdict: true } }]),
      ),
    ).toBe(true);
  });
  it("verdict false / 任务失败 / judgement 缺失（judge 被关）都不过", () => {
    expect(
      passesDistillGate(
        history([{ url: "https://a.com", done: { success: true, verdict: false } }]),
      ),
    ).toBe(false);
    expect(
      passesDistillGate(
        history([{ url: "https://a.com", done: { success: false, verdict: true } }]),
      ),
    ).toBe(false);
    expect(passesDistillGate(history([{ url: "https://a.com", done: { success: true } }]))).toBe(
      false,
    );
  });
});

describe("gateFailureReason", () => {
  it("门控通过 → null；三态归因互斥（issue #10 D4）", () => {
    expect(
      gateFailureReason(
        history([{ url: "https://a.com", done: { success: true, verdict: true } }]),
      ),
    ).toBeNull();
    expect(gateFailureReason(history([{ url: "https://a.com" }]))).toContain("任务未成功完成");
    expect(
      gateFailureReason(history([{ url: "https://a.com", done: { success: true } }])),
    ).toContain("judge 未执行或调用失败");
    expect(
      gateFailureReason(
        history([{ url: "https://a.com", done: { success: true, verdict: false } }]),
      ),
    ).toContain("judge 复核拒绝");
  });
});

describe("dominantHostOf", () => {
  it("步 URL 多数票；含端口形态保留", () => {
    expect(
      dominantHostOf(
        history([
          { url: "http://localhost:7780/admin/sales/" },
          { url: "http://localhost:7780/admin/orders/" },
          { url: "https://other.com" },
        ]),
      ),
    ).toBe("localhost_7780");
  });
  it("无 http URL → null", () => {
    expect(dominantHostOf(history([{ url: "about:blank" }]))).toBeNull();
    expect(dominantHostOf(new AgentHistoryList())).toBeNull();
  });
});

// —— 编排主流程 ——

describe("distillAfterRun", () => {
  it("门控不过 → 零 LLM 调用零落盘；日志归因三态（issue #10 D4）", async () => {
    const dir = await mkTmp();
    const llm = new FakeLlm(NO_MATCH, DISTILLED);
    const logs: string[] = [];
    await distillAfterRun({
      ...BASE,
      distill: { skillsDir: dir },
      llm,
      log: (m) => void logs.push(m),
      history: history([{ url: "https://a.com", done: { success: true, verdict: false } }]),
    });
    expect(llm.distillCalls).toBe(0);
    expect(await fsp.readdir(dir)).toEqual([]);
    expect(logs.at(-1)).toContain("judge 复核拒绝");
    const logs2: string[] = [];
    await distillAfterRun({
      ...BASE,
      distill: { skillsDir: dir },
      llm,
      log: (m) => void logs2.push(m),
      history: history([{ url: "https://a.com", done: { success: true } }]),
    });
    expect(logs2.at(-1)).toContain("judge 未执行或调用失败");
  });

  it("门控过 → 四文件落盘（_task.json snake_case meta 完整）", async () => {
    const dir = await mkTmp();
    const llm = new FakeLlm(NO_MATCH, DISTILLED);
    await distillAfterRun({
      ...BASE,
      distill: { skillsDir: dir, runId: "run_t1" },
      llm,
      history: history([
        { url: "https://creator.example.com/upload" },
        { url: "https://creator.example.com/done", done: { success: true, verdict: true } },
      ]),
    });
    expect(llm.distillCalls).toBe(1);
    const cardDir = join(dir, "creator.example.com", "tasks", "upload-video");
    expect(await fsp.readFile(join(cardDir, "_sop.md"), "utf8")).toContain("# SOP");
    expect(await fsp.readFile(join(cardDir, "quirks.md"), "utf8")).toContain("upload_file 直注");
    const meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta).toEqual({
      slug: "upload-video",
      task_description: "上传视频存草稿",
      task_keywords: ["上传", "视频"],
      source_traces: ["run_t1"],
      distilled_at: "2026-10-23T00:00:00.000Z",
      best_steps: 2, // #12：新卡基线 = 本次步数（history 2 步）
      distill_streak: 0, // 写入即真蒸馏——streak 归 0（D17）
    });
    // issue #10 B2：缺省 180s 对齐扩展 worker
    expect(llm.distillOpts.at(-1)?.callTimeoutMs).toBe(180_000);
  });

  it("callTimeoutMs 可选覆盖（issue #10 B2）", async () => {
    const dir = await mkTmp();
    const llm = new FakeLlm(NO_MATCH, DISTILLED);
    await distillAfterRun({
      ...BASE,
      distill: { skillsDir: dir, callTimeoutMs: 90_000 },
      llm,
      history: history([{ url: "https://a.com", done: { success: true, verdict: true } }]),
    });
    expect(llm.distillOpts.at(-1)?.callTimeoutMs).toBe(90_000);
  });

  it("增量：既有卡 source_traces 并集 + distilled_at 刷新（D8）", async () => {
    const dir = await mkTmp();
    const cardDir = join(dir, "shop.example.com", "tasks", "cancel-order");
    await fsp.mkdir(cardDir, { recursive: true });
    await fsp.writeFile(
      join(cardDir, "_task.json"),
      JSON.stringify({
        slug: "cancel-order",
        task_description: "取消指定订单",
        task_keywords: ["取消"],
        source_traces: ["run_old"],
        distilled_at: "2026-01-01T00:00:00Z",
      }),
      "utf8",
    );
    await fsp.writeFile(join(cardDir, "_sop.md"), "旧 SOP", "utf8");
    const llm = new FakeLlm(
      { match: "cancel-order", confidence: "high", reason: "same" },
      { ...DISTILLED, task_slug: "cancel-order" },
    );
    await distillAfterRun({
      ...BASE,
      task: "取消订单 302",
      distill: { skillsDir: dir, runId: "run_new" },
      llm,
      history: history([
        { url: "https://shop.example.com/orders", done: { success: true, verdict: true } },
      ]),
    });
    expect(llm.distillCalls).toBe(1);
    const meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta.source_traces).toEqual(["run_old", "run_new"]);
    expect(meta.distilled_at).toBe("2026-10-23T00:00:00.000Z");
  });

  it("蒸馏失败（LLM 不可解析）→ 不落盘不抛", async () => {
    const dir = await mkTmp();
    const llm = new FakeLlm(NO_MATCH, null);
    await distillAfterRun({
      ...BASE,
      distill: { skillsDir: dir },
      llm,
      history: history([{ url: "https://a.com", done: { success: true, verdict: true } }]),
    });
    expect(llm.distillCalls).toBe(2);
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it("无 http URL → 跳过（零蒸馏调用）", async () => {
    const dir = await mkTmp();
    const llm = new FakeLlm(NO_MATCH, DISTILLED);
    await distillAfterRun({
      ...BASE,
      distill: { skillsDir: dir },
      llm,
      history: history([{ url: "about:blank", done: { success: true, verdict: true } }]),
    });
    expect(llm.distillCalls).toBe(0);
  });
});

// —— 落盘纯函数（坏 JSON 既有 meta 覆盖写）——

describe("writeTaskCard", () => {
  it("既有 _task.json 坏 JSON → 覆盖写不抛", async () => {
    const dir = await mkTmp();
    const cardDir = join(dir, "h", "tasks", "s");
    await fsp.mkdir(cardDir, { recursive: true });
    await fsp.writeFile(join(cardDir, "_task.json"), "{bad json", "utf8");
    const out = await writeTaskCard(dir, "h", {
      host: "h",
      slug: "s",
      description: "d",
      keywords: [],
      sop: "sop",
      selectors: "",
      quirks: "",
      mode: "update",
      sourceTraces: ["r1"],
      distilledAt: "2026-10-23T00:00:00Z",
      bestSteps: 5,
    });
    expect(out).toBe(cardDir);
    const meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta.source_traces).toEqual(["r1"]);
    expect(meta.best_steps).toBe(5); // #12：坏 JSON 前科 → 取 draft 值
  });
});

// —— 装配面 ——

describe("assembleAgent 暴露主 llm（钩子复用面）", () => {
  it("注入的 llm 原样可达", () => {
    const dead = deadLlm();
    const assembled = assembleAgent({
      task: "t",
      settings: settings(),
      wsUrl: "ws://stub",
      llm: dead,
      console: false,
    });
    expect(assembled.llm).toBe(dead);
  });
});

// —— D17 收敛循环（unchanged / streak 累计与跳过 / 计数清零）——

/** 预置既有卡（含 distill_streak / best_steps）到沙箱 */
const seedCard = async (dir: string, opts: { streak?: number; bestSteps?: number } = {}) => {
  const cardDir = join(dir, "shop.example.com", "tasks", "cancel-order");
  await fsp.mkdir(cardDir, { recursive: true });
  await fsp.writeFile(join(cardDir, "_sop.md"), "旧 SOP 原文", "utf8");
  await fsp.writeFile(join(cardDir, "quirks.md"), "旧 quirk", "utf8");
  await fsp.writeFile(
    join(cardDir, "_task.json"),
    JSON.stringify({
      slug: "cancel-order",
      task_description: "取消指定订单",
      task_keywords: ["取消"],
      source_traces: ["run_old"],
      distilled_at: "2026-01-01T00:00:00Z",
      ...(opts.streak !== undefined ? { distill_streak: opts.streak } : {}),
      ...(opts.bestSteps !== undefined ? { best_steps: opts.bestSteps } : {}),
    }),
    "utf8",
  );
  return cardDir;
};

const MATCH_CANCEL = { match: "cancel-order", confidence: "high", reason: "same" };

describe("distillAfterRun 收敛循环", () => {
  const okHistory = history([
    { url: "https://shop.example.com/orders", done: { success: true, verdict: true } },
  ]);

  it("无新观察 → 内容文件与 distilled_at 不动，仅 distill_streak +1", async () => {
    const dir = await mkTmp();
    const cardDir = await seedCard(dir);
    const llm = new FakeLlm(MATCH_CANCEL, {
      ...DISTILLED,
      task_slug: "cancel-order",
      has_new_observations: false,
    });
    await distillAfterRun({
      ...BASE,
      task: "取消订单 302",
      distill: { skillsDir: dir, runId: "run_new" },
      llm,
      history: okHistory,
    });
    expect(llm.distillCalls).toBe(1);
    expect(await fsp.readFile(join(cardDir, "_sop.md"), "utf8")).toBe("旧 SOP 原文");
    const meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta.distill_streak).toBe(1);
    expect(meta.distilled_at).toBe("2026-01-01T00:00:00Z");
    expect(meta.source_traces).toEqual(["run_old"]);
  });

  it("streak 达阈值（缺省 2）→ 蒸馏调用都不发、卡零改动", async () => {
    const dir = await mkTmp();
    const cardDir = await seedCard(dir, { streak: 2 });
    const llm = new FakeLlm(MATCH_CANCEL, DISTILLED);
    await distillAfterRun({
      ...BASE,
      task: "取消订单 302",
      distill: { skillsDir: dir, runId: "run_new" },
      llm,
      history: okHistory,
    });
    expect(llm.distillCalls).toBe(0);
    expect(await fsp.readFile(join(cardDir, "_sop.md"), "utf8")).toBe("旧 SOP 原文");
    const meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta.distill_streak).toBe(2); // skip 不累计——streak 只统计成功蒸馏判定
  });

  it("#12 判停守卫：streak 达阈值但有显著步数改进 → 跨过收敛照发蒸馏 + best_steps 棘轮", async () => {
    const dir = await mkTmp();
    // okHistory 1 步；best=12 → margin=2 → 1 < 10 显著改进
    const cardDir = await seedCard(dir, { streak: 2, bestSteps: 12 });
    const llm = new FakeLlm(MATCH_CANCEL, { ...DISTILLED, task_slug: "cancel-order" });
    await distillAfterRun({
      ...BASE,
      task: "取消订单 302",
      distill: { skillsDir: dir, runId: "run_new" },
      llm,
      history: okHistory,
    });
    expect(llm.distillCalls).toBe(1); // 守卫放行——不 skip
    const meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta.best_steps).toBe(1); // min(12, 1)
    expect(meta.distill_streak).toBe(0); // 真蒸馏归 0
  });

  it("#12 unchanged+改进：内容不动但 best_steps 棘轮（下界记住，内容归下轮捕获）", async () => {
    const dir = await mkTmp();
    const cardDir = await seedCard(dir, { bestSteps: 12 });
    const llm = new FakeLlm(MATCH_CANCEL, {
      ...DISTILLED,
      task_slug: "cancel-order",
      has_new_observations: false,
    });
    await distillAfterRun({
      ...BASE,
      task: "取消订单 302",
      distill: { skillsDir: dir, runId: "run_new" },
      llm,
      history: okHistory,
    });
    expect(await fsp.readFile(join(cardDir, "_sop.md"), "utf8")).toBe("旧 SOP 原文");
    const meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta.distill_streak).toBe(1);
    expect(meta.best_steps).toBe(1); // 棘轮 min(12, 1)——本次 1 步
  });

  it("#12 writeTaskCard：best_steps 与既有 meta 取 min（防手工编辑旁路）", async () => {
    const dir = await mkTmp();
    const cardDir = join(dir, "h", "tasks", "s");
    await fsp.mkdir(cardDir, { recursive: true });
    await fsp.writeFile(
      join(cardDir, "_task.json"),
      JSON.stringify({ source_traces: ["old"], best_steps: 3 }),
      "utf8",
    );
    const draft = {
      host: "h",
      slug: "s",
      description: "d",
      keywords: [],
      sop: "sop",
      selectors: "",
      quirks: "",
      mode: "update" as const,
      sourceTraces: ["r1"],
      distilledAt: "2026-10-23T00:00:00Z",
      bestSteps: 5,
    };
    await writeTaskCard(dir, "h", draft);
    let meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta.best_steps).toBe(3); // 既有 3 更小——保持
    await writeTaskCard(dir, "h", { ...draft, bestSteps: 2 });
    meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta.best_steps).toBe(2); // draft 更小——棘轮下移
  });

  it("有新观察的增量更新 → distill_streak 归 0 + source_traces 并集", async () => {
    const dir = await mkTmp();
    // seed streak=1（低于缺省阈值 2——streak=2 会在蒸馏前被收敛 skip，这是 D17 语义）
    const cardDir = await seedCard(dir, { streak: 1 });
    const llm = new FakeLlm(MATCH_CANCEL, {
      ...DISTILLED,
      task_slug: "cancel-order",
      has_new_observations: true,
    });
    await distillAfterRun({
      ...BASE,
      task: "取消订单 302",
      distill: { skillsDir: dir, runId: "run_new" },
      llm,
      history: okHistory,
    });
    expect(llm.distillCalls).toBe(1);
    const meta = JSON.parse(await fsp.readFile(join(cardDir, "_task.json"), "utf8"));
    expect(meta.distill_streak).toBe(0);
    expect(meta.source_traces).toEqual(["run_old", "run_new"]);
    expect(meta.distilled_at).toBe("2026-10-23T00:00:00.000Z");
  });
});
