// tools 层参数模型：25 个动作的参数规格 + 手写校验器 + ACTION_DEFINITIONS 四元组。
// 移植自 TreeWalker tools/models.py @640d52a（pydantic v2 → 手写 validator，语义锚定：
// extra=forbid / Literal / ge·le·minLength / lax 数值与布尔强转 / model_validator 后置）。
// schema 生成（paramJsonSchema）逐字节复刻 pydantic model_json_schema 输出——键按
// 字母序、anyOf 可空联合、$defs 嵌套、default_factory 不渲染 default；由
// test/fixtures/python-anchors/tools.json（gen-tools-anchors.py 实跑产物）锚定。
// 执行路径不校验（Python memory: action-params-no-runtime-validation）——校验只发生在
// step 预检梯（4.4），报错文案锚定 pydantic 实跑样例（"; ".join("{loc}: {msg}")）。

/** 权限门 capability（04 §1.1 全表；READ=只读不过门，4.4 resolveCapability 消费） */
export type Capability =
  | "NAVIGATE"
  | "CLICK"
  | "TYPE"
  | "READ"
  | "UPLOAD"
  | "EXECUTE_JS"
  | "FS"
  | "DOWNLOAD";

/**
 * 单字段规格。type 是 JSON Schema 主形态；nullable=true 渲染 anyOf [主形态, {type:null}]
 * 且 default:null（对齐 `T | None = None`；WriteFileParams.newline 是 default:"" 的可空串）。
 */
export interface FieldSpec {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "array" | "object" | "literal" | "ref";
  required?: boolean;
  description?: string;
  /** literal 枚举值（type:"literal"） */
  enumValues?: readonly string[];
  /** array 元素 schema（items 键）：{type:"string"} / {type:"integer"} / {}（Any 空对象） */
  items?: Record<string, unknown>;
  /** dict[str, Any]：object + additionalProperties:true */
  freeForm?: boolean;
  /** 嵌套参数模型（type:"ref"） */
  refModel?: ParamModel;
  nullable?: boolean;
  /** 缺省值（undefined 且非 defaultEmptyList 的可选字段视为 null/缺省渲染） */
  default?: unknown;
  /** default_factory=list：不渲染 default，缺省 [] */
  defaultEmptyList?: boolean;
  ge?: number;
  le?: number;
  gt?: number;
  lt?: number;
  minLength?: number;
  /** already_collected 的 _drop_empty_items：滤空项，全空归 None */
  dropEmptyItems?: boolean;
}

/** 参数模型（pydantic BaseModel 等价物：字段序列 + 后置跨字段校验 + docstring 描述） */
export interface ParamModel {
  /** 类名（schema title / $defs 键） */
  readonly name: string;
  readonly fields: readonly FieldSpec[];
  /** model_validator(mode="after") 等价：字段校验全过后运行，返回裸错误消息或 null */
  readonly modelValidator?: (value: Record<string, unknown>) => string | null;
  /** 类 docstring → $defs 内 description（ScreenshotClipParams 用） */
  readonly docDescription?: string;
}

export interface ValidateOk {
  ok: true;
  /** 清洗后的值（缺省补齐 + field_validator 语义；step 梯只看 ok/errors，值供宿主复用） */
  value: Record<string, unknown>;
}
export interface ValidateFail {
  ok: false;
  /** 已格式化的单条错误（`{loc}: {msg}`，模型级 loc 为空串），join("; ") 后与 Python 一致 */
  errors: string[];
}
export type ValidateResult = ValidateOk | ValidateFail;

// —— pydantic v2 错误文案（锚定 gen-tools-anchors.py validate 样例） ——
const MSG_FIELD_REQUIRED = "Field required";
const MSG_EXTRA_FORBIDDEN = "Extra inputs are not permitted";
const MSG_STRING_TYPE = "Input should be a valid string";
const MSG_INT_FROM_STRING = "Input should be a valid integer, unable to parse string as an integer";
const MSG_INT_TYPE = "Input should be a valid integer";
const MSG_NUMBER_FROM_STRING = "Input should be a valid number, unable to parse string as a number";
const MSG_NUMBER_TYPE = "Input should be a valid number";
const MSG_BOOL_TYPE = "Input should be a valid boolean";
/** pydantic bool_parsing：number/string 形态存在但无法解释（0/1/"true" 之外） */
const MSG_BOOL_PARSING = "Input should be a valid boolean, unable to interpret input";
const MSG_DICT_TYPE = "Input should be a valid dictionary";
const MSG_LIST_TYPE = "Input should be a valid list";
const msgGe = (n: number) => `Input should be greater than or equal to ${n}`;
const msgLe = (n: number) => `Input should be less than or equal to ${n}`;
const msgGt = (n: number) => `Input should be greater than ${n}`;
const msgLt = (n: number) => `Input should be less than ${n}`;
const msgMinLength = (n: number) =>
  `String should have at least ${n} character${n === 1 ? "" : "s"}`;
const msgLiteral = (values: readonly string[]) =>
  values
    .map((v) => `'${v}'`)
    .reduce((acc, cur, i) =>
      i === 0 ? cur : i === values.length - 1 ? `${acc} or ${cur}` : `${acc}, ${cur}`,
    );

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * pydantic lax 布尔强转：数值 0/1（含 1.0）与 "true"/"false"/"yes"/"no"/"on"/"off"/"1"/"0"
 * （大小写不敏感）——venv 实测 2 / "2" 不接受（bool_parsing 错误另档文案）
 */
function laxBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
    return undefined;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(s)) return true;
    if (["false", "no", "off", "0"].includes(s)) return false;
  }
  return undefined;
}

type FieldErrors = {
  ok: false;
  errors: string[] /** errors 是否为子层错误（自带 `{subloc}: ` 前缀，外层拼 `.`）；本层类型错误为 false（外层拼 `: `） */;
  childErrors?: boolean;
};
type FieldOk = { ok: true; value: unknown };

/**
 * 单字段校验（lax 语义）。errors 为**不带本字段 loc 前缀**的最终文案（嵌套 ref/array
 * 自带下层 loc，由调用方按 `.` 或 `:` 拼接），对齐 pydantic errors() 的逐条结构。
 */
function validateField(field: FieldSpec, raw: unknown): FieldOk | FieldErrors {
  const t = field.type;
  if (t === "literal") {
    if (typeof raw === "string" && field.enumValues?.includes(raw)) return { ok: true, value: raw };
    return { ok: false, errors: [`Input should be ${msgLiteral(field.enumValues ?? [])}`] };
  }
  if (field.nullable && raw === null) return { ok: true, value: null };
  switch (t) {
    case "string": {
      if (typeof raw !== "string") return { ok: false, errors: [MSG_STRING_TYPE] };
      if (field.minLength !== undefined && raw.length < field.minLength)
        return { ok: false, errors: [msgMinLength(field.minLength)] };
      return { ok: true, value: raw };
    }
    case "integer": {
      let n: number | undefined;
      if (typeof raw === "number") n = Number.isInteger(raw) ? raw : undefined;
      else if (typeof raw === "string" && /^-?\d+$/.test(raw.trim()))
        n = Number.parseInt(raw.trim(), 10);
      if (n === undefined) {
        return {
          ok: false,
          errors: [typeof raw === "string" ? MSG_INT_FROM_STRING : MSG_INT_TYPE],
        };
      }
      return rangeChecked(field, n);
    }
    case "number": {
      let n: number | undefined;
      if (typeof raw === "number") n = raw;
      else if (typeof raw === "string" && raw.trim() !== "" && !Number.isNaN(Number(raw.trim())))
        n = Number(raw.trim());
      if (n === undefined) {
        return {
          ok: false,
          errors: [typeof raw === "string" ? MSG_NUMBER_FROM_STRING : MSG_NUMBER_TYPE],
        };
      }
      return rangeChecked(field, n);
    }
    case "boolean": {
      const b = laxBool(raw);
      if (b === undefined) {
        // 文案分档（pydantic 同款）：number/string 是「无法解释」，其余是类型不符
        return {
          ok: false,
          errors: [
            typeof raw === "number" || typeof raw === "string" ? MSG_BOOL_PARSING : MSG_BOOL_TYPE,
          ],
        };
      }
      return { ok: true, value: b };
    }
    case "object": {
      if (!isPlainObject(raw)) return { ok: false, errors: [MSG_DICT_TYPE] };
      return { ok: true, value: raw };
    }
    case "array": {
      if (!Array.isArray(raw)) return { ok: false, errors: [MSG_LIST_TYPE] };
      const items = field.items;
      const refItems = field.refModel;
      const out: unknown[] = [];
      const errs: string[] = [];
      for (const [i, item] of raw.entries()) {
        // list[Model] 逐项深校验（pydantic model_validate 语义；错误 loc `i.字段`）
        if (refItems !== undefined) {
          if (!isPlainObject(item)) {
            errs.push(`${i}: ${MSG_DICT_TYPE}`);
            continue;
          }
          const r = validateParams(refItems, item);
          if (!r.ok) {
            for (const e of r.errors) errs.push(`${i}.${e}`);
            continue;
          }
          out.push(r.value);
          continue;
        }
        if (items !== undefined && Object.keys(items).length > 0) {
          if (items.type === "string" && typeof item !== "string") {
            errs.push(`${i}: ${MSG_STRING_TYPE}`);
            continue;
          }
          if (items.type === "integer") {
            const r = validateField({ name: "", type: "integer" }, item);
            if (!r.ok) {
              errs.push(`${i}: ${r.errors.join("; ")}`);
              continue;
            }
            out.push(r.value); // lax 清洗值（"42"→42），对齐 pydantic model_validate 产物
            continue;
          }
        }
        out.push(item);
      }
      if (errs.length > 0) return { ok: false, errors: errs, childErrors: true };
      if (field.dropEmptyItems) {
        const kept = out.filter((item) => typeof item === "string" && item.trim() !== "");
        return { ok: true, value: kept.length > 0 ? kept : null };
      }
      return { ok: true, value: out };
    }
    case "ref": {
      const model = field.refModel;
      if (model === undefined) return { ok: true, value: raw };
      if (!isPlainObject(raw)) return { ok: false, errors: [MSG_DICT_TYPE] };
      const r = validateParams(model, raw);
      if (!r.ok) return { ok: false, errors: r.errors, childErrors: true };
      return { ok: true, value: r.value };
    }
  }
}

function rangeChecked(field: FieldSpec, n: number): FieldOk | FieldErrors {
  if (field.gt !== undefined && !(n > field.gt)) return { ok: false, errors: [msgGt(field.gt)] };
  if (field.ge !== undefined && !(n >= field.ge)) return { ok: false, errors: [msgGe(field.ge)] };
  if (field.lt !== undefined && !(n < field.lt)) return { ok: false, errors: [msgLt(field.lt)] };
  if (field.le !== undefined && !(n <= field.le)) return { ok: false, errors: [msgLe(field.le)] };
  return { ok: true, value: n };
}

/** 参数校验主入口：extra=forbid + 必填/类型/范围 + 后置跨字段校验 */
export function validateParams(model: ParamModel, raw: unknown): ValidateResult {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`${model.name}: ${MSG_DICT_TYPE}`] };
  }
  const errors: string[] = [];
  const value: Record<string, unknown> = {};
  const known = new Set(model.fields.map((f) => f.name));
  for (const field of model.fields) {
    const loc = field.name;
    if (!(field.name in raw)) {
      if (field.required) {
        errors.push(`${loc}: ${MSG_FIELD_REQUIRED}`);
      } else if (field.defaultEmptyList) {
        value[field.name] = [];
      } else if (field.default !== undefined) {
        value[field.name] = field.default;
      } else if (field.nullable) {
        value[field.name] = null;
      }
      continue;
    }
    const r = validateField(field, raw[field.name]);
    if (r.ok) {
      value[field.name] = r.value;
    } else {
      // 子层错误（ref/array 的嵌套 loc）拼 `.`；本层类型错误拼 `: `（pydantic 单级
      // loc 实跑形态：files_to_display 传字符串 → "files_to_display: Input should be
      // a valid list"，clip 传字符串 → "clip: Input should be a valid dictionary"）
      for (const e of r.errors) {
        errors.push(r.childErrors === true ? `${loc}.${e}` : `${loc}: ${e}`);
      }
    }
  }
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`${key}: ${MSG_EXTRA_FORBIDDEN}`);
  }
  // model_validator(mode="after")：字段校验存在错误时不运行（pydantic 语义）
  if (errors.length === 0 && model.modelValidator !== undefined) {
    const msg = model.modelValidator(value);
    if (msg !== null) errors.push(`: Value error, ${msg}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

// —— schema 生成（pydantic model_json_schema 逐字节复刻） ——

/** 字段 title：snake_case → Title Case（url→Url / element_id→Element Id） */
export function fieldTitle(name: string): string {
  return name
    .split("_")
    .map((w) => (w === "" ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

function jsonType(t: FieldSpec["type"]): string {
  if (t === "literal") return "string";
  return t === "ref" ? "object" : t;
}

const refPath = (model: ParamModel): string => `#/$defs/${model.name}`;

/** anyOf 非空分支（或非可空字段的主体）：范围/enum/items/长度进分支或主体，键字母序 */
function branchSchema(field: FieldSpec): Record<string, unknown> {
  if (field.type === "ref" && field.refModel !== undefined) {
    return { $ref: refPath(field.refModel) };
  }
  const b: [string, unknown][] = [];
  if (field.type === "object" && field.freeForm) b.push(["additionalProperties", true]);
  if (field.type === "literal" && field.enumValues !== undefined)
    b.push(["enum", [...field.enumValues]]);
  if (field.gt !== undefined) b.push(["exclusiveMinimum", field.gt]);
  if (field.lt !== undefined) b.push(["exclusiveMaximum", field.lt]);
  // list[Model] 形态（pydantic list[Post] 的等价表达）：items 直接 $ref 嵌套模型，
  // $defs 由 paramJsonSchema 按同一 refModel 收集
  if (field.type === "array" && field.refModel !== undefined) {
    b.push(["items", { $ref: refPath(field.refModel) }]);
  } else if (field.items !== undefined) {
    b.push(["items", field.items]);
  }
  if (field.le !== undefined) b.push(["maximum", field.le]);
  if (field.ge !== undefined) b.push(["minimum", field.ge]);
  if (field.minLength !== undefined) b.push(["minLength", field.minLength]);
  b.push(["type", jsonType(field.type)]);
  return Object.fromEntries(b);
}

function propSchema(field: FieldSpec): Record<string, unknown> {
  // 直接 $ref 的必填嵌套字段（变体 B 的 data）：{$ref, description?}——pydantic 不带 title/type
  if (field.type === "ref" && field.required && !field.nullable) {
    const prop: Record<string, unknown> = {};
    if (field.refModel !== undefined) prop.$ref = refPath(field.refModel);
    if (field.description !== undefined) prop.description = field.description;
    return prop;
  }
  const entries: [string, unknown][] = [];
  const main = branchSchema(field);
  if (field.nullable) {
    entries.push(["anyOf", [main, { type: "null" }]]);
  } else {
    for (const [k, v] of Object.entries(main)) entries.push([k, v]);
  }
  const def = field.defaultEmptyList
    ? undefined
    : field.default !== undefined
      ? field.default
      : field.nullable
        ? null
        : undefined;
  if (def !== undefined) entries.push(["default", def]);
  if (field.description !== undefined) entries.push(["description", field.description]);
  if (!(field.type === "ref")) entries.push(["title", fieldTitle(field.name)]);
  // properties 内键字母序（pydantic 输出实锚：anyOf/default/description/.../title/type）
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

/** 参数模型 → JSON Schema（batch1 全量锚定；嵌套模型进 $defs，顶层键字母序） */
export function paramJsonSchema(model: ParamModel): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of model.fields) {
    props[f.name] = propSchema(f);
    if ((f.type === "ref" || f.type === "array") && f.refModel !== undefined) {
      defs[f.refModel.name] = paramJsonSchema(f.refModel);
    }
    if (f.required) required.push(f.name);
  }
  const entries: [string, unknown][] = [];
  if (Object.keys(defs).length > 0) entries.push(["$defs", defs]);
  entries.push(["additionalProperties", false]);
  if (model.docDescription !== undefined) entries.push(["description", model.docDescription]);
  entries.push(["properties", props]);
  if (required.length > 0) entries.push(["required", required]);
  entries.push(["title", model.name]);
  entries.push(["type", "object"]);
  return Object.fromEntries(entries);
}

// —— 25 个参数模型（字段约束与描述逐字照搬 models.py；title/schema 由生成器保证） ——

const LOCATOR_INDEX_DESC =
  "ID of the element to click, shown in brackets in the DOM tree. Provide exactly one of index / element_id.";
const LOCATOR_ELEMENT_ID_DESC =
  "Stable backend node id from find_elements(return_node_ids=True); an alternative to index (same resolution path). Provide exactly one of index / element_id.";

/** index/element_id 二选一（exactly-one）后置校验（_LocatorParamsMixin :6-24） */
const locatorXor: NonNullable<ParamModel["modelValidator"]> = (v) =>
  (v.index === undefined || v.index === null) ===
  (v.element_id === undefined || v.element_id === null)
    ? "provide exactly one of `index` or `element_id` (currently both missing or both given)"
    : null;

const NAVIGATE_PARAMS: ParamModel = {
  name: "NavigateParams",
  fields: [
    {
      name: "url",
      type: "string",
      required: true,
      description: "The URL to navigate to",
    },
    {
      name: "new_tab",
      type: "boolean",
      default: false,
      description: "If True, open the URL in a new tab instead of navigating the current tab",
    },
  ],
};

const CLICK_PARAMS: ParamModel = {
  name: "ClickParams",
  fields: [
    { name: "index", type: "integer", nullable: true, description: LOCATOR_INDEX_DESC },
    { name: "element_id", type: "integer", nullable: true, description: LOCATOR_ELEMENT_ID_DESC },
  ],
  modelValidator: locatorXor,
};

const INPUT_TEXT_PARAMS: ParamModel = {
  name: "InputTextParams",
  fields: [
    {
      name: "index",
      type: "integer",
      nullable: true,
      description:
        "ID of the element to type into, shown in brackets in the DOM tree. Provide exactly one of index / element_id.",
    },
    { name: "element_id", type: "integer", nullable: true, description: LOCATOR_ELEMENT_ID_DESC },
    { name: "text", type: "string", required: true, description: "Text to type into the element" },
    {
      name: "clear",
      type: "boolean",
      default: true,
      description: "Whether to clear existing text first",
    },
  ],
  modelValidator: locatorXor,
};

const SCROLL_PARAMS: ParamModel = {
  name: "ScrollParams",
  fields: [
    {
      name: "amount",
      type: "integer",
      default: 3,
      ge: 1,
      le: 10,
      description:
        "Number of viewport-heights to scroll (1-10). Check the scroll info on scrollable elements in the DOM tree (e.g. '3.4 pages below') to judge how much remains before scrolling.",
    },
    {
      name: "direction",
      type: "literal",
      enumValues: ["up", "down"],
      default: "down",
      description: "Scroll direction: 'down' (default) or 'up'.",
    },
  ],
};

const SEARCH_PARAMS: ParamModel = {
  name: "SearchParams",
  fields: [
    {
      name: "query",
      type: "string",
      required: true,
      description: "Search query to type into the search engine",
    },
    {
      name: "engine",
      type: "literal",
      enumValues: ["baidu", "google", "bing", "duckduckgo"],
      default: "baidu",
      description: "Search engine: baidu (default, works in China), google, bing, or duckduckgo",
    },
  ],
};

const EXTRACT_PARAMS: ParamModel = {
  name: "ExtractParams",
  fields: [
    {
      name: "query",
      type: "string",
      required: true,
      description:
        "What information to extract from the current page. Be specific: name the fields/items and any filtering criteria. (Equivalent to browser-use `query`.)",
    },
    {
      name: "extract_links",
      type: "boolean",
      default: true,
      description:
        "If True, preserve <a href> URLs in the source markdown. Set False for text-only extraction.",
    },
    {
      name: "extract_images",
      type: "boolean",
      default: true,
      description: "If True, preserve <img src> URLs in the source markdown.",
    },
    {
      name: "start_from_char",
      type: "integer",
      default: 0,
      ge: 0,
      description:
        "Character offset to resume extraction from (for paginating large pages). Default 0 = start at the beginning. Use the offset reported by a previous truncated extract call to continue.",
    },
    {
      name: "already_collected",
      type: "array",
      items: { type: "string" },
      nullable: true,
      dropEmptyItems: true,
      description:
        "Items already extracted (dedupe across pages/chunks). Pass prior results (as text) and the model will skip exact duplicates. Optional.",
    },
  ],
};

const SEND_KEYS_PARAMS: ParamModel = {
  name: "SendKeysParams",
  fields: [
    {
      name: "keys",
      type: "string",
      required: true,
      minLength: 1,
      description:
        "Key combination or text to send. Combos use '+': 'Control+a', 'Shift+T', 'Alt+F4'. Named keys: 'Enter', 'Tab', 'Escape', 'ArrowUp', 'F5', etc. Plain text (e.g. 'hello') is typed character by character.",
    },
  ],
};

const SWITCH_TAB_PARAMS: ParamModel = {
  name: "SwitchTabParams",
  fields: [
    {
      name: "tab_id",
      type: "string",
      required: true,
      minLength: 1,
      description: "Tab ID (last 4 characters) to switch to",
    },
  ],
};

const CLOSE_TAB_PARAMS: ParamModel = {
  name: "CloseTabParams",
  fields: [
    {
      name: "tab_id",
      type: "string",
      default: "",
      description: "Tab ID (last 4 characters) to close. Empty string closes the current tab.",
    },
  ],
};

const WAIT_PARAMS: ParamModel = {
  name: "WaitParams",
  fields: [
    {
      name: "seconds",
      type: "integer",
      default: 3,
      ge: 1,
      le: 30,
      description: "Seconds to wait",
    },
  ],
};

const GO_BACK_PARAMS: ParamModel = { name: "GoBackParams", fields: [] };

const FIND_ELEMENTS_PARAMS: ParamModel = {
  name: "FindElementsParams",
  fields: [
    {
      name: "selector",
      type: "string",
      required: true,
      description: 'CSS selector to query elements (e.g. "table tr", "a.link", "div.product")',
    },
    {
      name: "attributes",
      type: "array",
      items: { type: "string" },
      nullable: true,
      description:
        'Specific attributes to extract (e.g. ["href", "src", "class"]). If not set, returns tag and text only. src/href are resolved to absolute URLs.',
    },
    {
      name: "max_results",
      type: "integer",
      default: 50,
      ge: 1,
      le: 200,
      description:
        "Maximum elements to return (total count is always reported even when truncated).",
    },
    {
      name: "offset",
      type: "integer",
      default: 0,
      ge: 0,
      description:
        "0-based index of the first element to return (for paginating large result sets; total is always the full count across all roots including shadow DOM / same-origin iframes).",
    },
    {
      name: "include_text",
      type: "boolean",
      default: true,
      description: "Include text content of each element",
    },
    {
      name: "first_only",
      type: "boolean",
      default: false,
      description:
        "Return only the first matching element; total still reports the full count so you know there are more.",
    },
    {
      name: "include_geometry",
      type: "boolean",
      default: false,
      description:
        "Add per-element getBoundingClientRect() {x,y,w,h} and a stable visibility flag (checks ancestor display/visibility/opacity + non-zero size). Default off to avoid overhead.",
    },
    {
      name: "return_node_ids",
      type: "boolean",
      default: false,
      description:
        "Return stable backend node ids usable directly as click/input_text `index` (uses DOM.performSearch — heavier, one CDP round-trip per element; no text). Offset applies to the document-order match list.",
    },
  ],
};

const FIND_TEXT_PARAMS: ParamModel = {
  name: "FindTextParams",
  fields: [
    {
      name: "text",
      type: "string",
      required: true,
      minLength: 1,
      description: "Text to search for on the page",
    },
    {
      name: "nth",
      type: "integer",
      default: 1,
      ge: 1,
      description:
        "Which match to scroll to, 1-based (default: 1st). The echo reports total/visible counts so the caller can increment to navigate matches.",
    },
    {
      name: "case_sensitive",
      type: "boolean",
      default: false,
      description:
        "Case-sensitive match (default: case-insensitive, like Ctrl+F). Aligns with search_page.",
    },
    {
      name: "highlight",
      type: "literal",
      enumValues: ["box", "selection", "none"],
      default: "box",
      description:
        "Highlight style: box=element outline (default), selection=native blue text selection (best-effort, Chromium-only), none=off.",
    },
  ],
};

const SCREENSHOT_CLIP_PARAMS: ParamModel = {
  name: "ScreenshotClipParams",
  docDescription: "Viewport rectangle for a clipped screenshot, in CSS pixels.",
  fields: [
    { name: "x", type: "number", default: 0, ge: 0, description: "Left offset in CSS pixels" },
    { name: "y", type: "number", default: 0, ge: 0, description: "Top offset in CSS pixels" },
    {
      name: "width",
      type: "number",
      required: true,
      gt: 0,
      description: "Rectangle width in CSS pixels",
    },
    {
      name: "height",
      type: "number",
      required: true,
      gt: 0,
      description: "Rectangle height in CSS pixels",
    },
  ],
};

const SCREENSHOT_PARAMS: ParamModel = {
  name: "ScreenshotParams",
  fields: [
    {
      name: "format",
      type: "literal",
      enumValues: ["png", "jpeg", "webp"],
      default: "png",
      description: "Image format. 'jpeg' supports quality; 'png' is lossless.",
    },
    {
      name: "quality",
      type: "integer",
      nullable: true,
      ge: 0,
      le: 100,
      description: "0-100, only effective when format='jpeg'.",
    },
    {
      name: "clip",
      type: "ref",
      refModel: SCREENSHOT_CLIP_PARAMS,
      nullable: true,
      description: "Optional viewport rect {x,y,width,height} (CSS px).",
    },
    {
      name: "full_page",
      type: "boolean",
      default: false,
      description: "Capture the full scrollable page instead of the viewport.",
    },
    {
      name: "save_path",
      type: "string",
      default: "",
      description: "Optional file path to save the screenshot bytes to disk.",
    },
  ],
};

const SAVE_AS_PDF_PARAMS: ParamModel = {
  name: "SaveAsPdfParams",
  fields: [
    {
      name: "path",
      type: "string",
      required: true,
      description: "File path to save the PDF (parent dirs auto-created).",
    },
    {
      name: "paper_format",
      type: "literal",
      enumValues: ["letter", "legal", "a4", "a3", "tabloid"],
      default: "letter",
      description: "Paper size.",
    },
    {
      name: "landscape",
      type: "boolean",
      default: false,
      description: "Landscape orientation.",
    },
    {
      name: "print_background",
      type: "boolean",
      default: true,
      description: "Include background graphics/colors.",
    },
    {
      name: "scale",
      type: "number",
      default: 1,
      ge: 0.1,
      le: 2,
      description: "Render scale (0.1-2.0).",
    },
  ],
};

const DROPDOWN_OPTIONS_PARAMS: ParamModel = {
  name: "DropdownOptionsParams",
  fields: [
    {
      name: "index",
      type: "integer",
      required: true,
      description: "ID of the select element, shown in brackets in the DOM tree",
    },
  ],
};

const SELECT_DROPDOWN_PARAMS: ParamModel = {
  name: "SelectDropdownParams",
  fields: [
    {
      name: "index",
      type: "integer",
      required: true,
      description: "ID of the select element, shown in brackets in the DOM tree",
    },
    {
      name: "value",
      type: "string",
      nullable: true,
      description: "Option value to select (single option). Each call REPLACES the selection.",
    },
    {
      name: "values",
      type: "array",
      items: { type: "string" },
      nullable: true,
      description:
        "For <select multiple> only: ALL wanted option values in ONE call — replaces the whole selection (repeated single-value calls keep only the last one)",
    },
  ],
  // issue #192：单选/多选二选一（schema/直接构造侧；execute 路径由 handler 运行时守卫兜底）
  modelValidator: (v) =>
    (v.value === undefined || v.value === null) === (v.values === undefined || v.values === null)
      ? "pass exactly one of value (single) or values (multi-select)"
      : null,
};

const UPLOAD_FILE_PARAMS: ParamModel = {
  name: "UploadFileParams",
  fields: [
    {
      name: "index",
      type: "integer",
      required: true,
      description:
        "ID of the file input element (or its labeled upload area / dropzone), shown in brackets in the DOM tree",
    },
    {
      name: "path",
      type: "string",
      required: true,
      description: "Path to the file to upload",
    },
  ],
};

const WRITE_FILE_PARAMS: ParamModel = {
  name: "WriteFileParams",
  fields: [
    {
      name: "path",
      type: "string",
      required: true,
      description: "File path to write to (parent directories are auto-created).",
    },
    {
      name: "content",
      type: "string",
      required: true,
      description: "Text content to write (UTF-8 by default; see encoding).",
    },
    {
      name: "append",
      type: "boolean",
      default: false,
      description:
        "If True, append to the end of an existing file instead of overwriting it. Default False overwrites the entire file.",
    },
    {
      name: "trailing_newline",
      type: "boolean",
      default: true,
      description:
        "If True (default), ensure the written content ends with exactly one newline (no-op if it already does).",
    },
    {
      name: "leading_newline",
      type: "boolean",
      default: false,
      description:
        "If True, prepend a newline before the content (useful when appending to a file that lacks a trailing newline).",
    },
    {
      name: "encoding",
      type: "string",
      nullable: true,
      description:
        "Text encoding to write with (default UTF-8). Set e.g. 'latin-1' or 'cp936' for legacy files; the byte-count echo reflects this encoding.",
    },
    {
      name: "newline",
      type: "string",
      nullable: true,
      default: "",
      description:
        "Python open() newline translation mode (default '' = no translation; \\n/\\r\\n written as-is). Set '\\r\\n' to force CRLF output, None to translate \\n to the OS native line ending (\\r\\n on Windows). Distinct from trailing_newline/leading_newline, which only add/remove a \\n in the content.",
    },
  ],
};

const READ_FILE_PARAMS: ParamModel = {
  name: "ReadFileParams",
  fields: [
    {
      name: "path",
      type: "string",
      required: true,
      description:
        "Path to a local file to read: UTF-8 text by default (see encoding), or PDF/DOCX for text extraction.",
    },
    {
      name: "encoding",
      type: "string",
      nullable: true,
      description:
        "Text encoding to decode with (default UTF-8). Set e.g. 'latin-1' or 'cp936' for legacy files.",
    },
    {
      name: "newline",
      type: "string",
      nullable: true,
      default: "",
      description:
        "Python open() newline mode (default '' = no translation, preserves \\r\\n byte-for-byte). Set None for universal-newline (collapses \\r\\n / \\r to \\n); other values do not translate on a full-file read.",
    },
    {
      name: "offset",
      type: "integer",
      default: 0,
      ge: 0,
      description:
        "0-based character offset to start reading at (for paginating files larger than the effective read window; pair with the truncation footer's 'use offset=N to continue').",
    },
    {
      name: "limit",
      type: "integer",
      nullable: true,
      ge: 1,
      description:
        "Max characters to return from this read (default: the effective read window = min(read_file_max_chars, LLM display cap) minus a footer reserve). Use with offset to page through very large files.",
    },
  ],
};

const REPLACE_FILE_PARAMS: ParamModel = {
  name: "ReplaceFileParams",
  fields: [
    {
      name: "path",
      type: "string",
      required: true,
      description: "Path to an existing local file to edit in place.",
    },
    {
      name: "old",
      type: "string",
      required: true,
      minLength: 1,
      description:
        "Text to find. A literal substring by default (case-sensitive); set regex=True to treat it as a Python regular expression. Must be non-empty.",
    },
    {
      name: "new",
      type: "string",
      required: true,
      description:
        "Replacement text (literal; may be empty to delete matches). In regex mode this is an re.sub replacement template and supports backreferences (\\1, \\g<name>); escape backslashes for literal paths.",
    },
    {
      name: "encoding",
      type: "string",
      nullable: true,
      description:
        "Text encoding to read/write with (default UTF-8). Set e.g. 'latin-1' or 'cp936' for legacy files.",
    },
    {
      name: "newline",
      type: "string",
      nullable: true,
      default: "",
      description:
        "Python open() newline mode (default '' = no translation, preserves original line endings byte-for-byte). Set None for universal-newline translation on read.",
    },
    {
      name: "regex",
      type: "boolean",
      default: false,
      description:
        "When True, treat 'old' as a Python regular expression (re.sub semantics, including backreference expansion \\1 / \\g<name> in 'new'; escape backslashes for literal paths). When False (default), 'old' is a literal substring.",
    },
    {
      name: "case_sensitive",
      type: "boolean",
      default: true,
      description:
        "When True (default), match case-sensitively. When False, match case-insensitively regardless of regex mode. Note: defaults to True (unlike search_page's False) to preserve replace_file's historical case-sensitive behavior.",
    },
    {
      name: "count",
      type: "integer",
      nullable: true,
      ge: 1,
      description:
        "Maximum number of occurrences to replace, from the top of the file. None (default) replaces all; a positive integer replaces only the first N (or fewer if the file has fewer matches).",
    },
    {
      name: "expected_count",
      type: "integer",
      nullable: true,
      ge: 0,
      description:
        "If set, the file must contain exactly this many matches for the operation to proceed; on mismatch the file is left UNCHANGED and an error is returned (typo-guard against 0 or unexpectedly-many replacements). Compared against the TOTAL match count, before the 'count' limit is applied.",
    },
    {
      name: "backup",
      type: "boolean",
      default: false,
      description:
        "When True, copy the original (pre-edit) file to <path>.bak before replacing (shutil.copy2 metadata retained). Default False; .bak is overwritten if it exists.",
    },
  ],
};

const EVALUATE_PARAMS: ParamModel = {
  name: "EvaluateParams",
  fields: [
    {
      name: "code",
      type: "string",
      required: true,
      description:
        "JavaScript to execute in the page. The code runs as a SCRIPT BODY — a top-level `return` is a SyntaxError unless wrapped, so use an IIFE: ((function(){try{...}catch(e){return 'Error: '+e.message}})()). Contrast: with `args`/`elements` the code IS wrapped as function(...a){ ... } and then MUST `return`. Use ONLY browser APIs (document, window, fetch); NO Node.js APIs. Return a primitive or a JSON-serializable object/array. Keep output small. Keep CODE short (< ~300 chars) — longer nested code tends to lose brace balance; split into several evaluate calls instead.",
    },
    {
      name: "await_promise",
      type: "boolean",
      default: true,
      description:
        "Await a returned Promise (default True; needed for await fetch(...)). Set False for fire-and-forget / strictly synchronous code.",
    },
    {
      name: "timeout_ms",
      type: "integer",
      nullable: true,
      ge: 1,
      le: 300000,
      description:
        "Per-call CDP execution timeout in ms, clamped to [1, 300000]. Default None → 30000 (project default). Larger for long fetches, smaller to fail fast. Only applies when no args/elements are given.",
    },
    {
      name: "user_gesture",
      type: "boolean",
      default: false,
      description:
        "Run as a user gesture — required by some APIs (fullscreen, certain clipboard / pointer-lock calls). No-op for most code.",
    },
    {
      name: "args",
      type: "array",
      items: {},
      nullable: true,
      description:
        "Optional JSON arguments injected as a[0], a[1], ... Your code is wrapped as function(...a){ ... } so it MUST `return` a value. Eliminates string-concat injection: pass values as JSON, reference them as a[i]. Example: args=['.btn'] with code `return document.querySelector(a[0]).disabled`.",
    },
    {
      name: "elements",
      type: "array",
      items: { type: "integer" },
      nullable: true,
      description:
        "Backend node ids (index/element_id from get_state or find_elements(return_node_ids=True)) of elements to inject as handles e[0], e[1], ... When present, code is wrapped as function(...a, ...e){ ... } (JSON args first, element handles last) and MUST `return`. Lets JS act on the exact node click/input_text operate on, without re-querying. Example: elements=[42] with code `return e[0].value`.",
    },
    {
      name: "return_element_ids",
      type: "boolean",
      default: false,
      description:
        "If True, a returned DOM node is resolved to its backend node id (usable as `index`/`element_id` for click/input_text) and reported. Expects the code to `return` a single element (e.g. `return document.querySelector('form')`). Only the first returned node is resolved; non-node returns fall back to normal normalization.",
    },
    {
      name: "frame",
      type: "integer",
      nullable: true,
      description:
        "Backend node id of an iframe element to execute inside (cross-origin safe). Default None → top document. When set, the call runs in that iframe's context (attached via Target.attachToTarget). Use when the parent cannot reach a cross-origin iframe's document. Same-origin iframes do NOT need this — just reference `iframe.contentDocument` in your code.",
    },
    {
      name: "extract_images",
      type: "boolean",
      default: false,
      description:
        "If True, scan the result text for `data:image/...;base64,...` URIs, collect them into ActionResult.metadata['images'], and replace each in the returned text with a short placeholder ([image 1], [image 2], ...) to avoid bloating context. Default False.",
    },
  ],
};

const SEARCH_PAGE_PARAMS: ParamModel = {
  name: "SearchPageParams",
  fields: [
    {
      name: "query",
      type: "string",
      required: true,
      minLength: 1,
      description: "Text or regex pattern to search for within the current page",
    },
    {
      name: "regex",
      type: "boolean",
      default: false,
      description: "Treat query as a regex (default: literal text match).",
    },
    {
      name: "case_sensitive",
      type: "boolean",
      default: false,
      description: "Case-sensitive match (default: case-insensitive).",
    },
    {
      name: "context_chars",
      type: "integer",
      default: 150,
      ge: 0,
      description: "Characters of surrounding context per match.",
    },
    {
      name: "css_scope",
      type: "string",
      nullable: true,
      description:
        "CSS selector to limit search scope (e.g. 'div#main'). Selector not matching anything is an error.",
    },
    {
      name: "max_results",
      type: "integer",
      default: 25,
      ge: 1,
      le: 200,
      description:
        "Maximum matches to return (total count is always reported even when truncated).",
    },
    {
      name: "offset",
      type: "integer",
      default: 0,
      ge: 0,
      description:
        "0-based index of the first match to return (for paginating large result sets; total is always the full count).",
    },
    {
      name: "search_attributes",
      type: "boolean",
      default: false,
      description:
        "Also search element attribute values (href / value / data-* etc). Returns a separate attribute_matches list; offset applies to text matches only.",
    },
  ],
};

const READ_GRID_PARAMS: ParamModel = {
  name: "ReadGridParams",
  fields: [
    {
      name: "namespace",
      type: "string",
      nullable: true,
      description:
        "Grid namespace, e.g. 'sales_order_grid' / 'product_listing'. Omit to auto-detect from the current page (first non-notification UI-component grid data source).",
    },
    {
      name: "filters",
      type: "object",
      freeForm: true,
      nullable: true,
      description:
        "Grid filters applied server-side, e.g. {'status':'complete'} or {'qty':{'from':2,'to':3}}. Replaces current filters (leftover bookmark filters are cleared first). Pass {} to read unfiltered.",
    },
    {
      name: "search",
      type: "string",
      nullable: true,
      description: "Fulltext keyword for the grid's search box (replaces current).",
    },
    {
      name: "sorting",
      type: "string",
      nullable: true,
      description:
        "'<field> <asc|desc>', e.g. 'created_at desc'. REQUIRED for top-N / latest / max queries — grid row order is otherwise NOT guaranteed.",
    },
    {
      name: "page_size",
      type: "integer",
      default: 200,
      ge: 1,
      le: 2000,
      description: "Rows per page for this read (server-side paging; use 1000+ to read all).",
    },
    {
      name: "page",
      type: "integer",
      default: 1,
      ge: 1,
      description: "1-based page number to read.",
    },
    {
      name: "fields",
      type: "array",
      items: { type: "string" },
      nullable: true,
      description:
        "Row fields to return, e.g. ['entity_id','increment_id','created_at','status']. Omit for all grid columns.",
    },
    {
      name: "fresh",
      type: "boolean",
      default: true,
      description:
        "True (default): clear leftover server-side bookmark filters/search before applying the given params — grids inherit filter state from previous sessions. False: apply on top of the current state.",
    },
    {
      name: "group_count",
      type: "string",
      nullable: true,
      description:
        "Field name to aggregate on, e.g. 'billing_name': returns per-value row counts computed in Python over the rows this call returned (no context tallying; the decisive tool for count-per-X questions). Watch the appended warnings — 'counted X of total Y' means page through for exact totals; legacy/DOM channels are page-local (current page/pageSize rows only, no total reported). Works on every channel. Pass fields=[that field] to slim the returned rows. If counts come back '(missing)', the field name is not present in the rows (legacy/DOM channels use display-name headers).",
    },
  ],
};

const DONE_PARAMS: ParamModel = {
  name: "DoneParams",
  fields: [
    {
      name: "text",
      type: "string",
      required: true,
      minLength: 1,
      description:
        "Final message to the user. ONLY report data you directly observed in page state, tool outputs, or screenshots during this session. Do NOT use training knowledge to fill gaps — if information was not found on the page, say so explicitly. Do NOT claim completion of steps from compacted_memory or prior session summaries unless you explicitly verified them yourself. If uncertain whether a prior step completed, say so explicitly. Must be non-empty.",
    },
    {
      name: "success",
      type: "boolean",
      default: true,
      description:
        "Whether the task was completed successfully. Set to False if any stated requirement was unmet, the page did not contain the expected data, or a step could not be verified. Leave True only when every requirement was directly confirmed this session. If any part of your data is incomplete or still marked uncertain — a value with `?`, an unread gap, a partial tally — verify it first or set success=False.",
    },
    {
      name: "files_to_display",
      type: "array",
      items: { type: "string" },
      defaultEmptyList: true,
      description:
        "Absolute file paths to attach to the final result (downloads, saved reports, screenshots). Each must exist and be under an allowed read path; invalid paths are skipped with a warning. Shown as a short manifest in the summary.",
    },
  ],
};

/**
 * 变体 B done 参数模型（make_structured_done_params :633-646）：data 必填（outputModel
 * 注入 schema 与校验）、success/files_to_display 保留给 handler 但被 registry 摘除
 * （_hideFieldsFromSchema——LLM 只见 data）。
 */
export function makeStructuredDoneParams(outputModel: ParamModel): ParamModel {
  return {
    name: "StructuredDoneParams",
    fields: [
      {
        name: "data",
        type: "ref",
        refModel: outputModel,
        required: true,
        description: "Structured final output.",
      },
      { name: "success", type: "boolean", default: true },
      {
        name: "files_to_display",
        type: "array",
        items: { type: "string" },
        defaultEmptyList: true,
      },
    ],
  };
}

/**
 * ParamModel 的紧凑 schema 渲染（变体 B 文本渠道注入用，授权偏离 F9.3 2026-10-02）：
 * `{"posts": [{"post_title": "string", ...}]}`——字段名/类型/嵌套一层不落。Python 的
 * 描述行只有一句 "Structured final output."（$ref 不展开），模型首次尝试前对字段名
 * 完全盲（真机 6 轮校验梯子仍未猜中）；本渲染把 browser-use 原版「output model 进
 * schema」的意图在文本通道找回。可选字段加 `?` 后缀，可空加 `|null`。
 */
export function compactModelSchema(model: ParamModel): string {
  const inner = model.fields.map((f) => `"${f.name}": ${compactFieldSchema(f)}`).join(", ");
  return `{${inner}}`;
}

function compactFieldSchema(f: FieldSpec): string {
  let base: string;
  if (f.type === "ref") {
    base = f.refModel !== undefined ? compactModelSchema(f.refModel) : "object";
  } else if (f.type === "array") {
    if (f.refModel !== undefined) {
      base = `[${compactModelSchema(f.refModel)}]`;
    } else {
      const itemType = f.items?.type;
      base = Array.isArray(itemType)
        ? "[any]"
        : `[${typeof itemType === "string" ? itemType : "any"}]`;
    }
  } else if (f.type === "literal") {
    base =
      f.enumValues !== undefined && f.enumValues.length > 0 ? f.enumValues.join("|") : "string";
  } else if (f.type === "object") {
    base = "object";
  } else {
    base = f.type;
  }
  if (f.nullable === true) {
    base += "|null";
  }
  if (f.required !== true) {
    base += "?";
  }
  return base;
}

/** 动作定义四元组（架构 §3.3 三元组 + capability 扩维） */
export interface ActionDefinition {
  params: ParamModel;
  description: string;
  terminatesSequence: boolean;
  /** 权限门 capability（04 §1.1）；数组=参数分流（send_keys → [CLICK, TYPE]）；空数组=不过门 */
  capability: readonly Capability[];
}

/** 动作名 → 四元组。键序 = Python ACTION_DEFINITIONS 声明序（注册顺序不影响排序面） */
export const ACTION_DEFINITIONS: Record<string, ActionDefinition> = {
  navigate: {
    params: NAVIGATE_PARAMS,
    description: "Navigate to a URL in the current tab, or open it in a new tab with new_tab=True",
    terminatesSequence: true,
    capability: ["NAVIGATE"],
  },
  click: {
    params: CLICK_PARAMS,
    description:
      "Click an element by its ID from the DOM state. Use index (from the DOM tree) or element_id (a backend node id from find_elements with return_node_ids=True).",
    terminatesSequence: false,
    capability: ["CLICK"],
  },
  input_text: {
    params: INPUT_TEXT_PARAMS,
    description:
      "Type text into an input element identified by index (from the DOM tree) or element_id (a backend node id from find_elements with return_node_ids=True).",
    terminatesSequence: false,
    capability: ["TYPE"],
  },
  scroll: {
    params: SCROLL_PARAMS,
    description: "Scroll the page up or down by a number of increments",
    terminatesSequence: false,
    capability: ["READ"],
  },
  search: {
    params: SEARCH_PARAMS,
    description:
      "Search the web via a search engine (baidu/google/bing/duckduckgo; default baidu). Navigates to the results page",
    terminatesSequence: true,
    capability: ["NAVIGATE"],
  },
  extract: {
    params: EXTRACT_PARAMS,
    description:
      "Extract specific information from the current page as clean markdown (via an LLM). Paginate large pages with start_from_char; dedupe across calls with already_collected.",
    terminatesSequence: false,
    capability: ["READ"],
  },
  send_keys: {
    params: SEND_KEYS_PARAMS,
    description: "Send keyboard shortcuts or key combinations",
    terminatesSequence: false,
    capability: ["CLICK", "TYPE"],
  },
  switch_tab: {
    params: SWITCH_TAB_PARAMS,
    description: "Switch to a different browser tab by tab ID",
    terminatesSequence: true,
    capability: ["NAVIGATE"],
  },
  close_tab: {
    params: CLOSE_TAB_PARAMS,
    description: "Close a browser tab",
    terminatesSequence: false,
    capability: ["NAVIGATE"],
  },
  wait: {
    params: WAIT_PARAMS,
    description: "Wait for a specified number of seconds",
    terminatesSequence: false,
    capability: ["READ"],
  },
  go_back: {
    params: GO_BACK_PARAMS,
    description: "Navigate back to the previous page in history",
    terminatesSequence: true,
    capability: ["NAVIGATE"],
  },
  find_elements: {
    params: FIND_ELEMENTS_PARAMS,
    description:
      "Query DOM elements by CSS selector (zero LLM cost, instant). Returns matching elements with tag, text, and attributes. Use attributes=['href','src'] to extract specific attributes (src/href resolve to absolute URLs). max_results caps the returned list; the total count is always reported. Use to explore page structure, count items, get links/attributes.",
    terminatesSequence: false,
    capability: ["READ"],
  },
  find_text: {
    params: FIND_TEXT_PARAMS,
    description: "Scroll to and highlight the nth visible match of text on the page",
    terminatesSequence: false,
    capability: ["READ"],
  },
  screenshot: {
    params: SCREENSHOT_PARAMS,
    description:
      "Take a screenshot with optional format, quality (jpeg), clip region, or full page. Saves to save_path if given.",
    terminatesSequence: false,
    capability: ["READ"],
  },
  save_as_pdf: {
    params: SAVE_AS_PDF_PARAMS,
    description:
      "Save the current page as a PDF. Supports paper_format (letter/legal/a4/a3/tabloid), landscape, scale (0.1-2.0), print_background.",
    terminatesSequence: false,
    capability: ["FS"],
  },
  dropdown_options: {
    params: DROPDOWN_OPTIONS_PARAMS,
    description:
      "Get all options from a dropdown element: native <select>, role=combobox, role=listbox, or custom dropdown",
    terminatesSequence: false,
    capability: ["READ"],
  },
  select_dropdown: {
    params: SELECT_DROPDOWN_PARAMS,
    description:
      "Select an option in a dropdown element (native <select>, role=combobox, role=listbox, or custom dropdown). Pass the dropdown's index — do not click it first. For <select multiple>, pass all wanted options at once as values=[...]",
    terminatesSequence: false,
    capability: ["CLICK"],
  },
  upload_file: {
    params: UPLOAD_FILE_PARAMS,
    description:
      "Upload a file to a file input element. Do NOT click the input or an upload button first — upload_file sets the file directly without opening the OS file picker",
    terminatesSequence: false,
    capability: ["UPLOAD"],
  },
  write_file: {
    params: WRITE_FILE_PARAMS,
    description:
      "Write UTF-8 text to a local file (parent directories are auto-created). Default is overwrite: the file's previous content is fully replaced. Set append=True to add to the end of an existing file instead (it is created if missing). trailing_newline (default True) ensures the content ends with exactly one newline — no-op if it already does; set leading_newline=True only when appending to a file you know lacks a trailing newline, to separate the new content. Prefer replace_file for in-place edits to a small region of a large file you have already read.",
    terminatesSequence: false,
    capability: ["FS"],
  },
  read_file: {
    params: READ_FILE_PARAMS,
    description:
      "Read content from a local text (UTF-8) or PDF/DOCX file; paginate large files with offset/limit.",
    terminatesSequence: false,
    capability: ["READ"],
  },
  replace_file: {
    params: REPLACE_FILE_PARAMS,
    description:
      "Replace occurrences of text inside an existing local file, in place. By default performs a case-sensitive literal substring replace of every non-overlapping occurrence (phase-1 behavior preserved). Set regex=True to treat 'old' as a Python regex (then 'new' supports backreferences), or case_sensitive=False for case-insensitive matching. count limits replacements to the first N (default: all). expected_count guards against typos: if the file does not contain exactly that many matches it is left unchanged and an error is returned. backup=True first copies the original to <path>.bak. old must be non-empty; zero matches returns 'no occurrences' rather than silently succeeding. Prefer this over write_file for small edits to a large file you have already read.",
    terminatesSequence: false,
    capability: ["FS"],
  },
  evaluate: {
    params: EVALUATE_PARAMS,
    description:
      "Execute arbitrary JavaScript in the page and return the result. Wrap in an IIFE with try-catch so errors become return values; use only browser APIs (no Node.js). Supports async (await / fetch). Result is normalized to a string (objects -> JSON). Escape hatch when find_elements / search_page / click cannot express the need. Avoid backslash escapes in the code (they get mangled in transport): for newlines/tabs inside regex use String.fromCharCode(10)/String.fromCharCode(9) instead of \\n/\\t.",
    terminatesSequence: true,
    capability: ["EXECUTE_JS"],
  },
  search_page: {
    params: SEARCH_PAGE_PARAMS,
    description:
      "Search page text for a pattern (like grep). Zero LLM cost, instant. Returns matches with surrounding context, element path, and a total count; paginate large result sets with offset. Traverses same-origin iframes and open shadow roots. Set regex=True for regex patterns; use css_scope to search within a section; search_attributes=True to also match href/value/etc. Read-only — does not scroll or highlight (use find_text for that).",
    terminatesSequence: false,
    capability: ["READ"],
  },
  read_grid: {
    params: READ_GRID_PARAMS,
    description:
      "Read structured rows from the page's tables and data grids — UI-component grids, legacy AJAX grids, plain HTML tables, and report result tables. Rows come back keyed by column header (plain/report tables and legacy grids) or by data-source field name (UI-component grids — check the returned keys before passing fields). For tables, adjacent numeric columns cannot be confused — use this instead of reading table values off the DOM snapshot by cell position. When the table has a Total/合计 row, it is returned as footer together with computed per-column sums (totals-check) for cross-checking. Bypasses row-render freezes; returns JSON rows plus metadata (total_records, sorting, active filters). Pass sorting='field desc' for top-N/latest queries — never assume row order. Read-only data channel: does NOT update the page UI (filter chips) — tasks graded on visible filter state must use the Filters panel.",
    terminatesSequence: true,
    capability: ["READ"],
  },
  done: {
    params: DONE_PARAMS,
    description:
      "Signal that the task is complete and stop the agent. Must be the only action in the step. Provide a final summary of what was accomplished; set success=False if any requirement was unmet or could not be verified.",
    terminatesSequence: false,
    capability: [],
  },
};
