#!/usr/bin/env node
// 示例：P7 轨迹重跑 base——用 Agent 重跑单个 WebArena 任务（轨迹分析用）。移植自
// TreeWalker examples/p7_rerun_webarena_task.py。与评测工作空间
//（D:\dev\git\z_jordon\evals\webarena）的关系：**只读**其 config_files/<id>.json；
// 登录 cookie 由使用者在浏览器侧自行保证（Python 2026-09-06 移除注入——注入过期
// cookie 反而会顶掉手登会话）；官方判分仍归评测仓——本示例产出轨迹 + agent 自评 +
// judge 判词（history.judgement 直打，TS 侧 judge 不进控制台日志的补偿面）+ 参考答案
// 对照，足够做轨迹分析。
//
// 不移植：Python llm.client 的 DEBUG「LLM response blocks」逐块日志（TS 客户端无此
// debug 面；控制台事件行已含决策面）——方案 p5/03 T2 登记。
//
// 用法（Chrome 以 --remote-debugging-port=<port> 启动并手动登录目标站后）：
//   node examples/p7-rerun-webarena-task.mjs                      # task 1, 30 步
//   node examples/p7-rerun-webarena-task.mjs --task-id 502 --max-steps 30
//   node examples/p7-rerun-webarena-task.mjs --log-file out.log   # 轨迹落盘

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadKit } from "../packages/node-host/boot.mjs";

const DEFAULT_WEBARENA_REPO = "D:\\dev\\git\\z_jordon\\evals\\webarena\\webarena_repo";

// ── argv（argparse 子集，值校验同 p7 回归 harness 形态） ──────────────────────
const args = {
  taskId: 1,
  port: 9223,
  maxSteps: 30,
  taskTimeout: 1800,
  webarenaRepo: DEFAULT_WEBARENA_REPO,
  logFile: null,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const value = (name) => {
    const v = process.argv[++i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`${name} 缺值（收到: ${v ?? "无"}）`);
      process.exit(2);
    }
    return v;
  };
  const intArg = (name, min) => {
    const n = Number(value(name));
    if (!Number.isInteger(n) || n < min) {
      console.error(`${name} 需 ≥${min} 的整数（收到: ${process.argv[i]}）`);
      process.exit(2);
    }
    return n;
  };
  if (a === "--task-id") args.taskId = intArg(a, 0);
  else if (a === "--port") args.port = intArg(a, 1);
  else if (a === "--max-steps") args.maxSteps = intArg(a, 1);
  else if (a === "--task-timeout") args.taskTimeout = intArg(a, 1);
  else if (a === "--webarena-repo") args.webarenaRepo = value(a);
  else if (a === "--log-file") args.logFile = value(a);
  else {
    console.error(`未知参数: ${a}`);
    process.exit(2);
  }
}

// CDP_PORT 必须在 loadKit/loadHostSettings 之前进 env（applyDotEnv override=false
// 不覆盖已设键——Python「load_settings 前设 env」同款时序）
process.env.CDP_PORT = String(args.port);

const kit = await loadKit();
const configPath = `${args.webarenaRepo}\\config_files\\${args.taskId}.json`;
if (!existsSync(configPath)) {
  console.error(`✗ 任务配置不存在: ${configPath}`);
  process.exit(1);
}
const task = JSON.parse(readFileSync(configPath, "utf8"));
const intent = task.intent ?? "";
const startUrl = task.start_url ?? "";
console.log(`task ${args.taskId}: ${intent}`);
console.log(`参考答案: ${JSON.stringify(task.eval?.reference_answers ?? {})}`);

// 配置面打印（runAgent 内部会重复装载一次——幂等无害）
kit.applyDotEnv();
const settings = kit.loadHostSettings();
console.log(
  `LLM 配置: model=${settings.llm.model} max_tokens=${settings.llm.maxTokens} output_mode=${settings.llm.outputMode}`,
);

// --log-file：经 runAgent 的 log 注入位 tee（console + 文件双写；[event]/[agent]/
// [skill] 等前缀行全走该通道）
let log;
if (args.logFile !== null) {
  mkdirSync(dirname(args.logFile), { recursive: true });
  log = (m) => {
    console.log(m);
    appendFileSync(args.logFile, `${m}\n`, "utf8");
  };
}

const taskText = startUrl ? `${intent}\n\n起始页: ${startUrl}` : intent;
// Python「AgentSettings(max_steps=...) 丢 env 接线」踩坑在 TS 由 overrides 合并天然免疫
const history = await Promise.race([
  kit.runAgent({ task: taskText, log, overrides: { agent: { maxSteps: args.maxSteps } } }),
  new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`任务超过 ${args.taskTimeout}s 被中断`)),
      args.taskTimeout * 1000,
    ).unref?.();
  }),
]).catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

console.log("\n=========== 重跑结果 ===========");
console.log(`is_done      : ${history.isDone()}`);
console.log(`is_successful: ${history.isSuccessful()}`);
console.log(`n_steps      : ${history.history.length}`);
console.log(`final_result :\n${history.finalResult()}`);
// judge 判词挂在 done 的 ActionResult 上（agent 侧静默附——TS 日志面差，此处直打）
const lastStep = history.history[history.history.length - 1];
const judgement = lastStep?.result.find((r) => r.isDone)?.judgement ?? null;
if (judgement !== null) {
  console.log(`judgement    : ${JSON.stringify(judgement)}`);
}
// url_match 型任务 reference_answers 为 null——?? 空对象守卫（Python 374 实锤注释同款）
const ref = task.eval?.reference_answers?.exact_match;
if (ref) {
  const contained = `${history.finalResult() ?? ""}`
    .toLowerCase()
    .includes(String(ref).toLowerCase());
  console.log(
    `参考答案对照 : 参考=${JSON.stringify(ref)}，final_result 含参考值: ${contained}（信息性对照，非官方判分）`,
  );
}
