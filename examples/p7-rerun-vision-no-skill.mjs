#!/usr/bin/env node
// 示例：P7 轨迹重跑·视觉开 + skill 关版（issue #197 真机验收用）。移植自
// TreeWalker examples/p7_rerun_vision_no_skill.py——在 p7-rerun-webarena-task.mjs
// 之上进程内预设三组 env 再跑原脚本：
//   AGENT_USE_VISION=true                     视觉模式（每步截图入 LLM）
//   AGENT_ENABLE_SKILL_INJECTION=false        站点级 skill 关
//   AGENT_ENABLE_TASK_SKILL_INJECTION=false   任务级 skill 关（默认本就 off，显式压死）
//
// 用途：#197 视觉畸形动作梯子的真机验收——V 轮死于「缺 name 键动作二连判死」的
// 10 任务（108/109/200/492/495/544/545/549/696/782）定向重跑。skill 全关是为隔离
// 变量：梯子行为（澄清/降级/死刑）与 skill 注入无关，关掉少一路噪声。
//
// 跑前检查（脚本内硬校验，对齐 evals 仓 smoke_test 的视觉口径守门）：
//   LLM_MODEL 必须在视觉名单（claude-* / glm-*v* / glm-5.3-flash）——名单外模型 +
//   use_vision=true 时视觉门**静默关闭**，整跑退化为贴 vision 标签的纯文本轮。
//
// 用法（Chrome 以 --remote-debugging-port=9223 启动并手动登录目标站后）：
//   node examples/p7-rerun-vision-no-skill.mjs --task-id 108
//   node examples/p7-rerun-vision-no-skill.mjs --task-id 108 --log-file v108.log

// 必须在 base（loadKit→loadHostSettings）之前设 env（applyDotEnv override=false）
process.env.AGENT_USE_VISION = "true";
process.env.AGENT_ENABLE_SKILL_INJECTION = "false";
process.env.AGENT_ENABLE_TASK_SKILL_INJECTION = "false";

console.log("[口径] 视觉开（AGENT_USE_VISION=true）+ skill 全关（站点级/任务级注入均 off）");
console.log("[注意] 不注入 cookie——请确保 Chrome 已手动登录目标站（Magento admin 等）");

// 视觉口径守门（对齐 Python _validate_vision_settings）：静默退化成纯文本轮的跑批是
// 红线事故形态（结果零异常信号），必须起跑前拦——须在 base 之前完成（故此处单独 loadKit）
const { loadKit } = await import("../packages/node-host/boot.mjs");
const kit = await loadKit();
kit.applyDotEnv();
const settings = kit.loadHostSettings();
if (settings.agent.useVision !== true) {
  console.error("✗ AGENT_USE_VISION=true 未生效（settings.agent.useVision 仍非 true）");
  process.exit(1);
}
if (!kit.modelSupportsVision(settings.llm.model)) {
  console.error(
    `✗ 视觉口径无效：use_vision=true 但模型 '${settings.llm.model}' 不在视觉名单` +
      "（claude-* / glm-*v* / glm-5.3-flash）——视觉门会静默关闭，整跑退化为纯文本。" +
      "设 LLM_MODEL 为名单内模型后重跑",
  );
  process.exit(1);
}
console.log("[口径] 视觉校验通过——梯子行为（澄清/降级/死刑）与 skill 无关，#197 验收口径");

await import("./p7-rerun-webarena-task.mjs");
