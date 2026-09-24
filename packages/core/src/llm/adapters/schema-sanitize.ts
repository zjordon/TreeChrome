// gemini 专用：functionDeclarations.parameters 只收 OpenAPI Schema 子集（02 §4.4）。
// JSON Schema 的 $schema/$id/additionalProperties/examples 等键会被端点拒收或忽略，
// 适配器对 parameters 做递归白名单清洗（清洗事件经 onSchemaIssue 上报，原始 schema
// 不动，其余两协议透传）。
// 白名单首版按 02 冻结：type/format/description/nullable/items/properties/required/enum
//；真机差异等有 key 实测后修订（README 风险 3）。
// 键名与 type 值做归一化（小写键写入、联合类型拆 nullable）——只清洗 schema 键，
// properties 下的属性名原样保留。

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
]);

export function sanitizeGeminiSchema(
  schema: Record<string, unknown>,
  onSchemaIssue?: (detail: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    const normalized = key.toLowerCase();
    if (!ALLOWED_KEYS.has(normalized)) {
      // 白名单外一律删（$schema/additionalProperties/examples/minimum…）——约束
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
    if (normalized === "properties" && isRecord(value)) {
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
      // 写入统一用归一化（小写）键——"Type"/"Required" 等变体放行但原样透传
      // 仍会被端点拒收，清洗必须闭环
      out[normalized] = value;
    }
  }
  return out;
}
