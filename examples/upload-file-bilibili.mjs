#!/usr/bin/env node
// 示例：B站创作者中心发视频存草稿（upload_file 动作 + allowedUploadPaths 白名单）。
// 移植自 TreeWalker examples/upload_file_bilibili.py（Python 源里被注释掉的 debug 日志
// 行不移植；upload_verify 未透传同源——TS 侧 Tools 默认已与 Python dataclass 默认全同，
// 方案 UP1 登记）。已知限制：domain-skills 站点 skill 库 TS 侧未移植，无 skill 注入。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行（需已登录B站创作者
// 中心）；设置 ZHIPU_API_KEY（或写 cwd/.env）。用法：node examples/upload-file-bilibili.mjs
// 注意：任务中的视频/封面路径是 Python 作者机器的示例路径，运行前改成你自己的文件。

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版（路径为示例模板，按需替换）
const TASK =
  "帮我到B站创作者中心发一个视频，信息如下，先暂存为草稿不要直接发布\n" +
  "\n" +
  "B站创作者中心网址:https://member.bilibili.com/platform/home\n" +
  "我要发的视频在'D:\\Videos\\test\\final\\2026-04-29-20-41-59.mp4'\n" +
  "封面图片在'D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\横封面.png'\n" +
  "标题为：ai浏览器第五期-browse-use\n" +
  "创作声明:个人观点，仅供参考\n" +
  "分区:科技数码\n" +
  "标签:浏览器Agent\n" +
  "简介：ai浏览器第五期-browse-use";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    overrides: {
      agent: {
        enablePlanning: true,
        allowedUploadPaths: [
          "D:\\Videos\\test\\final\\2026-04-29-20-41-59.mp4",
          "D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\横封面.png",
        ],
      },
    },
  });

  if (history.isDone()) {
    console.log(`\nTask completed: ${history.finalResult()}`);
  } else {
    console.log("\nTask did not complete within max steps");
  }
} catch (e) {
  console.error(`[upload-file-bilibili] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
