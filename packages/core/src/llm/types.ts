// 规范消息/工具/请求/响应类型（协议中立，架构 §3.4）。冻结契约见 docs/implement-plan/p2/01 §2-§3。

import { LLMProtocolViolationError } from "./errors.js";
import { isPlainRecord } from "./transforms.js";

/** 规范内容块。P2 只有文本与图片（截图）；PDF 等块后置 */
export type ContentBlock = TextBlock | ImageBlock;

export interface TextBlock {
  kind: "text";
  text: string;
}

/** 图片块：base64 裸数据（不带 data: 前缀）。截图管线产物即 PNG base64 */
export interface ImageBlock {
  kind: "image";
  mimeType: string; // "image/png"
  base64: string;
}

/**
 * 规范消息。system 不在其中——它是 chat() 的独立参数
 * （Python get_action(system_prompt, messages) 同形；Anthropic/Gemini
 * 也都是独立字段）。三种角色覆盖 agent loop 的全部用法。
 */
export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface UserMessage {
  role: "user";
  blocks: ContentBlock[]; // 恒非空（空块消息在入口校验拒绝）
}

export interface AssistantMessage {
  role: "assistant";
  blocks: ContentBlock[]; // 可为空数组（纯工具调用回合）
  /** 模型上一步发起的工具调用；无则为 undefined */
  toolCalls?: ToolCall[];
}

/**
 * 工具结果。同时携带 toolCallId 与 toolName：
 * - openai/anthropic 按 id 关联（tool_call_id / tool_use_id）；
 * - gemini 的 functionResponse 按 name 关联（无 id 匹配语义）。
 * isError 供动作层回灌"拒绝/失败"信号（anthropic 的 is_error 直译；
 * openai/gemini 无对应字段，映射策略见 02 各协议小节）。
 */
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  text: string;
  isError?: boolean;
}

/** 工具定义。parameters 为 JSON Schema 透传（P4 registry 产出） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 工具调用。args 恒为已解析对象——openai 的 JSON 字符串形态在适配器内消化 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * gemini thinking 模型（2.5/3 系）functionCall part 携带的 thoughtSignature：
   * 官方要求后续回合随 functionCall part 原样回传，缺失即 400 INVALID_ARGUMENT。
   * 仅 gemini 适配器读写（canonical 层透传不消费）；其余协议恒缺省
   */
  signature?: string;
}

/** 工具选择：auto（模型自决）或 forced（agent_response 强制） */
export type ToolChoice = { kind: "auto" } | { kind: "forced"; name: string };

export interface ChatRequest {
  systemPrompt: string | null;
  messages: ChatMessage[];
  tools: ToolDefinition[] | null; // null = 不带工具（纯文本调用）
  toolChoice?: ToolChoice; // 缺省 = auto；tools 为 null 时忽略
  maxTokens?: number; // 缺省用 ProviderConfig.maxTokens
  temperature?: number; // 缺省不发（Python 同款；见 03 偏离 8）
  timeoutMs?: number; // 单次 HTTP 超时（AbortController）
  signal?: AbortSignal; // 外部取消（step 停止/窗口 deadline）
}

/** 归一化停止原因。观测用（getAction 不分支，仅 warning 日志携带） */
export type StopReason = "tool_call" | "stop" | "length" | "other";

export interface ChatResponse {
  /** 全部文本块拼接（anthropic text / openai content / gemini text part） */
  text: string;
  /** 思考内容（GLM reasoning_content / anthropic thinking / gemini thought part）。
   *  观测用，getAction 不消费——thinking-only 响应自然落入空响应梯子 */
  reasoningText?: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: TokenUsage | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * canonical 消息序列不变量裁决（01 §2.1）。getAction 与各适配器入口调用；
 * 违例抛 LLMProtocolViolationError——把"什么消息序列合法"提前到 canonical 层
 * 一次性裁决，三适配器不再各自猜（Python 端无独立校验，靠 Anthropic 形状隐式成立）。
 *
 * 不变量：
 * - 首条消息可为 assistant：state 替换（保 1 旧删更老）在 step≥3 会留下
 *   assistant 开头的序列——Python 参考同款（消息列自 state1 起、无 task 首消息，
 *   生产实跑端点接受；4.6 真机 smoke 证实）。原「首条必须 user」是 TS 侧无证据
 *   收紧（2026-09-28 4.5 段移除）；
 * - toolResult 必须紧跟带 toolCalls 的 assistant，且每个 toolCall 恰有一条结果
 *   （顺序可乱，适配器按 id/name 配对）；
 * - user.blocks 非空；assistant 的 blocks 与 toolCalls 不同时为空；
 * - TextBlock.text 非空（轮 13 #6 收口：Anthropic 官方端点对空 text 块直接 400
 *   "text content blocks must be non-empty"——canonical 层一处拦截，三适配器
 *   不再各自猜）；ImageBlock 的 base64/mimeType 非空（轮 25 #4 同动机）。
 */
export function assertValidMessages(messages: ChatMessage[], providerName = "canonical"): void {
  const violation = (reason: string): LLMProtocolViolationError =>
    new LLMProtocolViolationError(`消息序列不变量被破坏：${reason}`, { provider: providerName });

  // 空串与字符串性同拦（轮 46 #15）：JS 宿主宽化输入下 text/base64/mimeType 非
  // string（数字/对象）会绕过 === "" 判定——getAction 路径在 text.replace/includes
  // 裸 TypeError、直连路径原样出站烧 400；字符串性与空串同为三协议一致约束
  // 块形态守卫（轮 47 #11）：null/非对象元素与未知 kind（{kind:"pdf"} 等）此前
  // 或在 b.kind 裸解引用崩溃（TypeError 而非本层声明的违例）、或穿透校验延迟到
  // 适配器穷尽断言抛裸 Error——在此统一拦截，适配器穷尽断言回归纯编译期防线
  const isBlockShape = (b: ContentBlock): b is TextBlock | ImageBlock =>
    typeof b === "object" && b !== null && (b.kind === "text" || b.kind === "image");
  const hasBadBlock = (blocks: ContentBlock[]): boolean => blocks.some((b) => !isBlockShape(b));
  const hasEmptyBlock = (blocks: ContentBlock[]): boolean =>
    blocks.some(
      (b) =>
        (b.kind === "text" && (typeof b.text !== "string" || b.text === "")) ||
        // 空/非 string 的 base64/mimeType image 块同为端点 400 形态（轮 25 #4 起，
        // 轮 46 #15 补类型形态）
        (b.kind === "image" &&
          (typeof b.base64 !== "string" ||
            b.base64 === "" ||
            typeof b.mimeType !== "string" ||
            b.mimeType === "")),
    );

  if (messages.length === 0) {
    throw violation("消息为空");
  }

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (!Array.isArray(msg.blocks)) {
        throw violation("user.blocks 非数组（宽化输入，端点 400 形态）");
      }
      if (msg.blocks.length === 0) {
        throw violation("user.blocks 为空");
      }
      if (hasBadBlock(msg.blocks)) {
        throw violation("user 消息含非块形态元素（null/非对象/未知 kind）");
      }
      if (hasEmptyBlock(msg.blocks)) {
        throw violation("user 消息含空块（空 text / 空 image 数据，Anthropic 端点 400 形态）");
      }
      i += 1;
      continue;
    }
    if (msg.role === "assistant") {
      if (!Array.isArray(msg.blocks)) {
        throw violation("assistant.blocks 非数组（宽化输入，端点 400 形态）");
      }
      const calls = msg.toolCalls ?? [];
      if (!Array.isArray(calls)) {
        throw violation("assistant.toolCalls 非数组（宽化输入，端点 400 形态）");
      }
      if (msg.blocks.length === 0 && calls.length === 0) {
        throw violation("assistant 的 blocks 与 toolCalls 同时为空");
      }
      if (hasBadBlock(msg.blocks)) {
        throw violation("assistant 消息含非块形态元素（null/非对象/未知 kind）");
      }
      if (hasEmptyBlock(msg.blocks)) {
        throw violation("assistant 消息含空块（空 text / 空 image 数据，端点 400 形态）");
      }
      if (calls.length > 0) {
        // id 空串：请求侧 tool_use id="" 会被官方端点 400（响应侧轮 12 已同款丢弃，
        // canonical 历史来自宿主回灌——在此拦截而非烧一次 400 后才暴露，轮 17 #8）
        if (calls.some((c) => typeof c.id !== "string" || c.id === "")) {
          throw violation("assistant 的 toolCall id 非字符串或为空串（端点 400 形态）");
        }
        // name 空串：Anthropic 工具名受 ^[a-zA-Z0-9_-]{1,128}$ 约束（openai/gemini
        // 同为必填非空）——空名 tool_use 回放历史同样烧 400；toolResult.toolName
        // 空串经下方配对一致性校验兜住（空名调用在此已先拦截，轮 18 #13）
        if (calls.some((c) => typeof c.name !== "string" || c.name === "")) {
          throw violation("assistant 的 toolCall name 非字符串或为空串（端点 400 形态）");
        }
        // signature 空串（轮 38 #4）：gemini 适配器对空串 thoughtSignature 原样
        // 保留/出站，空串值回传是 400 形态（LLMInvalidRequestError 非
        // ProtocolViolation，会误触 fallback 单向切换）——与 id/name 空串同动机，
        // canonical 层前置拦截
        if (calls.some((c) => c.signature !== undefined && typeof c.signature !== "string")) {
          throw violation(
            "assistant 的 toolCall signature 非字符串（gemini thoughtSignature 端点 400 形态；空串同档见下）",
          );
        }
        if (calls.some((c) => c.signature === "")) {
          throw violation(
            "assistant 的 toolCall signature 为空串（gemini thoughtSignature 端点 400 形态）",
          );
        }
        // args 非普通对象（轮 42 #4 + 轮 43 #6 收紧谓词：null/数组/原始值及
        // Date/Map/Set/类实例——JS 宿主可绕过 TS 类型回灌自构历史）。谓词与
        // cloneWorkMessages 透传分支共用 transforms.isPlainRecord 单源（transforms
        // 对 types 仅 type-only 导入，反向运行时导入无环）：宽谓词会把 Date/Map
        // 经浅拷贝静默展开成 {}（整棵 args 清空）。anthropic input/gemini args
        // 原样序列化出站即端点 400（非 infra 不退避还烧 fallback 切换）——响应
        // 侧轮 12 #13 已兜底，请求侧对称拦截
        if (calls.some((c) => !isPlainRecord(c.args))) {
          throw violation("assistant 的 toolCall args 非普通对象（端点 400 形态）");
        }
        // id→name 映射：配对校验同时要求 toolName 与 toolCall.name 一致——
        // gemini 的 functionResponse 按 name 关联，失配发到端点才 400（canonical 层拦截）
        const callsById = new Map(calls.map((c) => [c.id, c.name]));
        // Map 按 id 去重会让重复 id 的 toolCalls 一条结果即"恰好配对"假性通过，
        // 而适配器折叠同样按 id 建 Map——重复 id 下校验结论与 wire 输出会不一致
        if (callsById.size !== calls.length) {
          throw violation("assistant 的 toolCalls 存在重复 id");
        }
        const seen = new Set<string>();
        let j = i + 1;
        while (j < messages.length) {
          const cur = messages[j];
          if (cur.role !== "toolResult") {
            break;
          }
          // toolCallId/toolName 字符串性（轮 46 #15，先于配对）：非字符串在 Map
          // 配对/一致性比较中行为未定义（数字 id 与字符串 id 永不配对，落成误导
          // 性「孤儿」误报）
          if (typeof cur.toolCallId !== "string" || typeof cur.toolName !== "string") {
            throw violation(
              `toolResult 的 toolCallId/toolName 非字符串（toolCallId=${String(cur.toolCallId)}）`,
            );
          }
          const pairedName = callsById.get(cur.toolCallId);
          if (pairedName === undefined) {
            throw violation(
              `孤儿 toolResult（toolCallId=${cur.toolCallId} 不在紧邻 assistant 的 toolCalls 中）`,
            );
          }
          if (pairedName !== cur.toolName) {
            throw violation(
              `toolResult（toolCallId=${cur.toolCallId}）的 toolName=${cur.toolName} 与配对 toolCall 的 name=${pairedName} 不一致`,
            );
          }
          if (seen.has(cur.toolCallId)) {
            throw violation(`toolCall ${cur.toolCallId} 有重复结果`);
          }
          // 空文本/非字符串：anthropic 以字符串 content 直发 tool_result，空串是
          // 端点 400 形态（"content field is empty"）；非字符串在 getAction 路径的
          // includes 处裸 TypeError（轮 46 #15）。canonical 层拦截而非 400 后错误
          // 归因（轮 17 #8 起）
          if (typeof cur.text !== "string" || cur.text === "") {
            throw violation(`toolResult（toolCallId=${cur.toolCallId}）文本为空或非字符串`);
          }
          seen.add(cur.toolCallId);
          j += 1;
        }
        if (seen.size !== callsById.size) {
          throw violation(`assistant 的 ${callsById.size} 个 toolCall 仅收到 ${seen.size} 条结果`);
        }
        i = j;
      } else {
        i += 1;
      }
      continue;
    }
    // toolResult 不在带 toolCalls 的 assistant 之后
    throw violation(`孤儿 toolResult（toolCallId=${msg.toolCallId}，位置 ${i}）`);
  }
}
