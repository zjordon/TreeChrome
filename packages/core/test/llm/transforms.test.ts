// transforms 单测。期望值锚定 Python 实跑（AGENTS.md 铁律），生成命令与输出如下
//（用 evals venv 里的 tree_walker 实跑——venv 绝对路径与启用方式见 AGENTS.md
//「验收命令」节，Python: evals/webarena/.venv，tree_walker editable 安装）：
//
//   python - <<'PYEOF'
//   from tree_walker.llm.client import _try_parse_json, _infra_backoff_delay, LLMClient
//   cases = ['{"a": 1}', '```json\n{"a": 1}\n```', '```json\n{"a": {"b": 2}}\n```',
//            'no json here', '', 'Sure! Here it is: {"x": 1} hope it helps',
//            '{"bad json', '{}', '```{"k": [1,2]}```']
//   for c in cases: print(repr(c), "->", repr(_try_parse_json(c)))
//   # shorten/sensitive/backoff 节的实跑脚本同头部说明，输出见下面对应断言
//   PYEOF
//
// 输出：
//   '{"a": 1}' -> {'a': 1}
//   '```json\n{"a": 1}\n```' -> {'a': 1}
//   '```json\n{"a": {"b": 2}}\n```' -> {'a': {'b': 2}}   ← 围栏懒惰量词整体回溯后捕获完整对象，二级即命中（Python re.search 同语义）
//   'no json here' -> None
//   '' -> None
//   'Sure! Here it is: {"x": 1} hope it helps' -> {'x': 1}
//   '{"bad json' -> None
//   '{}' -> {}
//   '```{"k": [1,2]}```' -> {'k': [1, 2]}
//   shorten_urls：texts → ["see [u0] and [u1]", "i saw [u0]", "https://example.com/short stays, [u1] too"]
//                 map   → {"[u0]": "https://example.com/aaaa…(90a)", "[u1]": "https://example.org/bbbb…(90b)"}
//   sensitive：filter "my key sk-abc-def and sk-abc both" → "my key <KEY1> and <KEY2> both"
//              restore {"v": "<KEY2> and <KEY1>"} → {"v": "sk-abc and sk-abc-def"}（插入序）
//   backoff：attempt 0..6 → [2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]
//            retry-after "5"→5.0 / "120"→60.0 / "1e2"→60.0 / "0"/"-3"/"abc"/None→回落指数 2.0
//   （指数梯子的延迟消费路径在 client.test.ts 退避组锚定；retry-after 容错集在
//    http.test.ts 的 parseRetryAfterMs 矩阵锚定；本文件只锚定 tryParseJson/
//    shorten/sensitive 纯函数。）
import { describe, expect, it } from "vitest";
import type { ChatMessage, TextBlock, UserMessage } from "../../src/index.js";

import {
  applySensitiveInMessages,
  cloneWorkMessages,
  hasImageBlocks,
  restoreSensitiveInOutput,
  restoreUrlsInOutput,
  shortenUrlsInMessages,
  stripImageBlocks,
  tryParseJson,
  URL_MIN_LENGTH,
} from "../../src/llm/transforms.js";
import { LONG_URL } from "./fixtures.js";

const U0 = LONG_URL; // 110 字符 ≥ 100（fixtures.LONG_URL）
const U1 = `https://example.org/${"b".repeat(90)}`;
const SHORT = "https://example.com/short";

const firstText = (m: ChatMessage): string => {
  if (m.role === "toolResult") {
    return m.text;
  }
  const block = m.blocks[0];
  return block.kind === "text" ? block.text : "";
};

const userMsg = (text: string): UserMessage => ({ role: "user", blocks: [{ kind: "text", text }] });

describe("tryParseJson（Python 锚定 9 例）", () => {
  const cases: Array<[string, Record<string, unknown> | undefined]> = [
    ['{"a": 1}', { a: 1 }],
    ['```json\n{"a": 1}\n```', { a: 1 }],
    ['```json\n{"a": {"b": 2}}\n```', { a: { b: 2 } }],
    ["no json here", undefined],
    ["", undefined],
    ['Sure! Here it is: {"x": 1} hope it helps', { x: 1 }],
    ['{"bad json', undefined],
    ["{}", {}], // 解析成功返回空对象；Python `if parsed:` 在调用方按 falsy 处理
    ['```{"k": [1,2]}```', { k: [1, 2] }],
  ];
  it.each(cases)("%j → %j", (input, expected) => {
    expect(tryParseJson(input)).toEqual(expected);
  });

  it("URL_MIN_LENGTH 锚定 Python _URL_MIN_LENGTH=100", () => {
    expect(URL_MIN_LENGTH).toBe(100);
  });
});

describe("shortenUrlsInMessages（Python 锚定：tag 分配顺序 = 首次出现顺序）", () => {
  const buildMessages = (): ChatMessage[] => [
    userMsg(`see ${U0} and ${U1}`),
    { role: "assistant", blocks: [{ kind: "text", text: `i saw ${U0}` }] },
    userMsg(`${SHORT} stays, ${U1} too`),
  ];

  it("长 URL 换 [uN]、同 URL 复用 tag、短 URL 不动、跨消息共享 tag（锚定 texts 与 map）", () => {
    const messages = buildMessages();
    const map = shortenUrlsInMessages(messages);
    expect(map).toEqual(
      new Map([
        ["[u0]", U0],
        ["[u1]", U1],
      ]),
    );
    expect(messages.map(firstText)).toEqual([
      "see [u0] and [u1]",
      "i saw [u0]",
      "https://example.com/short stays, [u1] too",
    ]);
  });

  it("toolResult.text 不缩写（Python 只处理 type=text block 的对齐）", () => {
    const messages: ChatMessage[] = [
      userMsg("q"),
      {
        role: "assistant",
        blocks: [],
        toolCalls: [{ id: "t1", name: "agent_response", args: {} }],
      },
      { role: "toolResult", toolCallId: "t1", toolName: "agent_response", text: `result ${U0}` },
    ];
    const map = shortenUrlsInMessages(messages);
    expect(map.size).toBe(0);
    expect(firstText(messages[2])).toContain(U0);
  });

  it("URL 后紧跟全角标点 → 尾界截断不吞中文（有意偏离 Python \\S+，03 §4 偏离 10）", () => {
    const messages = [userMsg(`打开 ${U0}，然后点击按钮。`)];
    const map = shortenUrlsInMessages(messages);
    // Python \S+ 会把「，然后点击按钮。」吞进 URL 整体换 tag（中文静默删除）；
    // TS 尾界排除全角标点：URL 干净截断，后续中文保留
    expect(map).toEqual(new Map([["[u0]", U0]]));
    expect(firstText(messages[0])).toBe("打开 [u0]，然后点击按钮。");
  });
});

describe("敏感值占位/还原（Python 锚定：包含关系键按插入序）", () => {
  const map = { "sk-abc-def": "<KEY1>", "sk-abc": "<KEY2>" };

  it("filter：长键在前先替换（锚定输出）", () => {
    const messages: ChatMessage[] = [userMsg("my key sk-abc-def and sk-abc both")];
    applySensitiveInMessages(messages, map);
    expect(firstText(messages[0])).toBe("my key <KEY1> and <KEY2> both");
  });

  it("filter：短键在插入序首位 → 部分替换（插入序语义的另一半，防重排无声漂移，轮 13 #3）", () => {
    const messages: ChatMessage[] = [userMsg("my key sk-abc-def and sk-abc both")];
    applySensitiveInMessages(messages, { "sk-abc": "<KEY2>", "sk-abc-def": "<KEY1>" });
    // 按插入序替换：先短键命中，长键不再完整出现 → "-def" 片段残留（hazardous
    // 半边也是契约——宿主构造 map 时长键应放前）
    expect(firstText(messages[0])).toBe("my key <KEY2>-def and <KEY2> both");
  });

  it("toolResult.text 不占位（Python 只处理 type=text block 的取舍——与 URL 缩写侧锚定对称；P5 裁决时此用例感知漂移）", () => {
    const messages: ChatMessage[] = [
      userMsg("q"),
      {
        role: "assistant",
        blocks: [],
        toolCalls: [{ id: "t1", name: "agent_response", args: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "agent_response",
        text: "tool echoed sk-abc-def",
      },
    ];
    applySensitiveInMessages(messages, map);
    expect(firstText(messages[2])).toBe("tool echoed sk-abc-def"); // 明文保留（已知取舍）
  });
  it("空字符串键跳过（replaceAll('', x) 会逐字符插入占位符损坏全文）；还原侧滤空 real 与空占位符", () => {
    const messages: ChatMessage[] = [userMsg("keep this intact")];
    applySensitiveInMessages(messages, { "": "<BAD>", keep: "<K>" });
    expect(firstText(messages[0])).toBe("<K> this intact");
    // 还原侧：空 real 键与空占位符键都被滤除（请求侧只滤空 real——空占位符条目
    // 的请求侧语义是删除敏感值，见下一条用例），文本原样——含模型回显 "<BAD>"
    // 的输入也不被静默改写
    expect(restoreSensitiveInOutput({ v: "x secret" }, { "": "<BAD>", secret: "" })).toEqual({
      v: "x secret",
    });
    expect(restoreSensitiveInOutput({ v: "<BAD> x" }, { "": "<BAD>" })).toEqual({ v: "<BAD> x" });
  });

  it("空占位符条目：请求侧删除敏感值（replaceAll(real, '')，Python 同款不可逆语义）；还原侧跳过无从恢复", () => {
    const messages: ChatMessage[] = [userMsg("token sk-abc here")];
    applySensitiveInMessages(messages, { "sk-abc": "" });
    expect(firstText(messages[0])).toBe("token  here");
    expect(restoreSensitiveInOutput({ v: "token  here" }, { "sk-abc": "" })).toEqual({
      v: "token  here",
    });
  });

  it("restore：占位符还原真实值（锚定输出）", () => {
    expect(restoreSensitiveInOutput({ v: "<KEY2> and <KEY1>" }, map)).toEqual({
      v: "sk-abc and sk-abc-def",
    });
  });

  it("含 $$/$&/$' 序列的真实值与 URL 字面往返（字符串 replacement 会解释特殊模式）", () => {
    const dollar = "pa$$word";
    const tick = "pre$'post";
    const messages: ChatMessage[] = [userMsg(`secret ${dollar} and ${tick}`)];
    const sensitiveMap = { [dollar]: "<D>", [tick]: "<T>" };
    applySensitiveInMessages(messages, sensitiveMap);
    expect(firstText(messages[0])).toBe("secret <D> and <T>");
    const restored = restoreSensitiveInOutput({ v: "<D> <T>", url: "[u0]" }, sensitiveMap);
    expect(restored).toEqual({ v: `${dollar} ${tick}`, url: "[u0]" });
    // URL 还原同款：真实 URL 含 $& 时不被解释为"匹配串"
    const urlMap = new Map([["[u0]", "https://ex.com/$&/a"]]);
    expect(restoreUrlsInOutput({ u: "[u0]" }, urlMap)).toEqual({ u: "https://ex.com/$&/a" });
  });

  it("非普通对象（Map/Set/Date）原样保留，不被递归重建静默清空成 {}", () => {
    const m = new Map([["k", "v-<KEY1>"]]);
    const s = new Set(["<KEY1>"]);
    const d = new Date(0);
    const out = restoreSensitiveInOutput({ m, s, d }, { "sk-abc": "<KEY1>" });
    // 同一实例原样返回——按 entries 递归会把这些对象清空成 {}（数据损坏）
    expect(out.m).toBe(m);
    expect(out.s).toBe(s);
    expect(out.d).toBe(d);
  });

  it("删除语义把整块文本滤空 → 降级 [redacted]（不打破非空文本不变量，轮 15 #8）；原始空文本不掩蔽", () => {
    const messages: ChatMessage[] = [userMsg("sk-abc")];
    applySensitiveInMessages(messages, { "sk-abc": "" });
    expect(firstText(messages[0])).toBe("[redacted]");
    // 原始即空的文本块保持原样（调用方违例仍由 canonical 校验归因）
    const emptyOwn: ChatMessage[] = [userMsg("")];
    applySensitiveInMessages(emptyOwn, { "sk-abc": "" });
    expect(firstText(emptyOwn[0])).toBe("");
  });

  it("map 为空/undefined 时两侧都不动", () => {
    const messages: ChatMessage[] = [userMsg("sk-abc")];
    applySensitiveInMessages(messages, undefined);
    expect(firstText(messages[0])).toBe("sk-abc");
    expect(restoreSensitiveInOutput({ v: "x" }, undefined)).toEqual({ v: "x" });
  });
});

describe("restoreUrlsInOutput", () => {
  it("嵌套对象/数组递归还原，非字符串值原样", () => {
    const map = new Map([
      ["[u0]", U0],
      ["[u1]", U1],
    ]);
    const out = restoreUrlsInOutput(
      { next_goal: "open [u0]", steps: ["see [u1]", { url: "[u0] and [u1]", n: 3, nil: null }] },
      map,
    );
    expect(out).toEqual({
      next_goal: `open ${U0}`,
      steps: [`see ${U1}`, { url: `${U0} and ${U1}`, n: 3, nil: null }],
    });
  });

  it("空 map 原样返回", () => {
    expect(restoreUrlsInOutput({ a: "[u0]" }, new Map())).toEqual({ a: "[u0]" });
  });
});

describe("hasImageBlocks", () => {
  it("user/assistant 含图 → true；纯文本与 toolResult 不算（与 stripImageBlocks 跳过规则一致，轮 15 #11）", () => {
    expect(
      hasImageBlocks([
        userMsg("q"),
        {
          role: "user",
          blocks: [
            { kind: "text", text: "s" },
            { kind: "image", mimeType: "image/png", base64: "A" },
          ],
        },
      ]),
    ).toBe(true);
    expect(hasImageBlocks([userMsg("q")])).toBe(false);
    expect(
      hasImageBlocks([{ role: "toolResult", toolCallId: "t", toolName: "n", text: "img" }]),
    ).toBe(false);
  });
});

describe("stripImageBlocks", () => {
  it("移除 ImageBlock 保留文本块", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        blocks: [
          { kind: "text", text: "screenshot:" },
          { kind: "image", mimeType: "image/png", base64: "AAAA" },
        ],
      },
    ];
    stripImageBlocks(messages);
    expect(messages[0].role === "user" && messages[0].blocks).toEqual([
      { kind: "text", text: "screenshot:" },
    ]);
  });

  it("image-only 历史块被滤空 → 降级占位文本块继续（Python 降级空串同精神，不放大成步级硬失败）", () => {
    const messages: ChatMessage[] = [
      { role: "user", blocks: [{ kind: "image", mimeType: "image/png", base64: "AAAA" }] },
    ];
    stripImageBlocks(messages);
    expect(messages[0].role === "user" && messages[0].blocks).toEqual([
      { kind: "text", text: "[image omitted]" },
    ]);
  });

  it("toolResult 消息不受滤图影响", () => {
    const messages: ChatMessage[] = [
      { role: "toolResult", toolCallId: "t", toolName: "n", text: "ok" },
    ];
    stripImageBlocks(messages);
    expect(messages[0]).toEqual({ role: "toolResult", toolCallId: "t", toolName: "n", text: "ok" });
  });
});

describe("cloneWorkMessages", () => {
  it("变换落在副本上，调用方消息不被改动（03 偏离 1）", () => {
    const original: ChatMessage[] = [userMsg(`see ${U0}`)];
    const work = cloneWorkMessages(original);
    shortenUrlsInMessages(work);
    applySensitiveInMessages(work, { see: "[SEE]" });
    expect(firstText(original[0])).toBe(`see ${U0}`);
    expect(firstText(work[0])).toBe("[SEE] [u0]");
  });

  it("副本不共享 blocks 数组与文本块（改副本不泄漏回原消息）", () => {
    const original: ChatMessage[] = [userMsg("a")];
    const work = cloneWorkMessages(original);
    const workUser = work[0];
    if (workUser.role !== "user") {
      throw new Error("unreachable");
    }
    workUser.blocks.push({ kind: "text", text: "b" } satisfies TextBlock);
    (workUser.blocks[0] as TextBlock).text = "mutated";
    const originalUser = original[0];
    if (originalUser.role !== "user") {
      throw new Error("unreachable");
    }
    expect(originalUser.blocks.length).toBe(1);
    expect(originalUser.blocks[0]).toEqual({ kind: "text", text: "a" });
  });
});
