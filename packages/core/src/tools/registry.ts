// 动作注册表：registryVersion 指纹 / Anthropic agent_response tool schema /
// system prompt 动作描述文本 / pagePatterns 可见性。移植自 TreeWalker tools/registry.py
// @640d52a。schema 与描述文本逐字节锚定 test/fixtures/python-anchors/tools.json 的
// batch1 矩阵（gen-tools-anchors.py 实跑产物）。

import { sha256Hex } from "@tw/dom-snapshot";

import { type ParamModel, paramJsonSchema } from "./models.js";
import type { ActionHandler } from "./types.js";

/** 注册条目（Python RegisteredAction :33-40） */
export interface RegisteredAction {
  name: string;
  description: string;
  params: ParamModel;
  handler: ActionHandler;
  terminatesSequence: boolean;
  /** fnmatch 通配（可见性过滤；不拦截执行——架构 §3.3） */
  pagePatterns: string[] | null;
}

/** Anthropic tool_use schema 的 agent_response 工具形态 */
export interface AgentResponseToolSchema {
  name: "agent_response";
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * fnmatch 通配匹配（POSIX 语义，大小写敏感：* 任意串含 /、? 单字符、[seq]/[!seq]）。
 * 偏离登记：Python fnmatch 在 Windows 上经 os.path.normcase 小写化（大小写不敏感）；
 * TS 核心包平台无关，取 POSIX 恒定语义——pattern 作者用小写即无行为差。
 */
export function fnmatchLike(name: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1;
      let negated = false;
      // 否定前缀仅认 `!`（POSIX fnmatch 语义）——类内 `^` 是字面量字符
      //（venv 实测：fnmatch('a^c', 'a[^x]c') 与 fnmatch('axc', 'a[^x]c') 均 True，
      // `[^x]` = 类 {^, x}，非否定类）
      if (pattern[j] === "!") {
        negated = true;
        j++;
      }
      let cls = "";
      let first = true;
      while (j < pattern.length && (pattern[j] !== "]" || first)) {
        cls += pattern[j];
        first = false;
        j++;
      }
      if (j >= pattern.length) {
        // 未闭合 '[' 按字面量处理（fnmatch 同款容错）
        re += "\\[";
        continue;
      }
      i = j;
      re += negated ? `[^${escapeClass(cls)}]` : `[${escapeClass(cls)}]`;
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s").test(name);
}

/**
 * 类内容转义：仅 `\` `]` `^`（^ 在 RegExp 类首会被当否定，须字面化）。`-` 不转义
 * ——保留 `[0-9]` 范围语义（Python fnmatch.translate 同款；`[a-]`/`[-a]` 的字面
 * `-` 位置 RegExp 本身按字面处理，无需特判）。
 */
function escapeClass(cls: string): string {
  return cls.replace(/\\/g, "\\\\").replace(/\]/g, "\\]").replace(/\^/g, "\\^");
}

/** schema 深拷贝摘除字段（properties + required；变体 B done 对 LLM 隐藏 success/files_to_display） */
export function hideFieldsFromSchema(
  schema: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out = structuredClone(schema);
  const props = out.properties;
  if (isRecord(props)) {
    for (const f of fields) delete props[f];
  }
  const req = out.required;
  if (Array.isArray(req)) {
    out.required = req.filter((r) => !fields.includes(String(r)));
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface GetToolSchemaOptions {
  enablePlanning?: boolean;
  pageUrl?: string | null;
  /** "flash" | "standard" | "thinking"（Python 同名 str 参数） */
  outputMode?: string;
  includeActions?: string[] | null;
  maxActions?: number;
}

export class ActionRegistry {
  readonly actions = new Map<string, RegisteredAction>();
  /** 变体 B done 结构化输出模型；getToolSchema/getActionDescriptionsText 据此隐藏字段 */
  readonly outputModel: ParamModel | null;

  constructor(outputModel: ParamModel | null = null) {
    this.outputModel = outputModel;
  }

  /** 动作名集合的稳定指纹（写入历史文件用于注册表漂移校验；仅按名字集合，参数细节不触发） */
  get registryVersion(): string {
    const names = [...this.actions.keys()].sort().join("|");
    return `v1-${sha256Hex(names).slice(0, 12)}`;
  }

  private actionAvailable(name: string, pageUrl: string | null): boolean {
    if (pageUrl === null) return true;
    const action = this.actions.get(name);
    if (action === undefined) return false;
    if (action.pagePatterns === null) return true;
    return action.pagePatterns.some((p) => fnmatchLike(pageUrl, p));
  }

  /** 注册动作（Python @registry.action(...) 装饰器的直传形态） */
  register(
    action: Omit<RegisteredAction, "pagePatterns"> & { pagePatterns?: string[] | null },
  ): void {
    this.actions.set(action.name, {
      ...action,
      // ?? 归一：显式传 undefined（宿主透传可空配置的常见形态）不得覆盖 null 哨兵
      pagePatterns: action.pagePatterns ?? null,
    });
  }

  /** 构建 agent_response 工具 schema（:90-234）。maxActions>1 时 action 包 array（multi_act） */
  getToolSchema(options: GetToolSchemaOptions = {}): AgentResponseToolSchema {
    const {
      enablePlanning = false,
      pageUrl = null,
      outputMode = "standard",
      includeActions = null,
      maxActions = 1,
    } = options;

    const actionNames = [...this.actions.keys()]
      .filter(
        (name) =>
          this.actionAvailable(name, pageUrl) &&
          (includeActions === null || includeActions.includes(name)),
      )
      .sort();
    // 注：Python registry.py:110-116 同样收集 action_descriptions/params_by_action
    // 但从未消费（原样死代码）——TS 侧不移植死代码；参数细节经
    // getActionDescriptionsText 输出，tool schema 的 params 是通用 object 描述

    const actionProperty: Record<string, unknown> = {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          enum: actionNames,
          description: "The action to execute",
        },
        params: {
          type: "object",
          description:
            "Action-specific parameters as flat key-value pairs. " +
            'For example: click -> {"index": 42}, input_text -> {"index": 187, "text": "hello", "clear": true}, ' +
            'navigate -> {"url": "https://..."}. See Available Actions above for each action\'s expected params.',
        },
      },
    };

    let actionField: Record<string, unknown>;
    if (maxActions > 1) {
      actionField = {
        type: "array",
        minItems: 1,
        maxItems: maxActions,
        description:
          `One or more actions to execute in order (up to ${maxActions}). ` +
          "Chain when targeting the same stable DOM: form filling, clearing " +
          "multiple items, sequential scrolls, multi-field extraction. The " +
          "runtime stops the sequence automatically if the page changes.",
        items: actionProperty,
      };
    } else {
      actionField = actionProperty;
    }

    // Flash mode: minimal schema with only action
    if (outputMode === "flash") {
      return {
        name: "agent_response",
        description: "Respond with the action to take.",
        input_schema: {
          type: "object",
          required: ["action"],
          properties: {
            action: actionField,
          },
        },
      };
    }

    // Standard and thinking modes: full schema
    const properties: Record<string, unknown> = {
      evaluation_previous_goal: {
        type: "string",
        description:
          "Evaluate whether the previous goal was achieved. On the first step, say 'Starting task.'",
      },
      memory: {
        type: "string",
        description: "Key facts and progress to remember across steps. Keep concise.",
      },
      next_goal: {
        type: "string",
        description: "What you plan to do in this step.",
      },
      action: actionField,
    };

    const required = ["evaluation_previous_goal", "memory", "next_goal", "action"];

    if (outputMode === "thinking") {
      properties.thinking = {
        type: "string",
        description:
          "Your step-by-step reasoning process. Think through the current state, evaluate options, and explain your decision.",
      };
      required.push("thinking");
    }

    if (enablePlanning) {
      properties.plan_update = {
        type: "array",
        items: { type: "string" },
        description:
          "Replace the entire plan with these steps. Use when creating a new plan or revising the current plan. This is a RESPONSE FIELD — never use it as an action name in action/actions.",
      };
      properties.current_plan_item = {
        type: "integer",
        description:
          "Index of the current plan step to advance to. Steps between current and this index will be marked as done. This is a RESPONSE FIELD — never use it as an action name in action/actions.",
      };
    }

    let description = "Respond with your evaluation, memory, next goal, and the action to take.";
    if (outputMode === "thinking") {
      description =
        "Respond with your thinking process, evaluation, memory, next goal, and the action to take.";
    }

    return {
      name: "agent_response",
      description,
      input_schema: {
        type: "object",
        required,
        properties,
      },
    };
  }

  /** system prompt 的动作列表文本（:236-255，字节锚定 fixture） */
  getActionDescriptionsText(pageUrl: string | null = null): string {
    const lines: string[] = [];
    for (const name of [...this.actions.keys()].sort()) {
      if (!this.actionAvailable(name, pageUrl)) continue;
      const act = this.actions.get(name);
      if (act === undefined) continue;
      let schema = paramJsonSchema(act.params);
      // 变体 B：done 隐藏 success/files_to_display——LLM 实际看到的参数面
      if (name === "done" && this.outputModel !== null) {
        schema = hideFieldsFromSchema(schema, ["success", "files_to_display"]);
      }
      const props = isRecord(schema.properties) ? schema.properties : {};
      const paramsStr = Object.entries(props)
        .map(([k, v]) => {
          const desc = isRecord(v) ? v.description : undefined;
          const type = isRecord(v) ? v.type : undefined;
          return `${k}: ${desc ?? type ?? "any"}`;
        })
        .join(", ");
      const term = act.terminatesSequence ? " [terminates sequence]" : "";
      lines.push(`- **${name}**(${paramsStr})${term}: ${act.description}`);
    }
    return lines.join("\n");
  }
}
