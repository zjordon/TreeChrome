// 蒸馏器单测（issue #5 S1）：编排分流（新卡/增量/受保护 skip/可重试 error）、产物
// 校验（slug 归一化与撞名/keywords/PII 门）、脱敏（敏感真值不进 prompt）、prompt
// 组装（增量 addendum/目录块/trace 块）、词汇表守卫（CONSUMER_CONTEXT 动作名与
// ACTION_DEFINITIONS 同步义务）、trace 序列化直接锚定。零真网络——LLM 全 mock。

import { describe, expect, it } from "vitest";
import {
  type DistillLLM,
  distillTaskCard,
  normalizeTaskSlug,
  scanPII,
} from "../../../src/agent/skills/distill.js";
import {
  buildTaskDistillPrompt,
  CONSUMER_CONTEXT,
} from "../../../src/agent/skills/distill-prompt.js";
import { serializeTraceForPrompt } from "../../../src/agent/skills/trace-serialize.js";
import type { TaskCardMeta } from "../../../src/agent/skills/types.js";
import { ActionResult, AgentHistory, AgentHistoryList } from "../../../src/agent/views.js";
import { ACTION_DEFINITIONS } from "../../../src/tools/models.js";

// —— 测试件 ——

type Scripted = Record<string, unknown> | null | Error;

/** 按 schema 分流的假 LLM：properties 含 "match" = matcher 调用，否则 = 蒸馏调用。
 *  蒸馏侧是队列（每次 shift 一个，支持「首次失败重试成功」用例） */
class FakeLlm implements DistillLLM {
  readonly distillCalls: Array<{ user: string; schema: Record<string, unknown> }> = [];
  private readonly distillQueue: Scripted[];

  constructor(
    private readonly matcherResult: Scripted,
    distillResults: Scripted | Scripted[],
  ) {
    this.distillQueue = Array.isArray(distillResults) ? [...distillResults] : [distillResults];
  }

  async structuredCall(
    _systemPrompt: string,
    userPrompt: string,
    outputSchema: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const props = (outputSchema.properties ?? {}) as Record<string, unknown>;
    if ("match" in props) {
      if (this.matcherResult instanceof Error) throw this.matcherResult;
      return this.matcherResult;
    }
    this.distillCalls.push({ user: userPrompt, schema: outputSchema });
    const next = this.distillQueue.shift() ?? null;
    if (next instanceof Error) throw next;
    return next;
  }
}

interface StepSpec {
  goal?: string;
  name?: string;
  params?: Record<string, unknown>;
  url?: string;
  title?: string;
  content?: string;
  error?: string;
  domExcerpt?: string;
}

function historyOf(steps: StepSpec[]): AgentHistoryList {
  return new AgentHistoryList({
    history: steps.map(
      (s, i) =>
        new AgentHistory({
          stepNumber: i,
          modelOutput: {
            next_goal: s.goal ?? "",
            action: { name: s.name ?? "noop", params: s.params ?? {} },
          } as never,
          result: [
            s.error !== undefined
              ? new ActionResult({ error: s.error })
              : new ActionResult({ extractedContent: s.content ?? "OK" }),
          ],
          stateSummary: {
            url: s.url ?? "https://example.com",
            title: s.title ?? "Home",
            ...(s.domExcerpt !== undefined ? { domExcerpt: s.domExcerpt } : {}),
          },
        }),
    ),
  });
}

const VALID_CARD = {
  task_slug: "upload-video",
  task_description: "上传视频并保存草稿",
  task_keywords: ["上传", "视频", "草稿"],
  sop_md: "# 上传视频\nstep 1: 打开创作者中心并上传",
  selectors_md: "",
  quirks_md: "上传必须用 upload_file 直注",
};

const CATALOG: TaskCardMeta[] = [
  { slug: "upload-video", description: "上传视频存草稿", keywords: ["上传", "视频"] },
  { slug: "cancel-order", description: "取消指定订单" },
];

const NO_MATCH = { match: null, confidence: "high", reason: "no similar card" };
const MATCH_UPLOAD = {
  match: "upload-video",
  match_kind: "same_template",
  confidence: "high",
  reason: "same flow",
};

const BASE_INPUT = {
  task: "上传一个视频并保存草稿",
  host: "creator.example.com",
  runId: "run_abc",
  history: historyOf([
    { goal: "open site", name: "navigate", params: { url: "https://creator.example.com" } },
    { goal: "upload", name: "upload_file", params: { index: 5, path: "a.mp4" } },
  ]),
};

function makeLlm(matcher: Scripted, distill: Scripted | Scripted[]): FakeLlm {
  return new FakeLlm(matcher, distill);
}

// —— 词汇表守卫：CONSUMER_CONTEXT 的动作签名必须存在于 ACTION_DEFINITIONS ——

describe("CONSUMER_CONTEXT 词汇表守卫", () => {
  it("签名式提及（`action(…)`）全部是注册动作", () => {
    const mentioned = [...CONSUMER_CONTEXT.matchAll(/`([a-z_]+)\(/g)].map((m) => m[1]);
    expect(mentioned.length).toBeGreaterThan(10);
    const registered = new Set(Object.keys(ACTION_DEFINITIONS));
    for (const name of new Set(mentioned)) {
      expect(registered, `词汇表提及了未注册动作: ${name}`).toContain(name);
    }
  });

  it("方法关键动作都在词汇表里（upload_file 直注 / select_dropdown 免先点 / done 单动作）", () => {
    for (const name of [
      "upload_file",
      "select_dropdown",
      "dropdown_options",
      "done",
      "click",
      "input_text",
      "navigate",
      "go_back",
      "switch_tab",
      "close_tab",
      "send_keys",
      "scroll",
      "wait",
      "find_elements",
      "find_text",
      "search_page",
      "read_grid",
      "extract",
    ]) {
      expect(CONSUMER_CONTEXT).toMatch(new RegExp(`\\\`${name}(\\(|\\\`)`));
    }
  });
});

// —— 纯函数面 ——

describe("normalizeTaskSlug", () => {
  it("kebab 归一 + ≤5 词", () => {
    expect(normalizeTaskSlug("Cancel Order 302!!")).toBe("cancel-order-302");
    expect(normalizeTaskSlug("Upload A Video To Bilibili Now Please")).toBe(
      "upload-a-video-to-bilibili",
    );
  });
  it("全非法字符 → 空串", () => {
    expect(normalizeTaskSlug("！！")).toBe("");
  });
});

describe("scanPII", () => {
  it("三类命中", () => {
    expect(scanPII("联系 someone@example.com 处理")).toBe("email");
    expect(scanPII("手机号 13812345678 已验证")).toBe("mobile");
    expect(scanPII("卡号 4111111111111111")).toBe("card-number");
  });
  it("干净文本不命中（短数字串/日期不是卡号）", () => {
    expect(scanPII("订单 302 共 5 条，2026-10-23 完成")).toBeNull();
  });
});

// —— prompt 组装 ——

describe("buildTaskDistillPrompt", () => {
  it("新卡模式：任务/trace/空目录占位/spec 块齐全", () => {
    const prompt = buildTaskDistillPrompt({
      task: "取消订单 302",
      host: "shop.example.com",
      stepCount: 3,
      trace: "Step 0:\n  URL: https://shop.example.com",
      catalog: [],
      update: null,
    });
    expect(prompt).toContain("取消订单 302");
    expect(prompt).toContain("shop.example.com");
    expect(prompt).toContain("Step 0:");
    expect(prompt).toContain("(none — this is the first task card for this host)");
    expect(prompt).toContain("TASK-LEVEL skill card");
    expect(prompt).not.toContain("EXISTING KNOWLEDGE");
  });

  it("增量模式：命中 slug + 旧卡全文进 addendum", () => {
    const prompt = buildTaskDistillPrompt({
      task: "取消订单 302",
      host: "shop.example.com",
      stepCount: 3,
      trace: "Step 0:…",
      catalog: [{ slug: "cancel-order", description: "取消指定订单" }],
      update: { slug: "cancel-order", cardText: "PREV_SOP_CONTENT\n\nPREV_QUIRKS" },
    });
    expect(prompt).toContain("you are UPDATING card `cancel-order`");
    expect(prompt).toContain("PREV_SOP_CONTENT");
    expect(prompt).toContain("- `cancel-order` — 取消指定订单");
  });
});

// —— trace 序列化（共享模块直接锚定；judge 锚定测试经委托继续覆盖）——

describe("serializeTraceForPrompt", () => {
  it("步叙事：URL/Title/Goal/Action(params)/Result", () => {
    const trace = serializeTraceForPrompt(
      historyOf([
        {
          goal: "open",
          name: "navigate",
          params: { url: "https://x.example" },
          url: "https://x.example",
          content: "done",
        },
      ]),
    );
    expect(trace).toBe(
      [
        "Step 0:",
        "  URL: https://x.example",
        "  Title: Home",
        "  Goal: open",
        '  Action: navigate({"url": "https://x.example"})',
        "  Result: done",
      ].join("\n"),
    );
  });

  it("done 步附 Page excerpt；error 走 ERROR 通道", () => {
    const trace = serializeTraceForPrompt(
      historyOf([{ error: "boom", domExcerpt: "EXC", name: "click", params: { index: 3 } }]),
    );
    expect(trace).toContain("  Page excerpt: EXC");
    expect(trace).toContain("  Result: ERROR: boom");
  });
});

// —— 编排主流程 ——

describe("distillTaskCard", () => {
  it("空 history → error", async () => {
    const llm = makeLlm(NO_MATCH, VALID_CARD);
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      history: new AgentHistoryList(),
      catalog: [],
      llm,
    });
    expect(outcome).toEqual({ kind: "error", error: "empty history" });
    expect(llm.distillCalls.length).toBe(0);
  });

  it("新卡模式：无 catalog 跳过 matcher，一次调用产出 draft", async () => {
    const llm = makeLlm(NO_MATCH, VALID_CARD);
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    expect(outcome.card).toMatchObject({
      host: "creator.example.com",
      slug: "upload-video",
      description: "上传视频并保存草稿",
      keywords: ["上传", "视频", "草稿"],
      mode: "new",
      sourceTraces: ["run_abc"],
    });
    expect(llm.distillCalls.length).toBe(1);
    expect(llm.distillCalls[0].user).toContain("Action: upload_file");
  });

  it("新卡撞名 → slug 加后缀", async () => {
    const llm = makeLlm(
      NO_MATCH,
      VALID_CARD, // task_slug=upload-video，与 catalog 撞名
    );
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: CATALOG, llm });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind === "draft") expect(outcome.card.slug).toBe("upload-video-2");
  });

  it("增量模式：命中可更新卡 → 旧卡进 prompt，slug 强制复用（不信模型自报）", async () => {
    const llm = makeLlm(MATCH_UPLOAD, { ...VALID_CARD, task_slug: "model-wrong-slug" });
    let fetchedSlug = "";
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      cardText: async (slug) => {
        fetchedSlug = slug;
        return "旧卡 SOP 全文";
      },
      llm,
    });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    expect(outcome.card.mode).toBe("update");
    expect(outcome.card.slug).toBe("upload-video");
    expect(fetchedSlug).toBe("upload-video");
    expect(llm.distillCalls[0].user).toContain("EXISTING KNOWLEDGE");
    expect(llm.distillCalls[0].user).toContain("旧卡 SOP 全文");
  });

  it("D14：命中受保护卡（isUpdatable=false）→ skip，不发起蒸馏调用", async () => {
    const llm = makeLlm(MATCH_UPLOAD, VALID_CARD);
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      isUpdatable: () => false,
      llm,
    });
    expect(outcome).toEqual({ kind: "skip", reason: "matched protected card: upload-video" });
    expect(llm.distillCalls.length).toBe(0);
  });

  it("matcher 基建失败 → error（不照新卡走防近重复）", async () => {
    const llm = makeLlm(new Error("conn refused"), VALID_CARD);
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: CATALOG, llm });
    expect(outcome).toEqual({
      kind: "error",
      error: "matcher call failed: call failed: conn refused",
    });
    expect(llm.distillCalls.length).toBe(0);
  });

  it("首试不可解析、重试成功 → draft（TreeForge 重试理由）", async () => {
    const llm = makeLlm(NO_MATCH, [null, VALID_CARD]);
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome.kind).toBe("draft");
    expect(llm.distillCalls.length).toBe(2);
  });

  it("两次不可解析 → error", async () => {
    const llm = makeLlm(NO_MATCH, [null, null]);
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome).toEqual({ kind: "error", error: "unparseable output" });
  });

  it("两次 API 抛错 → error（带末次原因）", async () => {
    const llm = makeLlm(NO_MATCH, [new Error("rate limited"), new Error("rate limited")]);
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome).toEqual({ kind: "error", error: "rate limited" });
  });

  it("PII 门：产物含 email → 消耗重试后 error", async () => {
    const dirty = { ...VALID_CARD, sop_md: "有问题联系 admin@example.com" };
    const llm = makeLlm(NO_MATCH, [dirty, dirty]);
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error).toContain("PII");
      expect(outcome.error).toContain("email");
      // 样本值不外泄进 error 文案
      expect(outcome.error).not.toContain("admin@example.com");
    }
    expect(llm.distillCalls.length).toBe(2);
  });

  it("空 sop / 空 description → error", async () => {
    // 两次尝试各给一份失败样本（第二次重取新样本仍失败——真实语义）
    const noSop = await distillTaskCard({
      ...BASE_INPUT,
      catalog: [],
      llm: makeLlm(NO_MATCH, [
        { ...VALID_CARD, sop_md: "   " },
        { ...VALID_CARD, sop_md: "" },
      ]),
    });
    expect(noSop).toEqual({ kind: "error", error: "empty sop_md" });
    const noDesc = await distillTaskCard({
      ...BASE_INPUT,
      catalog: [],
      llm: makeLlm(NO_MATCH, [
        { ...VALID_CARD, task_description: "" },
        { ...VALID_CARD, task_description: "  " },
      ]),
    });
    expect(noDesc).toEqual({ kind: "error", error: "empty task_description" });
  });

  it("keywords 归一化：滤非串/去空/去重/截 5", async () => {
    const llm = makeLlm(NO_MATCH, {
      ...VALID_CARD,
      task_keywords: ["上传", "上传", 42, "", "视频", "草稿", "x", "y", "z"],
    });
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind === "draft") {
      expect(outcome.card.keywords).toEqual(["上传", "视频", "草稿", "x", "y"]);
    }
  });

  it("JSON 双重转义修复：字面量 \\n 反转义为真换行（真换行在场则不碰）", async () => {
    const llm = makeLlm(NO_MATCH, {
      ...VALID_CARD,
      sop_md: "# 标题\\n\\n## 步骤\\n第一步",
      quirks_md: "quirk1\\nquirk2",
    });
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    // 字面量 \n（无真换行）→ 反转义
    expect(outcome.card.sop).toBe("# 标题\n\n## 步骤\n第一步");
    expect(outcome.card.quirks).toBe("quirk1\nquirk2");
    // 真换行在场（模型转义正常）→ 原样保留（VALID_CARD.sop_md 含真换行）
    expect(outcome.card.description).toBe(VALID_CARD.task_description);
  });

  it("脱敏：敏感真值进 prompt 前被占位替换", async () => {
    const secret = "sk-live-abcdef123456";
    const llm = makeLlm(NO_MATCH, VALID_CARD);
    const history = historyOf([
      {
        goal: "login",
        name: "input_text",
        params: { index: 2, text: secret },
        content: "typed",
      },
    ]);
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      history,
      catalog: [],
      sensitiveData: { apiKey: secret },
      llm,
    });
    expect(outcome.kind).toBe("draft");
    const user = llm.distillCalls[0].user;
    expect(user).toContain("<secret>apiKey</secret>");
    expect(user).not.toContain(secret);
  });

  // —— D17 收敛循环 ——

  it("增量模式 has_new_observations=false → unchanged（卡内容不动，宿主只累计 streak）", async () => {
    const llm = makeLlm(MATCH_UPLOAD, { ...VALID_CARD, has_new_observations: false });
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      cardText: async () => "旧卡全文",
      llm,
    });
    expect(outcome).toEqual({ kind: "unchanged", slug: "upload-video" });
    expect(llm.distillCalls.length).toBe(1);
  });

  it("漏报 has_new_observations → 按有新观察处理（照常 draft）", async () => {
    // VALID_CARD 不带该字段——update 模式下不得误判收敛
    const llm = makeLlm(MATCH_UPLOAD, VALID_CARD);
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      cardText: async () => "旧卡全文",
      llm,
    });
    expect(outcome.kind).toBe("draft");
  });

  it("新卡模式忽略 has_new_observations（flag 只属增量判定）", async () => {
    const llm = makeLlm(NO_MATCH, { ...VALID_CARD, has_new_observations: false });
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome.kind).toBe("draft");
  });

  it("streak ≥ 阈值 → 蒸馏调用前直接 skip（判定器本身被省掉）", async () => {
    const llm = makeLlm(MATCH_UPLOAD, VALID_CARD);
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      cardText: async () => "旧卡全文",
      cardDistillState: async () => ({ streak: 2 }),
      convergeThreshold: 2,
      llm,
    });
    expect(outcome.kind).toBe("skip");
    if (outcome.kind === "skip") {
      expect(outcome.reason).toContain("converged");
      expect(outcome.reason).toContain("streak 2");
    }
    expect(llm.distillCalls.length).toBe(0);
  });

  it("streak < 阈值 → 照常进入蒸馏", async () => {
    const llm = makeLlm(MATCH_UPLOAD, { ...VALID_CARD, has_new_observations: true });
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      cardText: async () => "旧卡全文",
      cardDistillState: async () => ({ streak: 1 }),
      convergeThreshold: 2,
      llm,
    });
    expect(outcome.kind).toBe("draft");
    expect(llm.distillCalls.length).toBe(1);
  });
});
