// Python repr() 的深层等价（str/dict/list/标量）——f-string `{dict}` / `{params}` 渲染用
//（<agent_history> 的 action 串、zero-result desc、日志 params）。键序保持插入序
//（Python repr 语义）；字符串单引号优先（复用 element-lookup 的 pyRepr 规则）。

function pyReprString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  if (!escaped.includes("'")) return `'${escaped}'`;
  if (!escaped.includes('"')) return `"${escaped}"`;
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

export function pyReprDeep(value: unknown): string {
  if (value === null) return "None";
  if (value === undefined) return "None";
  if (typeof value === "string") return pyReprString(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    // Python repr(1.0)="1.0"/repr(1)="1"——JS number 无法区分；源自 JSON.parse 的
    // 整型按 int 渲染（登记为可接受漂移，与 pyJsonDumps 同口径）
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(pyReprDeep).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return `{${entries.map(([k, v]) => `${pyReprString(k)}: ${pyReprDeep(v)}`).join(", ")}}`;
  }
  return String(value);
}
