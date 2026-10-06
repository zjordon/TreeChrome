#!/usr/bin/env node
// 示例：抖音上传的视觉对照变体（vision ON，skill OFF）。移植自 TreeWalker
// examples/upload_file_vision.py（screenshot.md 阶段二 / issue #175）：
//   - useVision=true + glm-5.3-flash —— 每步带降采样截图（视觉门要求视觉模型）
//   - enableSkillInjection=false     —— 关闭站点级 skill 注入
// 对照矩阵（同一抖音上传任务；TS 侧 domain-skills 内容库未移植，两格实际都无 skill
// 注入——对照退化为「无 skill 基线上开/关视觉」的单变量对照，方案 UP1 登记）：
//   | 示例                     | 视觉 | skill |
//   | upload-file.mjs（原版）   | ✗    | ✓(Py) |
//   | upload-file-vision.mjs    | ✓    | ✗     |
// 看点：视觉能否补上领域知识的缺（封面选择/自主声明/合集等页面交互的视觉线索）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行（需已登录抖音创作者
// 中心）；设置 ZHIPU_API_KEY（或写 cwd/.env）。用法：node examples/upload-file-vision.mjs
// 注意：任务中的视频/封面路径是 Python 作者机器的示例路径，运行前改成你自己的文件。

import { loadKit, modelSupportsVision } from "../../packages/node-host/boot.mjs";

// 视觉门要求模型在已知视觉名单内（文本模型收图不报错只静默致盲——sense 的
// visionGateOpen 逐步评估为 false）——显式切到 glm-5.3-flash，保证示例开箱即跑
const MODEL = "glm-5.3-flash";
if (!modelSupportsVision(MODEL)) {
  console.error(`Error: model '${MODEL}' is not in the vision model list`);
  process.exit(1);
}

// 任务文本逐字保留 Python 版（与 upload-file.mjs 同文；路径为示例模板，按需替换）
const TASK =
  "帮我到抖音创作者中心发一个视频，信息如下，先暂存为草稿不要直接发布，发布完后回到发布视频界面就算完成了不要再点继续编辑进去重复编辑\n" +
  "\n" +
  "抖音创作者中心网址:https://creator.douyin.com/\n" +
  "我要发的视频在'D:\\Videos\\test\\final\\2026-04-29-20-41-59.mp4'\n" +
  "作品描述中的主标题为：ai浏览器第五期-browse-use,副标题为:'browse-use体验及技术原理'\n" +
  "添加合集到'AI浏览器合集'\n" +
  "自主声明选择'无需添加自主声明'\n" +
  "横封面图片在'D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\heng.png'\n" +
  "竖封面图片在'D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\shu.png'";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    overrides: {
      llm: { model: MODEL },
      agent: {
        enablePlanning: true,
        allowedUploadPaths: [
          "D:\\Videos\\test\\final\\2026-04-29-20-41-59.mp4",
          "D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\heng.png",
          "D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\shu.png",
        ],
        // ── 本示例的两个主角 ──
        useVision: true, // 每步带降采样截图（默认 false=评测红线）
        enableSkillInjection: false, // 关闭站点级 skill 注入（默认 true）
        // 截图降采样目标 [w, h]（对齐 browser-use）；null = 不缩放（原图可能很大）
        llmScreenshotSize: [1400, 850],
      },
    },
  });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[upload-file-vision] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
