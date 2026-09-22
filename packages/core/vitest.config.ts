import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 脚手架阶段（2.0）尚无测试文件；2.1 起删除此前勿提交实质测试
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      // 默认开启：让 `pnpm test` 也执行覆盖率门禁（不依赖调用方记得加 --coverage）
      enabled: true,
      include: ["src/**/*.ts"],
      // 纯类型声明文件，无运行时代码，不参与覆盖率统计（types.ts 含 assertValidMessages，
      // 是运行时代码，不在此列）
      exclude: ["src/llm/provider.ts", "src/llm/deps.ts"],
      // 项目门槛：> 85%（根 AGENTS.md「单元测试要求」）；不达标即失败
      thresholds: { statements: 85, lines: 85, functions: 85, branches: 85 },
      reporter: ["text", "html"],
    },
  },
});
