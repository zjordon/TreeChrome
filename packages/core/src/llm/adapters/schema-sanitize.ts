// gemini 专用：functionDeclarations.parameters 只收 OpenAPI Schema 子集（02 §4.4）。
// JSON Schema 的 $schema/$id/additionalProperties/examples 等键会被端点拒收或忽略，
// 适配器对 parameters 做递归白名单清洗（清洗事件经 onSchemaIssue 上报，原始 schema
// 不动，其余两协议透传）。
// 白名单按官方 v1beta Schema 文档收录：基础 8 键（02 首版冻结）+ 约束键
// minimum/maximum/pattern/minLength/maxLength/minItems/maxItems（评审轮 10 补入——
// 官方文档明确支持，删除会让数值/长度约束静默丢失、模型生成越界参数）；
// 真机差异等有 key 实测后修订（README 风险 3）。
// 核验结论（评审轮 12 #14，2026-09）：minProperties/maxProperties 不在官方经典
// Schema 字段列表（社区 Gemini schema 转换器均列为不支持项剥离）；Nov-2025 扩展
// 的 default/anyOf/$ref 走 response_json_schema 通道而非 functionDeclarations。
// parameters——维持删除并上报，真机有 key 后复核。
// 键名与 type 值做归一化（小写键判定、联合类型拆 nullable）——多词约束键按官方
// camelCase 发射；只清洗 schema 键，properties 下的属性名原样保留。

import { isRecord } from "./common.js";

const ALLOWED_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "items",
  "properties",
  "required",
  "enum",
  // 官方 Schema 支持的约束键（数值/长度/模式/数组规模），纯透传标量无清洗歧义
  "minimum",
  "maximum",
  "pattern",
  "minlength",
  "maxlength",
  "minitems",
  "maxitems",
]);

/** 归一化（小写）键 → 官方发射拼写：本模块写入键统一小写，多词键须还原 camelCase */
const EMIT_KEY: Record<string, string> = {
  minlength: "minLength",
  maxlength: "maxLength",
  minitems: "minItems",
  maxitems: "maxItems",
};

/**
 * format 官方支持集（轮 13 #4）：v1beta Schema 的 format 是按 type 限定的封闭
 * 枚举（string: enum/date-time；number: float/double；integer: int32/int64），
 * JSON Schema 常见的 uri/email/uuid 等值会被端点 400——不在此集即删除并上报
 */
const GEMINI_FORMATS = new Set(["enum", "date-time", "float", "double", "int32", "int64"]);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((t) => typeof t === "string");

export function sanitizeGeminiSchema(
  schema: Record<string, unknown>,
  onSchemaIssue?: (detail: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    const normalized = key.toLowerCase();
    if (!ALLOWED_KEYS.has(normalized)) {
      // 白名单外一律删（$schema/additionalProperties/examples/$ref…）——约束
      // 静默丢失无排障线索，经 onSchemaIssue 上报归一化键名（降噪由适配器负责）
      onSchemaIssue?.(`删除白名单外键「${normalized}」`);
      continue;
    }
    if (normalized === "type" && (Array.isArray(value) || value === "null")) {
      // JSON Schema 联合类型 type: ["string","null"] / 单值 "null" → 取首个非 null
      // 字符串 + nullable（Gemini Schema.type 只收单个字符串枚举，"null" 不在枚举
      // 内、数组形态会被拒收——三种形态统一收口，元素非字符串的病态值跳过取兜底）
      const list = Array.isArray(value) ? value : [value];
      const nonNull = list.filter((t) => typeof t === "string" && t !== "null");
      const first = nonNull[0];
      if (nonNull.length > 1) {
        // 联合窄化同样丢约束（string|number → string），与删键同口径上报
        onSchemaIssue?.(`type 联合窄化 ${nonNull.join("|")} → ${first}`);
      }
      // 全 null/病态元素：兜底合法枚举，避免产出无 type 或非法 type 的 schema
      out.type = first ?? "string";
      if (list.includes("null")) {
        out.nullable = true;
      }
      continue;
    }
    if (normalized === "required" && !isStringArray(value)) {
      // required 官方只收 string[]：null/病态值原样透传同有 400 风险——删除并上报
      onSchemaIssue?.("required 非 string[]，删除该键");
      continue;
    }
    if (normalized === "properties") {
      if (!isRecord(value)) {
        // 与 required/items 同款清洗闭环：非对象 properties 原样透传会被端点 400
        onSchemaIssue?.("properties 非对象，删除该键");
        continue;
      }
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        // 子 schema 非对象（draft-06+ 布尔 schema properties:{foo:true} 等）原样
        // 透传会被端点 400——归一为空 schema（Gemini 不支持布尔 schema），闭环
        if (!isRecord(sub)) {
          onSchemaIssue?.(`属性「${name}」子 schema 非对象，归一为空 schema`);
          props[name] = {};
          continue;
        }
        props[name] = sanitizeGeminiSchema(sub, onSchemaIssue);
      }
      out[normalized] = props;
    } else if (normalized === "items") {
      // 元组形态 items:[{…},{…}] 窄化为首元素（Gemini 的 items 只收单个 Schema）；
      // 非对象值兜底空 schema——不原样透传被端点 400
      const item = Array.isArray(value) ? value[0] : value;
      if (Array.isArray(value)) {
        onSchemaIssue?.("items 元组形态窄化为首元素");
      } else if (!isRecord(item)) {
        onSchemaIssue?.("items 非对象形态归一为空 schema");
      }
      out[normalized] = isRecord(item) ? sanitizeGeminiSchema(item, onSchemaIssue) : {};
    } else {
      // 标量键值形态校验（清洗闭环的最后一格，轮 11 #9）：病态值原样透传会被
      // 端点 400——type 非字符串兜底合法枚举、enum/nullable 非法形态删除并上报
      if (normalized === "type" && typeof value !== "string") {
        onSchemaIssue?.(`type 非字符串形态兜底为 string：${JSON.stringify(value)}`);
        out.type = "string";
        continue;
      }
      if (normalized === "enum" && !isStringArray(value)) {
        onSchemaIssue?.("enum 非 string[]，删除该键");
        continue;
      }
      if (normalized === "nullable" && typeof value !== "boolean") {
        onSchemaIssue?.("nullable 非布尔，删除该键");
        continue;
      }
      if (normalized === "format" && (typeof value !== "string" || !GEMINI_FORMATS.has(value))) {
        onSchemaIssue?.(`format「${JSON.stringify(value)}」不在官方支持集，删除该键`);
        continue;
      }
      // 写入统一用归一化（小写）键 + 多词约束键的官方 camelCase（"MaxLength" 等
      // 变体原样透传仍会被端点拒收，清洗必须闭环）
      out[EMIT_KEY[normalized] ?? normalized] = value;
    }
  }
  return out;
}
