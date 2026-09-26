// 敏感值观测单源（轮 43 #8 自 client.ts 拆出，client.ts >1000 行软门槛处置）：
// 十类病态检测 + systemPrompt/tool 定义命中告警 + 工具载荷泄露扫描（含
// redactToolPayloads 的检测/替换同域逻辑），自持按 (map 身份[, 类别/工具名]) 的
// WeakSet/WeakMap 去重状态——仅依赖注入 log，与 LLMClient 状态机正交。

import {
  isRecord,
  nonEmptySensitiveReals,
  redactOrPreserve,
  replaceSensitiveDeep,
  replaceSensitiveText,
  safeJsonStringify,
  URL_MIN_LENGTH,
} from "./transforms.js";
import type { ChatMessage, ToolDefinition } from "./types.js";

export class SensitiveObservability {
  /** systemPrompt 敏感命中 WARNING 的按 map 去重（轮 18 #3；轮 29 #6 改 WeakSet）：
   *  (systemPrompt, sensitiveMap) 是 per-call 输入，单一布尔会让首个命中掩蔽后续
   *  不同 map 的命中——按 map 身份去重，同一 map 跨步复用只告警一次（防刷屏），
   *  新 map 各自获得一次告警机会 */
  private readonly systemPromptLeaks = new WeakMap<object, Set<string>>();
  /** tool 定义（parameters/description）敏感命中的按 map 去重（轮 39 #5，与
   *  systemPromptLeaks 同口径）：明文出站面至少留证据的对称补口 */
  private readonly schemaLeaks = new WeakMap<object, Set<string>>();
  /** sensitiveMap 病态 WARNING 的按 (map, 类别) 去重（轮 20 #10/#14 起源；
   *  轮 29 #4 拆分类别、轮 31 #10 补 map 维度，与 systemPromptLeaks 同口径）：
   *  sensitiveMap 是 per-call 选项，实例级单一/总类别标志会让首个 map 的命中
   *  掩蔽后续 map 的病态或其它类别 */
  private readonly mapPathologies = new WeakMap<object, Set<string>>();
  /** 工具载荷泄露 WARNING 的按 (map, 工具名) 去重（轮 40 #17，与 mapPathologies
   *  同构）：历史回灌只累积不消失，逐步重复告警会刷屏淹没其它一次性证据 */
  private readonly toolPayloadLeaks = new WeakMap<object, Set<string>>();

  constructor(private readonly log: (message: string) => void) {}

  /** sensitiveMap 病态配置的一次性 WARNING（轮 20 #10/#14 起源，轮 27 #5 提取，
   *  轮 43 #8 拆至本模块；①-⑩ 各类机理内联注明来源轮次——transforms 纯函数
   *  无告警通道，检测上提到有 log 的入口；轮 21 #8 各检测独立执行，防一类病态
   *  掩盖另一类）。reals 滤空串键（轮 25 #6）：空 real 全链路从不参与替换。
   *  成本取舍（轮 32 #4 显式裁决）：交叉冲突/占位符嵌套是 O(n²) 字符串包含检测，
   *  且每次 getAction 全量重跑（去重的只是告警不短路检测）——维持重跑是有意
   *  支持宿主原地修改同一 map 后新增**类别**仍可观测（已告警类别的增量实例
   *  不重复告警——类别已在去重集）*/
  warnMapPathologies(sensitive: Record<string, string> | undefined): void {
    if (sensitive === undefined) {
      return;
    }
    let warned = this.mapPathologies.get(sensitive);
    if (warned === undefined) {
      warned = new Set();
      this.mapPathologies.set(sensitive, warned);
    }
    const once = (category: string, hit: boolean, message: string): void => {
      if (hit && !warned.has(category)) {
        warned.add(category);
        this.log(message);
      }
    };
    const reals = nonEmptySensitiveReals(sensitive);
    // ⑪ 空白 real（轮 46 #4）：" "（纯空格等）会使 replaceAll 逐空格命中全文——
    //    灾难性文本损坏；空串已滤（轮 25 #6），纯空白是同家族失误且检测廉价
    //    （极短 real 不另设长度阈值——⑦ 已覆盖 ph 短维度的对称风险）
    const hasWhitespaceReal = reals.some((real) => real.trim() === "");
    // ① canonical 数组索引键（非负整数 < 2^32-1 的数字串，上界 4294967294）：
    //    JS 引擎把它们重排到枚举首位升序（Python dict 恒插入序），含包含关系键时
    //    替换顺序静默偏离插入序——负数与超界数字串（11 位手机号/16-19 位卡号）
    //    是普通字符串键恒插入序，无此风险
    // array index 上界是 2^32-2（轮 43 #14）：ECMA-262 重排只作用于 0 ≤ i < 2^32-1
    // 的数组索引——键 "4294967295"（= 2^32-1）不是 canonical 数组索引，引擎按普通
    // 字符串键保持插入序，误判为重排风险是假阳性
    const ARRAY_INDEX_KEY_RE = /^(?:0|[1-9]\d*)$/;
    const isArrayIndexKey = (real: string): boolean =>
      ARRAY_INDEX_KEY_RE.test(real) && Number(real) <= 4294967294;
    const hasIntKey = reals.some(isArrayIndexKey);
    const placeholders = reals.map((real) => sensitive[real]).filter((ph) => ph !== "");
    const hasConflict = new Set(placeholders).size !== placeholders.length;
    // ② 占位符冲突（多 real 共享同一 placeholder）：还原侧顺序 replaceAll 先
    //    插入者恒胜，后续条目静默失效——还原结果张冠李戴的数据损坏
    // ③ 交叉冲突（轮 25 #3，轮 26 #4 放宽到子串）：占位符与另一条目的真实值
    //    存在包含关系（精确相等只是特例）——占位符含其它 real 时先占位出的值
    //    被再次替换（替换链）；其它 real 含占位符时先插入的占位符破坏后续 real
    //    的完整匹配——双向静默损坏。归属排除用条目键（other !== real）而非值
    //    比较：评审原式 real !== ph 会把跨条目精确撞值一并排除——自包含
    //    （ph 含自身 real）才是无害形态，单趟 replaceAll 不重扫插入内容
    const hasCrossConflict = reals.some((real) => {
      const ph = sensitive[real];
      if (ph === "") {
        return false;
      }
      return reals.some(
        (other) => other !== real && (ph === other || ph.includes(other) || other.includes(ph)),
      );
    });
    // ④ URL 缩写 tag 撞型（轮 26 #1）：占位符形如 [uN]（tag 计数从 [u0] 起）——
    //    okResult 同序还原（先 URL 后敏感）会把模型输出中的该占位符先消费成
    //    长 URL，敏感还原失配，真实值永不还原且被 URL 顶替。嵌入形态检测
    //    （轮 31 #9）：restoreUrlsInOutput 用 replaceAll 匹配任意出现位置——
    //    "xx[u0]yy" 形态的占位符同样会被 [u0]→长 URL 还原消费，不能只锚定
    //    整串形态（"[value0]" 等仍不会误命中）
    const hasUrlTagCollision = placeholders.some((ph) => /\[u\d+\]/.test(ph));
    // ⑩ 真实值含 [uN] 形态（轮 40 #9，④ 的镜像方向）：URL 缩写先产出的 tag 会被
    //    敏感替换消费（real 恰为 tag 时整条失配、urlMap 挂空），还原侧 toolInput
    //    得到裸 tag 而非真实 URL——与 ④ 同属静默数据损坏；宁可误报口径与 ③ 一致
    const hasRealUrlTagForm = reals.some((real) => /\[u\d+\]/.test(real));
    // ⑤ 占位符互相包含（轮 31 #14）：还原侧顺序 replaceAll 先短者胜，嵌套占位符
    //    （"AB" 与 "ABc"）被内层先还原撕裂后外层失配，真实值永不还原——与 ③ 同属
    //    替换链静默损坏；括号定界形态（[SECRET-1]/[SECRET-10]）天然免疫误报
    const hasPlaceholderNesting = placeholders.some((ph) =>
      placeholders.some((other) => other !== ph && (other.includes(ph) || ph.includes(other))),
    );
    // ⑥ 跨条目 real 互相包含（轮 33 #3）：短 real 插入序在前时请求侧先撕裂长 real
    //    （"sk-abc" 先吃掉 "sk-abcdef" → "[K1]def"），长条目失配 → 敏感值明文残留
    //    出站（泄露方向，比既有各类的数据损坏更重）；方向判定 jdx < idx 精确到
    //    有害形态（短者在后无害），共享前缀的 key/路径类配置是常见来源
    const hasRealNesting = reals.some((real, idx) =>
      reals.some((other, jdx) => jdx < idx && real.includes(other)),
    );
    // ⑦ 自条目占位符为真实值的真子串（轮 33 #4）：请求侧正常但还原侧 replaceAll
    //    (ph, real) 会把模型输出中天然出现的该子串全部还原（过度替换，toolInput
    //    数据损坏）；ph 极短时是灾难性替换。ph === real（恒等映射）与空 ph 无害排除。
    //    「自包含无害」的论证只覆盖替换链完整性（单趟 replaceAll 不重扫插入内容），
    //    不覆盖 ⑧ 的脱敏失效维度
    const hasSelfContainedPh = reals.some((real) => {
      const ph = sensitive[real];
      return ph !== "" && ph !== real && real.includes(ph);
    });
    // ⑧ 自条目占位符包含自身真实值（轮 35 #14，与 ⑦ 互补的泄露方向）：请求侧
    //    replaceAll(real, ph) 产出的占位符内嵌明文真实值，随出站内容完整保留——
    //    脱敏对该条目完全失效（{"sk-abc123": "[key:sk-abc123]"} 形态，比数据损坏
    //    更重）；ph === real（恒等映射）与空 ph 无害排除
    const hasPhContainingReal = reals.some((real) => {
      const ph = sensitive[real];
      return ph !== "" && ph !== real && ph.includes(real);
    });
    // ⑨ 真实值本身是长 URL（轮 38 #7，与 ④ 同属 URL 缩写交互病态）：请求侧
    //    变换顺序是先 shortenUrls（URL→[uN]）后敏感替换（real→ph）——real 为
    //    ≥URL_MIN_LENGTH 的 URL 时文本中先被换成 [uN]，敏感替换失配，占位语义
    //    静默偏离（出站是 [uN] 而非配置的 placeholder，真实值不会明文出站但宿主
    //    的占位契约失效且还原侧 ph 无处安放）
    const hasRealUrlForm = reals.some(
      (real) => real.length >= URL_MIN_LENGTH && /^https?:\/\//.test(real),
    );
    once(
      "whitespaceReal",
      hasWhitespaceReal,
      "[llm] WARNING: sensitiveMap 存在纯空白的真实值键（如纯空格）——replaceAll 将逐字符命中全文造成灾难性文本损坏，请检查配置",
    );
    once(
      "intKey",
      hasIntKey,
      "[llm] WARNING: sensitiveMap 含 canonical 数组索引键（0–4294967294 的非负整数串，上界 2^32-2）——JS 引擎会将其重排到枚举首位（与插入序不一致），存在包含关系键时替换顺序不可依赖；负数与超界数字串（手机号/卡号）无此风险",
    );
    once(
      "conflict",
      hasConflict,
      "[llm] WARNING: sensitiveMap 存在占位符冲突（多个真实值映射到同一占位符）——还原侧先插入者胜、后续条目静默失效，还原结果可能张冠李戴",
    );
    once(
      "crossConflict",
      hasCrossConflict,
      "[llm] WARNING: sensitiveMap 存在交叉冲突（占位符与另一条目的真实值存在包含关系）——顺序替换形成替换链，占位与还原双向静默数据损坏",
    );
    once(
      "urlTagCollision",
      hasUrlTagCollision,
      "[llm] WARNING: sensitiveMap 占位符含 [uN] 形态，与 URL 缩写 tag 撞型——还原侧先 URL 后敏感，占位符会被长 URL 顶替、真实值丢失，请改用其他占位符形态",
    );
    once(
      "realUrlTagForm",
      hasRealUrlTagForm,
      "[llm] WARNING: sensitiveMap 的真实值含 [uN] 形态，与 URL 缩写 tag 撞型——请求侧 tag 会被敏感替换消费，还原侧该 URL 永不还原，请改用与 [uN] 无关的真实值形态或调整占位策略",
    );
    once(
      "placeholderNesting",
      hasPlaceholderNesting,
      "[llm] WARNING: sensitiveMap 存在占位符互相包含（嵌套占位符）——还原侧顺序替换先短者胜，外层占位符被撕裂后失配，真实值永不还原",
    );
    once(
      "realNesting",
      hasRealNesting,
      "[llm] WARNING: sensitiveMap 存在真实值互相包含（短者在插入序之前）——请求侧顺序替换先撕裂长真实值，长条目失配后敏感值明文残留出站，请调整插入顺序或收窄条目",
    );
    once(
      "selfContainedPh",
      hasSelfContainedPh,
      "[llm] WARNING: sensitiveMap 存在占位符为自身真实值子串的条目——还原侧会把输出中天然出现的该子串一并还原为真实值（toolInput 数据损坏），请改用与真实值无包含关系的占位符形态",
    );
    once(
      "phContainingReal",
      hasPhContainingReal,
      "[llm] WARNING: sensitiveMap 存在占位符包含自身真实值的条目——占位后明文真实值仍完整出站，脱敏对该条目失效，请改用与真实值无包含关系的占位符形态",
    );
    once(
      "realUrlForm",
      hasRealUrlForm,
      "[llm] WARNING: sensitiveMap 的真实值本身是长 URL（≥URL_MIN_LENGTH）——请求侧 URL 缩写先行会把它替换为 [uN] 标签，敏感占位失配：出站是 [uN] 而非配置的占位符，还原侧该条目不会生效；如需占位请缩短或拆分该 URL（URL 缩写阈值当前为常量、不可配置）",
    );
  }

  /** systemPrompt 命中告警：不在占位范围（三适配器原样透传，轮 18 #3 核实）——
   *  命中留 WARNING；去重按 (map, real)（轮 46 #3，与 mapPathologies/toolPayloadLeaks
   *  对称）：同命中重复回灌压制，宿主原地扩展同一 map 的新增命中仍可观测；消息
   *  文本不含告警内容，观测通道自身不泄露明文 */
  warnSystemPromptHit(systemPrompt: string, sensitive: Record<string, string> | undefined): void {
    if (sensitive === undefined) {
      return;
    }
    const seen = this.systemPromptLeaks.get(sensitive) ?? new Set<string>();
    const fresh = nonEmptySensitiveReals(sensitive).filter(
      (real) => systemPrompt.includes(real) && !seen.has(real),
    );
    if (fresh.length > 0) {
      for (const real of fresh) {
        seen.add(real);
      }
      this.systemPromptLeaks.set(sensitive, seen);
      this.log(
        "[llm] WARNING: systemPrompt 含 sensitiveMap 命中值，将明文出站（systemPrompt 不在占位范围，由宿主自担）",
      );
    }
  }

  /** tool 定义（name/parameters/description）的明文出站面命中检测（轮 39 #5 起，
   *  轮 41 #1 上提覆盖主路径）：tools 路径把同一份 parameters/description 原文
   *  放进请求体、no-tools 承重墙内嵌 systemPrompt——同一「明文出站面至少留
   *  证据」口径；命中维度 (map, real)（轮 46 #3，与 systemPromptLeaks 对称）；
   *  串化崩溃安全（BigInt/循环引用） */
  warnToolDefinitionLeak(
    tool: ToolDefinition,
    sensitive: Record<string, string> | undefined,
  ): void {
    if (sensitive === undefined) {
      return;
    }
    // 该 map 的全部候选 real 已告警过时免重复游走（轮 44 #9 短路语义的等价保留
    // ——本方法经 buildChatRequest 每轮退避重建调用）
    const seen = this.schemaLeaks.get(sensitive);
    const candidates = nonEmptySensitiveReals(sensitive);
    if (seen !== undefined && candidates.every((real) => seen.has(real))) {
      return;
    }
    // 原始字符串值域检测（轮 47 #12，与 replaceSensitiveDeep 替换域对齐——轮 16
    // #6 同族雷）：对 JSON.stringify 文本做 includes 时，real 含引号/反斜杠/换行
    // 会被转义恒失配（漏报且无告警）；BigInt/循环引用则令串化 undefined 检测
    // 整体失能。游走收集全部字符串值（环守卫）后匹配
    const strings: string[] = [];
    const collect = (v: unknown, visited: WeakSet<object>): void => {
      if (typeof v === "string") {
        strings.push(v);
      } else if (Array.isArray(v) || isRecord(v)) {
        if (!visited.has(v)) {
          visited.add(v);
          for (const child of Array.isArray(v) ? v : Object.values(v)) {
            collect(child, visited);
          }
        }
      }
    };
    collect(tool, new WeakSet());
    const fresh = candidates.filter(
      (real) => !seen?.has(real) && strings.some((s) => s.includes(real)),
    );
    if (fresh.length > 0) {
      const merged = seen ?? new Set<string>();
      for (const real of fresh) {
        merged.add(real);
      }
      this.schemaLeaks.set(sensitive, merged);
      this.log(
        "[llm] WARNING: tool 定义（parameters/description）含 sensitiveMap 命中值，将随请求明文出站（schema 不在占位范围，由宿主自担）",
      );
    }
  }

  /** 工具载荷（toolResult 文本 + assistant.toolCalls[].args）泄露扫描：默认不在
   *  占位范围（P5 parity）——命中时按 redact 分流（缺省明文出站但留 WARNING，
   *  P4 SecretProvider 收口；opt-in 则占位阻断）。单趟遍历：检测命中时即时替换
   *  （对未命中载荷恒等，检测/替换不分离）。args 的泄露链路：okResult 把占位符
   *  还原为真实值 → 调用方回灌 assistant 历史 → 下一轮 args 明文出站 */
  scanToolPayloads(
    work: ChatMessage[],
    sensitive: Record<string, string> | undefined,
    redact: boolean,
  ): void {
    if (sensitive === undefined) {
      return;
    }
    const reals = nonEmptySensitiveReals(sensitive);
    const leaking: string[] = [];
    for (const m of work) {
      if (m.role === "toolResult") {
        if (reals.some((real) => m.text.includes(real))) {
          leaking.push(m.toolName);
          if (redact) {
            // 删除式 sensitiveMap 把整条 toolResult 滤成空串时降级 [redacted]
            //（redactOrPreserve 与 applySensitiveInMessages/R4 回显三处同源，
            // 轮 20 #15）：空 text 出站若被拒收，错误会归因到调用方历史
            m.text = redactOrPreserve(m.text, replaceSensitiveText(m.text, sensitive));
          }
        }
        continue;
      }
      if (m.role === "assistant") {
        for (const call of m.toolCalls ?? []) {
          // 先替换后比较（轮 16 #6）：以实际发生的替换为命中证据，检测与替换
          // 同域。旧 JSON.stringify(args).includes(real) 与文本替换域不一致：
          // real 含引号/反斜杠/换行时串化转义后失配（既漏报也无告警）；命中
          // 键名或 number 值时反向谎报「已占位」而明文仍出站
          const before = safeJsonStringify(call.args);
          const redacted = replaceSensitiveDeep(call.args, sensitive);
          const after = safeJsonStringify(redacted);
          // args 是宿主回灌历史（非 JSON-only 来源）：BigInt 会使 stringify 抛
          // TypeError（轮 38 #1，轮 37 #6 同款雷）——串化失败跳过该条目的
          // 泄漏检测（告警缺失优于崩溃）；redact 时仍照常替换
          //（深层替换不依赖串化，未命中时恒等）
          if (before !== undefined && after !== undefined && after !== before) {
            leaking.push(`${call.name}.args`);
          }
          if (redact) {
            call.args = redacted;
          }
        }
      }
    }
    if (leaking.length > 0) {
      // 同名工具多轮命中的调用内去重（轮 16 #9）+ 跨调用按 (map, 工具名)
      // 去重（轮 40 #17）：同一泄露源逐步回灌只告警一次，新 map/新工具名
      // 各自获得一次告警机会；「已占位」分支同款去重（逐步重复的信息量更低）
      const seen = this.toolPayloadLeaks.get(sensitive) ?? new Set<string>();
      const fresh = [...new Set(leaking)].filter((n) => !seen.has(n));
      if (fresh.length > 0) {
        for (const n of fresh) {
          seen.add(n);
        }
        this.toolPayloadLeaks.set(sensitive, seen);
        const names = fresh.join(", ");
        if (redact) {
          this.log(`[llm] 工具载荷(${names}) 敏感值已占位（redactToolPayloads）`);
        } else {
          this.log(
            `[llm] WARNING: 工具载荷(${names}) 包含敏感值，将以明文出站（toolResult/args 不在占位范围，redactToolPayloads:true 可阻断；P4 接 SecretProvider 时收口）`,
          );
        }
      }
    }
  }
}
