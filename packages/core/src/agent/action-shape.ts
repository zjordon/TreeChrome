// 动作形态共享工具：LLM 输出/历史数据里畸形动作的归一化与安全访问（无依赖叶子模块）。
// 移植自 TreeWalker action_shape.py（@640d52a 全量）；日志只记类型不记值（畸形 params
// 可能含已还原的敏感真值）——日志通道经 options.log 注入（P2 LLMDeps 同惯例）。
// 已知偏离：actions_of 对 truthy 非数组容器不做 Python list() 的逐字符拆分（管线
// 保证 normalize 先行，该边缘不可达；见 normalizeModelOutput 头注）。

export type Logger = (message: string) => void;

/** 动作条目：理想形态 {name, params}，畸形形态任意（裸字符串/标量/name 无效的 dict） */
export type ActionEntry = unknown;

export interface NormalizeOptions {
  /** live=实况管线（可执行/可反馈）；history=历史加载（不合成可执行动作） */
  context?: "live" | "history";
  /** issue #176 P0-A：非 undefined 时 live 批次里未注册名的条目被移除 */
  knownNames?: ReadonlySet<string>;
  log?: Logger;
}

export type ModelOutput = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 诚实失败标记（review6 #3 / review7 #4 带外化）：WeakSet 按对象身份判定——不进
// 动作数据载荷：LLM 自己输出的 _honest_failure key 没有任何特权；JSON 持久化/
// 拷贝（{...a}）/编辑器往返天然丢失标记，落回普通 dict（与 Python 子类语义一致）。
const HONEST_DONE = new WeakSet<object>();

/** 裸值 → 命名动作 dict（统一 strip 语义；调用点保证 raw 已是字符串） */
export function coerceNamedAction(raw: unknown): Record<string, unknown> {
  return { name: String(raw).trim(), params: {} };
}

/** 非字符串畸形值的统一去向：诚实失败 done（一次调用终止，绝不强转成模型从未输出过的名字） */
export function honestDoneAction(): Record<string, unknown> {
  const action: Record<string, unknown> = {
    name: "done",
    params: { text: "Invalid action shape", success: false },
  };
  HONEST_DONE.add(action);
  return action;
}

/** 校验层放行判定：诚实失败 done 不进参数校验/重试梯 */
export function isHonestFailureAction(action: unknown): boolean {
  return isRecord(action) && HONEST_DONE.has(action);
}

function hasInvalidName(action: Record<string, unknown>): boolean {
  if (!("name" in action)) return false;
  const name = action["name"];
  return !(typeof name === "string" && name);
}

// issue #176：agent_response 的响应字段名——模型偶发当动作名塞进 actions[]，良性混淆。
const RESPONSE_FIELD_ACTION_NAMES: ReadonlySet<string> = new Set([
  "plan_update",
  "current_plan_item",
  "thinking",
]);

function dropUnregisteredActions(
  actionsList: unknown[],
  knownNames: ReadonlySet<string>,
  log?: Logger,
): void {
  const kept: unknown[] = [];
  for (let i = 0; i < actionsList.length; i++) {
    const a = actionsList[i];
    if (
      isRecord(a) &&
      !isHonestFailureAction(a) &&
      typeof a["name"] === "string" &&
      a["name"] &&
      !knownNames.has(a["name"])
    ) {
      const name = a["name"];
      if (RESPONSE_FIELD_ACTION_NAMES.has(name)) {
        log?.(
          `action[${i}] (${JSON.stringify(name)}) is a response field, not an action — ` +
            "dropped (semantics live in the response body fields)",
        );
      } else {
        log?.(
          `action[${i}] (${JSON.stringify(name)}) is not a registered action — dropped ` +
            "from batch",
        );
      }
      continue;
    }
    kept.push(a);
  }
  if (kept.length === actionsList.length) return;
  if (kept.length === 0) {
    log?.(
      `all ${actionsList.length} action(s) unregistered — batch kept as-is for ` +
        "clarification retry (no synthesis, no empty batch)",
    );
    return;
  }
  actionsList.splice(0, actionsList.length, ...kept);
}

/**
 * 畸形动作归一化（issue #173 choke point）——原地修复。策略表（形状 × 位置 × 上下文）：
 * - live：裸字符串（像样的动作名）→ 命名动作；单元素列表的其他畸形 → 诚实失败 done；
 *   多元素列表的畸形条目原样保留（头部畸形走澄清重试、中段畸形执行时得可见错误）；
 *   dict 但 params 非对象 → 置空 {}。
 * - history：非列表 truthy 容器已在 normalizeModelOutput 物化；畸形条目只做无害化
 *   （不合成可执行动作——重放不得替它执行）。
 * - knownNames（仅 live）：shape 合法但未注册名的条目移除；丢光时原样保留。
 */
export function normalizeActionsList(actionsList: unknown[], options: NormalizeOptions = {}): void {
  const context = options.context ?? "live";
  const log = options.log;
  const single = actionsList.length === 1;
  for (let i = 0; i < actionsList.length; i++) {
    const a = actionsList[i];
    if (!isRecord(a)) {
      if (typeof a === "string" && a.trim() && context === "live") {
        log?.(`action[${i}] malformed (${typeName(a)}) — coerced to named action`);
        actionsList[i] = coerceNamedAction(a);
      } else if (context === "live" && single) {
        log?.(`action[0] malformed (${typeName(a)}) — honest-failure done termination`);
        actionsList[i] = honestDoneAction();
      } else {
        // live 多元素：原样保留（镜像无效 → 澄清重试；中段畸形执行时得可见错误）；
        // history：不合成可执行动作，消费方按形态跳过
        log?.(
          `action[${i}] malformed (${typeName(a)}, ${context}) — left as-is ` +
            "(consumers skip or surface visible error)",
        );
      }
    } else {
      if (hasInvalidName(a)) {
        if (context === "live" && single) {
          log?.(`action[0] has invalid name (${inspect(a["name"])}) — honest-failure done`);
          actionsList[i] = honestDoneAction();
        } else if (context === "live") {
          // 多元素列表：无效 name 原样保留（不造合成名进重试梯——镜像过不了校验走澄清）
          log?.(
            `action[${i}] has invalid name (${inspect(a["name"])}) — left as-is ` +
              "(invalid mirror → clarification retry)",
          );
        } else {
          log?.(`history action[${i}] has invalid name — left as-is`);
        }
      }
      const params = a["params"];
      if (!isRecord(params)) {
        if (params !== undefined && params !== null) {
          log?.(
            `action[${i}] (${inspect(a["name"])}) params malformed (${typeName(params)})` +
              " — coerced to {}",
          );
        }
        a["params"] = {};
      }
    }
  }
  if (options.knownNames !== undefined && context === "live") {
    dropUnregisteredActions(actionsList, options.knownNames, log);
  }
}

/**
 * 日志/澄清反馈用动作条目描述（issue #197）：畸形形状直出，弃用占位符。
 * 会进 LLM 可见的澄清文案——类型名按 Python 字面量渲染（str/int/float/bool/NoneType）。
 */
export function describeActionEntry(entry: unknown): string {
  if (isRecord(entry)) {
    const name = entry["name"];
    if (typeof name === "string" && name) return name;
    const keys = Object.keys(entry).map(String).sort().join(",");
    return `<dict:${keys || "empty"}>`;
  }
  return `<non-dict:${typeName(entry)}>`;
}

/**
 * 动作名访问（master 语义，绝不伪造 done）：dict 缺 name 键 → "done"；name 为显式
 * null/空串/非字符串 → 原样返回（透传给下游得可见错误）；裸字符串 → strip 后名字；
 * 其余 → null。消费侧请以 `String(nameOf(a) ?? "")` 包裹。
 */
export function nameOf(action: unknown): unknown {
  if (isRecord(action)) {
    if (!("name" in action)) return "done";
    return action["name"];
  }
  if (typeof action === "string" && action.trim()) return action.trim();
  return null;
}

/** 「params 非对象 → {}」的唯一实现——替换散落各处的手写变体 */
export function paramsOf(action: unknown): Record<string, unknown> {
  if (isRecord(action)) {
    const params = action["params"];
    return isRecord(params) ? params : {};
  }
  return {};
}

/** model_output 的 actions 分发：非空列表优先（浅拷贝），否则单动作包列表（falsy → [{}]） */
export function actionsOf(modelOutput: unknown): unknown[] {
  if (!isRecord(modelOutput)) return [];
  const actions = modelOutput["actions"];
  if (Array.isArray(actions) && actions.length > 0) return [...actions];
  const act = modelOutput["action"];
  return [act === undefined ? {} : act];
}

/**
 * 管线入口一次性归一化整个 model_output（review6 #9 / review7 主线）。物化 actions
 * 列表（非列表 truthy 容器按 [action 或 {}] 重置，防逐字符拆分）→ 逐条归一化 →
 * 刷新镜像。幂等（knownNames 传入时同样幂等）。原地修改并返回同一对象。
 */
export function normalizeModelOutput(
  modelOutput: ModelOutput,
  options: NormalizeOptions = {},
): ModelOutput {
  const actions = modelOutput["actions"];
  let list: unknown[];
  if (Array.isArray(actions) && actions.length > 0) {
    list = actions;
  } else {
    const act = modelOutput["action"];
    list = typeof act === "string" || isRecord(act) ? [act] : [{}];
  }
  normalizeActionsList(list, options);
  modelOutput["actions"] = list;
  modelOutput["action"] = list[0];
  return modelOutput;
}

/** Python type(x).__name__ 的字面量渲染（进 LLM 可见澄清文案，保 P5 prompt parity） */
export function typeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "string") return "str";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "boolean") return "bool";
  if (Array.isArray(value)) return "list";
  if (isRecord(value)) return "dict";
  return typeof value;
}

/** Python %r 的近似渲染（日志用；字符串带引号） */
function inspect(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
