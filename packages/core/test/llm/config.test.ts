// 视觉白名单 + 能力解析单测。期望值锚定 Python 实跑（AGENTS.md 铁律）：
//   D:/dev/git/z_jordon/evals/webarena/.venv/Scripts/python.exe -c \
//     "from tree_walker.config import model_supports_vision as f; \
//      cases=['claude-3-5-sonnet-20241022','claude-opus-4','glm-4v','glm-4.5v','glm-4.1v-plus',\
// 'glm-5v','glm-5.3-flash','glm-5.1','glm-5.2','glm-4','glm-4.5','GLM-4V','  glm-5.3-flash  ','','gpt-4o','gemini-2.0-flash',None]; \
//      print(repr({str(c): f(c) for c in cases}))"
// 输出（2026-09-23，tree_walker editable 安装）：
//   claude-*=True；glm-4v/4.5v/4.1v-plus/5v/5.3-flash=True；
//   glm-5.1/5.2/4/4.5、gpt-4o、gemini-2.0-flash、''、None=False；大小写/首尾空白不敏感（GLM-4V、'  glm-5.3-flash  '）
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/index.js";
import {
  DEFAULT_MAX_TOKENS,
  modelSupportsVision,
  resolveCapabilities,
} from "../../src/llm/config.js";

const card = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  name: "test",
  protocol: "anthropic-messages",
  baseUrl: "https://example.com",
  apiKey: "k",
  model: "glm-5.1",
  maxTokens: DEFAULT_MAX_TOKENS,
  ...over,
});

describe("modelSupportsVision（Python 锚定边界集）", () => {
  const cases: Array<[string | null | undefined, boolean]> = [
    ["claude-3-5-sonnet-20241022", true],
    ["claude-opus-4", true],
    ["glm-4v", true],
    ["glm-4.5v", true],
    ["glm-4.1v-plus", true],
    ["glm-5v", true],
    ["glm-5.3-flash", true],
    ["glm-5.1", false],
    ["glm-5.2", false],
    ["glm-4", false],
    ["glm-4.5", false],
    ["GLM-4V", true], // 大小写不敏感（Python 侧 .lower()）
    ["  glm-5.3-flash  ", true], // 首尾空白容错（Python 侧 .strip()）
    ["", false],
    [null, false],
    [undefined, false],
    ["gpt-4o", false],
    ["gemini-2.0-flash", false],
  ];
  it.each(cases)("%s → %s", (model, expected) => {
    expect(modelSupportsVision(model)).toBe(expected);
  });
});

describe("resolveCapabilities", () => {
  it("缺省：tools/forced 恒 true，vision 走白名单", () => {
    const caps = resolveCapabilities(card({ model: "glm-5.1" }));
    expect(caps).toEqual({ supportsTools: true, supportsForcedTool: true, supportsVision: false });
    expect(resolveCapabilities(card({ model: "glm-4.5v" })).supportsVision).toBe(true);
  });

  it("卡片声明覆盖启发式", () => {
    const caps = resolveCapabilities(
      card({
        capabilities: { supportsTools: false, supportsVision: true, supportsForcedTool: false },
      }),
    );
    expect(caps).toEqual({ supportsTools: false, supportsForcedTool: false, supportsVision: true });
  });

  it("部分声明：未声明项走缺省", () => {
    const caps = resolveCapabilities(
      card({ model: "glm-4.5v", capabilities: { supportsVision: false } }),
    );
    expect(caps).toEqual({ supportsTools: true, supportsForcedTool: true, supportsVision: false });
  });
});

describe("DEFAULT_MAX_TOKENS", () => {
  it("TreeWalker 教训缺省值 16384（thinking 写满 4096 → 空响应猝死）", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(16384);
  });
});
