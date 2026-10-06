#!/usr/bin/env node
// 示例：跨站结构化价格对比（outputModel 变体 B）。移植自 browser-use/examples/use-cases/
// phone_comparison.py，经 TreeWalker examples/use-cases/phone_price_comparison.py（Python 用
// Pydantic PhonePrice/PriceComparison 嵌套模型；本版用 core 的 ParamModel 定义同形状——
// done.data 结构化返回后硬校验渲染，失败抛错非软兜底）。
//
// 前置：pnpm install；Chrome 以 --remote-debugging-port=9222 运行；设置 ZHIPU_API_KEY
//（或写 cwd/.env）。用法：node examples/use-cases/phone-price-comparison.mjs

import { loadKit } from "../../packages/node-host/boot.mjs";

// Pydantic PhonePrice/PriceComparison 的 ParamModel 等价（prices: list[PhonePrice]——
// array.refModel 嵌套形态，description 逐字保留 Python Field(...)）
const PhonePrice = {
  name: "PhonePrice",
  fields: [
    { name: "site", type: "string", required: true, description: "站点名" },
    { name: "price", type: "string", required: true, description: "价格（含货币）" },
    { name: "url", type: "string", required: true, description: "商品页 URL" },
  ],
};
const PriceComparison = {
  name: "PriceComparison",
  fields: [
    { name: "model_name", type: "string", required: true },
    { name: "prices", type: "array", required: true, refModel: PhonePrice },
  ],
};

// 任务文本逐字保留 Python 版
const TASK =
  "Compare the price of 'iPhone 16 Pro 256GB' across at least 2 shopping sites " +
  "(e.g. Amazon, Best Buy). Return structured data with the model name and a " +
  "list of per-site prices.";

try {
  const kit = await loadKit();
  const history = await kit.runAgent({
    task: TASK,
    overrides: { agent: { outputModel: PriceComparison } },
  });

  const result = history.finalResult();
  if (!result) {
    console.log("No result");
  } else {
    // pydantic model_validate_json 的 TS 等价：JSON.parse + 形状校验，失败抛错走顶层
    // catch exit 1（Python 本例硬抛 traceback；区别于 structured_output.py 的软兜底）
    const parsed = JSON.parse(result);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.model_name !== "string" ||
      !Array.isArray(parsed.prices) ||
      !parsed.prices.every(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          typeof p.site === "string" &&
          typeof p.price === "string" &&
          typeof p.url === "string",
      )
    ) {
      throw new Error(`returned JSON does not match PriceComparison:\n${result}`);
    }
    console.log(`\n${parsed.model_name}`);
    for (const p of parsed.prices) {
      console.log(`  - ${p.site}: ${p.price}  (${p.url})`);
    }
  }
} catch (e) {
  console.error(`[phone-price-comparison] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
