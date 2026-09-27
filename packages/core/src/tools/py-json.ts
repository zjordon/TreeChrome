// json.dumps(ensure_ascii=False) 的 TS 等价（分隔符 ", " / ": "；indent 支持）。
// LLM 可见面（done 变体 B 的结构化 payload、select_dropdown 回显）保持 Python
// 字节形态——JSON.stringify 的紧凑分隔符会让对拍与 prompt 快照漂移。

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function encodeString(s: string): string {
  // JS JSON.stringify 的字符串转义与 Python ensure_ascii=False 语义一致
  //（控制字符 \uXXXX、引号/反斜杠转义；非 ASCII 原样保留）
  return JSON.stringify(s);
}

function dumps(value: unknown, indent: number, currentIndent: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "number") {
    // Python json.dumps 对整值浮点输出 "1.0"、JS 输出 "1"——payload 源自 JSON.parse
    //（字符串/整型为主），浮点字段罕见；按 JS 原生序列化（登记为可接受漂移）
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (indent > 0) {
      const items = value.map(
        (v) => `${" ".repeat(currentIndent + indent)}${dumps(v, indent, currentIndent + indent)}`,
      );
      return `[\n${items.join(",\n")}\n${" ".repeat(currentIndent)}]`;
    }
    return `[${value.map((v) => dumps(v, indent, currentIndent)).join(", ")}]`;
  }
  if (isPlain(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    if (indent > 0) {
      const items = keys.map(
        (k) =>
          `${" ".repeat(currentIndent + indent)}${encodeString(k)}: ${dumps(value[k], indent, currentIndent + indent)}`,
      );
      return `{\n${items.join(",\n")}\n${" ".repeat(currentIndent)}}`;
    }
    return `{${keys.map((k) => `${encodeString(k)}: ${dumps(value[k], indent, currentIndent)}`).join(", ")}}`;
  }
  return String(value); // undefined / 函数等 JSON 外值（防御分支）
}

/** json.dumps(value, ensure_ascii=False[, indent=N]) 等价 */
export function pyJsonDumps(value: unknown, indent = 0): string {
  return dumps(value, indent, 0);
}
