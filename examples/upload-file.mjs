#!/usr/bin/env node
// 示例：抖音创作者中心发视频存草稿（upload_file 动作 + allowedUploadPaths 白名单）。
// 移植自 TreeWalker examples/upload_file.py。Python 显式传 enable_planning=True（TS 侧
// node-host 运营默认已 true，仍显式传保真）与 upload_verify×3 env 透传（TS 侧 Tools
// 默认 true/1500/250 与 Python dataclass 默认全同，无需传——env 开关面不存在是 P4b 起
// 既定架构，方案 UP1 登记）。已知限制：TreeWalker 随仓 domain-skills/ 站点 skill 库
// TS 侧未移植，本示例实际无 skill 注入（AgentOptions.skillSource 缺省 null）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行（需已登录抖音创作者
// 中心）；设置 ZHIPU_API_KEY（或写 cwd/.env）。用法：node examples/upload-file.mjs
// 注意：任务中的视频/封面路径是 Python 作者机器的示例路径，运行前改成你自己的文件。

import { loadKit } from "../../packages/node-host/boot.mjs";

// 任务文本逐字保留 Python 版（路径为示例模板，按需替换）
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
      agent: {
        enablePlanning: true,
        allowedUploadPaths: [
          "D:\\Videos\\test\\final\\2026-04-29-20-41-59.mp4",
          "D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\heng.png",
          "D:\\dev\\git\\claude\\skills-deom\\ppt\\browser-use\\shu.png",
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
  console.error(`[upload-file] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
