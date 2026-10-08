import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      enabled: true,
      include: ["src/**/*.ts"],
      // types.ts 纯接口零运行时（AGENTS「纯类型文件不参与覆盖率统计」）
      exclude: ["src/types.ts"],
      thresholds: { statements: 85, lines: 85, functions: 85, branches: 85 },
      reporter: ["text", "html"],
    },
  },
});
