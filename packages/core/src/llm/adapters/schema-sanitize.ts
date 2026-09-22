// gemini 专用：functionDeclarations.parameters 只收 OpenAPI Schema 子集（02 §4.4）。
// JSON Schema 的 $schema/$id/additionalProperties/examples 等键会被端点拒收或忽略，
// 适配器对 parameters 做递归白名单清洗（只删不报），原始 schema 不动（其余两协议透传）。
// 白名单首版按 02 冻结：type/format/description/nullable/items/properties/required/enum
//（含 type 的大小写变体）；真机差异等有 key 实测后修订（README 风险 3）。

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

export function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    const normalized = key.toLowerCase();
    if (!ALLOWED_KEYS.has(normalized)) {
      continue; // 白名单外一律删（$schema/additionalProperties/examples/minimum…）
    }
    if (normalized === "properties" && isRecord(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        props[name] = isRecord(sub) ? sanitizeGeminiSchema(sub) : sub;
      }
      out[key] = props;
    } else if (normalized === "items") {
      out[key] = isRecord(value) ? sanitizeGeminiSchema(value) : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}
