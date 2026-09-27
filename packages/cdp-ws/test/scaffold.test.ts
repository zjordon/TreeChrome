// 脚手架冒烟（3.0）：占位导出可达、覆盖率门禁可过；3.1 起被真实测试矩阵替换。
import { expect, it } from "vitest";
import { CDP_WS_SCAFFOLD } from "../src/index.js";

it("占位导出", () => {
  expect(CDP_WS_SCAFFOLD).toBe(true);
});
