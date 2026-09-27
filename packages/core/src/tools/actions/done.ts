// done 动作（actions.py :3177-3265）：success 默认推导（text/data 存在才 true）→
// files_to_display 白名单+存在性 → attachments → 变体 B（outputModel 结构化输出，
// 校验失败 success=false 但仍 is_done）→ 变体 A（空 text 兜底仍终止 + 附件清单/内联）。

import { ActionResult } from "../../agent/views.js";
import { validateParams } from "../models.js";
import { pyJsonDumps } from "../py-json.js";
import type { ActionHandler } from "../types.js";
import type { ToolsContext } from "./context.js";

/** Python f"{success}" 字面量（bool → True/False；非 bool 原样字符串化） */
function renderSuccess(success: unknown): string {
  if (success === true) return "True";
  if (success === false) return "False";
  return String(success);
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function createDoneHandler(ctx: ToolsContext): ActionHandler {
  return async (params: Record<string, unknown>) => {
    // success 默认值（PR #174 review4 #1）：text/data 任一「存在」（非 null）才默认
    // True。显式空文本（""）是合法的有意终止；变体 B 无 text 有 data 同样维持 True。
    const hasTextOrData = params.text != null || params.data != null;
    const success = params.success !== undefined ? params.success : hasTextOrData;

    // 二.B 共享：解析 files_to_display → attachments（白名单 + 存在性）。
    // done 必须终止，故任何失败只 warn + 跳过，绝不 error / 绝不 is_done=false。
    const attachments: string[] = [];
    const allowed = ctx.allowedReadPaths;
    const filesToDisplay = Array.isArray(params.files_to_display) ? params.files_to_display : [];
    for (const raw of filesToDisplay) {
      const p = typeof raw === "string" ? (ctx.fs ? ctx.fs.resolve(raw) : raw) : String(raw);
      if (allowed && !allowed.some((pre) => p.startsWith(pre))) {
        ctx.log(`done: skip attachment outside allowed_read_paths: ${p}`);
        continue;
      }
      if (ctx.fs !== null && !(await ctx.fs.isFile(p))) {
        ctx.log(`done: skip missing attachment: ${p}`);
        continue;
      }
      attachments.push(p);
    }

    // 二.E 变体 B：结构化输出。extracted_content 保持纯 JSON；原始数据另存 metadata。
    if (ctx.outputModel !== null) {
      const validated = validateParams(ctx.outputModel, params.data);
      if (!validated.ok) {
        // done 必须终止：结构化校验失败 → success=False 兜底，仍 is_done=true
        ctx.log(`done: structured data invalid: ${validated.errors.join("; ")}`);
        const memory = "Task completed: False - invalid structured output";
        ctx.log(memory);
        return new ActionResult({
          isDone: true,
          success: false,
          extractedContent: `(invalid structured output: ${validated.errors.join("; ")})`,
          longTermMemory: memory,
          attachments: attachments.length > 0 ? attachments : null,
        });
      }
      const payload = validated.value;
      const memory = `Task completed (structured): ${renderSuccess(success)}`;
      ctx.log(memory);
      return new ActionResult({
        isDone: true,
        success: success === true,
        extractedContent: pyJsonDumps(payload, 2),
        longTermMemory: memory,
        metadata: { structured_output: payload },
        attachments: attachments.length > 0 ? attachments : null,
      });
    }

    // 变体 A：自由文本（+ 二.B 清单 + 二.D 内联）
    let text = String(params.text ?? "").trim();
    if (text === "") {
      // done 必须终止（is_done=true 才退出循环），空 text 不能走 soft-miss。
      // 兜底默认值保证终止 + 让退化情形在日志可见。
      text = "(no summary provided)";
      ctx.log("done called with empty text; substituting default summary");
    }
    const truncated = text.slice(0, 100);
    let memory = `Task completed: ${renderSuccess(success)} - ${truncated}`;
    if (text.length > 100) {
      memory += ` - ${text.length - 100} more characters`; // 二.A 后缀
    }
    let visible = text;
    if (attachments.length > 0) {
      // 二.B：附件清单（final_result() 可见；__str__ 仍被 500 截断）——Python `if attachments:`
      // 空列表为 falsy，JS [] 恒真，按长度判
      visible += `\n\nAttachments: ${attachments.map((a) => basename(a)).join(", ")}`;
    }
    if (ctx.displayFilesInDoneText && attachments.length > 0 && ctx.fs !== null) {
      // 二.D：内联文件内容
      const cap = ctx.truncation.doneAttachmentMaxChars;
      const inlineParts: string[] = ["", "Attachments:"];
      let inlined = 0;
      for (const a of attachments) {
        try {
          const body = await ctx.fs.readTextFile(a, cap);
          inlineParts.push(`--- ${a} ---\n${body}`);
          inlined += 1;
        } catch (e) {
          ctx.log(`done: skip inline read ${a}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (inlined > 0) {
        visible += `\n${inlineParts.join("\n")}`;
      }
    }
    ctx.log(memory);
    return new ActionResult({
      isDone: true,
      success: success === true,
      extractedContent: visible,
      longTermMemory: memory,
      attachments: attachments.length > 0 ? attachments : null,
    });
  };
}
