// gemini 适配器 + schema-sanitize 单测（04 §5 覆盖矩阵 G 列）。
// 无内部参考（webbrain 无 gemini provider）：断言全部锚定 02 §4 冻结的官方规格映射，
// 真机差异等有 key 实测后修订（README 风险 3——验收以 mock 为准，标注待实测）。
import { describe, expect, it } from "vitest";
import type { ChatRequest, ProviderConfig } from "../../src/index.js";
import { createGeminiProvider, SCHEMA_ISSUE_DEDUP_MAX } from "../../src/llm/adapters/gemini.js";
import { SCHEMA_MAX_DEPTH, sanitizeGeminiSchema } from "../../src/llm/adapters/schema-sanitize.js";
import { DEFAULT_MAX_TOKENS } from "../../src/llm/config.js";
import {
  LLMBlockedError,
  LLMProtocolViolationError,
  LLMRateLimitError,
} from "../../src/llm/errors.js";
import { logCountAfterChat, setupProvider, setupProviderWithLogs } from "./fixtures.js";

const CARD: ProviderConfig = {
  name: "gemini-card",
  protocol: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "g-key",
  model: "gemini-2.5-pro",
  maxTokens: 8192,
};

const TOOL = {
  name: "agent_response",
  description: "respond",
  parameters: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "object", description: "the action", additionalProperties: true },
      // minimum 数值约束键：官方 Schema 支持的约束键（轮 10 起白名单收录，透传
      // 保留）——挂数值域属性演示，与分域口径自洽（minimum/maximum 仅 NUMBER/
      // INTEGER，轮 31 #12：此前挂在 object 属性上与顶层归一剥离口径矛盾）
      count: { type: "number", minimum: 1 },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    },
    required: ["action"],
  },
};

const SANITIZED = {
  type: "object",
  properties: {
    action: { type: "object", description: "the action" },
    count: { type: "number", minimum: 1 },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
  },
  required: ["action"],
};

const setup = (over: Partial<ProviderConfig> = {}) =>
  setupProvider(createGeminiProvider, CARD, over);

const fnCallOk = (args: Record<string, unknown>) => ({
  status: 200,
  body: {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: "agent_response", args } }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  },
});

/** 带日志采集的装配（丢弃类/清洗类告警断言共用；over 覆盖卡片级配置，对齐 anthropic 侧轮 21 #13） */
const setupLogs = (over: Partial<ProviderConfig> = {}) =>
  setupProviderWithLogs(createGeminiProvider, CARD, over);
describe("sanitizeGeminiSchema（白名单递归清洗）", () => {
  it("白名单外键删除（$schema/additionalProperties/examples/$id），约束键（minimum）保留透传", () => {
    expect(sanitizeGeminiSchema(TOOL.parameters)).toEqual(SANITIZED);
  });

  it("官方约束键透传（域内）：分域后保留，多词键按官方 camelCase 发射（轮 10 起；轮 32 #12 收尾剥离后须域内自洽）", () => {
    expect(
      sanitizeGeminiSchema({
        type: "number",
        minimum: 0,
        Maximum: 10,
      }),
    ).toEqual({
      type: "number",
      minimum: 0,
      maximum: 10,
    });
    expect(
      sanitizeGeminiSchema({
        type: "string",
        pattern: "^a",
        MinLength: 1,
        maxlength: 20,
      }),
    ).toEqual({
      type: "string",
      pattern: "^a",
      minLength: 1,
      maxLength: 20,
    });
    expect(
      sanitizeGeminiSchema({
        type: "array",
        minItems: 0,
        MaxItems: 5,
      }),
    ).toEqual({
      type: "array",
      minItems: 0,
      maxItems: 5,
    });
  });

  it("约束键 type 分域收尾剥离（轮 32 #12）：域外键删除并上报，域内保留", () => {
    const issues: string[] = [];
    expect(
      sanitizeGeminiSchema(
        {
          type: "string",
          items: { type: "string" }, // items 仅 ARRAY 域
          minimum: 0, // minimum/maximum 仅 NUMBER/INTEGER 域
          minItems: 1, // minItems/maxItems 仅 ARRAY 域
          pattern: "^a", // 域内保留
        },
        (d) => issues.push(d),
      ),
    ).toEqual({ type: "string", pattern: "^a" });
    expect(issues).toContain("键「items」不在 type=string 的官方支持域，删除该键");
    expect(issues).toContain("键「minimum」不在 type=string 的官方支持域，删除该键");
    expect(issues).toContain("键「minItems」不在 type=string 的官方支持域，删除该键");
    // object 节点携带 required 合法、携带 minimum 剥离
    const objIssues: string[] = [];
    expect(
      sanitizeGeminiSchema(
        { type: "object", properties: { a: { type: "string" } }, required: ["a"], minimum: 1 },
        (d) => objIssues.push(d),
      ),
    ).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
    expect(objIssues).toContain("键「minimum」不在 type=object 的官方支持域，删除该键");
  });

  it("嵌套深度上限（SCHEMA_MAX_DEPTH）：深层节点截断为空 schema 留证据（轮 32 #7）", () => {
    const issues: string[] = [];
    // 程序化构造 SCHEMA_MAX_DEPTH + 5 层嵌套 properties（宿主程序化构造可绕过
    // JSON.parse 自身栈限制——未设限递归以 RangeError 直穿且无归因线索）
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < SCHEMA_MAX_DEPTH + 5; i += 1) {
      deep = { type: "object", properties: { next: deep } };
    }
    const out = sanitizeGeminiSchema(deep, (d) => issues.push(d));
    // depth 0..63 层正常处理，depth 64 层截断为 {type:"string"}（不再向下递归）
    let node: Record<string, unknown> = out;
    for (let i = 0; i < SCHEMA_MAX_DEPTH; i += 1) {
      node = (node.properties as Record<string, unknown>).next as Record<string, unknown>;
    }
    expect(node).toEqual({ type: "string" });
    expect(issues.filter((d) => d.includes("嵌套深度达")).length).toBe(1);
  });

  it("format 值按官方封闭枚举集校验：uri/email 等常见 JSON Schema 值删除并上报（轮 13 #4；父节点改 object 域自洽——string 节点的 properties 自轮 32 #12 起剥离）", () => {
    const issues: string[] = [];
    const out = sanitizeGeminiSchema(
      {
        type: "object",
        properties: { t: { type: "string", format: "email" } },
      },
      (d) => issues.push(d),
    );
    expect(out).toEqual({ type: "object", properties: { t: { type: "string" } } });
    expect(issues).toEqual(['format「"email"」不在官方支持集，删除该键']);
    expect(sanitizeGeminiSchema({ type: "number", format: 42 }, (d) => issues.push(d))).toEqual({
      type: "number",
    });
    expect(issues.length).toBe(2);
  });

  it("嵌套 properties/items 递归清洗；type 大小写变体（Type）归一化为小写键（object 节点的 items 自轮 32 #12 起剥离，演示项挪到 array 子节点）", () => {
    const out = sanitizeGeminiSchema({
      Type: "object",
      $id: "x",
      properties: {
        inner: { Type: "string", examples: ["a"], enum: ["x"] },
        list: { Type: "array", items: { $schema: "y", type: "string" } },
      },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        inner: { type: "string", enum: ["x"] },
        list: { type: "array", items: { type: "string" } },
      },
    });
  });

  it("联合类型 type: ['string','null'] → 首个非 null + nullable（Gemini type 只收单字符串；properties 挪进 object 成员演示，轮 32 #12 域自洽）", () => {
    expect(
      sanitizeGeminiSchema({
        type: ["object", "null"],
        properties: { opt: { type: ["object", "null"], description: "d" } },
      }),
    ).toEqual({
      type: "object",
      nullable: true,
      properties: { opt: { type: "object", nullable: true, description: "d" } },
    });
  });

  it("边界 type: ['null'] → 兜底合法 type 枚举（不产出无 type 的 schema）", () => {
    expect(sanitizeGeminiSchema({ type: ["null"] })).toEqual({ type: "string", nullable: true });
  });

  it("nullable 派生与显式键：显式优先且与键序无关（轮 40 #5：此前 {type:[…,null],nullable:false} 与反序产出相反结果）", () => {
    // 两种键序语义相同 → 输出必须一致（显式 nullable 优先）
    const a = sanitizeGeminiSchema({ type: ["string", "null"], nullable: false });
    const b = sanitizeGeminiSchema({ nullable: false, type: ["string", "null"] });
    expect(a).toEqual({ type: "string", nullable: false });
    expect(b).toEqual({ type: "string", nullable: false });
    // 无显式键 → null 成员派生 true；sourceKey 按「type 的 null 成员」归因
    const issues: string[] = [];
    expect(
      sanitizeGeminiSchema({ type: ["string", "null"], description: "d" }, (d) => issues.push(d)),
    ).toEqual({ type: "string", description: "d", nullable: true });
    expect(issues).toEqual([]);
  });

  it("type 字符串值枚举校验：PascalCase 小写归一，非法枚举值兜底 string 并上报（轮 15 #17 + 轮 18 #1）", () => {
    const issues: string[] = [];
    expect(sanitizeGeminiSchema({ type: "STRING" }, (d) => issues.push(d))).toEqual({
      type: "string",
    });
    // 非法枚举不删键：端点要求每个 schema 节点显式 type（"missing a type" 400，
    // 轮 18 #1 web 核实）——与全病态数组/非字符串形态统一兜底 string
    expect(sanitizeGeminiSchema({ type: "str" }, (d) => issues.push(d))).toEqual({
      type: "string",
    });
    expect(issues).toEqual([
      "type「STRING」归一化为小写 string",
      'type「"str"」不在官方枚举集，兜底为 string',
    ]);
  });

  it("约束键标量类型校验分域：pattern 非字符串、int64 四键非整数（含小数）、minimum/maximum 非有限数值删除并上报（轮 15 #13 + 轮 21 #12；文案含负值维度，轮 37 #13）", () => {
    const issues: string[] = [];
    expect(
      sanitizeGeminiSchema(
        {
          pattern: 123,
          minLength: true,
          minimum: "5",
          minItems: Number.NaN,
          maxLength: 2.5, // 小数：proto3 int64 解析失败同为 400
        },
        (d) => issues.push(d),
      ),
    ).toEqual({ type: "string" }); // 约束键删空后补注入缺省 type（轮 19 #1）
    expect(issues).toEqual([
      "约束键「pattern」非字符串，删除该键：123",
      "约束键「minlength」非整数或为负值，删除该键：true",
      '约束键「minimum」非有限数值，删除该键："5"',
      "约束键「minitems」非整数或为负值，删除该键：NaN",
      "约束键「maxlength」非整数或为负值，删除该键：2.5",
      "节点缺 type，补注入缺省 string",
    ]);
  });

  it("长度约束负值删除并上报（轮 37 #13：int64 四键官方语义非负，负值同为 400）；0 合法保留；minimum 负值语义合法不收口", () => {
    const issues: string[] = [];
    expect(sanitizeGeminiSchema({ maxLength: -1, minItems: -2 }, (d) => issues.push(d))).toEqual({
      type: "string",
    });
    expect(issues).toEqual([
      "约束键「maxlength」非整数或为负值，删除该键：-1",
      "约束键「minitems」非整数或为负值，删除该键：-2",
      "节点缺 type，补注入缺省 string",
    ]);
    expect(sanitizeGeminiSchema({ type: "array", minItems: 0, maxItems: 0 })).toEqual({
      type: "array",
      minItems: 0,
      maxItems: 0,
    });
    // minimum/maximum 为 double 且负值语义合法（如 minimum: -10），维持有限数值校验
    expect(sanitizeGeminiSchema({ type: "number", minimum: -10, maximum: -1 })).toEqual({
      type: "number",
      minimum: -10,
      maximum: -1,
    });
  });

  it("propertyOrdering 白名单收录 + camelCase 发射（轮 38 #10）：string[] 保留；非 string[] 删除上报；string 节点域外剥离", () => {
    const issues: string[] = [];
    expect(
      sanitizeGeminiSchema(
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          propertyOrdering: ["b", "a"],
        },
        (d) => issues.push(d),
      ),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      propertyOrdering: ["b", "a"],
    });
    expect(issues).toEqual([]);
    expect(
      sanitizeGeminiSchema({ type: "object", propertyOrdering: 5 }, (d) => issues.push(d)),
    ).toEqual({ type: "object" });
    expect(issues).toEqual(["propertyOrdering 非 string[]，删除该键"]);
    // 域外（string 节点）经 CONSTRAINT_KEYS_BY_TYPE 收尾剥离并上报
    expect(
      sanitizeGeminiSchema({ type: "string", propertyOrdering: ["a"] }, (d) => issues.push(d)),
    ).toEqual({ type: "string" });
    expect(issues[1]).toBe("键「propertyOrdering」不在 type=string 的官方支持域，删除该键");
  });

  it("format 值小写归一（轮 38 #10，与 type 归一同口径）：DATE-TIME → date-time 保留并上报归一；归一后仍未命中删除", () => {
    const issues: string[] = [];
    expect(
      sanitizeGeminiSchema({ type: "string", format: "DATE-TIME" }, (d) => issues.push(d)),
    ).toEqual({ type: "string", format: "date-time" });
    expect(issues).toEqual(["format「DATE-TIME」归一化为小写 date-time"]);
    expect(sanitizeGeminiSchema({ type: "string", format: "URI" }, (d) => issues.push(d))).toEqual({
      type: "string",
    });
    expect(issues[1]).toBe('format「"URI"」不在官方支持集，删除该键');
  });

  it("pattern 可编译性校验：编译失败的正则删除并上报，可编译的保留（轮 24 #5）", () => {
    const issues: string[] = [];
    expect(sanitizeGeminiSchema({ pattern: "[", description: "d" }, (d) => issues.push(d))).toEqual(
      { description: "d", type: "string" },
    );
    expect(issues).toEqual([
      '约束键「pattern」非可编译正则，删除该键："["',
      "节点缺 type，补注入缺省 string",
    ]);
    expect(sanitizeGeminiSchema({ type: "string", pattern: "^a+b?$" })).toEqual({
      type: "string",
      pattern: "^a+b?$",
    });
  });

  it("大小写归一撞键（MaxLength 与 maxlength 并存）→ 后写者覆盖但留证据（轮 30 #1）", () => {
    const issues: string[] = [];
    const out = sanitizeGeminiSchema({ maxLength: 5, MaxLength: 9 }, (d) => issues.push(d));
    expect(out).toEqual({ maxLength: 9, type: "string" }); // 插入序后写者覆盖
    expect(issues).toContain('键「"MaxLength"」与已写入键归一后均为「maxLength」，后者覆盖前者');
  });

  it("properties/items 分支的归一撞键同样上报（轮 31 #3——子树整棵静默丢失比标量更严重）", () => {
    const issues: string[] = [];
    const out = sanitizeGeminiSchema(
      { properties: { a: { type: "string" } }, Properties: { b: { type: "number" } } },
      (d) => issues.push(d),
    );
    expect(out).toEqual({ properties: { b: { type: "number" } }, type: "object" }); // 后写者覆盖
    expect(issues).toContain('键「"Properties"」与已写入键归一后均为「properties」，后者覆盖前者');
    const itemsIssues: string[] = [];
    const itemsOut = sanitizeGeminiSchema(
      { items: { type: "string" }, Items: { type: "number" } },
      (d) => itemsIssues.push(d),
    );
    expect(itemsOut).toEqual({ items: { type: "number" }, type: "array" });
    expect(itemsIssues).toContain('键「"Items"」与已写入键归一后均为「items」，后者覆盖前者');
  });

  it("单值 type:'null' 与数组含非字符串病态元素 → 同一兜底路径收口（'null' 不在 Gemini 枚举内）", () => {
    expect(sanitizeGeminiSchema({ type: "null" })).toEqual({ type: "string", nullable: true });
    expect(sanitizeGeminiSchema({ type: ["null", 5] })).toEqual({ type: "string", nullable: true });
    expect(sanitizeGeminiSchema({ type: [5, "object", "null"] })).toEqual({
      type: "object",
      nullable: true,
    });
  });

  it("type 全 null/病态元素兜底为 string → 上报清洗事件（兜底同样是约束丢失，轮 16 #10）", () => {
    const issues: string[] = [];
    expect(sanitizeGeminiSchema({ type: ["null", 5] }, (d) => issues.push(d))).toEqual({
      type: "string",
      nullable: true,
    });
    // 无 'null' 成员的纯病态数组：连 nullable 都不产出
    expect(sanitizeGeminiSchema({ type: [null, 42] }, (d) => issues.push(d))).toEqual({
      type: "string",
    });
    expect(issues).toEqual([
      "type 全 null/病态元素，兜底为 string",
      "type 全 null/病态元素，兜底为 string",
    ]);
  });

  it("联合 type 成员复用标量枚举口径：PascalCase 归一、非法成员跳过取首个合法成员（轮 17 #13 + 轮 18 #1 兜底统一）", () => {
    const issues: string[] = [];
    expect(sanitizeGeminiSchema({ type: ["STRING", "null"] }, (d) => issues.push(d))).toEqual({
      type: "string",
      nullable: true,
    });
    // 非法成员跳过、首个合法成员胜出（比盲目兜底 string 保真）；skip 与窄化
    // 两条独立证据各归各位
    expect(sanitizeGeminiSchema({ type: ["str", "object"] }, (d) => issues.push(d))).toEqual({
      type: "object",
    });
    expect(issues).toEqual([
      "type「STRING」归一化为小写 string",
      "type 成员「str」不在官方枚举集，跳过",
      "type 联合窄化 str|object → object",
    ]);
  });

  it("format 按 type 分域收尾校验：值在全集但 type 域外删除并上报，域内组合保留（轮 18 #8）", () => {
    const issues: string[] = [];
    expect(
      sanitizeGeminiSchema({ type: "number", format: "date-time" }, (d) => issues.push(d)),
    ).toEqual({ type: "number" });
    expect(
      sanitizeGeminiSchema({ type: "string", format: "int64" }, (d) => issues.push(d)),
    ).toEqual({ type: "string" });
    // boolean/array/object 无任何合法 format（分域表缺项 = 全部删除）
    expect(
      sanitizeGeminiSchema({ type: "boolean", format: "enum" }, (d) => issues.push(d)),
    ).toEqual({ type: "boolean" });
    // 域内组合保留：string+date-time、integer+int64
    expect(sanitizeGeminiSchema({ type: "string", format: "date-time" })).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(sanitizeGeminiSchema({ type: "integer", format: "int64" })).toEqual({
      type: "integer",
      format: "int64",
    });
    expect(issues).toEqual([
      "format「date-time」不在 type=number 的官方支持集，删除该键",
      "format「int64」不在 type=string 的官方支持集，删除该键",
      "format「enum」不在 type=boolean 的官方支持集，删除该键",
    ]);
  });

  it("description 非字符串删除并上报（白名单标量键值形态校验的最后一块，轮 18 #6）", () => {
    const issues: string[] = [];
    expect(
      sanitizeGeminiSchema({ type: "string", description: 123 }, (d) => issues.push(d)),
    ).toEqual({ type: "string" });
    expect(issues).toEqual(["description 非字符串，删除该键：123"]);
  });

  it("非对象子 schema（含 draft-06+ 布尔 schema）归一空 schema 并补缺省 type、required 非 string[] 删除——原样透传会被端点 400；原始 schema 不被改动", () => {
    const original = { type: "object", properties: { n: 3, s: "x", ok: true }, required: null };
    const snapshot = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    const issues: string[] = [];
    expect(sanitizeGeminiSchema(original, (d) => issues.push(d))).toEqual({
      type: "object",
      // 归一节点带显式 type（轮 19 #1：端点要求节点显式 type，空 schema 同为 400 形态）
      properties: { n: { type: "string" }, s: { type: "string" }, ok: { type: "string" } },
      // required: null 已被删除（官方只收 string[]）
    });
    expect(original).toEqual(snapshot);
    expect(issues).toEqual([
      "属性「n」子 schema 非对象，归一为空 schema",
      "属性「s」子 schema 非对象，归一为空 schema",
      "属性「ok」子 schema 非对象，归一为空 schema",
      "required 非 string[]，删除该键",
    ]);
  });

  it("type 联合多成员窄化 + items 元组/非对象收口 → 上报清洗事件（与删键同观测口径；窄化到 string 后 items 域外剥离，轮 32 #12）", () => {
    const issues: string[] = [];
    const out = sanitizeGeminiSchema(
      {
        type: ["string", "number"],
        items: [{ type: "string" }, { type: "number" }],
      },
      (d) => issues.push(d),
    );
    expect(out).toEqual({ type: "string" }); // items 仅 ARRAY 域，string 节点剥离
    const nonRecordItems = sanitizeGeminiSchema({ items: "x" }, (d) => issues.push(d));
    expect(nonRecordItems).toEqual({ type: "array", items: { type: "string" } });
    expect(issues).toEqual([
      "type 联合窄化 string|number → string",
      "items 元组形态窄化为首元素",
      "键「items」不在 type=string 的官方支持域，删除该键",
      "items 非对象形态归一为空 schema",
      "节点缺 type，按 items 推断注入 array", // { items: "x" } 自身也无 type（轮 20 #1）
    ]);
  });

  it("items 空元组单独分档：无首元素可窄化，文案与实际行为一致（轮 34 #5）", () => {
    const issues: string[] = [];
    // items:[] 语义是「数组须为空」（JSON Schema 合法形态），约束丢失须准确上报
    const out = sanitizeGeminiSchema({ type: "array", items: [] }, (d) => issues.push(d));
    expect(out).toEqual({ type: "array", items: { type: "string" } });
    expect(issues).toEqual(["items 空元组，归一为空 schema（空数组约束丢失）"]);
  });

  it("缺 type 按结构线索推断：properties→object、items→array、无线索→string（轮 20 #1）", () => {
    const issues: string[] = [];
    expect(
      sanitizeGeminiSchema({ properties: { a: { type: "string" } }, required: ["a"] }, (d) =>
        issues.push(d),
      ),
    ).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
    expect(sanitizeGeminiSchema({ items: { type: "number" } }, (d) => issues.push(d))).toEqual({
      type: "array",
      items: { type: "number" },
    });
    expect(issues).toEqual([
      "节点缺 type，按 properties 推断注入 object",
      "节点缺 type，按 items 推断注入 array",
    ]);
  });

  it("属性名 __proto__ 不触发原型 setter（null 原型容器，子 schema 不静默丢失，轮 22 #5）", () => {
    // defineProperty 构造自有 __proto__ 属性：字面量简写形式会设置原型、计算键
    // 与字符串成员访问会被 biome useLiteralKeys 误报（P1.2 轮 3 同款坑）
    const input: Record<string, unknown> = { type: "object" };
    const props: Record<string, unknown> = {};
    Object.defineProperty(props, "__proto__", {
      value: { type: "string" },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    input.properties = props;
    const out = sanitizeGeminiSchema(input);
    const outProps = out.properties as Record<string, unknown>;
    expect(Object.keys(outProps)).toContain("__proto__");
    expect(Object.getOwnPropertyDescriptor(outProps, "__proto__")?.value).toEqual({
      type: "string",
    });
  });

  it("标量键值形态闭环：properties 非对象/type 标量/enum 非 string[]/nullable 非布尔 → 删除或兜底并上报", () => {
    const issues: string[] = [];
    const out = sanitizeGeminiSchema(
      {
        type: "object",
        properties: "foo",
        enum: "bar",
        nullable: "yes",
      },
      (d) => issues.push(d),
    );
    expect(out).toEqual({ type: "object" });
    expect(sanitizeGeminiSchema({ type: 5 }, (d) => issues.push(d))).toEqual({
      type: "string",
    });
    expect(issues).toEqual([
      "properties 非对象，删除该键",
      "enum 非 string[]，删除该键",
      "nullable 非布尔，删除该键",
      "type 非字符串形态兜底为 string：5",
    ]);
  });

  it("onSchemaIssue：删键时按归一化键名上报（顶层与嵌套递归），约束键不报（嵌套域外约束键自轮 32 #12 起上报剥离）", () => {
    const issues: string[] = [];
    const out = sanitizeGeminiSchema(
      {
        type: "object",
        $schema: "x",
        ExclusiveMinimum: 1,
        properties: { inner: { examples: [1], type: "string", minimum: 0 } },
      },
      (d) => issues.push(d),
    );
    expect(out).toEqual({
      type: "object",
      properties: { inner: { type: "string" } }, // minimum 仅 NUMBER/INTEGER 域
    });
    expect(issues).toEqual([
      "删除白名单外键「$schema」",
      "删除白名单外键「exclusiveminimum」",
      "删除白名单外键「examples」",
      "键「minimum」不在 type=string 的官方支持域，删除该键",
    ]);
  });
});

describe("请求构造（canonical → wire）", () => {
  it("全量映射：x-goog-api-key 头、systemInstruction、user/model 角色、inlineData、functionCall 同 turn、toolResult 折叠一条 user turn、forced=ANY", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: "You are an agent.",
      messages: [
        {
          role: "user",
          blocks: [
            { kind: "text", text: "look" },
            { kind: "image", mimeType: "image/png", base64: "AAAA" },
          ],
        },
        {
          role: "assistant",
          blocks: [{ kind: "text", text: "ok" }],
          toolCalls: [
            { id: "t1", name: "agent_response", args: { action: "click" } },
            { id: "t2", name: "agent_response", args: { action: "type" } },
          ],
        },
        // 乱序到达：t2 在前——按前置 assistant.toolCalls 顺序重排
        { role: "toolResult", toolCallId: "t2", toolName: "agent_response", text: "done2" },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "agent_response",
          text: "failed",
          isError: true,
        },
        { role: "user", blocks: [{ kind: "text", text: "next" }] },
      ],
      tools: [TOOL],
      toolChoice: { kind: "forced", name: "agent_response" },
    });

    expect(mock.calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    expect(mock.calls[0].init.headers).toEqual({
      "content-type": "application/json",
      "x-goog-api-key": "g-key",
    });
    expect(mock.lastBody()).toEqual({
      systemInstruction: { parts: [{ text: "You are an agent." }] },
      contents: [
        {
          role: "user",
          parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }],
        },
        {
          role: "model",
          parts: [
            { text: "ok" },
            { functionCall: { name: "agent_response", args: { action: "click" } } },
            { functionCall: { name: "agent_response", args: { action: "type" } } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: { name: "agent_response", response: { result: "[error] failed" } },
            },
            { functionResponse: { name: "agent_response", response: { result: "done2" } } },
            // 连续同角色折叠：toolResult 折叠出的 user turn 与紧随的 user 观察合并
            //（Gemini 要求 user/model 交替，400 地雷）
            { text: "next" },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            { name: "agent_response", description: "respond", parameters: SANITIZED },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["agent_response"] },
      },
      generationConfig: { maxOutputTokens: 8192 },
    });
    expect(mock.lastBody().generationConfig).not.toHaveProperty("temperature");
  });

  it("纯工具调用 model turn（无文本 part）；auto 不发 toolConfig；tools null 不发 tools", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        {
          role: "assistant",
          blocks: [],
          toolCalls: [{ id: "t1", name: "agent_response", args: { a: 1 } }],
        },
        { role: "toolResult", toolCallId: "t1", toolName: "agent_response", text: "r" },
      ],
      tools: [TOOL],
    });
    const contents = mock.lastBody().contents as Array<Record<string, unknown>>;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "agent_response", args: { a: 1 } } }],
    });
    expect(mock.lastBody()).not.toHaveProperty("toolConfig");
    expect(mock.lastBody()).not.toHaveProperty("systemInstruction");

    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.lastBody()).not.toHaveProperty("tools");
    expect(mock.lastBody()).not.toHaveProperty("toolConfig");
  });

  it("tools null + forced toolChoice → 不发孤立 toolConfig（ChatRequest 契约，三协议一致）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      toolChoice: { kind: "forced", name: "agent_response" },
    });
    expect(mock.lastBody()).not.toHaveProperty("tools");
    expect(mock.lastBody()).not.toHaveProperty("toolConfig");
  });

  it("tools 空数组 → 不发 tools/toolConfig（空 functionDeclarations 是端点 400 形态；forced 一并抑制）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [],
      toolChoice: { kind: "forced", name: "agent_response" },
    });
    expect(mock.lastBody()).not.toHaveProperty("tools");
    expect(mock.lastBody()).not.toHaveProperty("toolConfig");
  });

  it("无参工具顶层 parameters {} → 归一 type:object（命名参数集语义，留清洗证据，轮 22 #7）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [{ name: "no_args", description: "d", parameters: {} }],
    });
    const tools = mock.lastBody().tools as Array<Record<string, unknown>>;
    const decls = tools[0].functionDeclarations as Array<Record<string, unknown>>;
    expect(decls[0].parameters).toEqual({ type: "object" }); // 非 type:string
    expect(logs.some((m) => m.includes("顶层 parameters") && m.includes("归一为 object"))).toBe(
      true,
    );
  });

  it("顶层 parameters 非 object 归一时剥离 type 域外键（items/enum/format/约束键残留即 400 形态，轮 25 #7 + 轮 26 #5）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [
        {
          name: "arr_tool",
          description: "d",
          // 原 type:array/string 带 items/enum/format/约束键是合法 schema——强制
          // 归一为 object 后全部残留即 400 形态（与 FORMATS_BY_TYPE 分域同口径）
          parameters: {
            type: "array",
            items: {
              type: "string",
              enum: ["a"],
              format: "date-time",
              pattern: "^a",
              minLength: 1,
              maxLength: 5,
              minItems: 1,
              maxItems: 9,
              minimum: 0,
              maximum: 10,
            },
          },
        },
      ],
    });
    const tools = mock.lastBody().tools as Array<Record<string, unknown>>;
    const decls = tools[0].functionDeclarations as Array<Record<string, unknown>>;
    expect(decls[0].parameters).toEqual({ type: "object" }); // 顶层只剩归一后的 object
  });

  it("schema 清洗事件告警在 provider 实例级去重（同 schema 逐请求固定，重复只有噪音）", async () => {
    const { mock, logs, provider } = setupLogs();
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [TOOL],
    };
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    await provider.chat(req);
    await provider.chat(req);
    // 契约：删键事件按首现序各告警一次、键名以归一化（小写）口径上报。
    // 注：关键词「白名单外键」与「」引号包裹格式是本断言契约的一部分（并非完全
    // 文案解耦）——措辞的其余部分可自由调整：
    // $schema（顶层）、additionalproperties（顶层+嵌套 action 同名）
    const droppedKeys = logs
      .filter((m) => m.includes("白名单外键"))
      .map((m) => m.match(/「([^」]+)」/)?.[1] ?? "");
    expect(droppedKeys).toEqual(["$schema", "additionalproperties"]);
  });

  it(`去重集条数上限（SCHEMA_ISSUE_DEDUP_MAX=${SCHEMA_ISSUE_DEDUP_MAX}）：动态 schema 的无界增长封顶——上限后新事件静默`, async () => {
    const { mock, logs, provider } = setupLogs();
    // 上限 + 2 个唯一属性名（各产生一条唯一清洗事件）→ 仅前 SCHEMA_ISSUE_DEDUP_MAX 条告警
    const dynamicProps: Record<string, unknown> = {};
    for (let i = 0; i < SCHEMA_ISSUE_DEDUP_MAX + 2; i += 1) {
      dynamicProps[`p${i}`] = i; // 非对象子 schema → 每属性一条唯一事件
    }
    const tool = { ...TOOL, parameters: { type: "object", properties: dynamicProps } };
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: [tool],
    });
    // 只计 schema 清洗事件（与姊妹用例的过滤口径对齐）：适配器未来新增的无关
    // 日志不应误红本断言
    expect(logs.filter((m) => m.includes("schema 清洗")).length).toBe(SCHEMA_ISSUE_DEDUP_MAX);
    // 达限一次性提示（轮 31 #5）：运维需知道「事件已停止上报」这一事实本身；
    // 文案避开「schema 清洗」关键词不进上方计数，且只发一次
    expect(logs.filter((m) => m.includes("告警去重集已达")).length).toBe(1);
  });

  it("maxTokens 请求级覆盖与 temperature 显式", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      maxTokens: 77,
      temperature: 0.5,
    });
    expect(mock.lastBody().generationConfig).toEqual({ maxOutputTokens: 77, temperature: 0.5 });
  });

  it("maxTokens 非法回退 DEFAULT_MAX_TOKENS 并留一次性告警（轮 40 #2 补齐接线锚定：接线是独立实现，漏传/内联替代后 NaN 序列化 null 直达端点 400 且无红测；轮 41 #6 双请求都断言——仅锁 lastBody 会漏首请求路径回归）", async () => {
    const { mock, logs, provider } = setupLogs({ maxTokens: Number.NaN });
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    };
    await provider.chat(req);
    await provider.chat(req);
    const genConfig = (i: number) => mock.bodyAt(i).generationConfig as Record<string, unknown>;
    expect(genConfig(0).maxOutputTokens).toBe(DEFAULT_MAX_TOKENS); // NaN 序列化 null 是端点硬 400
    expect(genConfig(1).maxOutputTokens).toBe(DEFAULT_MAX_TOKENS);
    const warnings = logs.filter((m) => m.includes("maxTokens"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("gemini-card");
  });

  it("temperature 回退链：请求级缺省用卡片级；两级缺省不发", async () => {
    const { mock, provider } = setup({ temperature: 0.3 });
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    const genConfig = () => mock.lastBody().generationConfig as Record<string, unknown>;
    expect(genConfig().temperature).toBe(0.3);
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      temperature: 0.8,
    });
    expect(genConfig().temperature).toBe(0.8);
    const noCard = setup();
    noCard.mock.queueMany(fnCallOk({}));
    await noCard.provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(noCard.mock.lastBody().generationConfig).not.toHaveProperty("temperature");
  });

  it("temperature 按协议上限钳制（gemini 0-2）：误配 3 钳到 2（轮 12 #7）", async () => {
    const { mock, provider } = setup({ temperature: 3 });
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect((mock.lastBody().generationConfig as Record<string, unknown>).temperature).toBe(2);
  });

  it("temperature 钳制告警接线锚定（轮 40 #12：onTemperatureClamp 是可选参数，漏传时钳制照常本用例仍绿、告警静默丢失）", async () => {
    const { mock, logs, provider } = setupLogs({ temperature: 3 });
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    };
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    await provider.chat(req);
    await provider.chat(req);
    const warnings = logs.filter((m) => m.includes("钳制"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("gemini-card"); // 卡片归因
  });

  it("timeoutMs 非法 → 视为未设置 + 实例级一次性告警（轮 37 #7 三适配器接线锚定，轮 38 #13 对齐 openai 侧：接线是独立实现，漏传无红测可拦）", async () => {
    const { mock, provider, logs } = setupLogs();
    const badReq = (): ChatRequest => ({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
      timeoutMs: 0,
    });
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    await provider.chat(badReq());
    await provider.chat(badReq());
    expect(logs.filter((m) => m.includes("timeoutMs 0 非法"))).toHaveLength(1);
    // 两次请求都正常完成（非法值不制造每请求超时）
    expect(mock.calls).toHaveLength(2);
  });

  it("空串 systemPrompt 与 null 同等不发（空 text part 是 400 形态，轮 20 #13）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: "",
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.lastBody()).not.toHaveProperty("systemInstruction");
  });

  it("model turn 的 inlineData 丢弃的 wire 形态 + 一次性告警接线锚定（轮 41 #8 补齐 gemini 侧——此前标题声称「已锁定」实无测试；重放两次仍只告警一次；多模态仅 user 角色合法，官方端点 400 形态，轮 13 #14）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        {
          role: "assistant",
          blocks: [{ kind: "image", mimeType: "image/png", base64: "AAAA" }],
          toolCalls: [{ id: "t1", name: "agent_response", args: {} }],
        },
        { role: "toolResult", toolCallId: "t1", toolName: "agent_response", text: "ok" },
      ],
      tools: [TOOL],
    };
    await provider.chat(req);
    const contents = mock.lastBody().contents as Array<Record<string, unknown>>;
    expect(JSON.stringify(contents)).not.toContain("inlineData");
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "agent_response", args: {} } }],
    });
    await provider.chat(req); // 重放：仍只告警一次（warnDroppedAssistantNonTextBlocks 接线锚定）
    expect(
      logs.filter((m) =>
        m.includes(
          "gemini(gemini-card) assistant 历史非 text 块（image 及未来新 kind）无 wire 形态，丢弃 1 块",
        ),
      ),
    ).toHaveLength(1);
  });

  it("image-only 且无 toolCalls 的 assistant → 过滤后空 parts 以 [image omitted] 占位（空 parts 是 INVALID_ARGUMENT，轮 14 #9）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        { role: "assistant", blocks: [{ kind: "image", mimeType: "image/png", base64: "AAAA" }] },
        { role: "user", blocks: [{ kind: "text", text: "next" }] },
      ],
      tools: [TOOL],
    });
    const contents = mock.lastBody().contents as Array<Record<string, unknown>>;
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "[image omitted]" }] });
  });

  it("连续 user turn 折叠（canonical 允许 [user, user]，Gemini 要求交替）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "first" }] },
        { role: "user", blocks: [{ kind: "text", text: "second" }] },
      ],
      tools: [TOOL],
    });
    expect(mock.lastBody().contents).toEqual([
      { role: "user", parts: [{ text: "first" }, { text: "second" }] },
    ]);
  });

  it("model 路径段编码：异常字符不截断 URL（配置问题不变形为 Invalid URL/404）", async () => {
    const { mock, provider } = setup({ model: "gemini 2.5#x" });
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini%202.5%23x:generateContent",
    );
  });

  it("image 块 mimeType 别名归一：image/jpg → image/jpeg（normalizeImageMime 单源，轮 28 #3）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [
        {
          role: "user",
          blocks: [
            { kind: "text", text: "look" },
            { kind: "image", mimeType: "image/jpg", base64: "AAAA" },
          ],
        },
      ],
      tools: null,
    });
    const contents = mock.lastBody().contents as Array<Record<string, unknown>>;
    const parts = contents[0].parts as Array<Record<string, unknown>>;
    expect((parts[1].inlineData as Record<string, unknown>).mimeType).toBe("image/jpeg");
  });

  it("枚举外 mime（gif 在 gemini 官方集合外）→ 降级占位留证据、图片不出站（轮 36 #2）", async () => {
    const unsupported = setupLogs();
    unsupported.mock.queueMany(fnCallOk({}));
    await unsupported.provider.chat({
      systemPrompt: null,
      messages: [
        {
          role: "user",
          blocks: [
            { kind: "text", text: "look" },
            { kind: "image", mimeType: "image/gif", base64: "AAAA" },
          ],
        },
      ],
      tools: null,
    });
    const wire = JSON.stringify(unsupported.mock.lastBody().contents);
    expect(wire).not.toContain("inlineData");
    expect(wire).toContain("[image omitted]");
    expect(unsupported.logs.some((m) => m.includes("不在官方枚举") && m.includes("gif"))).toBe(
      true,
    );
  });

  it("extraHeaders 最后合并（可覆盖 x-goog-api-key）——三处独立实现的接线锚定（轮 30 #8，对齐 anthropic 侧）", async () => {
    const { mock, provider } = setup({
      extraHeaders: { "x-goog-api-key": "override", "x-custom": "1" },
    });
    mock.queueMany(fnCallOk({}));
    await provider.chat({
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    });
    expect(mock.calls[0].init.headers).toEqual({
      "content-type": "application/json",
      "x-goog-api-key": "override",
      "x-custom": "1",
    });
  });

  it("baseUrl 整段误配官方端点（含 /v1beta）→ 如实拼接 + 一次性告警（轮 24 #4，与 anthropic /v1 同族）", async () => {
    // 官方文档 URL 本身以 /v1beta 结尾，整段复制进卡片会拼出 /v1beta/v1beta → 404
    const misconfigured = setupLogs({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    misconfigured.mock.queueMany(fnCallOk({}), fnCallOk({}));
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    };
    await misconfigured.provider.chat(req);
    await misconfigured.provider.chat(req);
    expect(misconfigured.mock.calls[0].url).toContain("/v1beta/v1beta/models/"); // 误配形态如实拼接
    expect(misconfigured.logs.filter((m) => m.includes("疑似官方端点整段误配"))).toHaveLength(1);
    // 无误配的缺省卡片不受影响：不告警（须真正走一请求采集日志——不 chat 时
    // logs 恒空、断言恒绿，防不住「告警条件被误删/改为无条件」回归，轮 25 #1）
    await expect(
      logCountAfterChat(setupLogs(), fnCallOk({}), req, "疑似官方端点整段误配"),
    ).resolves.toBe(0);
  });

  it("baseUrl 以 /v1 结尾（OpenAI 形态跨协议复用）或 :generateContent 结尾（整段端点复制）→ 各自一次性告警（轮 34 #6/#10）", async () => {
    const req: ChatRequest = {
      systemPrompt: null,
      messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
      tools: null,
    };
    const openaiForm = setupLogs({ baseUrl: "https://api.example.com/v1" });
    openaiForm.mock.queueMany(fnCallOk({}), fnCallOk({}));
    await openaiForm.provider.chat(req);
    await openaiForm.provider.chat(req);
    expect(openaiForm.mock.calls[0].url).toContain("/v1/v1beta/models/");
    expect(openaiForm.logs.filter((m) => m.includes("疑似 OpenAI 形态误配"))).toHaveLength(1);

    const endpointForm = setupLogs({
      baseUrl:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    });
    endpointForm.mock.queueMany(fnCallOk({}), fnCallOk({}));
    await endpointForm.provider.chat(req);
    await endpointForm.provider.chat(req);
    expect(endpointForm.mock.calls[0].url).toContain(":generateContent/v1beta/models/");
    expect(endpointForm.logs.filter((m) => m.includes("疑似整段端点 URL 误配"))).toHaveLength(1);
    // 阴性对照（轮 35 #3，与 /v1beta 用例轮 25 #1 口径一致）：两条守卫各自
    // 无误配时不告警
    const plain = setupLogs();
    // 双关键词阴性对照（轮 43 #3 收敛为 helper 后仍是两次独立断言）
    await expect(logCountAfterChat(plain, fnCallOk({}), req, "疑似 OpenAI 形态误配")).resolves.toBe(
      0,
    );
    await expect(
      logCountAfterChat(plain, fnCallOk({}), req, "疑似整段端点 URL 误配"),
    ).resolves.toBe(0);
  });

  it("forced toolChoice 名不在 tools → 前置拦截不出站（端点 400 形态，轮 35 #13）", async () => {
    const { mock, provider } = setup();
    await expect(
      provider.chat({
        systemPrompt: null,
        messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
        tools: [TOOL],
        toolChoice: { kind: "forced", name: "nonexistent" },
      }),
    ).rejects.toThrow(LLMProtocolViolationError);
    expect(mock.calls.length).toBe(0);
  });
});

describe("响应解析（wire → canonical）", () => {
  const baseReq = (): ChatRequest => ({
    systemPrompt: null,
    messages: [{ role: "user", blocks: [{ kind: "text", text: "q" }] }],
    tools: [TOOL],
  });
  it("usageMetadata 存在但非对象（网关畸形）→ 留证据归 null（轮 42 #20，与 candidates 域口径对齐）；缺失不告警", async () => {
    const { mock, provider, logs } = setupLogs();
    const resp = (usageMetadata: unknown) => ({
      status: 200,
      body: {
        candidates: [{ content: { role: "model", parts: [{ text: "t" }] }, finishReason: "STOP" }],
        usageMetadata,
      },
    });
    mock.queueMany(
      resp([1]),
      resp(undefined),
      resp({ promptTokenCount: 1, candidatesTokenCount: 2 }),
    );
    const r1 = await provider.chat(baseReq());
    expect(r1.usage).toBeNull();
    await provider.chat(baseReq());
    const r3 = await provider.chat(baseReq());
    expect(r3.usage?.outputTokens).toBe(2);
    expect(logs.some((m) => m.includes("gemini 丢弃形态异常的 usageMetadata（非对象）：[1]"))).toBe(
      true,
    );
    expect(logs.filter((m) => m.includes("丢弃形态异常的 usageMetadata"))).toHaveLength(1);
  });

  it("未知 finishReason（网关私货）→ other 且留证据；SAFETY/RECITATION 是 deliberate 设计不告警（轮 39 #9）", async () => {
    const resp = (finishReason: string) => ({
      status: 200,
      body: {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "t" }] },
            finishReason,
          },
        ],
        usageMetadata: null,
      },
    });
    const { mock, provider, logs } = setupLogs();
    // RECITATION 同为 deliberate 档（轮 42 #9）：误入未知告警档时下方计数变 2——
    // 此前只行使 SAFETY，mapFinishReason 误删该条件无红测
    mock.queueMany(resp("WEIRD_FINISH"), resp("SAFETY"), resp("RECITATION"));
    const r1 = await provider.chat(baseReq());
    expect(r1.stopReason).toBe("other");
    const r2 = await provider.chat(baseReq());
    expect(r2.stopReason).toBe("other"); // SAFETY → other（deliberate 档）
    const r3 = await provider.chat(baseReq());
    expect(r3.stopReason).toBe("other"); // RECITATION → other（轮 43 #12：it.each 矩阵未覆盖该成员）
    expect(
      logs.some((m) => m.includes('gemini 未知 finishReason 映射为 other："WEIRD_FINISH"')),
    ).toBe(true);
    expect(logs.filter((m) => m.includes("未知 finishReason"))).toHaveLength(1);
  });

  it("thought part 分流进 reasoningText；functionCall 合成 id；非请求名过滤；parts 推导 stopReason 优先", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "hmm", thought: true },
                { text: "answer" },
                { functionCall: { name: "agent_response", args: { a: 1 } } },
                { functionCall: { name: "agent_response", args: { b: 2 } } },
                { functionCall: { name: "other", args: {} } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, cachedContentTokenCount: 3 },
      },
    });
    const res = await provider.chat(baseReq());
    expect(res).toEqual({
      text: "answer",
      reasoningText: "hmm",
      toolCalls: [
        {
          id: expect.stringMatching(/^gemini-call-[a-z0-9]{6}-0$/),
          name: "agent_response",
          args: { a: 1 },
        },
        {
          id: expect.stringMatching(/^gemini-call-[a-z0-9]{6}-1$/),
          name: "agent_response",
          args: { b: 2 },
        },
      ],
      stopReason: "tool_call",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
    });
  });

  it("text 与 functionCall 并存的畸形 part → 两者都处理（转换型网关形态，轮 28 #4：旧 continue 静默丢弃并存调用）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              // 官方 proto oneof 互斥、端点不可达——转换型网关可能产出此形态
              parts: [{ text: "prefix", functionCall: { name: "agent_response", args: {} } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.text).toBe("prefix");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("agent_response");
  });

  it("text 存在但非 string 的畸形 part → 丢弃留证据；undefined 不告警（轮 29 #2）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              // text:123 是网关畸形形态；functionCall part 无 text 域是正常形态
              parts: [{ text: 123 }, { functionCall: { name: "agent_response", args: {} } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.text).toBe(""); // 畸形 text 不进拼接
    expect(res.toolCalls).toHaveLength(1); // 正常 functionCall 不受影响
    expect(logs.some((m) => m.includes("丢弃形态异常的 text part"))).toBe(true);
    // functionCall part 的 text 缺失（undefined）是正常形态，不产生告警
    expect(logs.filter((m) => m.includes("丢弃形态异常的 text part"))).toHaveLength(1);
  });

  it("顶层 candidates / promptFeedback「存在但形态异常」→ 归空留证据且拦截检测不误触（轮 32 #10/#11）", async () => {
    const candidatesForm = setupLogs();
    candidatesForm.mock.queueMany({
      status: 200,
      body: { candidates: "gateway junk", usageMetadata: { promptTokenCount: 1 } },
    });
    const r1 = await candidatesForm.provider.chat(baseReq());
    expect(r1.text).toBe("");
    expect(candidatesForm.logs.some((m) => m.includes("丢弃形态异常的顶层 candidates"))).toBe(true);

    // promptFeedback 非 record：blockReason 检测失效退化为空响应——留证据不抛 blocked
    const feedbackForm = setupLogs();
    feedbackForm.mock.queueMany({
      status: 200,
      body: {
        promptFeedback: "SAFETY",
        candidates: [],
        usageMetadata: { promptTokenCount: 1 },
      },
    });
    const r2 = await feedbackForm.provider.chat(baseReq());
    expect(r2.text).toBe("");
    expect(feedbackForm.logs.some((m) => m.includes("丢弃形态异常的 promptFeedback"))).toBe(true);

    // 嵌套三级（轮 33 #1）：candidate 非对象 / content 非对象 / parts 非数组——各自留证据
    for (const [label, first] of [
      ["candidate", "junk"],
      ["content", { content: "junk" }],
      ["parts", { content: { parts: "junk" } }],
    ] as const) {
      const nested = setupLogs();
      nested.mock.queueMany({
        status: 200,
        body: { candidates: [first], usageMetadata: { promptTokenCount: 1 } },
      });
      const r = await nested.provider.chat(baseReq());
      expect(r.text).toBe("");
      expect(nested.logs.some((m) => m.includes(`丢弃形态异常的 ${label}`))).toBe(true);
    }
  });

  it("非对象形态的 part（网关畸形，如字符串）→ 丢弃留证据（轮 30 #4）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: { role: "model", parts: ["str-part", { text: "ok" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.text).toBe("ok");
    expect(logs.some((m) => m.includes("丢弃非对象形态的 part"))).toBe(true);
  });

  it("无已知内容域的对象 part（inlineData 等官方类型/网关私货）→ 丢弃留键名证据（轮 31 #11）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            // 图像输出模型的响应 part 即 inlineData 形态——静默丢弃后只见空响应
            content: {
              role: "model",
              parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }, { text: "ok" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.text).toBe("ok");
    const dropped = logs.find((m) => m.includes("丢弃无已知内容域的 part"));
    expect(dropped).toContain("keys=inlineData"); // 键名证据而非整 part 串化（防 base64 刷屏）
  });

  it("丢弃类事件留告警 + 病态分支覆盖：非请求名 / name 非字符串 / functionCall 非对象 / args 非对象（轮 12 #12）", async () => {
    const { mock, logs, provider } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "other_tool", args: {} } }, // 非请求名
                { functionCall: { name: 42, args: {} } }, // name 非字符串
                { functionCall: "not-an-object" }, // functionCall 整体非对象
                { functionCall: { name: "agent_response", args: "bad" } }, // args 非对象
                { functionCall: { name: "agent_response", args: { ok: 1 } } }, // 合法保留
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([
      {
        id: expect.stringMatching(/^gemini-call-[a-z0-9]{6}-0$/),
        name: "agent_response",
        args: { ok: 1 },
      },
    ]);
    expect(logs.some((m) => m.includes("忽略非请求工具名") && m.includes("other_tool"))).toBe(true);
    // includes("42") 真正锚定 name 非字符串分档（轮 19 #5）：仅断言短语会被
    // functionCall 整体非对象分支（"not-an-object"）的同文案喂绿，畸形输出误
    // 路由进「忽略非请求工具名」档时本用例不再失明
    expect(logs.some((m) => m.includes("丢弃形态异常的 functionCall") && m.includes("42"))).toBe(
      true,
    );
    // 整体非对象分支独立锚定（轮 42 #17）：与 name 分支共享文案，else-if 被误删时
    // 该 part 落入「无已知内容域」档，仅靠上方的 42 断言测不出
    expect(
      logs.some((m) => m.includes("丢弃形态异常的 functionCall") && m.includes("not-an-object")),
    ).toBe(true);
    expect(logs.some((m) => m.includes("丢弃 args 非对象的 functionCall"))).toBe(true);
  });

  it("thoughtSignature 形态异常（非 string）→ 丢弃留证据（轮 39 #8：静默剥签名后下回合历史回传缺 signature 即 400，本地无线索）", async () => {
    const { mock, provider, logs } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: { name: "agent_response", args: { a: 1 } },
                  thoughtSignature: 42,
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: null,
      },
    });
    const r = await provider.chat(baseReq());
    expect(r.toolCalls[0]?.signature).toBeUndefined(); // 畸形签名不进 canonical
    expect(logs.some((m) => m.includes("丢弃形态异常的 thoughtSignature（非 string）：42"))).toBe(
      true,
    );
  });

  it("text part 携带的 thoughtSignature → 剥离留证据（轮 40 #14：canonical 仅 ToolCall 有签名槽位，thinking 模型会把签名同时挂在 text part 上）", async () => {
    const { mock, provider, logs } = setupLogs();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "reasoning...", thoughtSignature: "sig-text" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: null,
      },
    });
    const r = await provider.chat(baseReq());
    expect(r.text).toBe("reasoning..."); // 文本照常处理
    expect(r.toolCalls).toHaveLength(0); // 无 functionCall，签名无处安放
    expect(
      logs.some((m) =>
        m.includes(
          '丢弃非 functionCall part 携带的 thoughtSignature（thinking 模型常态形态，canonical 无槽位）："sig-text"',
        ),
      ),
    ).toBe(true);
  });

  it("thoughtSignature：解析捕获进 ToolCall.signature，回传时随 functionCall part 原样写回（2.5/3 thinking 模型硬要求，不回传即 400）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(
      {
        status: 200,
        body: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: { name: "agent_response", args: { a: 1 } },
                    thoughtSignature: "sig-1",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: null,
        },
      },
      fnCallOk({}),
    );
    const first = await provider.chat(baseReq());
    expect(first.toolCalls[0]?.id).toMatch(/^gemini-call-[a-z0-9]{6}-0$/);
    expect(first.toolCalls[0]?.signature).toBe("sig-1");
    await provider.chat({
      systemPrompt: null,
      messages: [
        { role: "user", blocks: [{ kind: "text", text: "q" }] },
        { role: "assistant", blocks: [], toolCalls: first.toolCalls },
        {
          role: "toolResult",
          toolCallId: first.toolCalls[0]!.id,
          toolName: "agent_response",
          text: "ok",
        },
      ],
      tools: [TOOL],
    });
    const contents = mock.lastBody().contents as Array<Record<string, unknown>>;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        { functionCall: { name: "agent_response", args: { a: 1 } }, thoughtSignature: "sig-1" },
      ],
    });
    // 双携带（轮 10 #9）：签名同时随下一回合的 functionResponse part 回传——官方
    // 两处口径并存（错误文案指 functionCall part、SDK 组装指 functionResponse），
    // 真机核验后收敛（README 风险 3）
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: { name: "agent_response", response: { result: "ok" } },
          thoughtSignature: "sig-1",
        },
      ],
    });
  });

  it("跨实例盐唯一（fallback 切换重建 provider 后 id 不复用，轮 15 #14）", async () => {
    const a = setup();
    a.mock.queueMany(fnCallOk({}));
    const b = setup();
    b.mock.queueMany(fnCallOk({}));
    const ra = await a.provider.chat(baseReq());
    const rb = await b.provider.chat(baseReq());
    expect(ra.toolCalls[0]?.id).not.toBe(rb.toolCalls[0]?.id); // 不同实例不同盐
  });

  it("合成 id 跨响应持续自增（宿主可能以 toolCallId 作跨回合键，不碰撞）", async () => {
    const { mock, provider } = setup();
    mock.queueMany(fnCallOk({}), fnCallOk({}));
    const first = await provider.chat(baseReq());
    const second = await provider.chat(baseReq());
    // 同实例同盐自增；跨实例（fallback 重建）不同盐不碰撞（轮 15 #14）
    expect(first.toolCalls[0]?.id).toMatch(/^gemini-call-[a-z0-9]{6}-0$/);
    expect(second.toolCalls[0]?.id).toMatch(/^gemini-call-[a-z0-9]{6}-1$/);
  });

  it("只有被丢弃的 functionCall（非请求名）→ stopReason 按 finishReason 归一，不因丢弃变形", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "other", args: {} } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe("stop"); // 从保留的调用推导（toolCalls 空不报 tool_call）
  });

  it("无参 functionCall（args 被 proto3 JSON 省略 / 转换型网关 args:null）→ 兜底 {} 保留（与 anthropic input 口径对齐）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "agent_response" } },
                { functionCall: { name: "agent_response", args: null } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.toolCalls).toEqual([
      {
        id: expect.stringMatching(/^gemini-call-[a-z0-9]{6}-0$/),
        name: "agent_response",
        args: {},
      },
      {
        id: expect.stringMatching(/^gemini-call-[a-z0-9]{6}-1$/),
        name: "agent_response",
        args: {},
      },
    ]);
  });

  it("响应不是对象 → LLMProtocolViolationError（provider 归因到卡片 name，fallback 双卡可区分）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: "not-an-object" });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMProtocolViolationError);
    expect((err as LLMProtocolViolationError).provider).toBe("gemini-card");
  });

  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
    ["SAFETY", "other"],
  ] as const)("finishReason %s（无 functionCall）→ %s", async (raw, expected) => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 200,
      body: {
        candidates: [{ content: { role: "model", parts: [{ text: "t" }] }, finishReason: raw }],
        usageMetadata: null,
      },
    });
    const res = await provider.chat(baseReq());
    expect(res.stopReason).toBe(expected);
    expect(res.usage).toBeNull();
  });

  it("candidates 缺失容错为空响应", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: {} });
    const res = await provider.chat(baseReq());
    expect(res).toEqual({ text: "", toolCalls: [], stopReason: "other", usage: null });
  });

  it("promptFeedback.blockReason → LLMBlockedError（全局拦截，无候选内容；provider 归因到卡片 name）", async () => {
    const { mock, provider } = setup();
    mock.queueMany({ status: 200, body: { promptFeedback: { blockReason: "SAFETY" } } });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMBlockedError);
    expect((err as LLMBlockedError).provider).toBe("gemini-card");
  });

  it("429 gemini 错误体（error.code/message/status）→ LLMRateLimitError", async () => {
    const { mock, provider } = setup();
    mock.queueMany({
      status: 429,
      body: { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } },
    });
    const err = await provider.chat(baseReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMRateLimitError);
    expect((err as Error).message).toContain("Resource exhausted");
  });

  it("testConnection 两态", async () => {
    const ok = setup();
    ok.mock.queueMany({
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      },
    });
    await expect(ok.provider.testConnection()).resolves.toEqual({
      ok: true,
      model: "gemini-2.5-pro",
    });

    const bad = setup();
    bad.mock.queueMany({ status: 403, body: { error: { message: "no key" } } });
    const r = await bad.provider.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("403");
  });
});
