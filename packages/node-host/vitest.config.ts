import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // 默认开启：让 `pnpm test` 也执行覆盖率门禁（不依赖调用方记得加 --coverage）
      enabled: true,
      include: ["src/**/*.ts"],
      // 纯装配入口不入单测覆盖率（真机 smoke 覆盖）：cli-main-entry 是 dist 构建入口
      //（main() 本体在 cli.ts 已全测）；boot.mjs 在包根（非 src/）天然不在 include。
      exclude: ["src/cli-main-entry.ts"],
      // 项目门槛：> 85%（根 AGENTS.md「单元测试要求」）；不达标即失败。
      thresholds: { statements: 85, lines: 85, functions: 85, branches: 85 },
      reporter: ["text", "html"],
    },
  },
});
