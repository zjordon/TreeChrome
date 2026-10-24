// 蒸馏 prompt 常量（issue #5 S1，架构 §6.3）：结构移植自 treeforge/harness/distiller.py
// 任务级模板（_TASK_PROMPT_TEMPLATE / _TASK_SLUG_RULES / _CONSUMER_CONTEXT /
// _SELECTORS_SPEC / _QUIRKS_SPEC / _RULES_BLOCK / 增量 addendum）。TreeForge 是参考
// 不是契约——本文件是新创作面，不进 prompt-consts.ts 的 Python 字节锚定生成器。
// 已知裁剪：①消费端动作词汇表以本仓 ACTION_DEFINITIONS（25 动作）为准——与
// TreeWalker 24 动作的差异由 distill.test.ts 词汇表守卫测试钉住同步义务；②TreeForge
// 的 # Page context（DOM 快照阶段对比）段未移植——agent trace 无逐步快照
//（SCRATCHPAD §1 已登记局限，阶段 0 验证对象）。

import { catalogLine, type TaskCardMeta } from "./types.js";

export const DISTILL_SYSTEM_PROMPT =
  "You are a site-specific knowledge distiller for browser automation. " +
  "You produce READY-TO-USE site knowledge, NOT generic SOPs. " +
  "Output STRICT JSON only, no prose, no markdown fences.";

/** 增量 addendum 旧卡全文的字符预算（任务卡整体小——单预算不分文件） */
export const PREV_CARD_BUDGET = 12_000;

// —— 消费端上下文：动作词汇表 +「session 层已自动处理别写」（TreeForge P3.7 洞察：
// 「别写」比「能做」更值钱——写进卡反而浪费消费端注意力预算甚至误导）——
export const CONSUMER_CONTEXT = `# Consumer context — the agent that will use this skill

The consumer is the TreeChrome agent (TreeWalker lineage). It drives the browser via a fixed action vocabulary (ACTION_DEFINITIONS, 25 actions). When you describe a method requirement (e.g. "must upload via direct injection"), reference the action by its EXACT name so the agent recognizes it.

## Action vocabulary (distill-relevant subset)

Navigation / tabs:
- \`navigate(url)\` — go to a URL in the current tab (or open it in a new tab).
- \`go_back()\` — navigate back to the previous page in history.
- \`switch_tab(tab_id)\` — switch to a different browser tab (suffix match on tab id).
- \`close_tab(tab_id)\` — close a browser tab.

Element interaction (target by \`index\` from the DOM tree, or \`element_id\` from find_elements):
- \`click(index)\` — click an element by its index.
- \`input_text(index, text)\` — type into <input>/<textarea>/contenteditable.
- \`send_keys(keys)\` — key combos / named keys (e.g. Enter to commit a tag input). Plain text goes through input_text instead.

Read channels (zero LLM cost — prefer these over eyeballing the DOM):
- \`find_elements(query)\` — CSS selector query, returns tag/text/attributes with total count.
- \`search_page(pattern)\` — grep-like page text search with context and count; traverses same-origin iframes and shadow roots.
- \`find_text(query, index)\` — scroll to and highlight the nth visible match.
- \`read_grid(...)\` — read structured rows from tables/data grids keyed by column header; supports sorting for top-N/latest queries — never assume row order.
- \`extract(query)\` — LLM extraction of the current page as clean markdown (only when the channels above cannot express the need).

Dropdowns — \`select_dropdown\` works on ALL of these, not just native <select>: role=combobox, role=listbox, and custom dropdowns built from <div>/<span>/<ul>.
- \`dropdown_options(index)\` — get all options from a dropdown element.
- \`select_dropdown(index, value)\` — select an option. **Pass the dropdown's index — do NOT click it first.** For <select multiple>, pass all wanted options at once as values=[...].

File upload:
- \`upload_file(index, path)\` — upload a file to a file input element. **Do NOT click the input or an upload button first — upload_file sets the file directly without opening the OS file picker.** This is the ONLY way to handle <input type=file>.

Scroll / wait:
- \`scroll(amount, direction)\` — scroll the page up or down.
- \`wait(seconds)\` — wait for a short while (use when an async render must complete first).

Completion:
- \`done(text, success)\` — signal task complete and stop. Must be the only action in its step.

The agent looks up \`index\` directly in its current DOM snapshot — there is NO xpath/attribute fuzzy matching at runtime. For ambiguous elements, skills must guide attribute-based identification (that is what selectors_md is for); a stale index makes the agent error and re-read the DOM, not auto-resolve.

## What the agent ALREADY handles automatically — DO NOT write these into the skill

Writing these wastes the agent's attention budget and may mislead it. They are silent robustness layers in the agent's session code, not things the skill should teach.

- **JS click / occlusion**: if an element is covered by an overlay, the agent auto-falls-back to a JS click. Do NOT write "use JS click" / "element is occluded" / "force click".
- **Dropdown handling**: \`select_dropdown\` opens and selects in one action — do NOT write "click the dropdown first, then select the option". And do NOT write "don't use select_dropdown because it's a <div> not a <select>" — that is FALSE; only fall back to \`click(index)\` on option nodes when the element is genuinely not a dropdown.
- **Text input**: typing handles framework-controlled inputs (React/Vue), built-in clearing and per-char key events natively. Do NOT write "clear the field manually first" unless the site needs something beyond a normal clear.
- **Multi file-input metadata**: the DOM snapshot already lists each <input type=file> with its accept/visible status. Only note it when the disambiguation is NON-obvious (e.g. accept is the only distinguisher among same-name inputs).
- **Runtime fuzzy matching**: there is NONE (see above). Do NOT suggest the agent will "find the closest element" if the index is stale.`;

// —— 三件套产出规范（TreeForge spec 块移植；evidence 措辞换 trace）——

export const TASK_SOP_SPEC = `1. \`sop_md\`: A **COHERENT PROCEDURAL NARRATIVE** for THIS task's flow — a step-by-step playbook an agent can execute directly: "step 1: locate element X (how to identify it), action Y; step 2: ...". Bind to this site (real URLs, real button labels, real placeholder text). Do NOT write a site function map — that belongs to the host-level card. Describe each element **in place** where the step uses it (tag + whitelist attrs + visible text + what to do), so agents don't need to cross-reference selectors_md for routine elements.`;

export const SELECTORS_SPEC = `2. \`selectors_md\` (appendix, LOW volume): An **ELEMENT DESCRIPTION TABLE** — NOT CSS selectors. The consumer is an LLM agent that reads DOM as \`[index]<tag attr=val /> text\`. **Most elements are already described in-place in sop_md — this file only collects the FEW elements that need a "fingerprint" because they have no unique identity** (e.g. two same-name inputs that must be distinguished by \`accept\`; an element that only exists at a specific stage of the flow). If every element is already unambiguously described in sop_md, output a short note saying so. Do NOT duplicate elements already covered in sop_md.

   Output a 4-column markdown table:
   | 元素用途 | 怎么找到它 | 稳定标识 | 备注 |

   Column spec:
   - 元素用途: what this element is for (e.g. "投稿入口", "标题输入框").
   - 怎么找到它: natural-language location/context (e.g. "首页右上角导航区").
   - 稳定标识: whitelist attributes + visible text ONLY. Allowed attributes: \`id\`, \`name\`, \`type\`, \`placeholder\`, \`aria-label\`, \`role\`, \`data-testid\`, \`data-test\`, \`data-cy\`, \`contenteditable\`, visible text. Format as \`attr=value\` pairs separated by commas.
   - 备注: pitfalls, timing notes (e.g. "只在封面设置弹窗出现", "与字幕 input 同名，靠 accept 区分").

   HARD CONSTRAINTS (must obey):
   - Do NOT produce CSS selectors: no \`.class-name\`, no \`div > span\`, no \`#id\` selector syntax, no XPath.
   - Only use the whitelist attributes above in 稳定标识. Other attributes (class, style, src, href-as-locator) are NOT allowed.
   - If an element has no whitelist attribute, rely on visible text + natural-language location.
   - If the trace contains CSS selectors (find_elements queries), extract whitelist attributes embedded in them, but PREFER describing what the element IS over reusing the selector syntax. Do NOT echo raw selectors.`;

export const QUIRKS_SPEC = `3. \`quirks_md\` (quirks): **Only write quirks the agent CANNOT tell from reading the DOM text alone.** This is the SINGLE MOST IMPORTANT file for agent success, and noise here directly hurts performance. Apply this judgment criteria strictly:

   **WRITE these (DOM-invisible, agent would fail or get confused without them):**
   - Hidden dependencies / sequencing triggers (e.g. "封面上传 input only appears after opening the 封面设置 modal — it is not in the DOM during the upload stage")
   - Element identity ambiguities (e.g. "page has multiple same-name file inputs; distinguish by \`accept\`")
   - Action-method requirements — when the correct ACTION from the Consumer context above matters (e.g. "hidden file input — MUST use \`upload_file\` direct injection, clicking opens an OS dialog the agent can't drive"; "tag input commits with \`send_keys\` Enter, not blur/click"). Reference the exact action name.
   - SPA stage-transition cues (e.g. "URL stays constant across stages; detect stage by DOM content, not URL")
   - Non-AJAX vs AJAX submission behavior (e.g. "提交 triggers a full-page redirect — wait for navigation, don't immediately re-query" / "保存 is AJAX — success is a toast, page does not navigate")
   - Timing/ordering requirements (e.g. "finish cover editing first; the title input is absent during cover-editing")

   **Do NOT WRITE these (writing them wastes the agent's attention):**
   - Element tag/attribute observations the DOM already shows (e.g. "立即投稿 is \`<span>\` not \`<button>\`")
   - Field labels, placeholders, maxlength — all visible in DOM text
   - Anything that is just "describing what the DOM shows"
   - **Things the agent's session layer already handles automatically** (see Consumer context "ALREADY handles automatically" list): JS click / occlusion fallback, dropdown handling, framework text input, file-input metadata. Writing them is noise.

   When in doubt, ask TWO questions:
   1. "If the agent reads the DOM text, can it figure this out itself?" If yes, do NOT write it.
   2. "Does the agent's session layer already handle this automatically?" If yes, do NOT write it.
   Write it only if the answer to both is NO. Describe the **triggering situation** ("after clicking Show Report, ..."), NOT trace step numbers — the card outlives this run's numbering, "step 5" means nothing to a future run.`;

// —— 通用规则（TreeForge _RULES_BLOCK 移植 + §6.3 实体值规则 + secret 占位符规则）——

export const DISTILL_RULES_BLOCK = `# Rules
- **产出语言：中文**（除非站点元素本身是英文，如 placeholder 文本）。所有说明文字、备注、quirks 描述用中文写，保持与站点语言一致。元素用途/可见文本保留站点原文。
- Use OBSERVED element attributes and visible text from the trace. Quote them verbatim where possible.
- Do NOT invent selectors, attributes, or endpoints you didn't see. If unsure, say so explicitly.
- **易变结果值不要写死**：计数 / 金额 / 日期 / 查询结果等随数据漂移的值（如 "N records found（本例为 5）"）固化进卡，数据一变就是错的。描述「去哪里读、怎么读」，不写「读到的值」；确需举例时显式标注「录制时示例，以页面当前值为准」。
- **实体值是参数**：本卡要能服务同模板换实体的任务（如不同订单号/商品名/客户）。步骤中的实体值写成占位描述（如 "订单号（任务给定）"），不写死本例的具体值。
- \`<secret>name</secret>\` 占位符是用户提供的敏感值——步骤确需提及时原样保留占位符，绝不猜测或编造真实值。
- Keep markdown clean — these files are read by an LLM agent, not a human browser.`;

// —— slug/描述/关键词判定（TreeForge _TASK_SLUG_RULES 适配：增量模式 slug 由调用方
//    强制复用，此处只约束新卡命名与检索面）——

export const TASK_SLUG_RULES = `# Task slug & retrieval fields decision
- Return a NEW slug only if this is a genuinely new task: english kebab-case, at most 5 words, derived from the task description (e.g. \`upload-video\`, \`cancel-order\`).
- \`task_description\`: ONE concise line (≤ 80 chars, site's language) describing what this task does — it is the retrieval key for future matching; keep entity values generic (e.g. "取消指定订单" not "取消订单 302").
- \`task_keywords\`: at most 5 keywords in the site's language (usually Chinese), for future semantic retrieval.`;

/** 增量蒸馏 addendum（TreeForge _INCREMENTAL_ADDENDUM 移植：以旧卡为基线更新——
 *  压缩措辞不丢主题；新证据胜出；禁从零重写丢累积） */
export function incrementalAddendum(slug: string, cardText: string | null): string {
  const prev = cardText !== null && cardText.trim() !== "" ? clipPrev(cardText) : "(empty)";
  return `# EXISTING KNOWLEDGE — you are UPDATING card \`${slug}\`
This task has been distilled before (the card below). Produce an **UPDATED VERSION** of the existing card, incorporating the NEW trace (incremental update):
- The previous card below is your **BASE**: carry forward every still-valid entry/topic — compress the wording where needed, but do NOT silently drop topics or sections.
- Remove only what the new trace contradicts — **new evidence wins**.
- Add newly discovered steps/selectors/quirks; do NOT duplicate what's already there.
- Keep the SAME \`task_slug\` (\`${slug}\`) — the old card will be replaced by this updated one.
- **Convergence check**: if after reviewing the new trace you find NOTHING to add, fix, or remove (the existing card already fully covers how this run went), set \`has_new_observations\` to **false** and return the previous card's content as-is. Do NOT reword for the sake of it — an unchanged card is the desired outcome when nothing was learned.

Previous card (sop + selectors + quirks, truncated):
\`\`\`
${prev}
\`\`\``;
}

function clipPrev(text: string): string {
  const s = text.trim();
  return s.length <= PREV_CARD_BUDGET ? s : `${s.slice(0, PREV_CARD_BUDGET)}\n…(truncated)`;
}

export interface TaskDistillPromptInput {
  task: string;
  host: string;
  stepCount: number;
  trace: string;
  /** 既有任务卡目录（slug 规则上下文 + 新卡撞名判定输入） */
  catalog: readonly TaskCardMeta[];
  /** 增量模式（matcher 命中且可更新）：命中 slug + 旧卡全文（null = 取不到旧卡文本） */
  update: { slug: string; cardText: string | null } | null;
}

/** 任务级蒸馏 user prompt 组装（evidence 段 = agent run 叙事，非 TreeForge 示教段） */
export function buildTaskDistillPrompt(input: TaskDistillPromptInput): string {
  const existingTasksBlock =
    input.catalog.length > 0
      ? input.catalog.map((c) => catalogLine(c)).join("\n")
      : "(none — this is the first task card for this host)";
  const updateBlock =
    input.update !== null
      ? `\n${incrementalAddendum(input.update.slug, input.update.cardText)}`
      : "";
  return `Distill the following browser agent execution trace into a **TASK-LEVEL skill card** for \`${input.host}\`.
This card documents ONE task — the flow recorded below — and will later be retrieved by its task description, so the description and keywords must faithfully identify the task.

${CONSUMER_CONTEXT}

# Task description (user intent — use it to guide step selection and wording)
${input.task}

# Existing task cards for this host
${existingTasksBlock}

${TASK_SLUG_RULES}

# Execution trace (${input.stepCount} steps, on ${input.host})
A successful agent run of this task (each step: URL/title, the agent's stated goal, actions with params, and results). \`<secret>name</secret>\` marks values the agent typed from user-provided secrets — keep the placeholder as-is when a step must be documented; never guess or invent the real value.
\`\`\`
${input.trace}
\`\`\`
${updateBlock}
# Output spec — produce THREE markdown sections

${TASK_SOP_SPEC}

${SELECTORS_SPEC}

${QUIRKS_SPEC}

${DISTILL_RULES_BLOCK}
- This card documents ONE task; \`task_slug\` / \`task_description\` / \`task_keywords\` identify it for future retrieval.

Return ONLY JSON in this exact shape:
{
  "task_slug": "...",
  "task_description": "...",
  "task_keywords": ["...", "..."],
  "sop_md": "# ...\\n\\n...",
  "selectors_md": "# Selectors — ${input.host}\\n\\n...",
  "quirks_md": "# Quirks — ${input.host}\\n\\n..."
}`;
}
