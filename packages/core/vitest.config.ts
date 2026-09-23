import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // 门禁由 package.json 的 test 脚本（vitest run --coverage）显式开启——config 层
      // 不默认 enabled：单文件调试/watch 模式下未执行源文件按 0% 计入会假性卡死阈值
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
