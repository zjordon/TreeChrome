// 请求/响应侧变换：URL 缩写/还原、敏感值占位/还原、JSON 兜底解析、滤图、work 副本。
// 移植自 tree_walker/llm/client.py 同名私有方法（03 §3.2-3.4）；期望值锚定 Python 实跑，
// 见 test/llm/transforms.test.ts 头部命令与输出。

import type { ChatMessage, ContentBlock } from "./types.js";

/** URL 缩写阈值（Python _URL_MIN_LENGTH=100） */
export const URL_MIN_LENGTH = 100;

/** 纯对象判别（轮 16 #2 单源；轮 20 #9 上提为中立导出——transforms 属 canonical
 * 低层，adapters/common 反向引用恢复「adapters 依赖 core」的单向分层） */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** assistant 历史仅含 image 块时的占位文本（stripImageBlocks + 三适配器空
 * content/parts 兜底统一口径，轮 14 #8/#9；轮 20 #2 收敛为常量防四处漂移） */
export const IMAGE_OMITTED_PLACEHOLDER = "[image omitted]";

/** 滤空降级哨兵（轮 20 #15 共享实现）：仅「原始非空、替换后为空」降级，不掩蔽
 * 调用方自带的空文本违例（归因仍指向调用方）；client.ts 的 redactToolPayloads
 * 与 R4 回显分支同款复用（经 redactOrPreserve 函数），防三处判空条件/文案漂移
 * 破坏非空文本不变量。模块内常量（轮 32 #3 收窄）：测试锚定 "[redacted]"
 * 字面量是既定防漂移口径，导出面不再宽于实际复用面 */
const REDACTED_PLACEHOLDER = "[redacted]";

export function redactOrPreserve(original: string, replaced: string): string {
  return original !== "" && replaced === "" ? REDACTED_PLACEHOLDER : replaced;
}

/**
 * URL 缩写：长度 ≥100 的 URL 换 [uN] 短标记，同 URL 同 tag（省 token），
 * tag 分配顺序 = 首次出现顺序（契约，锚定测试锁定）。只碰 user/assistant 的
 * TextBlock（Python 只处理 type=text block；toolResult 的 text 不动——对齐原实现）。
 * 就地改写传入的 work 消息（调用方保证是副本），返回 tag→原 URL 映射供还原。
 */
export function shortenUrlsInMessages(messages: ChatMessage[]): Map<string, string> {
  const urlMap = new Map<string, string>(); // tag → 原 URL
  const urlToTag = new Map<string, string>(); // 原 URL → tag
  let counter = 0;
  // 尾界排除常见全角标点/引号/括号 + CJK 表意字符（有意偏离 Python 的 \S+，
  // 03 §4 偏离 10；Han/假名/谚文为轮 29 #7 补入）：中文书写里 URL 后紧跟「，。」
  // 或直接紧邻表意字符（无标点无空白）时，\S+ 会把后续中文吞进「URL」整体换
  // tag——请求侧静默删中文、还原侧产出带中文尾巴的损坏 URL。ASCII 标点保持
  // Python 同款吞入（尾随句点等，锚定不破坏）；代价是含原始 CJK 路径的 IRI
  // 在首个 CJK 字符处截断（浏览器常规百分号编码，裸 IRI 少见，取舍同偏离 10）
  const shorten = (text: string): string =>
    text.replace(
      /https?:\/\/[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。；：、！？“”‘’（）「」『』【】《》]+/gu,
      (url) => {
        if (url.length < URL_MIN_LENGTH) {
          return url;
        }
        const existing = urlToTag.get(url);
        if (existing !== undefined) {
          return existing;
        }
        const tag = `[u${counter}]`;
        counter += 1;
        urlMap.set(tag, url);
        urlToTag.set(url, tag);
        return tag;
      },
    );

  for (const msg of messages) {
    if (msg.role === "toolResult") {
      continue;
    }
    for (const block of msg.blocks) {
      if (block.kind === "text") {
        block.text = shorten(block.text);
      }
    }
  }
  return urlMap;
}

/**
 * 敏感值文本替换的单一实现（轮 13 #10）：滤空 real 键 + 回调式 replaceAll
 * 防 $ 替换模式 + 按对象插入序（键有包含关系时顺序影响结果，Python dict 序
 * 等价，锚定测试覆盖正反两序）。请求侧占位 / R4 回显占位 / redactToolPayloads
 * 三处共用，防语义失同步。
 * 注意（轮 15 #10，轮 21 #15 表述收窄）：canonical 数组索引键（≤10 位非负
 * 数字串，引擎重排到枚举首位升序）存在包含关系键时替换序不可依赖；负数与
 * 超界数字串（手机号/卡号）是普通字符串键，恒插入序无此风险。
 */
/** 敏感值 entries 构造单源（轮 32 #5）：滤空 real + 插入序，文本侧与深层侧
 * 共用——各写一份时任一侧调整过滤条件/顺序会静默漂移 */
function filteredSensitiveEntries(
  sensitiveMap: Record<string, string>,
): ReadonlyArray<readonly [string, string]> {
  return Object.entries(sensitiveMap)
    .filter(([real]) => real !== "")
    .map(([real, placeholder]) => [real, placeholder] as const);
}

export function replaceSensitiveText(
  text: string,
  sensitiveMap: Record<string, string> | undefined,
): string {
  if (!sensitiveMap) {
    return text;
  }
  // 委托 rewriteStrings 字符串分支（轮 32 #5）：「real→placeholder 顺序替换」
  // 此前在文本侧/深层侧各维护一份平行实现，注释宣称的「单一实现」名不符实
  return rewriteStrings(text, filteredSensitiveEntries(sensitiveMap)) as string;
}

/**
 * 敏感值深层替换：args 等嵌套 JSON 结构内的字符串走 real→placeholder（轮 15 #7，
 * redactToolPayloads 的 args 分支）。经 rewriteStrings 游走（方向中立，轮 16 #8）：
 * 普通对象递归重建、数组逐项、非普通对象（Map/Set/Date 等）与非字符串原样保留。
 * **覆盖边界（轮 17 #16）**：只重写字符串**值**，对象键名原样保留——敏感 real 值
 * 出现在键位（如 {"sk-abc": …}）时不替换；扩展键名改写需评估 restore 方向共用
 * 游走的影响，P4 收口时一并裁决
 */
export function replaceSensitiveDeep<T>(
  value: T,
  sensitiveMap: Record<string, string> | undefined,
): T {
  if (!sensitiveMap) {
    return value;
  }
  const entries = filteredSensitiveEntries(sensitiveMap);
  if (entries.length === 0) {
    return value;
  }
  return rewriteStrings(value, entries) as T;
}

/**
 * 敏感值占位：TextBlock 文本内 real→placeholder。
 * 就地改写 work 消息；map 为空/undefined 时不动。
 *
 * 已知取舍（对齐 Python `_filter_sensitive_in_messages` 只处理 type=text block）：
 * toolResult.text 与 assistant.toolCalls[].args **不占位**——工具输出与回灌的
 * 真实 args 会明文发往端点（client.ts 以 WARNING + redactToolPayloads 分流兜底，
 * 后者覆盖两者的 opt-in 占位）。Python 原实现如此（P5 parity），修约属上游
 * 契约变更；P4 接 SecretProvider 时一并裁决。
 */
export function applySensitiveInMessages(
  messages: ChatMessage[],
  sensitiveMap: Record<string, string> | undefined,
): void {
  if (!sensitiveMap) {
    return;
  }
  // 空字符串 real 键会让 replaceAll 逐字符插入占位符（无声损坏全文）——宿主侧
  // 失误防御（Python 不滤）。空占位符条目**保留**：语义即删除敏感值
  //（replaceAll(real, '')，Python 同款不可逆语义），还原侧无从恢复、跳过该条。
  // 删除结果为空串时降级 "[redacted]"：空文本块会打破 canonical 非空不变量
  //（types.ts 轮 13 #6），适配器二次校验抛出的违例会错误归因到调用方历史
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      continue;
    }
    for (const block of msg.blocks) {
      if (block.kind === "text") {
        block.text = redactOrPreserve(block.text, replaceSensitiveText(block.text, sensitiveMap));
      }
    }
  }
}

/**
 * 方向中立的字符串重写游走（轮 16 #8）：replace（real→placeholder）与 restore
 * （placeholder→real / tag→URL）两方向共用，方向语义由调用方传入的 entries
 * 决定、收敛在各自包装函数内——游走本体不得掺入任一方向的特有逻辑
 *（如占位符格式校验），否则静默污染另一方向。
 */
function rewriteStrings(
  obj: unknown,
  replacements: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof obj === "string") {
    let out = obj;
    for (const [from, to] of replacements) {
      // 回调形式做字面替换：字符串 replacement 会解释 $$/$&/$' 等特殊模式，
      // 真实敏感值/URL 含 $ 序列时会被静默篡改（Python str.replace 是字面替换）
      out = out.replaceAll(from, () => to);
    }
    return out;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => rewriteStrings(item, replacements));
  }
  if (isRecord(obj)) {
    // 仅递归普通对象：Map/Set/Date 等非普通对象的 entries 为空，按原逻辑重建会
    // 静默清空成 {}（现调用点只喂纯 JSON 产物，此处防御未来复用踩坑）。
    // 注意（轮 18 #5）：null 原型对象（Object.create(null)）按普通对象重建，产出
    // 以 Object.prototype 为原型——复用扩展时注意原型被静默替换。
    // 注意（轮 25 #5）：Object.entries 仅枚举可枚举字符串键——symbol 键与不可枚举
    // 属性在重建时静默丢失（当前调用域为纯 JSON 产物，复用扩展时一并评估）
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      return obj;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // "__proto__" 键走 defineProperty（轮 30 #9，同 schema-sanitize 轮 22 #5）：
      // JSON.parse 产物可含自有 __proto__ 键（模型输出的 JSON 完全可控该键名），
      // 直接赋值命中普通字面量的原型 setter——子树静默丢失 + out 原型被输入改写
      if (k === "__proto__") {
        Object.defineProperty(out, k, {
          value: rewriteStrings(v, replacements),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        out[k] = rewriteStrings(v, replacements);
      }
    }
    return out;
  }
  return obj;
}

/** 响应侧 URL 还原：toolInput 递归把 [uN] 换回原 URL（对象/数组/嵌套全走） */
export function restoreUrlsInOutput<T>(output: T, urlMap: Map<string, string>): T {
  if (urlMap.size === 0) {
    return output;
  }
  return rewriteStrings(output, [...urlMap.entries()]) as T;
}

/** 响应侧敏感值还原：placeholder→real，结构与 restoreUrlsInOutput 同 */
export function restoreSensitiveInOutput<T>(
  output: T,
  sensitiveMap: Record<string, string> | undefined,
): T {
  if (!sensitiveMap) {
    return output;
  }
  // entries 是 real→placeholder，还原方向取反（顺序仍按插入序，与 Python dict 一致）。
  // 空键过滤是还原侧防御（replaceAll('', x) 逐字符插入会损坏全文；Python 不滤）：
  // 滤空 real 与空占位符两类——后者的请求侧语义是删除敏感值（不可逆），无从还原。
  // 恢复集为空时早退（与 restoreUrlsInOutput 对称）：删除语义配置下省掉整树深重建
  // **占位符须唯一**（轮 20 #14）：多个 real 共享同一 placeholder 时，reversed 的
  // 重复 from 键顺序 replaceAll 先插入者恒胜，后续条目静默失效——还原结果张冠
  // 李戴的数据损坏；此处纯函数无告警通道，唯一性检测在 client.getAction 入口
  const reversed = Object.entries(sensitiveMap)
    .filter(([real, placeholder]) => real !== "" && placeholder !== "")
    .map(([real, placeholder]) => [placeholder, real] as const);
  if (reversed.length === 0) {
    return output;
  }
  return rewriteStrings(output, reversed) as T;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * JSON 兜底解析（Python _try_parse_json 三级，逐级回退）：
 * 1. trim 后以 { 开头 → 直接 parse；
 * 2. ```(json)? 围栏内的 {…}（非贪婪）；
 * 3. 首个 { … 末个 } 的子串。
 * 全部失败返回 undefined。注意 "{}" 会解析成功返回空对象——调用方按
 * Python `if parsed:` 语义把空对象视为失败（client.ts 处理）。
 */
export function tryParseJson(text: string): Record<string, unknown> | undefined {
  const stripped = text.trim();
  if (stripped.startsWith("{")) {
    const direct = parseJsonObject(stripped);
    if (direct !== undefined) {
      return direct;
    }
  }
  // 无 /s（dotAll）：Python 基线 ```(?:json)?\s*(\{.*?\})\s*``` 的 `.` 不匹配换行，
  // 围栏内多行对象在二级不命中、落三级（首 { … 末 }）——逐字对齐（轮 15 #16）
  const fence = /```(?:json)?\s*(\{.*?\})\s*```/.exec(stripped);
  if (fence !== null) {
    const parsed = parseJsonObject(fence[1]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const parsed = parseJsonObject(stripped.slice(start, end + 1));
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * 「work 中是否存在可滤图片」的共享判定（轮 14 #11）：与 stripImageBlocks 的
 * 跳过规则（toolResult 不算）同处维护——滤图 WARNING 与致盲 advisory 两处
 * 调用点复用，防判定与实际滤图行为漂移。
 */
export function hasImageBlocks(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role !== "toolResult" && m.blocks.some((b) => b.kind === "image"));
}

/**
 * 滤图（fallback 切到无视觉模型后调用，Python _strip_image_blocks）：
 * 从 work 消息移除全部 ImageBlock。智谱端点对「文本模型+图」静默致盲不报错
 * （P0 实测），不滤只会得到困惑回答。块滤空 = image-only 历史（截图型 agent
 * 常见）——降级为占位文本块继续而非抛错（Python 同款降级为空串；一次瞬时 429
 * 触发 fallback 切换不该被放大成步级硬失败）。
 */
export function stripImageBlocks(messages: ChatMessage[]): void {
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      continue;
    }
    const kept = msg.blocks.filter((b) => b.kind !== "image");
    if (kept.length !== msg.blocks.length) {
      if (kept.length === 0) {
        msg.blocks = [{ kind: "text", text: IMAGE_OMITTED_PLACEHOLDER }];
        continue;
      }
      msg.blocks = kept;
    }
  }
}

/**
 * work 副本：请求侧变换只落在副本上，不改动调用方消息（03 偏离 1）。
 * 复制会被改写的对象（消息对象、blocks 数组、TextBlock）；ImageBlock 与
 * toolResult 的字符串字段不可变，共享/浅拷贝即可。
 */
/** blocks 拷贝单点（轮 32 #1）：「TextBlock 拷贝、ImageBlock 共享」的偏离 1 契约
 * 只在此一处维护——两分支各写一份时未来只改一处会静默破坏副本语义 */
const cloneBlocks = (blocks: ContentBlock[]): ContentBlock[] =>
  blocks.map((b) => (b.kind === "text" ? { ...b } : b));

export function cloneWorkMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === "toolResult") {
      return { ...msg };
    }
    if (msg.role === "assistant") {
      return {
        ...msg,
        blocks: cloneBlocks(msg.blocks),
        // toolCalls 防御性拷贝（数组 + 调用对象 + args 顶层，轮 15 #9）：请求侧
        // 变换扩展到 args 时（redactToolPayloads 的深层替换）原地改写不会泄漏
        // 回调用方原始消息——「变换只落在副本上（03 偏离 1）」不再靠隐式约定维持。
        // 注意（轮 32 #1）：args 仅顶层浅拷贝，嵌套对象在副本与原件间共享——
        // replaceSensitiveDeep 为重建式改写故现无泄漏，引入就地改写嵌套 args 的
        // 变换前必须先加深拷贝
        toolCalls: msg.toolCalls?.map((c) => ({ ...c, args: { ...c.args } })),
      };
    }
    return {
      ...msg,
      blocks: cloneBlocks(msg.blocks),
    };
  });
}
