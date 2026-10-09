// 扩展单测配置（m5/04 §10）：runtime/ 全件 fake chrome（storage Map 化/Port stub/
// IndexedDB 窄接口注入 fake）单测；覆盖率阈值对齐各包 85%。e2e 真机 smoke 走
// package.json 的 e2e:* 脚本（Playwright/CDP，不入 vitest）。

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["src/**/*.ts"],
      // chrome-apis.ts 的真绑定访问器（扩展上下文才有 chrome——测试不触，
      // 注入面已被各件覆盖）
      exclude: ["src/host/chrome-apis.ts"],
      thresholds: { statements: 85, lines: 85, functions: 85, branches: 85 },
      reporter: ["text", "html"],
    },
  },
});
