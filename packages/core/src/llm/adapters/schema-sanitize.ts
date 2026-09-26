// gemini 专用：functionDeclarations.parameters 只收 OpenAPI Schema 子集（02 §4.4）。
// JSON Schema 的 $schema/$id/additionalProperties/examples 等键会被端点拒收或忽略，
// 适配器对 parameters 做递归白名单清洗（清洗事件经 onSchemaIssue 上报，原始 schema
// 不动，其余两协议透传）。
// 白名单按官方 v1beta Schema 文档收录：基础 8 键（02 首版冻结）+ 约束键
// minimum/maximum/pattern/minLength/maxLength/minItems/maxItems（评审轮 10 补入——
// 官方文档明确支持，删除会让数值/长度约束静默丢失、模型生成越界参数）+
// propertyOrdering（轮 38 #10 补入——官方属性呈现顺序键 string[]，仅 object 域）；
// 真机差异等有 key 实测后修订（README 风险 3）。
// 核验结论（评审轮 12 #14，2026-09）：minProperties/maxProperties 不在官方经典
// Schema 字段列表（社区 Gemini schema 转换器均列为不支持项剥离）；Nov-2025 扩展
// 的 default/anyOf/$ref 走 response_json_schema 通道而非 functionDeclarations。
// parameters——维持删除并上报，真机有 key 后复核。
// 键名与 type 值做归一化（小写键判定、联合类型拆 nullable）——多词约束键按官方
// camelCase 发射；只清洗 schema 键，properties 下的属性名原样保留。

import { isPlainRecord, isRecord, stringifyForLog } from "./common.js";

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
  // 属性呈现顺序键（string[]，仅 object 域合法——轮 38 #10 补入：官方 v1beta
  // Schema 支持，删除会让宿主对属性顺序的约束静默丢失）
  "propertyordering",
]);

/** 归一化（小写）键 → 官方发射拼写：本模块写入键统一小写，多词键须还原 camelCase */
const EMIT_KEY: Record<string, string> = {
  minlength: "minLength",
  maxlength: "maxLength",
  minitems: "minItems",
  maxitems: "maxItems",
  propertyordering: "propertyOrdering",
};

/**
 * format 官方支持集（轮 13 #4）：v1beta Schema 的 format 是按 type 限定的封闭
 * 枚举（string: enum/date-time；number: float/double；integer: int32/int64），
 * JSON Schema 常见的 uri/email/uuid 等值会被端点 400——不在此集即删除并上报
 */
const GEMINI_FORMATS = new Set(["enum", "date-time", "float", "double", "int32", "int64"]);

/** type 官方封闭枚举（大小写敏感，轮 15 #17）：值小写归一后校验，未命中兜底
 * string（轮 18 #1：端点要求节点显式 type，删键产出无 type schema 同为 400） */
const GEMINI_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

/** format 按 type 限定的官方分域（轮 18 #8）：全集校验之外，「值在全集但 type
 * 域外」的组合（{type:"number",format:"date-time"}）同样是 400 形态 */
const FORMATS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  string: new Set(["enum", "date-time"]),
  number: new Set(["float", "double"]),
  integer: new Set(["int32", "int64"]),
};

/** boolean/array/object 无任何合法 format（分域表缺项 = 全部删除） */
const NO_FORMATS: ReadonlySet<string> = new Set();

// 轮 32 #12 约束键 type 分域表：各 type 合法的结构/约束键（官方 v1beta Schema
// 口径，与 gemini.ts 顶层归一剥离清单同源）——收尾按最终 type 剥离域外键
const CONSTRAINT_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  string: new Set(["enum", "pattern", "minLength", "maxLength"]),
  number: new Set(["minimum", "maximum"]),
  integer: new Set(["minimum", "maximum"]),
  array: new Set(["items", "minItems", "maxItems"]),
  object: new Set(["properties", "required", "propertyOrdering"]),
};
const NO_CONSTRAINT_KEYS: ReadonlySet<string> = new Set();
// 遍历清单由域表派生单源（轮 42 #23）：12 键恰好等于 CONSTRAINT_KEYS_BY_TYPE 各
// type 值集的并集——两份手工平行清单在新增域键时漏改一侧会让收尾剥离不再覆盖
// 新键（残留 400 形态键）或空转，正是本模块反复强调的「域表清单漏同步」形态
const DOMAIN_SCOPED_KEYS: ReadonlySet<string> = new Set(
  Object.values(CONSTRAINT_KEYS_BY_TYPE).flatMap((keys) => [...keys]),
);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((t) => typeof t === "string");

// 轮 24 #5：编译失败（"["、"(" 等）的 pattern 上送端点即 400，清洗侧截断
function isCompilablePattern(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

/** 嵌套深度上限（轮 32 #7）：未设限递归在病态深层 schema（宿主程序化构造可绕过
 *  JSON.parse 自身栈限制）上以 RangeError 栈溢出直穿——非 LLMError，client 按
 * 「编程错误原样穿透」上抛，既无清洗证据也无归因线索（同 http.ts 轮 27 #2 的
 * 宿主数据硬化维度）。导出供测试锚定（同 SCHEMA_ISSUE_DEDUP_MAX 口径） */
export const SCHEMA_MAX_DEPTH = 64;

export function sanitizeGeminiSchema(
  schema: Record<string, unknown>,
  onSchemaIssue?: (detail: string) => void,
  depth = 0,
): Record<string, unknown> {
  if (depth >= SCHEMA_MAX_DEPTH) {
    // 截断留证据而非栈溢出直穿（轮 32 #7）
    onSchemaIssue?.(`schema 嵌套深度达 ${SCHEMA_MAX_DEPTH}，深层节点截断为空 schema`);
    return { type: "string" };
  }
  const out: Record<string, unknown> = {};
  // 归一撞键统一上报出口（轮 30 #1，轮 31 #3 扩到全部分支）：归一化（大小写/
  // camelCase 发射）后同键后写者覆盖先写者（"properties" 与 "Properties" 并存
  // 会整棵子树静默丢失）——覆盖必留证据，全部分支共用防口径漂移
  const emit = (sourceKey: string, emitKey: string, value: unknown): void => {
    if (out[emitKey] !== undefined) {
      onSchemaIssue?.(
        `键「${stringifyForLog(sourceKey)}」与已写入键归一后均为「${emitKey}」，后者覆盖前者`,
      );
    }
    out[emitKey] = value;
  };
  // type 联合数组的 null 成员 → nullable 派生标志（轮 40 #5）：延迟到循环后
  // 收尾处理，显式 nullable 键优先——消除派生写入与显式键的键序依赖
  let derivedNullable = false;
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
      // 成员 + nullable（Gemini Schema.type 只收单个字符串枚举，"null" 不在枚举
      // 内、数组形态会被拒收）。端点要求每个 schema 节点显式 type（"missing a
      // type" 400，轮 18 #1 web 核实 livekit/agents#5044）——任何病态形态都兜底
      // 合法枚举、不删键；成员逐一过标量枚举口径（小写归一、非法跳过），首个
      // 合法成员胜出（比盲目兜底 string 更保真：["str","object"] 取 object）
      const list = Array.isArray(value) ? value : [value];
      // 非 string 成员（宽化输入病态，如 42/对象）被 filter 丢弃同样必留证据
      //（轮 44 #16，轮 31 #3 口径——本模块清洗路径唯一无上报的丢弃点）；null
      // 成员是联合 nullable 的合法语义，不上报
      for (const t of list) {
        if (typeof t !== "string" && t !== null) {
          onSchemaIssue?.(`type 成员「${stringifyForLog(t)}」非字符串，跳过`);
        }
      }
      const nonNull = list.filter((t) => typeof t === "string" && t !== "null");
      const skipped: string[] = [];
      let chosen: string | undefined;
      for (const t of nonNull) {
        const lowered = t.toLowerCase();
        if (!GEMINI_TYPES.has(lowered)) {
          skipped.push(t);
          continue;
        }
        if (lowered !== t) {
          onSchemaIssue?.(`type「${t}」归一化为小写 ${lowered}`);
        }
        chosen = lowered;
        break;
      }
      if (skipped.length > 0) {
        onSchemaIssue?.(`type 成员「${skipped.join("、")}」不在官方枚举集，跳过`);
      }
      if (nonNull.length > 1) {
        // 联合窄化同样丢约束（string|number → string），与删键同口径上报
        onSchemaIssue?.(`type 联合窄化 ${nonNull.join("|")} → ${chosen ?? "string"}`);
      }
      if (chosen === undefined) {
        // 全 null/病态/非法枚举成员：兜底合法枚举——兜底同样是约束丢失，与联合
        // 窄化同口径上报（轮 16 #10），否则此路径无排障线索
        onSchemaIssue?.("type 全 null/病态元素，兜底为 string");
        emit(key, "type", "string");
      } else {
        emit(key, "type", chosen);
      }
      // 实际 null 成员同派生（轮 46 #13）：includes("null") 是严格字符串比较，
      // {"type":["string",null]} 的 null 语义会被静默丢弃无证据——与上方成员豁免
      // （t !== null 视为合法语义）自洽
      if (list.some((t) => t === null || t === "null")) {
        // nullable 派生延迟到收尾（轮 40 #5）：此处立即写入会与显式 nullable 键
        // 产生键序依赖（{type:[…,"null"],nullable:false} 与反序产出相反结果），
        // 且撞键上报把来源归因到 type 键本身（归一后仍是 type，真实来源是其
        // null 成员）——只置位，收尾处显式键优先地补写
        derivedNullable = true;
      }
      continue;
    }
    if (normalized === "required" && !isStringArray(value)) {
      // required 官方只收 string[]：null/病态值原样透传同有 400 风险——删除并上报
      onSchemaIssue?.("required 非 string[]，删除该键");
      continue;
    }
    // propertyOrdering 官方只收 string[]（轮 38 #10；与 required 同款形态校验——
    // 成员是否引用 properties 内实有属性官方不强制校验，此处保持纯形态口径）
    if (normalized === "propertyordering" && !isStringArray(value)) {
      onSchemaIssue?.("propertyOrdering 非 string[]，删除该键");
      continue;
    }
    if (normalized === "properties") {
      // isPlainRecord（轮 47 #10）：宽松 isRecord 放行 Date/Map 等类实例但
      // Object.entries 为空——properties 会静默清空为 {} 且零告警；与顶层
      // parameters 拦截单源对齐（items/子 schema 两处守卫同款替换）
      if (!isPlainRecord(value)) {
        // 与 required/items 同款清洗闭环：非对象 properties 原样透传会被端点 400
        onSchemaIssue?.("properties 非对象，删除该键");
        continue;
      }
      // __proto__ 属性名会命中普通对象字面量继承的原型 setter 而非创建自有键
      //（子 schema 静默丢失 + 原型被改写）——null 原型容器收口（轮 22 #5；属性名
      // 是宿主/用户可控输入，与 P1.2 parseAttrs 同款坑）
      const props = Object.create(null) as Record<string, unknown>;
      for (const [name, sub] of Object.entries(value)) {
        // 子 schema 非对象（draft-06+ 布尔 schema properties:{foo:true} 等）原样
        // 透传会被端点 400——归一空 schema 并补缺省 type（Gemini 不支持布尔
        // schema；节点须显式 type，轮 19 #1），闭环
        if (!isPlainRecord(sub)) {
          onSchemaIssue?.(`属性「${name}」子 schema 非对象，归一为空 schema`);
          props[name] = { type: "string" };
          continue;
        }
        props[name] = sanitizeGeminiSchema(sub, onSchemaIssue, depth + 1);
      }
      emit(key, normalized, props);
    } else if (normalized === "items") {
      // 元组形态 items:[{…},{…}] 窄化为首元素（Gemini 的 items 只收单个 Schema）；
      // 非对象值兜底空 schema 并补缺省 type（节点须显式 type，轮 19 #1）——不原样
      // 透传被端点 400
      const item = Array.isArray(value) ? value[0] : value;
      if (Array.isArray(value)) {
        // 空元组分档（轮 34 #5）：items:[] 语义是「数组须为空」，无首元素可窄化
        // ——与普通元组窄化共用文案会让证据与实际行为不符
        onSchemaIssue?.(
          value.length === 0
            ? "items 空元组，归一为空 schema（空数组约束丢失）"
            : "items 元组形态窄化为首元素",
        );
      } else if (!isPlainRecord(item)) {
        onSchemaIssue?.("items 非对象形态归一为空 schema");
      }
      emit(
        key,
        normalized,
        isRecord(item) ? sanitizeGeminiSchema(item, onSchemaIssue, depth + 1) : { type: "string" },
      );
    } else {
      // 标量键值形态校验（清洗闭环的最后一格，轮 11 #9）：病态值原样透传会被
      // 端点 400——type 非字符串兜底合法枚举、enum/nullable/format 及约束键
      // 非法形态删除并上报
      if (normalized === "type") {
        if (typeof value !== "string") {
          onSchemaIssue?.(`type 非字符串形态兜底为 string：${stringifyForLog(value)}`);
          emit(key, "type", "string");
          continue;
        }
        if (!GEMINI_TYPES.has(value)) {
          // 合法字符串但非法枚举值（PascalCase 等病态，轮 15 #17）：小写归一命中
          // 则发射小写形态，否则兜底 string——Gemini Schema.type 是大小写敏感封闭
          // 枚举，且端点要求每个 schema 节点显式 type（"missing a type" 400，轮
          // 18 #1 web 核实 livekit/agents#5044），删键产出无 type 的 schema 同样
          // 是 400 形态（三档口径统一：非字符串/全病态数组/非法枚举都兜底）
          const lowered = value.toLowerCase();
          if (GEMINI_TYPES.has(lowered)) {
            onSchemaIssue?.(`type「${value}」归一化为小写 ${lowered}`);
            emit(key, "type", lowered);
          } else {
            onSchemaIssue?.(`type「${stringifyForLog(value)}」不在官方枚举集，兜底为 string`);
            emit(key, "type", "string");
          }
          continue;
        }
      }
      if (normalized === "description" && typeof value !== "string") {
        // description 是 proto string 字段，非字符串上送即 400——白名单内最后
        // 一个未做值形态校验的标量键（轮 18 #6 补齐闭环）
        onSchemaIssue?.(`description 非字符串，删除该键：${stringifyForLog(value)}`);
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
      if (normalized === "format") {
        // format 值小写归一（轮 38 #10，与 type 归一同口径）：官方枚举全小写
        //（date-time/int64 等），"DATE-TIME" 等 JSON Schema 惯用大写形态归一命中
        // 而非直接删除；非字符串/未命中（含归一后）删除并上报
        if (typeof value !== "string") {
          onSchemaIssue?.(`format「${stringifyForLog(value)}」不在官方支持集，删除该键`);
          continue;
        }
        const loweredFormat = value.toLowerCase();
        if (!GEMINI_FORMATS.has(loweredFormat)) {
          onSchemaIssue?.(`format「${stringifyForLog(value)}」不在官方支持集，删除该键`);
          continue;
        }
        if (loweredFormat !== value) {
          onSchemaIssue?.(`format「${value}」归一化为小写 ${loweredFormat}`);
        }
        emit(key, "format", loweredFormat);
        continue;
      }
      // 约束键标量类型校验（轮 15 #13）：官方口径 pattern 为 string、
      // minLength/maxLength 为 int64（数值）——病态值（pattern: 123 等）上送
      // 即 400 INVALID_ARGUMENT
      if (normalized === "pattern" && typeof value !== "string") {
        onSchemaIssue?.(`约束键「pattern」非字符串，删除该键：${stringifyForLog(value)}`);
        continue;
      }
      // pattern 可编译性校验（轮 24 #5）：JS 编译失败的正则（"[" 等）上送同为 400。
      // 编译通过只是必要条件——JS 正则是端点 RE2 的超集（lookbehind 等 JS 合法
      // 形态仍可能被拒收），不可编译形态在此截断
      if (normalized === "pattern" && typeof value === "string" && !isCompilablePattern(value)) {
        onSchemaIssue?.(`约束键「pattern」非可编译正则，删除该键：${stringifyForLog(value)}`);
        continue;
      }
      // 约束键标量类型校验分域（轮 15 #13 + 轮 21 #12 + 轮 37 #13）：
      // minLength/maxLength/minItems/maxItems 官方为 int64 且语义非负——小数
      //（如 maxLength: 2.5）proto3 解析失败、负值（maxLength: -1）同为 400
      // INVALID_ARGUMENT（Number.isInteger 蕴含 number+finite）；minimum/maximum
      // 为 double 且负值语义合法（minimum: -10），维持有限数值校验
      if (
        (normalized === "minlength" ||
          normalized === "maxlength" ||
          normalized === "minitems" ||
          normalized === "maxitems") &&
        (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      ) {
        onSchemaIssue?.(
          `约束键「${normalized}」非整数或为负值，删除该键：${stringifyForLog(value)}`,
        );
        continue;
      }
      if (
        (normalized === "minimum" || normalized === "maximum") &&
        (typeof value !== "number" || !Number.isFinite(value))
      ) {
        onSchemaIssue?.(`约束键「${normalized}」非有限数值，删除该键：${stringifyForLog(value)}`);
        continue;
      }
      // 写入统一用归一化（小写）键 + 多词约束键的官方 camelCase（"MaxLength" 等
      // 变体原样透传仍会被端点拒收，清洗必须闭环）；撞键上报经 emit 统一出口
      emit(key, EMIT_KEY[normalized] ?? normalized, value);
    }
  }
  // type null 成员的 nullable 派生收尾（轮 40 #5）：显式 nullable 键已在此前的
  // 循环中写入，无显式键时才补 true——sourceKey 用真实来源描述（type 键归一后
  // 仍是 type，撞键场景按「type 的 null 成员」归因才不误导）
  if (derivedNullable && out.nullable === undefined) {
    emit("type 的 null 成员", "nullable", true);
  }
  // 缺 type 补注入（轮 19 #1 + 轮 20 #1 结构线索）：端点要求每个 schema 节点显式
  // type（轮 18 #1 web 核实）——统一注 string 会产出 {type:"string", properties:…}
  // 语义错误形态（properties 仅 OBJECT、items 仅 ARRAY 合法），按已有结构线索
  // 推断：有 properties 注 object、有 items 注 array、无线索才兜底 string；
  // 先于 format 分域校验注入，缺 type 节点的 format 按注入后的 type 收口
  if (out.type === undefined) {
    if (out.properties !== undefined) {
      onSchemaIssue?.("节点缺 type，按 properties 推断注入 object");
      out.type = "object";
    } else if (out.items !== undefined) {
      onSchemaIssue?.("节点缺 type，按 items 推断注入 array");
      out.type = "array";
    } else {
      onSchemaIssue?.("节点缺 type，补注入缺省 string");
      out.type = "string";
    }
  }
  if (typeof out.type === "string") {
    stripKeysOutsideTypeDomain(out, out.type, onSchemaIssue);
  }
  return out;
}

/** 按 type 剥离域外键的单源收尾（轮 32 #12 收口，轮 35 #7 导出单源）：format 走
 * FORMATS_BY_TYPE 分域（轮 18 #8）、约束/结构键走 CONSTRAINT_KEYS_BY_TYPE 分域
 * ——sanitizeGeminiSchema 收尾与 gemini.ts 顶层归一（强制 object 后的剥离）共用，
 * 防两处域表清单漏同步（改一漏二：顶层残留 400 形态键或误删仍合法的键） */
export function stripKeysOutsideTypeDomain(
  out: Record<string, unknown>,
  type: string,
  onSchemaIssue?: (detail: string) => void,
): void {
  if (typeof out.format === "string") {
    const allowed = FORMATS_BY_TYPE[type] ?? NO_FORMATS;
    if (!allowed.has(out.format)) {
      onSchemaIssue?.(`format「${out.format}」不在 type=${type} 的官方支持集，删除该键`);
      delete out.format;
    }
  }
  const allowedConstraintKeys = CONSTRAINT_KEYS_BY_TYPE[type] ?? NO_CONSTRAINT_KEYS;
  for (const k of DOMAIN_SCOPED_KEYS) {
    if (out[k] !== undefined && !allowedConstraintKeys.has(k)) {
      onSchemaIssue?.(`键「${k}」不在 type=${type} 的官方支持域，删除该键`);
      delete out[k];
    }
  }
}
