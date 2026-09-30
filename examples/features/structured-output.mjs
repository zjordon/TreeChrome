#!/usr/bin/env node
// 示例：结构化输出（outputModel 变体 B）。移植自 browser-use/examples/features/
// custom_output.py，经 TreeWalker examples/features/structured_output.py（Python 用
// Pydantic Posts 模型；本版用 core 的 ParamModel 定义同形状——done.data 结构化输出）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/features/structured-output.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// Pydantic Post/Posts 的 ParamModel 等价（posts: list[Post]——array.refModel 嵌套形态）
const Post = {
  name: "Post",
  fields: [
    { name: "post_title", type: "string", required: true },
    { name: "post_url", type: "string", required: true },
    { name: "num_comments", type: "integer", required: true },
    { name: "hours_since_post", type: "integer", required: true },
  ],
};
const Posts = {
  name: "Posts",
  fields: [{ name: "posts", type: "array", required: true, refModel: Post }],
};

// 任务文本逐字保留 Python 版
const TASK = "Go to https://news.ycombinator.com/show and give me the first 5 posts.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    overrides: { agent: { outputModel: Posts } },
  });

  const result = history.isDone() ? history.finalResult() : null;
  if (!result) {
    console.log("No result");
  } else {
    // final_result() 可能是非 JSON 字符串（agent 未能产出合法结构化输出、success=false
    // 兜底）——直接展示原始结果而不是抛异常（Python :64-70 同款兜底）
    let parsed = null;
    try {
      parsed = JSON.parse(result);
    } catch {
      // 非 JSON
    }
    const posts =
      parsed !== null &&
      Array.isArray(parsed.posts) &&
      parsed.posts.every(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          typeof p.post_title === "string" &&
          typeof p.post_url === "string" &&
          typeof p.num_comments === "number" &&
          typeof p.hours_since_post === "number",
      )
        ? parsed.posts
        : null;
    if (posts === null) {
      console.log(`Agent did not return valid Posts JSON:\n${result}`);
    } else {
      for (const p of posts) {
        console.log(
          `- ${p.post_title}\n  ${p.post_url}  (comments=${p.num_comments}, ${p.hours_since_post}h ago)`,
        );
      }
    }
  }
} catch (e) {
  console.error(`[structured-output] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
