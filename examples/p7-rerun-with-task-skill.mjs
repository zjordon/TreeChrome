#!/usr/bin/env node
// 示例：P7 轨迹重跑·任务级 skill 注入版（口径 C 冒烟，docs/p7/03）。移植自
// TreeWalker examples/p7_rerun_with_task_skill.py——在 p7-rerun-webarena-task.mjs
// 之上只做一件事：进程内预设 AGENT_ENABLE_TASK_SKILL_INJECTION=true 再跑原脚本
//（动态 import 执行 base 顶层 = Python「import base 后调 main」的结构等价）。
// 其余参数/行为与原脚本完全一致（argv 透传）。
//
// ⚠️ 口径提醒（docs/p7/03 §八红线）：本脚本跑出的是**口径 C（with task knowledge）**
// 的数字——任务级 skill 对自主探索口径等价泄露参考轨迹，其 SR 禁止与主口径（A）/
// 站点口径（B）或外部 leaderboard 混合对比。只用于产品能力验证 / 检索层冒烟。
//
// 用法（Chrome 以 --remote-debugging-port=9223 启动并手动登录目标站后）：
//   node examples/p7-rerun-with-task-skill.mjs --task-id 0
//   node examples/p7-rerun-with-task-skill.mjs --task-id 0 --log-file out-c.log
//
// 预期日志（三条齐 = 检索层活 + 匹配判定 + 实际装载）：
//   [skill] task-skill catalog: 44 cards (host_key=localhost_7780)
//   [agent] task-skill-match: {..., "match": "<slug>", ...}
//   [agent] task-skill hit: slug=<slug> chars=N

// 必须在 base（loadKit→loadHostSettings）之前设 env——applyDotEnv override=false
// 不覆盖已设键，Python「load_settings 前设 env」同款时序
process.env.AGENT_ENABLE_TASK_SKILL_INJECTION = "true";

console.log("[口径 C] AGENT_ENABLE_TASK_SKILL_INJECTION=true——任务级 skill 注入已开");
console.log("[注意] 不注入 cookie——请确保 Chrome 已手动登录目标站");
console.log(
  "[口径 C] ⚠️ 本运行的 SR 属产品口径，禁止与主口径/站点口径/外部榜对比（docs/p7/03 §八）",
);

await import("./p7-rerun-webarena-task.mjs");
