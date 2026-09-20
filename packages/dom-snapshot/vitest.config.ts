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
      // 纯类型声明文件，无运行时代码，不参与覆盖率统计
      exclude: ["src/protocol.ts"],
      // 项目门槛：> 85%（根 AGENTS.md「单元测试要求」）；不达标即失败
      thresholds: { statements: 85, lines: 85, functions: 85, branches: 85 },
      reporter: ["text", "html"],
    },
  },
});
