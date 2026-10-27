// 蒸馏器单测（issue #5 S1）：编排分流（新卡/增量/受保护 skip/可重试 error）、产物
// 校验（slug 归一化与撞名/keywords/PII 门）、脱敏（敏感真值不进 prompt）、prompt
// 组装（增量 addendum/目录块/trace 块）、词汇表守卫（CONSUMER_CONTEXT 动作名与
// ACTION_DEFINITIONS 同步义务）、trace 序列化直接锚定。零真网络——LLM 全 mock。

import { describe, expect, it } from "vitest";
import {
  applySelfCheckFooter,
  type DistillLLM,
  distillTaskCard,
  efficiencyMargin,
  normalizeTaskSlug,
  scanPII,
  TASK_SOP_SELF_CHECK_FOOTER,
  TASK_SOP_SELF_CHECK_FOOTER_V1,
} from "../../../src/agent/skills/distill.js";
import {
  buildTaskDistillPrompt,
  CONSUMER_CONTEXT,
  TASK_SOP_SPEC,
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
    // 字面量 \n（无真换行）→ 反转义（SOP 尾部还有自检 footer——startsWith 锚定）
    expect(outcome.card.sop.startsWith("# 标题\n\n## 步骤\n第一步")).toBe(true);
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

  it("callTimeoutMs 覆盖透传；缺省 60s（长轨迹 thinking 模型实测需放宽——扩展传 180s）", async () => {
    const seen: Array<{ callTimeoutMs?: number | null } | undefined> = [];
    const llm: import("../../../src/agent/skills/distill.js").DistillLLM = {
      async structuredCall(_s, _p, schema, opts) {
        const props = (schema.properties ?? {}) as Record<string, unknown>;
        if ("match" in props) return MATCH_UPLOAD;
        seen.push(opts);
        return VALID_CARD;
      },
    };
    const overridden = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      llm,
      callTimeoutMs: 180_000,
    });
    expect(overridden.kind).toBe("draft");
    expect(seen.at(-1)?.callTimeoutMs).toBe(180_000);
    const defaulted = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(defaulted.kind).toBe("draft");
    expect(seen.at(-1)?.callTimeoutMs).toBe(60_000);
  });

  it("issue #16 D2：前置匹配共享蒸馏超时——matcher 调用收到同一 callTimeoutMs（缺省 60s）", async () => {
    const matcherSeen: Array<{ callTimeoutMs?: number | null } | undefined> = [];
    const llm: DistillLLM = {
      async structuredCall(_s, _p, schema, opts) {
        const props = (schema.properties ?? {}) as Record<string, unknown>;
        if ("match" in props) {
          matcherSeen.push(opts);
          return MATCH_UPLOAD;
        }
        return VALID_CARD;
      },
    };
    const overridden = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      llm,
      callTimeoutMs: 180_000,
    });
    expect(overridden.kind).toBe("draft");
    expect(matcherSeen).toEqual([{ callTimeoutMs: 180_000 }]);
    const defaulted = await distillTaskCard({ ...BASE_INPUT, catalog: CATALOG, llm });
    expect(defaulted.kind).toBe("draft");
    expect(matcherSeen.at(-1)?.callTimeoutMs).toBe(60_000);
  });
});

// —— issue #11 D1 防锚定：SOP 尾部自检 footer（蒸馏侧后处理，不动消费端冻结口径）——

describe("SOP 自检 footer（issue #11 D1）", () => {
  it("新卡 draft：原 sop 在前、footer 恒居尾", async () => {
    const llm = makeLlm(NO_MATCH, VALID_CARD);
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    expect(outcome.card.sop.startsWith(VALID_CARD.sop_md)).toBe(true);
    expect(outcome.card.sop.endsWith(TASK_SOP_SELF_CHECK_FOOTER)).toBe(true);
  });

  it("幂等：增量模式 LLM 原样回带 footer 的 sop → 剥后重附恒单份（不重复）", async () => {
    const withFooter = `${VALID_CARD.sop_md}\n\n${TASK_SOP_SELF_CHECK_FOOTER}`;
    const llm = makeLlm(MATCH_UPLOAD, { ...VALID_CARD, sop_md: withFooter });
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      cardText: async () => `旧卡 SOP\n\n${TASK_SOP_SELF_CHECK_FOOTER}`,
      llm,
    });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    expect(outcome.card.sop.split(TASK_SOP_SELF_CHECK_FOOTER).length - 1).toBe(1);
    expect(outcome.card.sop.endsWith(TASK_SOP_SELF_CHECK_FOOTER)).toBe(true);
  });

  it("applySelfCheckFooter 纯函数：未含 → 附加；已含 → 剥后重附等值", () => {
    const sop = "# 步骤\nstep 1: 打开页面";
    const once = applySelfCheckFooter(sop);
    expect(once.endsWith(TASK_SOP_SELF_CHECK_FOOTER)).toBe(true);
    expect(once.startsWith(sop)).toBe(true);
    // 双重附加（footer 后再走一次）→ 与单次等值
    expect(applySelfCheckFooter(once)).toBe(once);
  });

  it("评审轮 1 [1]：footer 被模型前置/置于中部 → 剥除所有出现且不丢正文（尾部单份）", () => {
    // 前置（「执行前自检」字面语义诱导）——旧实现 slice(0,0) 丢整卡正文
    const front = `${TASK_SOP_SELF_CHECK_FOOTER}\n\n${VALID_CARD.sop_md}`;
    expect(applySelfCheckFooter(front)).toBe(
      `${VALID_CARD.sop_md}\n\n${TASK_SOP_SELF_CHECK_FOOTER}`,
    );
    // 中部（尾部 footer 之后又追加新观察）——旧实现丢弃 footer 之后全部正文
    const mid = `# 标题\n\n${TASK_SOP_SELF_CHECK_FOOTER}\n\nstep 1: 后续正文`;
    expect(applySelfCheckFooter(mid)).toBe(
      `# 标题\n\nstep 1: 后续正文\n\n${TASK_SOP_SELF_CHECK_FOOTER}`,
    );
  });

  it("#12 评审轮 1 [1]：存量卡的旧版三条 footer（#11 形态）一并剥除——不残留双份自检节", () => {
    // #12 D3 加第四条前落盘到存量卡的历史原文（冻结兼容面——勿随后续常量改动漂移）
    expect(TASK_SOP_SELF_CHECK_FOOTER_V1).not.toBe(TASK_SOP_SELF_CHECK_FOOTER);
    expect(TASK_SOP_SELF_CHECK_FOOTER_V1).toContain("以页面为准");
    expect(TASK_SOP_SELF_CHECK_FOOTER_V1).not.toContain("不是最短保证");
    // 旧卡（尾部带 V1）增量回带 → 剥 V1、附新版单份
    const withV1 = `${VALID_CARD.sop_md}\n\n${TASK_SOP_SELF_CHECK_FOOTER_V1}`;
    const out = applySelfCheckFooter(withV1);
    expect(out.split("## 执行前自检").length - 1).toBe(1); // 恰一份
    expect(out.endsWith(TASK_SOP_SELF_CHECK_FOOTER)).toBe(true);
    expect(out.startsWith(VALID_CARD.sop_md)).toBe(true);
    // 混合：V1 中部 + 新版尾部（模型既回带旧又落新）→ 双双剥除
    const mixed = `# 标题\n\n${TASK_SOP_SELF_CHECK_FOOTER_V1}\n\n正文\n\n${TASK_SOP_SELF_CHECK_FOOTER}`;
    const out2 = applySelfCheckFooter(mixed);
    expect(out2.split("## 执行前自检").length - 1).toBe(1);
    expect(out2).toBe(`# 标题\n\n正文\n\n${TASK_SOP_SELF_CHECK_FOOTER}`);
  });

  it("TASK_SOP_SPEC 防锚定规则锚定：步骤只能是页面操作、完成断言只属 done 且须页面实时证据", () => {
    expect(TASK_SOP_SPEC).toContain("page operation");
    expect(TASK_SOP_SPEC).toContain("final done");
    expect(TASK_SOP_SPEC).toContain("live check against the CURRENT page");
    // footer 文案要点：历史总结声明 / 页面实时核验 / 不符以页面为准
    expect(TASK_SOP_SELF_CHECK_FOOTER).toContain("历史成功轨迹的总结");
    expect(TASK_SOP_SELF_CHECK_FOOTER).toContain("以当前页面真实状态核验");
    expect(TASK_SOP_SELF_CHECK_FOOTER).toContain("以页面为准");
    // #12 D3 效率句（缺口 B 软杠杆）：更短等效做法优先
    expect(TASK_SOP_SELF_CHECK_FOOTER).toContain("不是最短保证");
    expect(TASK_SOP_SELF_CHECK_FOOTER).toContain("优先采用更短路径");
  });
});

// —— issue #12 效率信号：margin 判定 / 判停守卫 / 基线透传与棘轮落值 ——

describe("效率信号（issue #12）", () => {
  it("efficiencyMargin：max(2, ⌈10%·best⌉)", () => {
    expect(efficiencyMargin(5)).toBe(2);
    expect(efficiencyMargin(20)).toBe(2);
    expect(efficiencyMargin(21)).toBe(3);
    expect(efficiencyMargin(50)).toBe(5);
  });

  it("D2 判停守卫：streak≥阈值但有显著改进 → 蒸馏照发；无基线/无改进 → 照常 skip", async () => {
    // BASE_INPUT 轨迹 2 步；best=12 → margin=2 → 2 < 10 显著改进 → 跨过收敛
    const llm = makeLlm(MATCH_UPLOAD, VALID_CARD);
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      llm,
      cardDistillState: async () => ({ streak: 2, bestSteps: 12 }),
    });
    expect(outcome.kind).toBe("draft");
    expect(llm.distillCalls.length).toBe(1);
    // 无基线（旧卡 meta 无 best_steps——存量卡）→ 守卫无从判定 → 照旧 skip
    const llm2 = makeLlm(MATCH_UPLOAD, VALID_CARD);
    const outcome2 = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      llm: llm2,
      cardDistillState: async () => ({ streak: 2 }),
    });
    expect(outcome2.kind).toBe("skip");
    expect(llm2.distillCalls.length).toBe(0);
    // 有基线但无改进（best=3 → margin=2 → 2 < 1 不成立）→ skip
    const llm3 = makeLlm(MATCH_UPLOAD, VALID_CARD);
    const outcome3 = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      llm: llm3,
      cardDistillState: async () => ({ streak: 2, bestSteps: 3 }),
    });
    expect(outcome3.kind).toBe("skip");
  });

  it("D1 基线透传：prompt 渲染 M vs N 对比行；draft.bestSteps = min(基线, 本次)", async () => {
    const llm = makeLlm(MATCH_UPLOAD, VALID_CARD);
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      llm,
      cardDistillState: async () => ({ streak: 0, bestSteps: 5 }),
    });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    expect(outcome.card.bestSteps).toBe(2); // min(5, 2)
    const user = llm.distillCalls[0].user;
    expect(user).toContain("best successful run took **5 steps**");
    expect(user).toContain("this trace took **2 steps** (-60%)");
    expect(user).toContain("has_new_observations");
  });

  it("新卡无基线 → draft.bestSteps = 本次步数；prompt 无效率对比行", async () => {
    const llm = makeLlm(NO_MATCH, VALID_CARD);
    const outcome = await distillTaskCard({ ...BASE_INPUT, catalog: [], llm });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind !== "draft") return;
    expect(outcome.card.bestSteps).toBe(2);
    expect(llm.distillCalls[0].user).not.toContain("Efficiency baseline");
  });

  it("unchanged 判定不受改进影响（内容归模型——基线棘轮是宿主 bump 侧职责）", async () => {
    const llm = makeLlm(MATCH_UPLOAD, { ...VALID_CARD, has_new_observations: false });
    const outcome = await distillTaskCard({
      ...BASE_INPUT,
      catalog: CATALOG,
      llm,
      cardDistillState: async () => ({ streak: 0, bestSteps: 12 }),
    });
    expect(outcome).toEqual({ kind: "unchanged", slug: "upload-video" });
  });
});
